"""Signing in for MCP with OAuth (NOTES-20 AC-7): since the shared module mcp (``vendor/nexmcp`` 1.1.2) every route is
the module's (metadata, registration, consent, tokens, revocation; ``routers/mcp.py`` mounts them). The paths stay
where connected programs know them (``/api/oauth/register``, ``/authorize``, ``/token``; the page ``/oauth/authorize``).
What nexnotes answered before, the module gives over ``services/mcp.CONFIG``: the consent's checks, ``approve`` of the
page of before and ``client_name`` (M-13, M-14), and while MCP is off 403 ``mcp_off`` on the consent and 403
``access_denied`` on registering (``oauth_off_status``, ``oauth_off_code``, E55).

Left here: the names of before for the tests and the places that read them, the address of nexnotes, the module's
store over a request's session.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Request

from ..deps import DbSession
from ..services import settings_service
from ..services.mcp import CONFIG
from ..services.mcp_store import McpStore
from ..vendor.nexmcp.brake import BRAKE

#: Names of before, for the tests and the places that read them.
SPENT_KEPT = CONFIG.spent_kept
CODE_MINUTES = CONFIG.code_minutes
ACCESS_HOURS = CONFIG.access_hours
REFRESH_PREFIX = CONFIG.refresh_prefix
REFRESH_DAYS = CONFIG.refresh_days
IDLE_DAYS = CONFIG.idle_days
MAX_CLIENTS = CONFIG.max_clients
REGISTER_PER_MINUTE = CONFIG.register_per_minute
REGISTER_PER_SENDER = CONFIG.register_per_sender


def forget() -> None:
    """For tests: the module's brakes forget the registrations they counted."""
    BRAKE.forget()


def base_url(request: Request, db: Any) -> str:
    """Where nexnotes is reached: the public address, else the one of this request."""
    return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def mcp_store(db: DbSession) -> McpStore:
    """The module's store over this request's session."""
    return McpStore(db)


Store = Annotated[McpStore, Depends(mcp_store)]
