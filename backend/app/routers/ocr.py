"""Text recognition (NOTES-11) over HTTP: the text of an attachment page by page, the text the iOS app brings, the pages
of a PDF as pictures for the large view, and whether the server can recognise at all. The rules are in
``services/ocr.py``."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI, Query, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import error
from ..services import attachments, notes, ocr, workqueue


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(ocr.start)
    try:
        yield
    finally:
        await asyncio.to_thread(workqueue.stop)


router = APIRouter(prefix="/api", tags=["ocr"], lifespan=lifespan)

AttachmentId = Annotated[str, PathParam(min_length=16, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/ocr", summary="Whether the server recognises text, and in which of the languages offered")
def engine(_account: Account) -> dict[str, Any]:
    info = ocr.engine_info()
    return {"available": info.available, "languages": list(info.languages)}


@router.get("/attachments/{attachment_id}/text", summary="The recognised text of an attachment, page by page")
def text_of(attachment_id: AttachmentId, account: Account, db: DbSession) -> dict[str, Any]:
    return ocr.text_out(db, attachments.get_for(db, account, attachment_id))


class PageIn(BaseModel):
    text: str = Field(default="", max_length=ocr.MAX_PAGE_CHARS)
    #: The language the device found (``de``, ``en`` ...); empty: the server tells it.
    language: str = Field(default="", max_length=8)


class DeviceText(BaseModel):
    pages: list[PageIn] = Field(min_length=1, max_length=ocr.MAX_PAGES)


@router.put("/attachments/{attachment_id}/text", summary="The text the iOS app recognised itself")
def device_text(attachment_id: AttachmentId, body: DeviceText, account: Account, db: DbSession) -> dict[str, Any]:
    row = attachments.get_for(db, account, attachment_id)
    notes.note_for(db, account, row.note_id, write=True)
    if row.kind not in ocr.KINDS:
        raise error("text_not_possible", "This attachment carries no text.", 422)
    if ocr.note_locked(db, row.note_id):
        raise error("note_locked", "The note is locked.", 409)
    ocr.take_device_text(db, row, [(page.text, page.language) for page in body.pages])
    return ocr.text_out(db, row)


@router.get("/attachments/{attachment_id}/pages/{page}", summary="A page of a PDF as a picture (the large view)")
async def page_picture(attachment_id: AttachmentId, account: Account, db: DbSession,
                       page: Annotated[int, PathParam(ge=1, le=100_000)],
                       width: Annotated[int, Query(ge=200, le=2400)] = 1400) -> Response:
    row = attachments.get_for(db, account, attachment_id)
    if row.kind != "pdf" or page > (row.pages or 0):
        raise error("not_found", "Not found.", 404)
    try:
        data = await asyncio.to_thread(ocr.render_page, row, page, width)
    except (ocr.EngineFailed, OSError) as exc:
        raise error("not_found", "Not found.", 404) from exc
    return Response(data, media_type="image/webp", headers={
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox"})
