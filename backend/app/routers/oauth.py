"""Signing in for MCP with OAuth (NOTES-20 AC-7), so that AI programs add nexnotes as a connector.

A connector finds its way from the 401 of ``/api/mcp``: the protected resource metadata (RFC 9728) names nexnotes as
its own authorization server (RFC 8414), the connector registers itself (RFC 7591) and sends its person to the consent
page ``/oauth/authorize`` with PKCE (S256). The member signs in as always, chooses "read only" or "read and write", and
the code the program gets is traded for tokens once.

What comes out is an MCP key like one made by hand (a row of ``api_tokens`` with ``kind = mcp`` and its ``client_id``):
it acts as its account, shows in the member's list under Connections and is revoked there. Its access token runs out
after an hour and is refreshed with a refresh token that changes every time; any of its last spent ones, or its code,
brought again ends the connector. Nothing secret is stored: only SHA-256 of codes and tokens.

Only public clients with PKCE; return addresses only over HTTPS or to the own machine. Everything here is off while
the operator has MCP switched off (``mcp_enabled``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import secrets
import threading
import time
from collections import deque
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..db import SessionLocal
from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..models import TOKEN_MCP, ApiToken, utcnow
from ..models import Account as AccountRow
from ..models_mcp import OAuthClient, OAuthCode, OAuthSpent
from ..security import account_out, brake
from ..services import apitokens, mcp, settings_service, totp

logger = logging.getLogger("nexnotes.oauth")

router = APIRouter(tags=["oauth"])

CODE_MINUTES = 10
ACCESS_HOURS = 1
REFRESH_PREFIX = "nnr_"
#: A connector signs in again after this long, and after ``IDLE_DAYS`` without a refresh.
REFRESH_DAYS = 90
IDLE_DAYS = 30
#: Spent codes and refresh tokens remembered per connector, to know a copy when it is brought again.
SPENT_KEPT = 20
#: Registered clients kept at most; the ones used longest ago go first.
MAX_CLIENTS = 500
#: Registrations per minute for the whole server (registering needs no account), and per sender in an hour.
REGISTER_PER_MINUTE = 30
REGISTER_PER_SENDER = 10
LOOPBACK = ("localhost", "127.0.0.1", "[::1]")


def _open(db: Any) -> bool:
    return mcp.allowed(db)


def base_url(request: Request, db: Any) -> str:
    return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _oauth_error(code: str, text: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": code, "error_description": text}, status_code=status,
                        headers={"Cache-Control": "no-store"})


def _not_found() -> JSONResponse:
    return JSONResponse({"detail": {"code": "not_found", "message": "Not found."}}, status_code=404)


# --- Discovery ----------------------------------------------------------------------------------------------------


def _resource_metadata(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return _not_found()
        base = base_url(request, db)
    return JSONResponse(headers={"Cache-Control": "no-store"}, content={
        "resource": f"{base}/api/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["mcp"],
        "resource_name": "nexnotes",
    })


@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
def resource_metadata(request: Request) -> JSONResponse:
    return _resource_metadata(request)


@router.get("/.well-known/oauth-protected-resource/api/mcp", include_in_schema=False)
def resource_metadata_for_mcp(request: Request) -> JSONResponse:
    return _resource_metadata(request)


@router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
def server_metadata(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return _not_found()
        base = base_url(request, db)
    return JSONResponse(headers={"Cache-Control": "no-store"}, content={
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/api/oauth/token",
        "registration_endpoint": f"{base}/api/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
        "authorization_response_iss_parameter_supported": True,
    })


def challenge_header(request: Request) -> str:
    """What the 401 of /api/mcp says, so that a connector finds where to sign in."""
    with SessionLocal() as db:
        if not _open(db):
            return "Bearer"
        base = base_url(request, db)
    return f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource"'


# --- Registration -------------------------------------------------------------------------------------------------

_registered: deque[float] = deque()
_registered_lock = threading.Lock()


def _may_register(now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    with _registered_lock:
        while _registered and now - _registered[0] > 60:
            _registered.popleft()
        if len(_registered) >= REGISTER_PER_MINUTE:
            return False
        _registered.append(now)
        return True


def forget() -> None:
    with _registered_lock:
        _registered.clear()


def valid_redirect(uri: Any) -> bool:
    """HTTPS anywhere, or plain HTTP to the own machine; never a fragment, never a user in the address."""
    if not isinstance(uri, str) or len(uri) > 2048 or any(ord(char) < 33 for char in uri):
        return False
    try:
        parts = urlsplit(uri)
        hostname, _port = parts.hostname, parts.port
    except ValueError:
        return False
    if parts.fragment or parts.username or parts.password or not hostname:
        return False
    if not re.fullmatch(r"[a-z0-9.-]+|[0-9a-f:.]+", hostname):
        return False
    if parts.scheme == "https":
        return True
    host = parts.netloc.rsplit("@", 1)[-1].lower()
    host = host if host.startswith("[") else host.split(":")[0]
    if host.startswith("[::1]"):
        host = "[::1]"
    return parts.scheme == "http" and host in LOOPBACK


@router.post("/api/oauth/register", include_in_schema=False)
async def register(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return _oauth_error("access_denied", "MCP is switched off here.", 403)
    raw = await request.body()
    if len(raw) > 64 * 1024:
        return _oauth_error("invalid_client_metadata", "The body is too large.")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return _oauth_error("invalid_client_metadata", "The body must be JSON.")
    if not isinstance(body, dict):
        return _oauth_error("invalid_client_metadata", "The body must be a JSON object.")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not 1 <= len(uris) <= 10 or not all(valid_redirect(uri) for uri in uris):
        return _oauth_error("invalid_redirect_uri", "Give 1 to 10 redirect addresses: https, or http to localhost.")
    if body.get("token_endpoint_auth_method", "none") != "none":
        return _oauth_error("invalid_client_metadata", "Only public clients with PKCE sign in here.")
    sender = "oauth-register:" + client_ip(request)
    if brake.wait_seconds(sender, REGISTER_PER_SENDER) or not _may_register():
        return _oauth_error("temporarily_unavailable", "Too many registrations. Try again later.", 429)
    brake.failed(sender)
    name = body.get("client_name") if isinstance(body.get("client_name"), str) else ""
    name = " ".join(name.split())[:100] or "MCP client"
    client = OAuthClient(id="nno_" + secrets.token_urlsafe(24), name=name, redirect_uris=list(uris),
                         created_at=utcnow())
    with SessionLocal() as db:
        db.add(client)
        db.commit()
        count = len(db.scalars(select(OAuthClient.id)).all())
        if count > MAX_CLIENTS:
            # The ones used longest ago (never used first) make room; not one from the last hour: its person may be
            # on the consent page right now. Their keys stay until revoked.
            oldest = db.scalars(
                select(OAuthClient.id)
                .where(OAuthClient.created_at < utcnow() - timedelta(hours=1))
                .order_by(OAuthClient.last_used_at.is_not(None), OAuthClient.last_used_at, OAuthClient.created_at)
                .limit(count - MAX_CLIENTS)
            ).all()
            db.execute(delete(OAuthClient).where(OAuthClient.id.in_(oldest)))
            db.commit()
    logger.info("OAuth client registered redirects=%s", len(uris))
    return JSONResponse({
        "client_id": client.id,
        "client_name": name,
        "redirect_uris": list(uris),
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_id_issued_at": int(time.time()),
    }, status_code=201)


# --- Consent (the page /oauth/authorize asks these) -----------------------------------------------------------------


def _client(db: Any, client_id: str, redirect_uri: str) -> OAuthClient:
    client = db.get(OAuthClient, client_id)
    if client is None:
        raise error("oauth_client", "This program is not registered here.", 400)
    if redirect_uri not in (client.redirect_uris or []):
        # Never send anybody to an address the program did not register: that is how codes are stolen.
        raise error("oauth_redirect", "This return address is not registered for the program.", 400)
    return client


def _check_challenge(challenge: str, method: str) -> None:
    if method != "S256" or not 43 <= len(challenge) <= 128 or not all(
        char.isalnum() or char in "-._~" for char in challenge
    ):
        raise error("oauth_pkce", "The program must use PKCE with S256.", 400)


@router.get("/api/oauth/authorize", summary="What a program asks to sign in for")
def consent_info(
    account: Account,
    db: DbSession,
    client_id: str = Query(max_length=64),
    redirect_uri: str = Query(max_length=2048),
    code_challenge: str = Query(max_length=128),
    code_challenge_method: str = Query("plain", max_length=8),
    response_type: str = Query("code", max_length=16),
) -> dict[str, Any]:
    if not _open(db):
        raise error("mcp_off", "The operator has switched MCP off.", 403)
    if response_type != "code":
        raise error("oauth_response_type", "Only response_type=code is spoken here.", 400)
    client = _client(db, client_id, redirect_uri)
    _check_challenge(code_challenge, code_challenge_method)
    return {"client_name": client.name, "redirect_host": urlsplit(redirect_uri).netloc}


class ConsentIn(BaseModel):
    client_id: str = Field(max_length=64)
    redirect_uri: str = Field(max_length=2048)
    code_challenge: str = Field(max_length=128)
    code_challenge_method: str = Field(max_length=8)
    state: str = Field(default="", max_length=1024)
    approve: bool
    level: str = Field(default="read", pattern="^(read|write)$")


def _back(redirect_uri: str, values: dict[str, str]) -> str:
    joiner = "&" if "?" in redirect_uri else "?"
    return redirect_uri + joiner + urlencode({key: value for key, value in values.items() if value})


@router.post("/api/oauth/authorize", summary="Agree to a program's sign-in, or turn it down")
def consent(body: ConsentIn, request: Request, account: Account, db: DbSession) -> dict[str, str]:
    if not _open(db):
        raise error("mcp_off", "The operator has switched MCP off.", 403)
    _client(db, body.client_id, body.redirect_uri)
    _check_challenge(body.code_challenge, body.code_challenge_method)
    issuer = base_url(request, db)
    if not body.approve:
        logger.info("OAuth sign-in declined")
        return {"redirect": _back(body.redirect_uri, {"error": "access_denied", "state": body.state, "iss": issuer})}
    code = secrets.token_urlsafe(32)
    db.add(OAuthCode(code_hash=apitokens.digest(code), client_id=body.client_id, account_id=account.id,
                     redirect_uri=body.redirect_uri, challenge=body.code_challenge, level=body.level,
                     expires_at=utcnow() + timedelta(minutes=CODE_MINUTES)))
    db.execute(delete(OAuthCode).where(OAuthCode.expires_at <= utcnow()))
    db.commit()
    logger.info("OAuth sign-in agreed level=%s", body.level)
    return {"redirect": _back(body.redirect_uri, {"code": code, "state": body.state, "iss": issuer})}


# --- Tokens -------------------------------------------------------------------------------------------------------


def _account_may(db: Any, account_id: int) -> bool:
    """No new tokens for an account that is blocked, gone, or still owes the second factor the operator requires."""
    account = db.get(AccountRow, account_id)
    if account is None or account_out(account):
        return False
    return not totp.setup_required(db, account)


def _verifier_fits(verifier: str, challenge: str) -> bool:
    if not 43 <= len(verifier) <= 128:
        return False
    made = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii", "replace")).digest()).rstrip(b"=")
    return secrets.compare_digest(made.decode(), challenge)


def _spend(db: Any, key: ApiToken, token_hash: str) -> None:
    """Remembers a code or refresh token traded in for ``key``; only the last ``SPENT_KEPT``."""
    db.merge(OAuthSpent(token_hash=token_hash, key_id=key.id, spent_at=utcnow()))
    db.flush()
    kept = select(OAuthSpent.token_hash).where(OAuthSpent.key_id == key.id).order_by(
        OAuthSpent.spent_at.desc(), OAuthSpent.token_hash).limit(SPENT_KEPT)
    db.execute(delete(OAuthSpent).where(OAuthSpent.key_id == key.id, OAuthSpent.token_hash.not_in(kept)))


def _spent_key(db: Any, token_hash: str, client_id: str) -> ApiToken | None:
    """The connector a spent code or refresh token belonged to, if it is still there."""
    spent = db.get(OAuthSpent, token_hash)
    key = db.get(ApiToken, spent.key_id) if spent is not None else None
    if key is None:
        # Keys refreshed before ``oauth_spent`` came still know the refresh token before their last one.
        key = db.scalar(select(ApiToken).where(ApiToken.refresh_old_hash == token_hash))
    if key is None or key.client_id != client_id or key.kind != TOKEN_MCP:
        return None
    return key


def _end(db: Any, key: ApiToken, what: str) -> None:
    key_id = key.id
    db.delete(key)
    db.commit()
    logger.warning("OAuth %s used twice, connector ended key_id=%s", what, key_id)


def _issue(db: Any, key: ApiToken, spent: str) -> dict[str, Any]:
    access = apitokens.PREFIXES[TOKEN_MCP] + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    key.token_hash = apitokens.digest(access)
    key.prefix = access[: len(apitokens.PREFIXES[TOKEN_MCP]) + 4]
    key.refresh_old_hash = None
    key.refresh_hash = apitokens.digest(refresh)
    db.flush()
    _spend(db, key, spent)
    key.expires_at = utcnow() + timedelta(hours=ACCESS_HOURS)
    db.commit()
    return {"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_HOURS * 3600,
            "refresh_token": refresh, "scope": "mcp"}


async def _form(request: Request) -> dict[str, str]:
    raw = (await request.body())[: 64 * 1024].decode("utf-8", "replace")
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            found = json.loads(raw)
        except (ValueError, RecursionError):
            return {}
        return {key: str(value) for key, value in found.items()} if isinstance(found, dict) else {}
    return {key: values[0] for key, values in parse_qs(raw, keep_blank_values=True).items()}


@router.post("/api/oauth/token", include_in_schema=False)
async def token(request: Request) -> JSONResponse:
    form = await _form(request)
    grant = form.get("grant_type", "")
    client_id = form.get("client_id", "")[:64]
    with SessionLocal() as db:
        if not _open(db):
            return _oauth_error("access_denied", "MCP is switched off here.", 403)
        client = db.get(OAuthClient, client_id) if client_id else None
        if client is None:
            return _oauth_error("invalid_client", "Unknown client.", 401)
        if grant == "authorization_code":
            code_hash = apitokens.digest(form.get("code", ""))
            row = db.get(OAuthCode, code_hash)
            # Taken away first: a code is traded once, even when two requests bring it at the same moment.
            gone = db.execute(delete(OAuthCode).where(OAuthCode.code_hash == code_hash)).rowcount
            db.commit()
            if row is None and gone == 0:
                # A code traded in already: whoever brings it again has a copy. What it gave ends (RFC 6749, 4.1.2).
                used = _spent_key(db, code_hash, client.id)
                if used is not None:
                    _end(db, used, "code")
                return _oauth_error("invalid_grant", "The code is not valid (any more).")
            if (
                row is None or gone != 1 or row.expires_at <= utcnow() or row.client_id != client.id
                or row.redirect_uri != form.get("redirect_uri", "")
                or not _verifier_fits(form.get("code_verifier", ""), row.challenge)
            ):
                return _oauth_error("invalid_grant", "The code is not valid (any more).")
            if not _account_may(db, row.account_id):
                return _oauth_error("invalid_grant", "The account may not sign in now.")
            key = db.scalar(select(ApiToken).where(ApiToken.account_id == row.account_id, ApiToken.kind == TOKEN_MCP,
                                                   ApiToken.client_id == client.id))
            if key is None:
                if mcp.count_keys(db, row.account_id) >= mcp.MAX_KEYS:
                    return _oauth_error("invalid_grant", f"The account holds {mcp.MAX_KEYS} keys already. "
                                                         "Revoke one first.")
                key = ApiToken(account_id=row.account_id, kind=TOKEN_MCP, name=client.name, level=row.level,
                               client_id=client.id, token_hash="", prefix="", created_at=utcnow())
                db.add(key)
            else:
                key.level = row.level
            key.signed_in_at = utcnow()
            key.refresh_hash = None
            client.last_used_at = utcnow()
            answer = _issue(db, key, code_hash)
            logger.info("OAuth tokens issued key_id=%s", key.id)
            return JSONResponse(answer, headers={"Cache-Control": "no-store"})
        if grant == "refresh_token":
            brought = apitokens.digest(form.get("refresh_token", ""))
            key = db.scalar(select(ApiToken).where(ApiToken.refresh_hash == brought, ApiToken.client_id == client.id,
                                                   ApiToken.kind == TOKEN_MCP))
            if key is None:
                # A refresh token traded in already, however many changes ago: whoever brings it has a copy. The
                # whole connector ends, for the thief and the program alike; its member signs it in again
                # (OAuth 2.1, section 4.3.1).
                used = _spent_key(db, brought, client.id)
                if used is not None:
                    _end(db, used, "refresh token")
                return _oauth_error("invalid_grant", "The refresh token is not valid (any more).")
            now = utcnow()
            started = key.signed_in_at or key.created_at
            idle_since = key.expires_at or started
            if now - started > timedelta(days=REFRESH_DAYS) or now - idle_since > timedelta(days=IDLE_DAYS):
                return _oauth_error("invalid_grant", "The connector has to sign in again.")
            if not _account_may(db, key.account_id):
                return _oauth_error("invalid_grant", "The account may not sign in now.")
            client.last_used_at = utcnow()
            answer = _issue(db, key, brought)
            logger.info("OAuth tokens refreshed key_id=%s", key.id)
            return JSONResponse(answer, headers={"Cache-Control": "no-store"})
    return _oauth_error("unsupported_grant_type", "Only authorization_code and refresh_token.")
