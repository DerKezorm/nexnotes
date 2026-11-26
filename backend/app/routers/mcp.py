"""MCP over HTTP (``POST /api/mcp``, NOTES-20), since the shared module mcp (``vendor/nexmcp`` 1.1.2) the module's
endpoint, OAuth for programs, rights per tool, requests that wait for their account, and the operator's settings,
mounted here over nexnotes' tables (``services/mcp_store.py``) with nexnotes' tools (``services/mcp.py``).

The answers of before stay: an ``Origin`` 403 ``origin_refused``, MCP switched off 403 ``mcp_off``, 20 wrong keys per
sender, then 429; no valid key 401 ``key_invalid`` with ``WWW-Authenticate`` naming where to sign in; 240 calls a
minute per key; a body up to 4 MB. Keys are made and revoked in ``routers/connections.py`` (and the older
``routers/tokens.py``); the account's pages of the module are under ``/api/connections/mcp``.

Every route of OAuth is the module's too (since mcp 1.1.2 with the consent's checks, ``approve``, ``client_name`` and
nexnotes' answers while MCP is off, ``CONFIG.oauth_off_*``); ``routers/oauth.py`` keeps the store and the address.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import client_ip, require_account, require_operator
from ..errors import detail
from ..services import notify, settings_service
from ..services.mcp import CONFIG
from ..vendor.nexmcp import McpRefused
from ..vendor.nexmcp import api as mcp_api
from .oauth import mcp_store


def _address(request: Request) -> str:
    """Where programs reach nexnotes: the public address, else the one of this request."""
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: McpRefused) -> Exception:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.code, refusal.message, **values))


router = mcp_api.router(
    # Looked up at each call, so a test can listen (``tests/nexmcp_adapter.py``).
    notify=lambda event, request: notify.mcp_event(event, request),
    config=CONFIG,
    store=mcp_store,
    account=require_account,
    operator=require_operator,
    address=_address,
    sender=client_ip,
    error=_error,
    tags=["mcp"],
)
