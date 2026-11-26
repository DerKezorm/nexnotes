"""Signing in for MCP with OAuth (NOTES-20 AC-7), since the shared module mcp (``vendor/nexmcp``) the module's flow:
metadata, registration, consent, tokens, revocation (``routers/mcp.py`` mounts its routes). The paths stay where
connected programs know them (``/api/oauth/register``, ``/authorize``, ``/token``; the page ``/oauth/authorize``).

Three of them are nexnotes' own thin wrappers over the module's functions, so that nothing of before changes:

- ``POST /api/oauth/authorize`` keeps its body ``ConsentIn`` with its name in the API description (E53), takes the
  answer as ``approve`` (the page of before) or ``allow`` (the module's page), and only adds the module's fields;
- ``GET /api/oauth/authorize`` answers the module's view and ``client_name`` as before;
- ``POST /api/oauth/token`` still reads a JSON body as well as a form, as nexnotes did
  (TODO mcp 1.1.0, einst-fragen/nexnotes-module.md 2 and 3).
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import detail
from ..services import settings_service
from ..services.mcp import CONFIG
from ..services.mcp_store import McpStore
from ..vendor.nexmcp import McpRefused, OAuthError
from ..vendor.nexmcp import api as mcp_api
from ..vendor.nexmcp import oauth as mcp_oauth
from ..vendor.nexmcp.brake import BRAKE

router = APIRouter(tags=["oauth"])

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
#: The largest body of the token endpoint, as before.
MAX_FORM = 64 * 1024


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


def refused(refusal: McpRefused) -> HTTPException:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.code, refusal.message, **values))


# --- Consent (the page /oauth/authorize asks these) -----------------------------------------------------------------


@router.get("/api/oauth/authorize", summary="What a program asks to sign in for")
def consent_info(
    request: Request,
    account: Account,
    data: Store,
    client_id: Annotated[str, Query(max_length=200)] = "",
    redirect_uri: Annotated[str, Query(max_length=2048)] = "",
    response_type: Annotated[str, Query(max_length=40)] = "code",
    code_challenge: Annotated[str, Query(max_length=200)] = "",
    code_challenge_method: Annotated[str, Query(max_length=20)] = "",
    state: Annotated[str, Query(max_length=1000)] = "",
    resource: Annotated[str, Query(max_length=2048)] = "",
) -> dict[str, Any]:
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": response_type,
              "code_challenge": code_challenge, "code_challenge_method": code_challenge_method, "state": state,
              "resource": resource}
    try:
        shown = mcp_oauth.consent_info(data, CONFIG, account.id, params, base_url(request, data.db))
    except McpRefused as refusal:
        raise refused(refusal) from None
    # The name as the page of before read it.
    return {**shown, "client_name": shown["client"]["name"]}


class ConsentIn(BaseModel):
    client_id: str = Field(max_length=200)
    redirect_uri: str = Field(max_length=2048)
    code_challenge: str = Field(max_length=200)
    code_challenge_method: str = Field(max_length=20)
    state: str = Field(default="", max_length=1024)
    #: The page of before answered ``approve``; the module's page answers ``allow``.
    approve: bool | None = None
    allow: bool | None = None
    level: str = Field(default="read", pattern="^(read|write)$")
    response_type: str = Field(default="code", max_length=40)
    #: The folders the program may reach; left out: all (module mcp).
    areas: list[Annotated[str, Field(max_length=36)]] | None = Field(default=None, max_length=1000)
    #: Extras of the key (nexnotes has none).
    options: dict[str, bool] | None = None
    #: The address the program asked for (RFC 8707).
    resource: str = Field(default="", max_length=2048)


@router.post("/api/oauth/authorize", summary="Agree to a program's sign-in, or turn it down")
def consent(body: ConsentIn, request: Request, account: Account, data: Store) -> dict[str, str]:
    answer = body.model_dump(exclude={"approve"})
    answer["allow"] = bool(body.allow if body.allow is not None else body.approve)
    try:
        redirect = mcp_oauth.consent(data, CONFIG, account.id, answer, base_url(request, data.db),
                                     mcp_api._now())
    except McpRefused as refusal:
        data.rollback()
        raise refused(refusal) from None
    return {"redirect": redirect}


# --- Tokens -------------------------------------------------------------------------------------------------------


async def _form(request: Request) -> dict[str, str]:
    """A form as RFC 6749 asks, or a JSON object, as nexnotes took it before the module."""
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_FORM:
            raise OAuthError("invalid_request", "The request is too large.", 413)
    text = raw.decode("utf-8", "replace")
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            found = json.loads(text)
        except (ValueError, RecursionError):
            return {}
        return {key: str(value) for key, value in found.items()} if isinstance(found, dict) else {}
    return {key: values[0] for key, values in parse_qs(text, keep_blank_values=True).items()}


@router.post("/api/oauth/token", include_in_schema=False)
async def token(request: Request, data: Store) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
    try:
        form = await _form(request)
        answer = mcp_oauth.token(data, CONFIG, form, base_url(request, data.db), mcp_api._now())
    except OAuthError as refusal:
        return JSONResponse(refusal.as_dict(), status_code=refusal.status, headers=headers)
    return JSONResponse(answer, headers=headers)


#: The routes of this file stand in for the module's under the same path and method (``routers/mcp.py``).
OWN = {("/api/oauth/authorize", "GET"), ("/api/oauth/authorize", "POST"), ("/api/oauth/token", "POST")}
