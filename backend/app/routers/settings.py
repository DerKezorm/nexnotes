"""The operator's settings: address, sign-in, limits, the switches of the features, invitation mail, backups,
the space in the data folder.

Secrets (the mail password) are written encrypted and never read back: the answer only says whether one is set.
The sign-in providers live in ``routers/oidc.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..config import get_settings
from ..deps import DbSession, OperatorAccount, unknown_proxy_seen
from ..errors import error
from ..models import SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..security import encrypt_secret
from ..services import accounts, mailer, mounts, settings_service, storage
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import authentik, providers

logger = logging.getLogger("nexnotes.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsOut(BaseModel):
    public_url: str
    password_login: bool
    two_factor_required: bool
    backup_schedule: str
    backup_keep: int
    smtp_host: str
    smtp_port: int
    smtp_security: str
    smtp_user: str
    smtp_password_set: bool
    smtp_from: str
    upload_max_mb: int
    history_days: int
    trash_days: int
    link_previews: bool
    share_links: bool
    mcp_enabled: bool
    api_enabled: bool
    connections_local_network: bool
    ocr_languages: list[str]
    update_check: bool
    #: The disk under the data folder, in bytes (NOTES-1 AC-11).
    data_total: int = 0
    data_used: int = 0
    data_free: int = 0
    #: What nexnotes itself takes in the data folder, in bytes: the sum and its parts (NOTES-1 AC-11). The disk above
    #: may hold much else besides.
    nexnotes_used: int = 0
    nexnotes_parts: dict[str, int] = Field(default_factory=dict)
    #: The data folder lies on a network share (NOTES-1 EC-2).
    data_on_share: bool = False
    #: Requests come with proxy headers, but no trusted proxy is configured (only in the answer of GET).
    proxy_unknown: bool = False


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=255)
    #: The operator answered the question that came back as 409 ``public_url_change`` (authentik knows the old
    #: address). Not a setting; it only goes with ``public_url``.
    confirm_address: bool = False
    password_login: bool | None = None
    two_factor_required: bool | None = None
    backup_schedule: Literal["off", "daily", "weekly"] | None = None
    backup_keep: int | None = Field(default=None, ge=1, le=365)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] | None = None
    smtp_user: str | None = Field(default=None, max_length=255)
    #: Empty removes the password; left out keeps it.
    smtp_password: str | None = Field(default=None, max_length=500)
    smtp_from: str | None = Field(default=None, max_length=255)
    upload_max_mb: int | None = Field(default=None, ge=1, le=100_000)
    history_days: int | None = None
    trash_days: int | None = None
    link_previews: bool | None = None
    share_links: bool | None = None
    mcp_enabled: bool | None = None
    api_enabled: bool | None = None
    connections_local_network: bool | None = None
    ocr_languages: list[str] | None = Field(default=None, max_length=20)
    update_check: bool | None = None


class TestMailIn(BaseModel):
    to: str = Field(max_length=255)
    #: The language the operator's page shows, for the mail when neither the receiver nor the operator has one.
    language: str = Field(default="", max_length=16)


def _view(db: DbSession) -> SettingsOut:
    values = settings_service.get_all(db)
    folder = get_settings().data_dir
    used = storage.usage(folder)
    own = storage.footprint(folder)
    return SettingsOut(
        public_url=values["public_url"],
        password_login=values["password_login"],
        two_factor_required=bool(values["two_factor_required"]),
        backup_schedule=values["backup_schedule"],
        backup_keep=values["backup_keep"],
        smtp_host=values["smtp_host"],
        smtp_port=values["smtp_port"],
        smtp_security=values["smtp_security"],
        smtp_user=values["smtp_user"],
        smtp_password_set=bool(values["smtp_password_enc"]),
        smtp_from=values["smtp_from"],
        upload_max_mb=settings_service.upload_max_mb(db),
        history_days=settings_service.history_days(db),
        trash_days=settings_service.trash_days(db),
        link_previews=bool(values["link_previews"]),
        share_links=bool(values["share_links"]),
        mcp_enabled=bool(values["mcp_enabled"]),
        api_enabled=bool(values["api_enabled"]),
        connections_local_network=bool(values["connections_local_network"]),
        ocr_languages=[code for code in settings_service.OCR_LANGUAGES if code in (values["ocr_languages"] or [])],
        update_check=bool(values["update_check"]),
        data_total=used.total,
        data_used=used.used,
        data_free=used.free,
        nexnotes_used=own.total,
        nexnotes_parts={"database": own.database, "attachments": own.attachments, "backups": own.backups,
                        "exports": own.exports, "other": own.other},
        data_on_share=mounts.locate(folder).network,
    )


@router.get("", response_model=SettingsOut)
def read(request: Request, _operator: OperatorAccount, db: DbSession) -> SettingsOut:
    # Requests come through a proxy nexnotes was not told about: the sign-in brake sees one sender for everybody.
    # The page names the setting.
    return _view(db).model_copy(update={"proxy_unknown": unknown_proxy_seen(request)})


@router.put("", response_model=SettingsOut)
def save(payload: SettingsIn, request: Request, operator: OperatorAccount, db: DbSession) -> SettingsOut:
    changes: dict[str, Any] = {}
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None or key == "confirm_address":
            continue
        if key == "public_url":
            try:
                value = settings_service.normalize_public_url(value)
            except ValueError as exc:
                raise error("invalid_url", "Enter an address starting with http:// or https://.", 422) from exc
            # Saving the address changes the return address of the sign-in: authentik, set up by the button, knows
            # the old one. Ask first, save nothing.
            question = authentik.public_url_guard(SqlStore(db), value, str(request.base_url),
                                                  confirm=payload.confirm_address)
            if question is not None:
                raise error("public_url_change", "The address changes what authentik knows.", 409, **question)
        elif key == "smtp_from":
            value = value.strip()
            if value and not accounts.EMAIL_PATTERN.match(value):
                raise error("invalid_email", "This is not a mail address.", 422)
        elif key == "two_factor_required" and value and operator.sign_in == SIGN_IN_PASSWORD and not (
            operator.totp_secret_enc
        ):
            # Else the operator would be the first one sent to the account page, with nothing else in reach.
            raise error("own_second_factor_first", "Set up your own second factor first.", 409)
        elif key == "password_login" and not value:
            if not providers.public_list(SqlStore(db)):
                # Without an active provider nobody but the operator could sign in any more, and invitations would
                # fail.
                raise error("provider_first", "Set up a sign-in provider first.", 409)
        elif key == "history_days" and value not in settings_service.HISTORY_DAYS:
            raise error("invalid_input", "The input is not valid.", 422, fields=["history_days"])
        elif key == "trash_days" and value not in settings_service.TRASH_DAYS:
            raise error("invalid_input", "The input is not valid.", 422, fields=["trash_days"])
        elif key == "ocr_languages":
            if not value or any(code not in settings_service.OCR_LANGUAGES for code in value):
                raise error("invalid_input", "The input is not valid.", 422, fields=["ocr_languages"])
            value = [code for code in settings_service.OCR_LANGUAGES if code in value]
        elif key == "smtp_password":
            changes["smtp_password_enc"] = encrypt_secret(value)
            continue
        elif isinstance(value, str):
            value = value.strip()
        changes[key] = value
    settings_service.save(db, changes)
    logger.info("Settings changed keys=%s by=%s", ",".join(sorted(changes)), operator.name)
    return _view(db)


@router.post("/mail-test", status_code=204, summary="Send a test mail through the configured server")
def mail_test(payload: TestMailIn, operator: OperatorAccount, db: DbSession) -> None:
    to = payload.to.strip()
    if not accounts.EMAIL_PATTERN.match(to):
        raise error("invalid_email", "This is not a mail address.", 422)
    # In the language of whoever receives it, as the invitation: an account with this address, else the operator's
    # own language, else the page's, else English.
    known = db.scalar(select(AccountRow).where(func.lower(AccountRow.email) == to.lower()).limit(1))
    language = mailer.language_for(db, known, *mailer.languages(operator, payload.language))
    try:
        mailer.send_test(db, to, language)
    except mailer.MailError as exc:
        # No mail server is a setting, not a failing server: no gateway error, no ERROR in the log.
        raise error(exc.code, str(exc), 409 if exc.code == "mail_off" else 502) from exc
