"""Bringing notes over from another account (``/api/app/1/import``, interface 0.6, NOTESIOS-13): a note or folder
moved from iCloud or another server, and "Move everything from iCloud here".

The app makes every id, and the ids are the request ids: the same piece sent again creates nothing twice, so a
transfer that broke off goes on by sending the same pieces again (EC-2). The server keeps no state of a transfer; the
app counts the progress. Every entry stands on its own: one refused never stops the others, and nothing of a refused
entry is kept. Folders come first, in the order given (a parent before its children); a name taken beside it becomes
"Name (2)" (EC-3). Notes go the way of ``POST /notes`` (``routers/app1.make_note``): the whole Yjs state as the
update, colour, pin, paper, symbol and both times kept; never the history (AC-1).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal
from ..errors import error
from ..models import Folder
from ..services import folders, notes, vault
from .app1 import Device, NewNote, _out, _utc, check_note_color, finish_new, make_note

logger = logging.getLogger("nexnotes.app")

router = APIRouter(prefix="/api/app/1", tags=["app"])

#: Folders and notes one call takes at most.
IMPORT_FOLDERS = 200
IMPORT_NOTES = 50


class ImportFolder(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(max_length=1000)
    parent_id: str | None = Field(default=None, max_length=64)
    icon: str = Field(default="", max_length=64)
    color: str = Field(default="", max_length=16)


class ImportIn(BaseModel):
    folders: list[ImportFolder] = Field(default_factory=list)
    notes: list[NewNote] = Field(default_factory=list)


def _code(exc: HTTPException) -> str:
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    return str(detail.get("code") or "invalid_input")


def _folder(account: Any, item: ImportFolder) -> dict[str, Any]:
    if not notes.DEVICE_ID.fullmatch(item.id):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    if item.parent_id == "inbox":
        raise error("folder_target_not_allowed", "Folders cannot go into the inbox.")
    with SessionLocal() as db:
        existing = db.get(Folder, item.id)
        if existing is not None:
            if existing.owner_id != account.id:
                raise error("folder_id_taken", "This folder id is taken.", 409)
            return {"id": item.id, "state": "existed", "name": existing.name}
        try:
            made = folders.create(db, account.id, name=item.name, parent_id=item.parent_id or None, icon=item.icon,
                                  color=item.color, folder_id=item.id, rename_taken=True)
        except IntegrityError:
            # The same id at the same moment from a second request: the first one made it.
            db.rollback()
            existing = db.get(Folder, item.id)
            if existing is None or existing.owner_id != account.id:
                raise error("folder_id_taken", "This folder id is taken.", 409) from None
            return {"id": item.id, "state": "existed", "name": existing.name}
        except HTTPException as exc:
            if _code(exc) == "not_found":
                # The parent: not one of the account's living folders.
                raise error("folder_not_found", "The folder does not exist.", 404) from exc
            raise
        return {"id": item.id, "state": "created", "name": made["name"]}


@router.post("/import", summary="Folders and notes brought over from another account, in pieces; resumable")
async def bring_over(found: Device, body: ImportIn) -> dict[str, Any]:
    account = found.account
    if len(body.folders) > IMPORT_FOLDERS:
        raise error("too_many_folders", f"At most {IMPORT_FOLDERS} folders per call.", 422, max=IMPORT_FOLDERS)
    if len(body.notes) > IMPORT_NOTES:
        raise error("too_many_notes", f"At most {IMPORT_NOTES} notes per call.", 422, max=IMPORT_NOTES)
    folder_answers: list[dict[str, Any]] = []
    for item in body.folders:
        try:
            folder_answers.append(await asyncio.to_thread(_folder, account, item))
        except HTTPException as exc:
            folder_answers.append({"id": item.id, "error": _code(exc)})
    note_answers: list[dict[str, Any]] = []
    for note in body.notes:
        try:
            new, done = await make_note(account, note)
        except HTTPException as exc:
            note_answers.append({"id": note.id, "error": _code(exc)})
            continue
        note_answers.append({"id": note.id, "state": "created" if new else "existed", "seq": done.seq})
    made = sum(1 for entry in folder_answers + note_answers if entry.get("state") == "created")
    if made:
        logger.info("Brought over by a device folders=%s notes=%s created=%s", len(body.folders), len(body.notes),
                    made)
    return {"folders": folder_answers, "notes": note_answers}


# --- A locked note brought over (NOTESIOS-13 EC-4, NOTESIOS-16 AC-8, interface 0.10) ------------------------------


class LockedNote(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    folder_id: str | None = Field(default=None, max_length=64)
    title: str = Field(default="", max_length=1000)
    #: The Yjs state sealed on the device for this note's id and revision 1 (``nexnotes sealed v2|content|<id>|1``).
    content: str
    #: The vault's epoch the device sealed with (a new password meanwhile: ``409 vault_changed``).
    epoch: int
    paper: str | None = Field(default=None, max_length=16)
    icon: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, max_length=16)
    pinned: bool | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    origin: str = Field(default="", max_length=100)


@router.post("/locked-notes", status_code=201,
             summary="A note that comes locked from another account, sealed on the device; never plain here")
def create_locked(found: Device, body: LockedNote, response: Response) -> dict[str, Any]:
    account = found.account
    check_note_color(body.color)
    # The inbox (or none) is the own inbox (``notes._folder_for`` takes it from ``None``).
    folder_id = None if body.folder_id in (None, "", "inbox") else body.folder_id
    _note, new = vault.create_locked(account, note_id=body.id, folder_id=folder_id, content_b64=body.content,
                                     epoch=body.epoch, title=body.title, paper=body.paper, icon=body.icon,
                                     created_at=_utc(body.created_at), origin=body.origin)
    if new:
        finish_new(account, body.id, color=body.color, pinned=body.pinned, updated_at=_utc(body.updated_at))
    else:
        response.status_code = 200
    return {**_out(account, body.id), "rev": vault.FIRST_REV}
