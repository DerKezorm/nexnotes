"""Tokens of programs and devices: a paired iPhone or iPad, or a key for MCP tools.

The features that hand them out (device pairing, MCP keys) make them with ``make``; this frame checks them on every
request (``deps.require_account``). A token acts as its account and never sees more. The token itself is shown once;
only its SHA-256 is stored, with its first characters to tell tokens apart. It travels in ``Authorization: Bearer``,
never in an address, and never reaches the log.

A blocked or deleted account's tokens count for nothing at once, and a block removes them for good: a device of a
blocked account is turned away whatever it sends.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import TOKEN_DEVICE, TOKEN_MCP, Account, ApiToken, utcnow
from ..security import account_out

logger = logging.getLogger("nexnotes.api")

KINDS = (TOKEN_DEVICE, TOKEN_MCP)
LEVELS = ("read", "write")
PREFIXES = {TOKEN_DEVICE: "nnd_", TOKEN_MCP: "nn_mcp_"}
#: ``last_used_at`` is written at most this often.
USED_EVERY = timedelta(minutes=1)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make(db: Session, account: Account, name: str, *, kind: str = TOKEN_DEVICE, level: str = "write",
         days: int | None = None) -> tuple[ApiToken, str]:
    """A new token; the token itself is returned once and never stored."""
    if kind not in KINDS or level not in LEVELS:
        raise ValueError("unknown kind or level")
    token = PREFIXES[kind] + secrets.token_urlsafe(32)
    row = ApiToken(
        account_id=account.id, kind=kind, name=name.strip()[:100] or kind, level=level, token_hash=digest(token),
        prefix=token[: len(PREFIXES[kind]) + 4],
        expires_at=utcnow() + timedelta(days=days) if days else None,
    )
    db.add(row)
    db.commit()
    logger.info("Token made account=%s kind=%s prefix=%s", account.name, kind, row.prefix)
    return row, token


def authenticate(db: Session, token: str | None, kinds: tuple[str, ...] = KINDS) -> tuple[Account, ApiToken] | None:
    """The account and the token behind a bearer token, or None: unknown, of another kind than ``kinds``, run out, or
    its account blocked or deleted. An MCP key counts at ``/api/mcp`` only: the other routes would let a key that may
    only read write through them (NOTES-20)."""
    if not token or len(token) > 200:
        return None
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == digest(token)))
    if row is None or row.kind not in kinds:
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
    """Every token of the account goes (a block or a delete)."""
    result = db.execute(delete(ApiToken).where(ApiToken.account_id == account_id))
    db.commit()
    return int(getattr(result, "rowcount", 0) or 0)
