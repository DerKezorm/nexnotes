"""Notes over HTTP: made, listed, their head (path, dates, who changed), titles, copies, deleting, and the live
connection ``WS /api/notes/{id}/live`` the editor writes through (``services/notes.py``, ``app/notedoc/room.py``)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, Query, Response, WebSocket
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..models import Note
from ..notedoc.room import CLOSE_FORBIDDEN, CLOSE_GONE, Access
from ..security import SESSION_COOKIE, session_account
from ..services import notes, settings_service, tags, totp

logger = logging.getLogger("nexnotes.notes")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    notes.register()
    notes.rooms()
    try:
        yield
    finally:
        await notes.shutdown()


router = APIRouter(prefix="/api/notes", tags=["notes"], lifespan=lifespan)


# --- Shapes -------------------------------------------------------------------------------------------------------


class NewNote(BaseModel):
    #: The browser's own UUID: the same id twice is the same note (a double click).
    id: str | None = Field(default=None, max_length=36)
    folder_id: str | None = Field(default=None, max_length=36)
    title: str | None = Field(default=None, max_length=1000)
    markdown: str | None = None
    origin: str = Field(default="", max_length=100)
    #: The title is a suggestion (a page's title), not one the member typed: the note gets "Titel prüfen".
    title_suggested: bool = False


class TitleIn(BaseModel):
    title: str = Field(max_length=1000)


class SuggestionIn(BaseModel):
    title: str | None = Field(default=None, max_length=1000)
    #: The person looked at the suggestion and took it ("Take suggestion" when leaving): a title like a typed one, no
    #: "Titel prüfen". Without it (a tab closed, the back button unanswered) nobody looked, and the mark comes.
    confirmed: bool = False


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def item_out(note: Note) -> dict[str, Any]:
    return {
        "id": note.id,
        "folder_id": note.folder_id,
        "title": note.title,
        "title_check": note.title_check,
        "origin": note.origin,
        "preview": notes.preview(note.text),
        "created_at": _iso(note.created_at),
        "updated_at": _iso(note.updated_at),
        # NOTES-6: pinned, its color, the progress of its checklists.
        "pinned": note.pinned_at is not None,
        "color": note.color or "",
        # NOTES-3 AC-18: the symbol before the title, in lists, tiles and tabs too.
        "icon": note.icon or "",
        "tasks": {"done": note.tasks_done or 0, "total": note.tasks_total} if note.tasks_total else None,
    }


def note_out(db: Any, note: Note, account: Any) -> dict[str, Any]:
    access = notes.access_to(db, account, note)
    extras: dict[str, Any] = {}
    for extra in notes.HEAD_EXTRAS:
        extras.update(extra(db, account, note))
    return {
        **item_out(note),
        **extras,
        "path": [notes.folder_out(folder) for folder in notes.folder_path(db, note.folder_id)],
        "updated_by": notes.person(db, note.updated_by_id),
        "owner": notes.person(db, note.owner_id),
        "deleted_at": _iso(note.deleted_at),
        "can_write": access == Access.WRITE or (access == Access.GONE
                                                and notes.right_to(db, account, note) == Access.WRITE),
        # NOTES-3 AC-17: the paper, on every device; the lists do not need it.
        "paper": note.paper or notes.PAPERS[0],
    }


def _out(note_id: str, account: Any) -> dict[str, Any]:
    with SessionLocal() as db:
        return note_out(db, notes.note_for(db, account, note_id, deleted=True), account)


# --- Routes -------------------------------------------------------------------------------------------------------


@router.get("")
def list_notes(db: DbSession, account: Account, folder_id: str | None = Query(default=None, max_length=36)
               ) -> list[dict[str, Any]]:
    # Every note with its tags (NOTES-5), read for the whole list at once.
    return tags.with_tags(db, [item_out(note) for note in notes.list_notes(db, account, folder_id)])


@router.post("", status_code=201)
def create_note(body: NewNote, db: DbSession, account: Account, response: Response) -> dict[str, Any]:
    note, new = notes.create(db, account, note_id=body.id, folder_id=body.folder_id, title=body.title,
                             markdown=body.markdown, origin=body.origin, title_suggested=body.title_suggested)
    if not new:
        response.status_code = 200
    return note_out(db, note, account)


@router.get("/{note_id}")
def get_note(note_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    note = notes.note_for(db, account, note_id, deleted=True)
    return note_out(db, note, account)


class PaperIn(BaseModel):
    paper: str = Field(max_length=8)


@router.put("/{note_id}/paper", summary="The paper of a note: blank, lined, grid or dots (needs the right to write)")
def put_paper(note_id: str, body: PaperIn, db: DbSession, account: Account) -> dict[str, Any]:
    return note_out(db, notes.set_paper(db, account, note_id, body.paper), account)


class IconIn(BaseModel):
    icon: str = Field(max_length=32)


@router.put("/{note_id}/icon", summary="The symbol before a note's title, empty for none (needs the right to write)")
def put_icon(note_id: str, body: IconIn, db: DbSession, account: Account) -> dict[str, Any]:
    return note_out(db, notes.set_icon(db, account, note_id, body.icon), account)


@router.put("/{note_id}/title")
async def put_title(note_id: str, body: TitleIn, account: Account) -> dict[str, Any]:
    await notes.set_title(account, note_id, body.title)
    return _out(note_id, account)


@router.post("/{note_id}/title/suggestion")
async def take_suggestion(note_id: str, body: SuggestionIn, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        notes.note_for(db, account, note_id, write=True)
    await notes.suggest(note_id, body.title, confirmed=body.confirmed)
    return _out(note_id, account)


@router.post("/{note_id}/title/ok")
def title_ok(note_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    note = notes.title_ok(db, account, note_id)
    return note_out(db, note, account)


@router.post("/{note_id}/duplicate", status_code=201)
async def duplicate(note_id: str, account: Account) -> dict[str, Any]:
    copy = await notes.duplicate(account, note_id)
    return _out(copy.id, account)


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: str, account: Account) -> Response:
    await notes.delete_note(account, note_id)
    return Response(status_code=204)


@router.post("/{note_id}/restore")
def restore(note_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    note = notes.restore(db, account, note_id)
    return note_out(db, note, account)


@router.post("/{note_id}/discard")
async def discard(note_id: str, account: Account) -> dict[str, bool]:
    with SessionLocal() as db:
        notes.note_for(db, account, note_id, write=True)
    return {"discarded": await notes.discard_if_empty(note_id)}


# --- Live -----------------------------------------------------------------------------------------------------------


def _origin_ok(socket: WebSocket) -> bool:
    """The page that opens the connection must be nexnotes itself. A WebSocket knows no CORS: without this a page on
    another site could open one with the visitor's cookie. Behind a proxy the host may arrive as
    ``X-Forwarded-Host``."""
    origin = socket.headers.get("origin")
    if not origin:
        return True
    host = urlsplit(origin).netloc.lower()
    allowed = {socket.headers.get("host", "").lower(), socket.headers.get("x-forwarded-host", "").lower()}
    with SessionLocal() as db:
        public = settings_service.public_url(db)
    if public:
        allowed.add(urlsplit(public).netloc.lower())
    return bool(host) and host in allowed


def _admit(token: str, note_id: str) -> tuple[Any, Access]:
    with SessionLocal() as db:
        account = session_account(db, token)
        if account is None or totp.setup_required(db, account):
            return None, Access.NONE
        access = notes.access_to(db, account, db.get(Note, note_id) if len(note_id) <= 36 else None)
        db.expunge(account)
        return account, access


async def _refuse(socket: WebSocket, code: int) -> None:
    """Accepted first, then closed with the room's code. Closed before ``accept()``, the server answers the handshake
    with HTTP 403 and the browser only ever sees 1006, which reads as a broken connection: it would reconnect for ever
    instead of saying that the note went (NOTES-12 EC-2) or the right did (EC-5). Nothing is sent before the close."""
    await socket.accept()
    await socket.close(code=code)


@router.websocket("/{note_id}/live")
async def live(socket: WebSocket, note_id: str) -> None:
    if not _origin_ok(socket):
        await _refuse(socket, CLOSE_FORBIDDEN)
        return
    token = socket.cookies.get(SESSION_COOKIE, "")
    account, access = await asyncio.to_thread(_admit, token, note_id)
    if access == Access.GONE:
        await _refuse(socket, CLOSE_GONE)
        return
    if account is None or access not in (Access.WRITE, Access.READ):
        await _refuse(socket, CLOSE_FORBIDDEN)
        return
    await socket.accept()
    rooms = notes.rooms()
    try:
        await rooms.serve(socket, note_id, account_id=account.id, name=account.display_name or account.name,
                          can_write=access == Access.WRITE, session=notes.LiveSession(token, note_id))
    except Exception as exc:
        if type(exc).__name__ not in ("WebSocketDisconnect", "ClientDisconnected", "CancelledError"):
            logger.exception("Live connection failed note=%s", note_id)
    finally:
        if rooms.room_of(note_id) is None:
            notes.schedule_after_leave(note_id)
