"""API tokens in the interface (NOTES-25), the ways of before the shared key module (schluessel 1.0.0), in their old
shapes; making, revoking and blocking go through the module now (``routers/connections.py`` has its own ways).

A member's list under Settings, Connections, making one (shown once),
revoking one; and the operator's overview of every token with "Sperren" (AC-27).

The list holds the API tokens and the older MCP and card keys, each with where it counts (AC-2, AC-3); connectors
(programs that signed in with OAuth, NOTES-20 AC-7) come apart as "Verbundene KI-Werkzeuge". Only API tokens are made
now: the older kinds stay valid as they are but no new ones come (AC-3). Neither list ever holds a token or its hash,
and the operator's never a title or a text.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Path, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..models import TOKEN_API, TOKEN_DEVICE, ApiToken, utcnow
from ..models import Account as AccountRow
from ..services import apiaccess, apitokens, mcp
from ..services.schluessel_store import CONFIG, KeyStore
from ..vendor.nexschluessel import keys
from ..vendor.nexschluessel.errors import KeyRefused
from . import oauth

logger = logging.getLogger("nexnotes.api")

router = APIRouter(tags=["tokens"])

TokenId = Annotated[int, Path(ge=1, le=2**62)]


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(pattern="^(read|write)$")
    #: "Auch für KI-Werkzeuge (MCP)", off from the start.
    mcp: bool = False
    #: "Nur diese Ordner …": the folders' ids (``inbox`` for the inbox); left out or null for all notes.
    folders: list[Annotated[str, Field(max_length=36)]] | None = Field(default=None, max_length=apitokens.MAX_FOLDERS)
    #: 30, 90 or 365 days, or null for never; 90 when left out.
    days: int | None = apitokens.DEFAULT_DAYS


@router.get("/api/tokens", summary="The account's API tokens, older keys and connected programs")
def listing(account: Account, db: DbSession, request: Request) -> dict[str, Any]:
    """Which keys and switches: the shared key module's (``keys.listing``); each key in the shape of before."""
    now = utcnow()
    found = keys.listing(KeyStore(db), CONFIG, account.id, now)
    rows = {row.id: row for row in db.scalars(select(ApiToken).where(
        ApiToken.id.in_([entry["id"] for entry in found["keys"]])))} if found["keys"] else {}
    # Oldest first, as before; the module lists newest first.
    listed = sorted((rows[entry["id"]] for entry in found["keys"] if entry["id"] in rows), key=lambda row: row.id)
    return {
        "allowed": bool(found["api"]),
        "mcp_allowed": bool(found["mcp"]),
        "address": oauth.base_url(request, db),
        "max_tokens": apitokens.MAX_TOKENS,
        "tokens": [apitokens.token_out(row, now) for row in listed if not row.client_id],
        "connectors": [apitokens.token_out(row, now) for row in listed if row.client_id],
    }


@router.post("/api/tokens", status_code=201, summary="A new API token; the token itself is shown this once")
def make(body: TokenIn, account: Account, db: DbSession) -> dict[str, Any]:
    if not apiaccess.enabled(db):
        raise error("api_off", "The operator has switched the API off.", 403)
    name = " ".join(body.name.split())
    if not name:
        raise error("invalid_input", "The input is not valid.", 422, fields=["name"])
    if body.days not in apitokens.EXPIRY_DAYS:
        raise error("invalid_input", "The input is not valid.", 422, fields=["days"])
    if body.mcp and not mcp.allowed(db):
        raise error("mcp_off", "The operator has switched MCP off.", 403)
    folders = None
    if body.folders is not None:
        folders = apiaccess.valid_folders(db, account, body.folders)
        if not folders:
            raise error("invalid_input", "The input is not valid.", 422, fields=["folders"])
    # Made by the shared key module (schluessel 1.0.0) over the same table: the same prefix, hash and columns.
    try:
        # retired: this older way still sets "also for AI tools" as before (MCP decision 12, schluessel 1.1.0).
        made = keys.make(KeyStore(db), CONFIG, account.id, kind="api", name=name, right=body.level,
                         areas=folders, options={"mcp": body.mcp}, days=body.days, retired=True)
    except KeyRefused as exc:
        values = {key: value for key, value in exc.as_dict().items() if key not in ("code", "message")}
        raise error(exc.public_code, exc.message, exc.status, **values) from exc
    row = db.get(ApiToken, made.key.id)
    assert row is not None
    if folders is not None and row.folder_ids != folders:
        # This way kept the folders in the order chosen (the module keeps the account's order): the same folders.
        row.folder_ids = folders
        db.commit()
    token = made.secret
    logger.info("API token made token_id=%s level=%s mcp=%s folders=%s", row.id, row.level, bool(row.allow_mcp),
                len(folders or []))
    return {"made": apitokens.token_out(row), "token": token}


@router.delete("/api/tokens/{token_id}", status_code=204, summary="Revoke a token or a connected program at once")
def revoke(token_id: TokenId, account: Account, db: DbSession) -> Response:
    row = db.get(ApiToken, token_id)
    if row is None or row.account_id != account.id or row.kind == TOKEN_DEVICE:
        raise error("not_found", "Not found.", 404)
    kind = row.kind
    keys.revoke(KeyStore(db), CONFIG, account.id, token_id)
    logger.info("Token revoked token_id=%s kind=%s", token_id, kind)
    return Response(status_code=204)


# --- The operator (AC-27) -------------------------------------------------------------------------------------------


@router.get("/api/admin/tokens", summary="Every token of every account: who, name, right, last use; never contents")
def every(_operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    """Which keys: the shared key module's overview (``keys.overview``); each in the shape of before."""
    seen = [entry["id"] for entry in keys.overview(KeyStore(db), CONFIG)]
    found = {row.id: row for row in db.scalars(select(ApiToken).where(ApiToken.id.in_(seen)))} if seen else {}
    rows = [found[key_id] for key_id in seen if key_id in found]
    owners = {row.id: row for row in db.scalars(select(AccountRow).where(
        AccountRow.id.in_({row.account_id for row in rows})))} if rows else {}
    now = utcnow()
    out = []
    for row in rows:
        entry = apitokens.token_out(row, now)
        # The operator learns how many folders, never which (their names are the member's).
        entry["folders"] = len(row.folder_ids or []) if row.kind == TOKEN_API else 0
        entry.pop("prefix", None)
        owner = owners.get(row.account_id)
        entry["account"] = {"id": row.account_id,
                            "name": (owner.display_name or owner.name) if owner is not None else ""}
        out.append(entry)
    return {"tokens": out}


@router.post("/api/admin/tokens/{token_id}/block", status_code=204,
             summary="Block a token: its next request is turned away")
def block(token_id: TokenId, operator: OperatorAccount, db: DbSession) -> Response:
    row = db.get(ApiToken, token_id)
    if row is None or row.kind == TOKEN_DEVICE:
        raise error("not_found", "Not found.", 404)
    keys.block(KeyStore(db), CONFIG, token_id)
    logger.warning("Token blocked by the operator token_id=%s account_id=%s by=%s", row.id, row.account_id,
                   operator.name)
    return Response(status_code=204)
