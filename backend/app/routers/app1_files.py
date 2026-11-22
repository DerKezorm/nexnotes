"""Attachments from the app (``/api/app/1``, interface 0.5, NOTESIOS-10): the gallery, and the recognised text of the
attachments for the search offline.

Uploading, the limits, a note's attachments, the files themselves (with Range), the text the app recognised are the
browser's routes (``routers/attachments.py``, ``routers/ocr.py``), which take the device's token as they are. Here
what the app needs besides: the gallery of the account (or of a smart folder), as the browser's, and the text.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..errors import error
from ..models import Note
from ..models_smart import SmartFolder
from ..notedoc.room import Access
from ..services import appsync, attachments, notes, smart_folders
from .app1 import Device

router = APIRouter(prefix="/api/app/1", tags=["app"])

#: Notes one ``texts`` takes at most.
TEXT_NOTES = 50

GalleryKind = Annotated[str | None, Query(pattern="^(" + "|".join(attachments.GALLERY_KINDS) + ")$")]


@router.get("/attachments", summary="The gallery: every attachment of the account's notes, or of a smart folder's")
def gallery(
    found: Device,
    kind: GalleryKind = None,
    sort: Annotated[str, Query(pattern="^(newest|largest)$")] = "newest",
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 120,
    smart: Annotated[str | None, Query(max_length=64)] = None,
    tz: Annotated[str, Query(max_length=64)] = "",
) -> dict[str, Any]:
    account = found.account
    with SessionLocal() as db:
        if smart is None:
            return attachments.gallery(db, account, kind, sort, offset, limit)
        folder = db.get(SmartFolder, smart) if len(smart) <= 36 else None
        if folder is None or folder.owner_id != account.id:
            raise error("not_found", "Not found.", 404)
        return smart_folders.gallery(db, account, smart, tz, kind, sort, offset, limit)


class TextsIn(BaseModel):
    notes: list[Annotated[str, Field(max_length=64)]] = Field(default_factory=list)


@router.post("/texts", summary="The recognised text of the attachments of up to 50 notes, for the search offline")
def texts(found: Device, body: TextsIn) -> dict[str, Any]:
    account = found.account
    if len(body.notes) > TEXT_NOTES:
        raise error("too_many_notes", f"At most {TEXT_NOTES} notes per call.", 422, max=TEXT_NOTES)
    wanted = list(dict.fromkeys(body.notes))
    with SessionLocal() as db:
        rows = {row.id: row for row in db.scalars(select(Note).where(Note.id.in_(wanted)))} if wanted else {}
        seen = {note_id: row for note_id, row in rows.items()
                if notes.right_to(db, account, row) in (Access.WRITE, Access.READ)}
        held = appsync.attachment_texts(db, account.id, {note_id: row.owner_id for note_id, row in seen.items()
                                                         if not row.locked})
    out: list[dict[str, Any]] = []
    for note_id in wanted:
        if note_id not in seen:
            out.append({"id": note_id, "error": "not_found"})
            continue
        entries = held.get(note_id, [])
        out.append({"id": note_id, "texts": appsync.text_stamp(entries), "attachments": entries})
    return {"notes": out}
