"""Tokens of programs and devices: a paired iPhone or iPad, an API token (NOTES-25), and the kinds from before it, a key
for MCP tools (NOTES-20) and a key for a nexdeck card (NOTES-21).

The features that hand them out (device pairing, API tokens, OAuth connectors) make them with ``make``; the routes
check them on every request. A token acts as its account and never sees more. The token itself is shown once; only its
SHA-256 is stored, with its first characters to tell tokens apart. It travels in ``Authorization: Bearer``, never in an
address, and never reaches the log.

A blocked or deleted account's tokens count for nothing at once, and a block removes them for good: a device of a
blocked account is turned away whatever it sends. A token the operator blocked (``blocked_at``, NOTES-25 AC-27) stays
in the member's list, says so, and opens nothing.

The older kinds are never rewritten: an MCP key stays a key for ``/api/mcp``, a card key one for the card's routes
(NOTES-25 AC-3). No new ones are made; only connectors (OAuth) still are MCP keys.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import TOKEN_API, TOKEN_DASHBOARD, TOKEN_DEVICE, TOKEN_MCP, Account, ApiToken, utcnow
from ..security import account_out

logger = logging.getLogger("nexnotes.api")

KINDS = (TOKEN_DEVICE, TOKEN_MCP, TOKEN_DASHBOARD, TOKEN_API)
LEVELS = ("read", "write")
PREFIXES = {TOKEN_DEVICE: "nnd_", TOKEN_MCP: "nn_mcp_", TOKEN_DASHBOARD: "nn_deck_", TOKEN_API: "nn_api_"}
#: ``last_used_at`` is written at most this often.
USED_EVERY = timedelta(minutes=1)
#: API tokens an account may hold, the older MCP and card keys counted with them (NOTES-25 EC-11). Devices and
#: connectors do not count.
MAX_TOKENS = 20
#: The choices of "Ablauf" (AC-1), in days; ``None`` is "Nie". 90 is chosen from the start.
EXPIRY_DAYS = (30, 90, 365, None)
DEFAULT_DAYS = 90
#: Folders one token may be limited to.
MAX_FOLDERS = 100


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make(db: Session, account: Account, name: str, *, kind: str = TOKEN_DEVICE, level: str = "write",
         days: int | None = None, allow_mcp: bool = False, folder_ids: list[str] | None = None,
         ) -> tuple[ApiToken, str]:
    """A new token; the token itself is returned once and never stored."""
    if kind not in KINDS or level not in LEVELS:
        raise ValueError("unknown kind or level")
    token = PREFIXES[kind] + secrets.token_urlsafe(32)
    row = ApiToken(
        account_id=account.id, kind=kind, name=name.strip()[:100] or kind, level=level, token_hash=digest(token),
        prefix=token[: len(PREFIXES[kind]) + 4],
        expires_at=utcnow() + timedelta(days=days) if days else None,
        allow_mcp=bool(allow_mcp) if kind == TOKEN_API else False,
        folder_ids=list(folder_ids) if kind == TOKEN_API and folder_ids else None,
    )
    db.add(row)
    db.commit()
    # The token's number only: never a piece of the secret (NOTES-25 AC-24).
    logger.info("Token made account=%s kind=%s token_id=%s", account.name, kind, row.id)
    return row, token


def authenticate(db: Session, token: str | None, kinds: tuple[str, ...] = KINDS) -> tuple[Account, ApiToken] | None:
    """The account and the token behind a bearer token, or None: unknown, of another kind than ``kinds``, run out,
    blocked by the operator, or its account blocked or deleted. Each route names the kinds it takes: an MCP key at
    ``/api/mcp`` only, a card key at the card's routes only (NOTES-20, NOTES-21, NOTES-25 AC-3)."""
    if not token or len(token) > 200:
        return None
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == digest(token)))
    if row is None or row.kind not in kinds or row.blocked_at is not None:
        return None
    now = utcnow()
    if row.expires_at is not None and row.expires_at <= now:
        return None
    account = db.get(Account, row.account_id)
    if account is None or account_out(account):
        return None
    if row.last_used_at is None or now - row.last_used_at > USED_EVERY:
        row.last_used_at = now
        db.commit()
    return account, row


def revoke_all(db: Session, account_id: int) -> int:
    """Every token of the account goes (a block or a delete). Its paired devices are told why when they call next
    (``account_blocked``, NOTES-24 EC-5)."""
    from .devices import remember_blocked

    remember_blocked(db, account_id)
    result = db.execute(delete(ApiToken).where(ApiToken.account_id == account_id))
    db.commit()
    return int(getattr(result, "rowcount", 0) or 0)


# --- The list of a member (NOTES-25 AC-2) ---------------------------------------------------------------------------


def _counted() -> Any:
    """API tokens and the older keys made by hand: what the limit of ``MAX_TOKENS`` counts."""
    return ((ApiToken.kind == TOKEN_API) | (ApiToken.kind == TOKEN_DASHBOARD)
            | ((ApiToken.kind == TOKEN_MCP) & ApiToken.client_id.is_(None)))


def tokens_of(db: Session, account_id: int) -> list[ApiToken]:
    return list(db.scalars(select(ApiToken).where(ApiToken.account_id == account_id, _counted())
                           .order_by(ApiToken.id)))


def connectors_of(db: Session, account_id: int) -> list[ApiToken]:
    """Programs that signed in with OAuth ("Verbundene KI-Werkzeuge")."""
    return list(db.scalars(select(ApiToken).where(ApiToken.account_id == account_id, ApiToken.kind == TOKEN_MCP,
                                                  ApiToken.client_id.is_not(None)).order_by(ApiToken.id)))


def count_tokens(db: Session, account_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(ApiToken)
                         .where(ApiToken.account_id == account_id, _counted())) or 0)


def every_token(db: Session) -> list[ApiToken]:
    """Every token of every account but devices: the operator's overview (AC-27)."""
    return list(db.scalars(select(ApiToken).where(ApiToken.kind != TOKEN_DEVICE)
                           .order_by(ApiToken.account_id, ApiToken.id)))


def access_of(row: ApiToken) -> list[str]:
    """Where a token counts: ``api``, ``mcp``, ``card`` (the card's routes only, an older card key)."""
    if row.kind == TOKEN_API:
        return ["api", "mcp"] if row.allow_mcp else ["api"]
    if row.kind == TOKEN_DASHBOARD:
        return ["card"]
    return ["mcp"]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def token_out(row: ApiToken, now: datetime | None = None) -> dict[str, Any]:
    """A token as the list shows it: never the token, never its hash."""
    now = now or utcnow()
    legacy = None
    if row.kind == TOKEN_MCP and not row.client_id:
        legacy = "mcp"
    elif row.kind == TOKEN_DASHBOARD:
        legacy = "card"
    folders = list(row.folder_ids or []) if row.kind == TOKEN_API else []
    return {
        "id": row.id,
        "name": row.name,
        "kind": "connector" if row.client_id else row.kind,
        "legacy": legacy,
        "level": row.level,
        "access": access_of(row),
        "folders": folders or None,
        "prefix": row.prefix,
        "created_at": _iso(row.created_at),
        "last_used_at": _iso(row.last_used_at),
        "expires_at": _iso(row.expires_at),
        "expired": row.expires_at is not None and row.expires_at <= now,
        "blocked": row.blocked_at is not None,
    }
