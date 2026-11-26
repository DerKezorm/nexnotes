"""Operator settings in the database, with defaults."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Setting
from ..vendor.nexoidc import flow

#: The languages text recognition reads in pictures, scans and PDFs (NOTES-11): German and English from the start, the
#: others to choose.
OCR_LANGUAGES = ("de", "en", "fr", "es", "it", "nl", "pt", "pl", "tr")
#: How long the history of a note may be kept, and the trash, in days (NOTES-15): the choices of the settings page.
HISTORY_DAYS = (30, 90, 180, 365, 730)
TRASH_DAYS = (7, 30, 90, 180, 365)

DEFAULTS: dict[str, Any] = {
    #: The version that ran last on this data: a different one at the start makes a backup first.
    "running_version": "",
    "log_mode": "normal",
    "log_mode_until": None,
    #: off | daily | weekly | monthly (the shared module sicherung). Daily in the night unless the operator decides
    #: otherwise, at 03:00 in the server's zone; 7 kept.
    "backup_schedule": "daily",
    "backup_time": "03:00",
    "backup_keep": 7,
    #: Largest single attachment in MB (NOTES-10): 100 from the start.
    "upload_max_mb": 100,
    #: The storage limit every new account starts with, in bytes (Bauplan E44); None: none. An account's own limit is
    #: set under Accounts › Manage; changing this changes no account that exists.
    "new_account_storage_limit": None,
    #: How long the history of a note is kept, in days: a year from the start (NOTES-15).
    "history_days": 365,
    #: How long deleted notes stay in the trash, in days: 90 from the start (NOTES-15).
    "trash_days": 90,
    #: The server fetches title and picture of linked pages (NOTES-10).
    "link_previews": True,
    #: Members may make read links for people without an account (NOTES-13).
    "share_links": True,
    #: Members may make keys for MCP tools, and the tools may ask (NOTES-20).
    "mcp_enabled": True,
    #: Members may make API tokens and programs may ask under ``/api/v1/`` (NOTES-25 AC-5), the nexdeck card too.
    #: On from the start; the MCP switch stays its own.
    "api_enabled": True,
    #: A member's connection (their own nextasks, NOTES-19) may point into the operator's own network (LAN, VPN):
    #: closed from the start, as in nexmail, because then every member can make nexnotes ask an address there.
    "connections_local_network": False,
    #: The languages text recognition reads (NOTES-11).
    "ocr_languages": ["de", "en"],
    #: The address people use to reach nexnotes: invitation and share links, the OIDC redirect. Empty means
    #: ``NEXNOTES_PUBLIC_URL``, and without that the request's own.
    "public_url": "",
    #: Members may sign in with a password. The operator always may: the emergency exit when OIDC fails.
    "password_login": True,
    #: Every account that signs in with a password needs a second factor; until it has one, it reaches only its
    #: account page. Accounts from OIDC bring their provider's.
    "two_factor_required": False,
    #: Ask GitHub once a day whether a newer nexnotes is out (services/updates). Only the question goes out, so on.
    "update_check": True,
    #: Invitation mail: without a host nothing is sent, the link to copy is enough.
    "smtp_host": "",
    "smtp_port": 587,
    #: starttls | tls | none
    "smtp_security": "starttls",
    "smtp_user": "",
    "smtp_password_enc": "",
    "smtp_from": "",
    #: The name the system mail goes out under; empty: "nexnotes" (the shared post module).
    "smtp_sender_name": "",
    #: The last mail that went out, the last error and when (the operator's mail card; the shared post module).
    "mail_last_ok_at": "",
    "mail_last_error": "",
    "mail_last_error_at": "",
    #: Passkeys may be added and used to sign in (the shared account module, part 2): on from the start.
    "passkeys_allowed": True,
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        values[row.key] = row.value
    return values


def save(db: Session, changes: dict[str, Any], *, commit: bool = True) -> None:
    for key, value in changes.items():
        if key not in DEFAULTS:
            raise KeyError(key)
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    if commit:
        db.commit()
    else:
        db.flush()


def normalize_public_url(value: str) -> str:
    """``scheme://host[:port]`` and nothing else, or empty. ``ValueError`` for anything people could not type into
    a browser: no other schemes, no credentials, no path, no query, nothing the shared sign-in module refuses."""
    text = value.strip()
    if not text:
        return ""
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("scheme or host")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("path, query or credentials")
    try:
        parts.port  # noqa: B018 - raises ValueError when the port is not a number
    except ValueError as exc:
        raise ValueError("port") from exc
    # Never more than the sign-in module takes (the host's letters, at most 199 characters): what it refuses is no
    # address here either, or the authentik card and the sign-in would disagree about it.
    return flow.clean_public_url(f"{parts.scheme.lower()}://{parts.netloc}")


def public_url(db: Session) -> str:
    """The public address without a trailing slash: the setting, otherwise the environment, otherwise empty."""
    stored = str(get(db, "public_url") or "").strip().rstrip("/")
    return stored or get_settings().public_url.strip().rstrip("/")


def upload_max_mb(db: Session) -> int:
    """The largest attachment in MB, as the operator set it; read at every upload, so a change counts at once."""
    return max(1, int(get(db, "upload_max_mb") or 1))


def history_days(db: Session) -> int:
    return int(get(db, "history_days") or 365)


def trash_days(db: Session) -> int:
    return int(get(db, "trash_days") or 90)


def new_account_storage_limit(db: Session) -> int | None:
    """The limit a new account starts with (E44), bytes or None."""
    value = get(db, "new_account_storage_limit")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None
