"""MCP over HTTP (``POST /api/mcp``, NOTES-20), since the shared module mcp (``vendor/nexmcp`` 1.1.0) the module's
endpoint, OAuth for programs, rights per tool, requests that wait for their account, and the operator's settings,
mounted here over nexnotes' tables (``services/mcp_store.py``) with nexnotes' tools (``services/mcp.py``).

The answers of before stay: an ``Origin`` 403 ``origin_refused``, MCP switched off 403 ``mcp_off``, 20 wrong keys per
sender, then 429; no valid key 401 ``key_invalid`` with ``WWW-Authenticate`` naming where to sign in; 240 calls a
minute per key; a body up to 4 MB. Keys are made and revoked in ``routers/connections.py`` (and the older
``routers/tokens.py``); the account's pages of the module are under ``/api/connections/mcp``.

The consent (``GET``/``POST /api/oauth/authorize``) and the token endpoint are nexnotes' thin wrappers in
``routers/oauth.py``; the module's routes of the same path and method are left out here.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute

from ..db import SessionLocal
from ..deps import client_ip, require_account, require_operator
from ..errors import detail
from ..services import settings_service
from ..services.mcp import CONFIG
from ..vendor.nexmcp import McpRefused
from ..vendor.nexmcp import api as mcp_api
from .oauth import OWN, mcp_store


def _address(request: Request) -> str:
    """Where programs reach nexnotes: the public address, else the one of this request."""
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: McpRefused) -> Exception:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.code, refusal.message, **values))


router = mcp_api.router(
    config=CONFIG,
    store=mcp_store,
    account=require_account,
    operator=require_operator,
    address=_address,
    sender=client_ip,
    error=_error,
    tags=["mcp"],
)
# nexnotes' own wrappers serve these (``routers/oauth.py``).
router.routes[:] = [
    route for route in router.routes
    if not (isinstance(route, APIRoute) and any((route.path, method) in OWN for method in route.methods))
]
