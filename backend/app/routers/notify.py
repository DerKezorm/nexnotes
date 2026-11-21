"""Notifications over HTTP (NOTES-14, ``services/notify.py``): the switch at a note or a folder with the member's
devices and a preview (AC-1, AC-8), the browser's own sign-up for Web Push (AC-7), and its word that it shows a note
right now (AC-9).

A browser's sign-up belongs to the session it is made in, so these ways take the session cookie only, never a token.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..config import get_settings
from ..deps import Account, DbSession, _bearer
from ..errors import error
from ..models import AuthSession
from ..security import SESSION_COOKIE, hash_token
from ..services import notify, webpush


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    notify.register()
    stop = asyncio.Event()
    ticker = None if get_settings().disable_background else asyncio.create_task(notify.run_forever(stop))
    try:
        yield
    finally:
        stop.set()
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        # What waits in ``notify_edits`` and ``notify_outbox`` goes out at the first tick after the next start.


router = APIRouter(prefix="/api/notify", tags=["notifications"], lifespan=lifespan)


def _session_id(request: Request, db: DbSession, *, required: bool = False) -> int | None:
    """The browser session of the request; ``None`` for a token (a device, a program)."""
    if _bearer(request):
        if required:
            raise error("browser_only", "Only a browser can do this.", 403)
        return None
    cookie = request.cookies.get(SESSION_COOKIE)
    found = db.scalar(select(AuthSession.id).where(AuthSession.token_hash == hash_token(cookie))) if cookie else None
    if found is None and required:
        raise error("sign_in_required", "Sign in first.", 401)
    return found


class SwitchIn(BaseModel):
    on: bool


class KeysIn(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=webpush.MAX_ENDPOINT)
    keys: KeysIn


class ViewingIn(BaseModel):
    note_id: str | None = Field(default=None, max_length=36)


@router.get("/note/{note_id}")
def note_settings(note_id: str, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return notify.note_settings(db, account, note_id, _session_id(request, db))


@router.put("/note/{note_id}")
def set_note(note_id: str, body: SwitchIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return notify.set_note(db, account, note_id, body.on, _session_id(request, db))


@router.get("/folder/{folder_id}")
def folder_settings(folder_id: str, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return notify.folder_settings(db, account, folder_id, _session_id(request, db))


@router.put("/folder/{folder_id}")
def set_folder(folder_id: str, body: SwitchIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return notify.set_folder(db, account, folder_id, body.on, _session_id(request, db))


@router.get("/webpush")
def webpush_state(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """The server's public key for ``pushManager.subscribe`` and whether this browser is signed up."""
    session_id = _session_id(request, db)
    row = webpush.of_session(db, session_id) if session_id is not None else None
    return {"key": webpush.public_key(db), "subscribed": row is not None and row.account_id == account.id}


@router.put("/webpush", status_code=204)
def subscribe(body: SubscriptionIn, request: Request, account: Account, db: DbSession) -> None:
    """This browser allowed notifications (AC-7): from now on they come here too, until it signs out."""
    session_id = _session_id(request, db, required=True)
    assert session_id is not None
    endpoint = body.endpoint.strip()
    if not webpush.endpoint_valid(endpoint):
        raise error("webpush_endpoint", "This is not the address of a push service.", 422, fields=["endpoint"])
    if not webpush.valid_keys(body.keys.p256dh, body.keys.auth):
        raise error("webpush_keys", "The browser's keys are not usable.", 422, fields=["keys"])
    webpush.subscribe(db, account.id, session_id, endpoint, body.keys.p256dh, body.keys.auth,
                      request.headers.get("user-agent", ""))


@router.delete("/webpush", status_code=204)
def unsubscribe(request: Request, account: Account, db: DbSession) -> None:
    session_id = _session_id(request, db, required=True)
    assert session_id is not None
    webpush.unsubscribe(db, account.id, session_id)


@router.put("/viewing", status_code=204)
def viewing(body: ViewingIn, request: Request, account: Account, db: DbSession) -> None:
    """This browser shows ``note_id`` in view right now, or none (AC-9). Said again while it lasts."""
    session_id = _session_id(request, db, required=True)
    assert session_id is not None
    notify.viewing(session_id, body.note_id or None)
