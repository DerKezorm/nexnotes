"""The API a nexdeck card reads (NOTES-21), as the other apps of the family offer it: ``/api/v1/…`` with a key in
``Authorization: Bearer``, errors as ``{"detail": {"code", "message"}}``; and the keys for it in the interface.

Walls, in this order:

1. A request that carries an ``Origin`` is refused: the API is for programs, not web pages.
2. A valid key of the kind ``dashboard`` of an account that may sign in (``token_invalid``); wrong keys count per
   sender like wrong passwords (``too_many_attempts``).
3. The key's rate (``slow_down``).
4. Ticking needs a key that may write (``token_reads_only``, EC-3) and a member who may write the note.

The data is in ``services/dashboard.py``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import __version__
from ..db import SessionLocal
from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..models import TOKEN_DASHBOARD, ApiToken
from ..notedoc import doc as notedoc
from ..notedoc import edit
from ..notedoc.room import Access
from ..security import brake as sign_in_brake
from ..services import apitokens, dashboard, history, logs, notes
from ..services.dashboard import Caller, CardRefused
from . import oauth

logger = logging.getLogger("nexnotes.dashboard")

router = APIRouter(tags=["dashboard"])

#: Wrong keys one sender may bring before it waits.
FREE_WRONG_KEYS = 20
#: What ``/me`` names, for a program to ask before it uses something.
FEATURES = ["pinned", "notes", "check"]

_REFUSED = {
    "not_found": (404, "This note is not there, or not shared with you any more."),
    "note_trashed": (410, "This note is in the trash."),
    "note_locked": (409, "This note is locked."),
}


def _refuse(status: int, code: str, text: str, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": text}, headers=headers)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def card_caller(request: Request) -> Caller:
    if request.headers.get("origin"):
        raise _refuse(403, "origin_refused", "This API is for programs, not web pages.")
    sender = "deck:" + client_ip(request)
    wait = sign_in_brake.wait_seconds(sender, FREE_WRONG_KEYS)
    if wait:
        raise _refuse(429, "too_many_attempts", "Too many wrong keys. Try again later.", {"Retry-After": str(wait)})
    with SessionLocal() as db:
        caller = dashboard.authenticate(db, _bearer(request))
    if caller is None:
        sign_in_brake.failed(sender)
        raise _refuse(401, "token_invalid", "No valid key.")
    if not dashboard.brake(caller.key_id):
        raise _refuse(429, "slow_down", "Too many requests with this key. Wait a minute.", {"Retry-After": "60"})
    logs.set_actor(caller.account.name)
    return caller


CardCaller = Annotated[Caller, Depends(card_caller)]
NoteId = Annotated[str, Path(min_length=1, max_length=36)]


def _base(request: Request) -> str:
    with SessionLocal() as db:
        return oauth.base_url(request, db)


@router.get("/api/v1/me", summary="Who the key reads as, its level, what this nexnotes offers")
def me(caller: CardCaller) -> dict[str, Any]:
    account = caller.account
    return {"app": "nexnotes", "name": account.name, "display_name": account.display_name or account.name,
            "level": caller.level, "version": __version__, "features": FEATURES}


@router.get("/api/v1/dashboard", summary="The pinned notes for a card: title, first line, progress")
def pinned(caller: CardCaller, request: Request,
           limit: Annotated[int, Query(ge=1, le=dashboard.MAX_PINNED)] = 12) -> JSONResponse:
    base = _base(request)
    with SessionLocal() as db:
        return JSONResponse(dashboard.pinned(db, caller.account, base, limit))


@router.get("/api/v1/notes", summary="The notes a card may show, for its setting")
def choice(caller: CardCaller, q: Annotated[str, Query(max_length=200)] = "",
           limit: Annotated[int, Query(ge=1, le=dashboard.MAX_CHOICE)] = 50) -> dict[str, Any]:
    with SessionLocal() as db:
        return {"notes": dashboard.choice(db, caller.account, q, limit)}


def _card_note(caller: Caller, note_id: str) -> tuple[Any, Access, str]:
    with SessionLocal() as db:
        try:
            note, access = dashboard.note_for_card(db, caller.account, note_id)
        except CardRefused as exc:
            status, text = _REFUSED[exc.code]
            raise _refuse(status, exc.code, text) from exc
        stamp = dashboard.stamp_of(note)
        db.expunge(note)
        return note, access, stamp


async def _read(note_id: str) -> tuple[str, list[edit.Task], str]:
    try:
        return await notes.change(note_id, dashboard.read_doc)
    except HTTPException as exc:
        if exc.status_code == 409:
            raise _refuse(409, "note_locked", _REFUSED["note_locked"][1]) from exc
        raise
    except notedoc.FormatError as exc:
        raise _refuse(409, "note_format", "This note is in a format this server cannot read.") from exc


@router.get("/api/v1/notes/{note_id}", summary="One note for a card: its checklist items, or its first lines")
async def card(note_id: NoteId, caller: CardCaller, request: Request) -> dict[str, Any]:
    note, access, stamp = await asyncio.to_thread(_card_note, caller, note_id)
    base = await asyncio.to_thread(_base, request)
    return dashboard.card_of(note, access, caller, base, await _read(note.id), stamp)


class CheckIn(BaseModel):
    checked: bool = True
    #: The item's text as the card showed it: a different item at that place by now is left alone.
    text: str | None = Field(default=None, max_length=4000)


@router.post("/api/v1/notes/{note_id}/items/{index}", summary="Tick a checklist item off, or open it again")
async def check(note_id: NoteId, index: Annotated[int, Path(ge=0, le=1_000_000)], body: CheckIn,
                caller: CardCaller, request: Request) -> dict[str, Any]:
    if not caller.writes:
        raise _refuse(403, "token_reads_only", "This key may only read.")
    note, access, _stamp = await asyncio.to_thread(_card_note, caller, note_id)
    if access != Access.WRITE:
        raise _refuse(403, "not_allowed", "This note is shared with you to read only.")

    def toggle(doc: Any) -> bool | None:
        try:
            return edit.toggle_task(doc, index, body.checked, expect=body.text)
        except edit.TaskNotFound:
            return None

    try:
        with history.acting_via(caller.label):
            done = await notes.change(note.id, toggle, account_id=caller.account.id)
    except HTTPException as exc:
        if exc.status_code == 409:
            raise _refuse(409, "note_locked", _REFUSED["note_locked"][1]) from exc
        raise
    except notedoc.FormatError as exc:
        raise _refuse(409, "note_format", "This note is in a format this server cannot change.") from exc
    if done is None:
        raise _refuse(409, "item_changed", "This item is not there any more, or it says something else now.")
    logger.info("Card ticked note=%s index=%s key_id=%s", note.id, index, caller.key_id)
    note, access, stamp = await asyncio.to_thread(_card_note, caller, note.id)
    base = await asyncio.to_thread(_base, request)
    return dashboard.card_of(note, access, caller, base, await _read(note.id), stamp)


# --- Keys, through the interface ------------------------------------------------------------------------------------


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(pattern="^(read|write)$")


@router.get("/api/dashboard/keys", summary="The account's keys for nexdeck (name, right, last use)")
def keys(account: Account, db: DbSession, request: Request) -> dict[str, Any]:
    return {"address": oauth.base_url(request, db), "max_keys": dashboard.MAX_KEYS,
            "keys": [dashboard.key_out(row) for row in dashboard.keys_of(db, account.id)]}


@router.post("/api/dashboard/keys", status_code=201, summary="A new key for nexdeck; the key itself is shown this once")
def make_key(body: KeyIn, account: Account, db: DbSession) -> dict[str, Any]:
    name = " ".join(body.name.split())
    if not name:
        raise error("invalid_input", "The input is not valid.", 422, fields=["name"])
    if dashboard.count_keys(db, account.id) >= dashboard.MAX_KEYS:
        raise error("dashboard_too_many_keys", f"An account holds at most {dashboard.MAX_KEYS} keys for nexdeck.",
                    409, max=dashboard.MAX_KEYS)
    row, token = apitokens.make(db, account, name, kind=TOKEN_DASHBOARD, level=body.level)
    logger.info("Key for nexdeck made key_id=%s level=%s", row.id, row.level)
    return {"key": dashboard.key_out(row), "token": token}


@router.delete("/api/dashboard/keys/{key_id}", status_code=204, summary="Revoke a key for nexdeck: it stops at once")
def revoke_key(key_id: Annotated[int, Path(ge=1, le=2**62)], account: Account, db: DbSession) -> Response:
    row = db.get(ApiToken, key_id)
    if row is None or row.account_id != account.id or row.kind != TOKEN_DASHBOARD:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()
    logger.info("Key for nexdeck revoked key_id=%s", key_id)
    return Response(status_code=204)
