"""nexnotes' side of the shared key module ``vendor/nexschluessel`` (plan "Einstellungen", Verbindungen 5 and 6,
Allgemein › Schnittstellen, Konten › API-Schlüssel aller Konten): its ``AppConfig`` and the ``Store`` over the table
``api_tokens``, as NOTES-25 and NOTES-20 wrote it.

⚠️ **No row moves, no key is hashed anew.** Every key nexnotes ever handed out stays valid with its prefix, hash,
right, folders and extra: API tokens ``nn_api_`` (kind ``api``), the older nexdeck card keys ``nn_deck_`` (kind
``dashboard``, a legacy form of an API key, still only for the card's routes), MCP keys made by hand ``nn_mcp_``
(kind ``mcp`` without a client, no longer made) and the keys AI tools got by OAuth (kind ``mcp`` with a client: the
module's programs). Paired devices (``nnd_``, kind ``device``) live in the same table and are never keys of the
module. The check of a key on use stays nexnotes' own (``services/apiaccess``: folders with their subfolders, read or
write, the second factor the operator requires); the OAuth flow stays in ``routers/oauth.py``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FOLDER_INBOX, TOKEN_API, TOKEN_DASHBOARD, TOKEN_DEVICE, TOKEN_MCP, Account, ApiToken, Folder
from ..security import account_out
from ..vendor.nexschluessel import ALL_AREAS, AppConfig, Area, Holder, Key, KeyChange, KeyKind, NewKey
from . import settings_service

logger = logging.getLogger("nexnotes.api")

#: nexnotes' keys as the module knows them (the module's proposal, checked against ``services/apitokens``: prefixes,
#: rights, the lifetimes 30/90/365/never with 90 at the start, 20 per account with the older keys made by hand
#: counted, folders, the extra "also for AI tools", the switches ``api_enabled``/``mcp_enabled``, the old code
#: ``tokens_too_many``).
CONFIG = AppConfig(
    app_name="nexnotes",
    kinds=(
        # API tokens; the old card keys of nexdeck (kind "dashboard") stay valid as a legacy form of them.
        KeyKind(
            id="api", prefix="nn_api_", accepted=("nn_deck_",), options=("mcp",), areas=True, counted_with=("mcp",)
        ),
        # MCP keys made by hand before NOTES-25: still valid, no longer made; connectors of AI tools are programs.
        KeyKind(id="mcp", prefix="nn_mcp_", creatable=False, editable=False, switch="mcp"),
    ),
    switches=("api", "mcp"),
    programs=True,
    mcp_path="/api/mcp",
    error_codes={"too_many_keys": "tokens_too_many"},
)

#: The operator's switches under nexnotes' names (both on from the start).
SWITCHES = {"api": "api_enabled", "mcp": "mcp_enabled"}
#: The inbox in the list of folders a key may be limited to, in the account's language.
INBOX_NAMES = {"de": "Eingang", "en": "Inbox"}


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _kind_of(row: ApiToken) -> str:
    return "mcp" if row.kind == TOKEN_MCP else "api"


class KeyStore:
    """``nexschluessel.Store`` over ``api_tokens``, inside one session (one request)."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- reading -------------------------------------------------------------------------------------------------
    @staticmethod
    def _key(row: ApiToken) -> Key:
        api = row.kind in (TOKEN_API, TOKEN_DASHBOARD)
        return Key(
            id=row.id,
            account_id=row.account_id,
            kind=_kind_of(row),
            name=row.name,
            right=row.level if row.level in ("read", "write") else "read",
            prefix=row.prefix,
            created_at=_aware(row.created_at),
            last_used_at=_aware(row.last_used_at),
            expires_at=_aware(row.expires_at),
            blocked_at=_aware(row.blocked_at),
            areas=list(row.folder_ids) if row.kind == TOKEN_API and row.folder_ids is not None else None,
            options={"mcp": bool(row.allow_mcp)} if row.kind == TOKEN_API else ({"mcp": False} if api else {}),
            legacy="card" if row.kind == TOKEN_DASHBOARD else None,
            program=row.kind == TOKEN_MCP and bool(row.client_id),
        )

    def _rows(self):  # type: ignore[no-untyped-def]
        return select(ApiToken).where(ApiToken.kind != TOKEN_DEVICE)

    def keys_of(self, account_id: int | str) -> list[Key]:
        rows = self.db.scalars(self._rows().where(ApiToken.account_id == int(account_id)).order_by(ApiToken.id.desc()))
        return [self._key(row) for row in rows]

    def all_keys(self) -> list[Key]:
        rows = self.db.scalars(self._rows().order_by(ApiToken.account_id, ApiToken.id))
        return [self._key(row) for row in rows]

    def _row(self, key_id: int | str) -> ApiToken | None:
        try:
            row = self.db.get(ApiToken, int(key_id))
        except (TypeError, ValueError):
            return None
        return row if row is not None and row.kind != TOKEN_DEVICE else None

    def key(self, key_id: int | str) -> Key | None:
        row = self._row(key_id)
        return self._key(row) if row is not None else None

    def key_by_hash(self, token_hash: str) -> Key | None:
        row = self.db.scalar(self._rows().where(ApiToken.token_hash == token_hash))
        return self._key(row) if row is not None else None

    # --- writing -------------------------------------------------------------------------------------------------
    def add_key(self, new: NewKey) -> Key:
        """As ``apitokens.make`` wrote an API token (only API tokens are made: MCP keys are not ``creatable``)."""
        row = ApiToken(
            account_id=int(new.account_id),
            kind=TOKEN_API,
            name=new.name,
            level=new.right,
            token_hash=new.token_hash,
            prefix=new.prefix,
            created_at=new.created_at,
            expires_at=new.expires_at,
            allow_mcp=bool(new.options.get("mcp")),
            folder_ids=[str(area) for area in new.areas] if new.areas else None,
        )
        self.db.add(row)
        self.db.flush()
        # The token's number only: never a piece of the secret (NOTES-25 AC-24).
        logger.info("Token made account_id=%s kind=%s token_id=%s", row.account_id, row.kind, row.id)
        return self._key(row)

    def change_key(self, key_id: int | str, change: KeyChange) -> Key:
        row = self._row(key_id)
        if row is None:
            raise LookupError(key_id)
        if change.name is not None:
            row.name = change.name
        if change.right is not None:
            row.level = change.right
        if change.areas is not None:
            row.folder_ids = None if change.areas == ALL_AREAS else [str(area) for area in change.areas]
        if change.options is not None and row.kind == TOKEN_API:
            row.allow_mcp = bool(change.options.get("mcp"))
        self.db.flush()
        return self._key(row)

    def remove_key(self, key_id: int | str) -> None:
        row = self._row(key_id)
        if row is not None:
            self.db.delete(row)
            self.db.flush()

    def set_blocked(self, key_id: int | str, when: datetime | None) -> None:
        row = self._row(key_id)
        if row is not None:
            row.blocked_at = when
            self.db.flush()

    def touch(self, key_id: int | str, when: datetime) -> None:
        row = self._row(key_id)
        if row is not None:
            row.last_used_at = when
            self.db.flush()

    # --- the account ---------------------------------------------------------------------------------------------
    def holder(self, account_id: int | str) -> Holder | None:
        row = self.db.get(Account, int(account_id))
        if row is None:
            return None
        return Holder(id=row.id, name=row.name, display_name=row.display_name or "", out=account_out(row))

    def areas_of(self, account_id: int | str, kind: str) -> list[Area]:
        """The account's own folders that are alive, the inbox first, each below its parent with the path in its name
        (``Work › Projects``): what a key may be limited to (with everything below, ``apiaccess.folder_scope``)."""
        if kind != "api":
            return []
        account = self.db.get(Account, int(account_id))
        if account is None:
            return []
        rows = list(self.db.scalars(
            select(Folder).where(Folder.owner_id == account.id, Folder.deleted_at.is_(None))
            .order_by(Folder.position, Folder.name)
        ))
        inbox = next((row for row in rows if row.kind == FOLDER_INBOX), None)
        known = {row.id for row in rows}
        children: dict[str | None, list[Folder]] = {}
        for row in rows:
            if row.kind == FOLDER_INBOX:
                continue
            parent = row.parent_id if row.parent_id in known else None
            children.setdefault(parent, []).append(row)
        language = (account.language or account.browser_language or "en").split("-")[0].lower()
        found: list[Area] = []
        if inbox is not None:
            found.append(Area(inbox.id, INBOX_NAMES.get(language, INBOX_NAMES["en"])))

        def walk(parent: str | None, path: str) -> None:
            for row in children.get(parent, []):
                name = f"{path} › {row.name}" if path else row.name
                found.append(Area(row.id, name))
                walk(row.id, name)

        walk(None, "")
        return found

    def keys_wait(self, account_id: int | str) -> bool:
        """nexnotes' own rule (``totp.factor_missing``): the operator requires a second factor and this password
        account has none of its own; a provider's check of a session does not count for a key."""
        from . import totp

        account = self.db.get(Account, int(account_id))
        return account is not None and totp.factor_missing(self.db, account)

    def switch(self, name: str) -> bool:
        return bool(settings_service.get(self.db, SWITCHES[name]))

    def set_switch(self, name: str, on: bool) -> None:
        settings_service.save(self.db, {SWITCHES[name]: bool(on)}, commit=False)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()
