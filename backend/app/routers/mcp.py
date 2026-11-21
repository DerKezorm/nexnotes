"""MCP over HTTP (``POST /api/mcp``, NOTES-20) and the MCP keys of an account.

The protocol is JSON-RPC 2.0 as MCP's "Streamable HTTP" transport has it, without streams: every request gets its
answer as ``application/json``, a notification gets 202. No session is kept; each request names its key in
``Authorization: Bearer``.

Walls, in this order:

1. A request that carries an ``Origin`` is refused (EC-4). Browsers send one, MCP clients do not: no web page can talk
   to this with a key it guessed or stole, and DNS rebinding goes nowhere. The session cookie counts for nothing here.
2. The operator's switch (``mcp_enabled``, AC-8).
3. A valid MCP key of an account that may sign in (EC-5); wrong keys count per sender like wrong passwords.
4. The key's rate (EC-2).
5. The size of the body and the shape of the arguments.

The tools are in ``services/mcp.py``.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .. import __version__
from ..db import SessionLocal
from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..models import TOKEN_MCP, ApiToken
from ..security import brake as sign_in_brake
from ..services import apitokens, logs, mcp
from ..services.mcp import Caller, ToolError
from . import oauth

logger = logging.getLogger("nexnotes.mcp")

router = APIRouter(tags=["mcp"])

#: Protocol versions this server speaks, newest first.
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
#: The largest request body: a note's Markdown at its limit, escaped as JSON, fits.
MAX_BODY = 4 * 1024 * 1024
#: Wrong keys one sender may bring before it waits (``security.brake``): a key cannot be guessed, but trying costs.
FREE_WRONG_KEYS = 20


def _error(message_id: Any, code: int, text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": text}}


def _tool_result(value: Any, failed: bool = False) -> dict[str, Any]:
    value = jsonable_encoder(value)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": failed}
    if not failed and isinstance(value, dict):
        result["structuredContent"] = value
    return result


async def call_tool(caller: Caller, name: Any, args: Any) -> dict[str, Any]:
    tool = mcp.BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None or not caller.may(tool.level):
        # A tool above the key's level is as unknown as one that does not exist.
        return _tool_result(f"No tool called {str(name)[:100]!r}.", failed=True)
    if not isinstance(args, dict):
        return _tool_result("'arguments' must be an object.", failed=True)
    problem = mcp.check_arguments(tool.schema, args)
    if problem:
        return _tool_result(problem, failed=True)
    logger.info("MCP tool called tool=%s key_id=%s", tool.name, caller.key_id)
    try:
        return _tool_result(await tool.run(caller, dict(args)))
    except ToolError as exc:
        return _tool_result(str(exc), failed=True)
    except HTTPException as exc:
        found = exc.detail if isinstance(exc.detail, dict) else {}
        text = "Not found." if exc.status_code == 404 else str(found.get("message") or "Not possible.")
        return _tool_result(text, failed=True)


async def handle(message: Any, caller: Caller) -> dict[str, Any] | None:
    """One JSON-RPC message: its answer, or None for a notification."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid request.")
    method = message["method"]
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if "id" not in message:
        return None
    message_id = message["id"]
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {"jsonrpc": "2.0", "id": message_id, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "nexnotes", "version": __version__},
            "instructions": mcp.INSTRUCTIONS,
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": message_id,
                "result": {"tools": [mcp.listed(tool) for tool in mcp.tools_for(caller)]}}
    if method == "tools/call":
        return {"jsonrpc": "2.0", "id": message_id,
                "result": await call_tool(caller, params.get("name"), params.get("arguments", {}))}
    return _error(message_id, -32601, "Method not found.")


def _refuse(status: int, code: str, text: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"detail": {"code": code, "message": text}}, status_code=status, headers=headers)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


@router.post("/api/mcp", summary="MCP (JSON-RPC over HTTP) with a key in Authorization: Bearer")
async def endpoint(request: Request) -> Response:
    if request.headers.get("origin"):
        return _refuse(403, "origin_refused", "MCP is not for web pages.")
    asked = request.headers.get("mcp-protocol-version")
    if asked is not None and asked not in PROTOCOL_VERSIONS:
        return _refuse(400, "protocol_version", "This MCP protocol version is not spoken here.")
    sender = "mcp:" + client_ip(request)
    with SessionLocal() as db:
        if not mcp.allowed(db):
            return _refuse(403, "mcp_off", "The operator has switched MCP off.")
        wait = sign_in_brake.wait_seconds(sender, FREE_WRONG_KEYS)
        if wait:
            return _refuse(429, "too_many_attempts", "Too many wrong keys. Try again later.",
                           {"Retry-After": str(wait)})
        caller = mcp.authenticate(db, _bearer(request))
    if caller is None:
        sign_in_brake.failed(sender)
        # A connector learns from this where to sign in (OAuth, routers/oauth.py).
        return _refuse(401, "key_invalid", "No valid key.", {"WWW-Authenticate": oauth.challenge_header(request)})
    if not mcp.brake(caller.key_id):
        return _refuse(429, "slow_down", "Too many requests with this key. Wait a minute.", {"Retry-After": "60"})
    logs.set_actor(caller.account.name)
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY):
        return _refuse(413, "too_large", "The request is too large.")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            return _refuse(413, "too_large", "The request is too large.")
    try:
        message = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        # RecursionError: JSON nested deeper than Python's stack, sent to break the server.
        return JSONResponse(_error(None, -32700, "Parse error."), status_code=400)
    answer = await handle(message, caller)
    if answer is None:
        return Response(status_code=202)
    return JSONResponse(answer)


@router.get("/api/mcp", include_in_schema=False)
def no_stream() -> Response:
    # No server-sent stream: every answer comes with its request.
    return Response(status_code=405, headers={"Allow": "POST"})


# --- Keys, through the interface ----------------------------------------------------------------------------------


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(pattern="^(read|write)$")


@router.get("/api/mcp/keys", summary="The account's MCP keys and connectors (name, right, last use)")
def keys(account: Account, db: DbSession, request: Request) -> dict[str, Any]:
    return {"allowed": mcp.allowed(db), "address": oauth.base_url(request, db) + "/api/mcp",
            "max_keys": mcp.MAX_KEYS, "keys": [mcp.key_out(row) for row in mcp.keys_of(db, account.id)]}


@router.post("/api/mcp/keys", status_code=201, summary="A new MCP key; the key itself is shown this once")
def make_key(body: KeyIn, account: Account, db: DbSession) -> dict[str, Any]:
    if not mcp.allowed(db):
        raise error("mcp_off", "The operator has switched MCP off.", 403)
    name = " ".join(body.name.split())
    if not name:
        raise error("invalid_input", "The input is not valid.", 422, fields=["name"])
    if mcp.count_keys(db, account.id) >= mcp.MAX_KEYS:
        raise error("mcp_too_many_keys", f"An account holds at most {mcp.MAX_KEYS} MCP keys.", 409,
                    max=mcp.MAX_KEYS)
    row, token = apitokens.make(db, account, name, kind=TOKEN_MCP, level=body.level)
    logger.info("MCP key made key_id=%s level=%s", row.id, row.level)
    return {"key": mcp.key_out(row), "token": token}


@router.delete("/api/mcp/keys/{key_id}", status_code=204, summary="Revoke an MCP key: it stops at once")
def revoke_key(key_id: Annotated[int, Path(ge=1, le=2**62)], account: Account, db: DbSession) -> Response:
    row = db.get(ApiToken, key_id)
    if row is None or row.account_id != account.id or row.kind != TOKEN_MCP:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()
    logger.info("MCP key revoked key_id=%s", key_id)
    return Response(status_code=204)

