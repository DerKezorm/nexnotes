"""MCP over HTTP (``POST /api/mcp``, NOTES-20), since the shared module mcp (``vendor/nexmcp`` 1.1.1) the module's
endpoint, OAuth for programs, rights per tool, requests that wait for their account, and the operator's settings,
mounted here over nexnotes' tables (``services/mcp_store.py``) with nexnotes' tools (``services/mcp.py``).

The answers of before stay: an ``Origin`` 403 ``origin_refused``, MCP switched off 403 ``mcp_off``, 20 wrong keys per
sender, then 429; no valid key 401 ``key_invalid`` with ``WWW-Authenticate`` naming where to sign in; 240 calls a
minute per key; a body up to 4 MB. Keys are made and revoked in ``routers/connections.py`` (and the older
``routers/tokens.py``); the account's pages of the module are under ``/api/connections/mcp``.

The consent (``GET``/``POST /api/oauth/authorize``) is nexnotes' thin wrapper in ``routers/oauth.py`` (``approve`` of
the page of before, ``client_name``); the module's routes of the same path and method are left out here.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from ..db import SessionLocal
from ..deps import client_ip, require_account, require_operator
from ..errors import detail
from ..services import notify, settings_service
from ..services.mcp import CONFIG
from ..vendor.nexmcp import McpRefused
from ..vendor.nexmcp import api as mcp_api
from .oauth import OWN, Store, mcp_store


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
#: The module's registration, behind nexnotes' answer of before (below).
_register = next(route.endpoint for route in router.routes
                 if isinstance(route, APIRoute) and route.path == "/api/oauth/register")
# nexnotes' own wrappers serve these (``routers/oauth.py`` and the registration below).
router.routes[:] = [
    route for route in router.routes
    if not (isinstance(route, APIRoute)
            and any((route.path, method) in OWN | {("/api/oauth/register", "POST")} for method in route.methods))
]


@router.post("/api/oauth/register", include_in_schema=False)
async def register(request: Request, data: Store) -> JSONResponse:
    """E55: while MCP is switched off, registering answers as before, 403 ``access_denied`` (the module: 404 for every
    way of OAuth); otherwise the module's registration, also its 404 for the operator's newer switch "programs"."""
    if not data.mcp_on():
        return JSONResponse({"error": "access_denied", "error_description": "MCP is switched off here."},
                            status_code=403, headers={"Cache-Control": "no-store"})
    return await _register(request, data)
