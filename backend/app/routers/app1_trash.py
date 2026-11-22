"""History and trash from the app (``/api/app/1``, interface 0.5, NOTESIOS-9).

The versions of a note the account sees, one version whole (with its Yjs state, so the app can show it with its own
editor), restoring one and copying one into a new note with the device's id; the account's own trash, gone for good
and emptied. Each route calls the browser's services (``services/history.py``, ``services/trash.py``), so the rules
are the browser's; the app's rules on top: ``not_found`` for everything the account cannot see, ``no_right`` only for
a note it may read but not write. Back from the trash goes through ``POST /notes/{id}/restore`` and
``POST /folders/{id}/restore`` (``routers/app1.py``, ``routers/app1_member.py``).
"""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..errors import error
from ..models import Note
from ..models_history import NoteVersion
from ..notedoc.room import Access
from ..services import appsync, history, notes, trash
from .app1 import Device

router = APIRouter(prefix="/api/app/1", tags=["app"])

def _no_right() -> HTTPException:
    return error("no_right", "Only reading is allowed here.", 403)


def _readable(db: Any, account: Any, note_id: str, *, write: bool = False) -> Note:
    """The note when the account sees it (not in the trash, as in the browser); ``no_right`` when it may only read and
    ``write`` is asked."""
    note = notes.note_for(db, account, note_id)
    if write and notes.access_to(db, account, note) != Access.WRITE:
        raise _no_right()
    return note


# --- History ------------------------------------------------------------------------------------------------------


@router.get("/notes/{note_id}/versions", summary="The versions of a note, newest first, a page at a time")
def versions(note_id: str, found: Device, before: int | None = Query(default=None, ge=1),
             limit: int = Query(default=history.PAGE, ge=1, le=history.PAGE_MAX)) -> dict[str, Any]:
    with SessionLocal() as db:
        _readable(db, found.account, note_id)
        listed = history.listing(db, found.account, note_id, before=before, limit=limit)
    keep = ("versions", "next", "pending", "can_restore", "history_days", "locked")
    return {key: listed[key] for key in keep}


@router.get("/notes/{note_id}/versions/{version_id}", summary="One version whole, with its Yjs state")
def version(note_id: str, version_id: int, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _readable(db, found.account, note_id)
        answer = history.read(db, found.account, note_id, version_id)
        if not answer.get("sealed"):
            state = db.scalar(_state_of(note_id, version_id))
            answer["state"] = base64.b64encode(state or b"").decode("ascii")
        return answer


def _state_of(note_id: str, version_id: int) -> Any:
    from sqlalchemy import select

    return select(NoteVersion.state).where(NoteVersion.id == version_id, NoteVersion.note_id == note_id)


@router.post("/notes/{note_id}/versions/{version_id}/restore", summary="A version becomes the note")
async def restore(note_id: str, version_id: int, found: Device) -> dict[str, Any]:
    account = found.account
    with SessionLocal() as db:
        _readable(db, account, note_id, write=True)
    done = await history.restore(account, note_id, version_id)
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        return {"version": done["id"], "restored_from": done["restored_from"],
                "note": appsync.note_out(db, account.id, note)}


class CopyIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    #: The version's date as the device writes it, for the copy's title.
    when: str | None = Field(default=None, max_length=100)


@router.post("/notes/{note_id}/versions/{version_id}/copy", status_code=201,
             summary="A version as a new note with the device's id; the same id again is that note")
def copy(note_id: str, version_id: int, body: CopyIn, found: Device, response: Response) -> dict[str, Any]:
    account = found.account
    if not notes.DEVICE_ID.fullmatch(body.id):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    with SessionLocal() as db:
        _readable(db, account, note_id, write=True)
        existing = db.get(Note, body.id)
        if existing is not None:
            if notes.right_to(db, account, existing) not in (Access.WRITE, Access.READ):
                raise error("note_id_taken", "This note id is taken.", 409)
            # Sent again (the answer got lost): the copy made the first time.
            response.status_code = 200
            return appsync.note_out(db, account.id, existing)
        made = history.copy(db, account, note_id, version_id, body.when, new_id=body.id)
        return appsync.note_out(db, account.id, made)


# --- Trash --------------------------------------------------------------------------------------------------------


@router.get("/trash", summary="The account's trash: what was deleted, when it goes for good")
def listing(found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        listed = trash.listing(db, found.account)
    for item in listed["items"]:
        origin = item.get("origin")
        if origin and origin.get("inbox"):
            item["origin"] = {**origin, "id": "inbox"}
    return listed


@router.delete("/trash/notes/{note_id}", summary="A note in the trash gone for good")
async def purge_note(note_id: str, found: Device) -> dict[str, int]:
    if len(note_id) > 64:
        raise error("not_found", "Not found.", 404)
    return await trash.purge_note(found.account, note_id)


@router.delete("/trash/folders/{folder_id}", summary="A folder in the trash gone for good, with what went with it")
async def purge_folder(folder_id: str, found: Device) -> dict[str, int]:
    if len(folder_id) > 64:
        raise error("not_found", "Not found.", 404)
    return await trash.purge_folder(found.account, folder_id)


class EmptyIn(BaseModel):
    #: The ``now`` of the listing the person saw: what was deleted after it stays.
    until: datetime


@router.post("/trash/empty", summary="Everything in the trash deleted until the moment given, gone for good")
async def empty(body: EmptyIn, found: Device) -> dict[str, int]:
    return await trash.empty(found.account, body.until)
