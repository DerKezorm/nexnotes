"""Attachments (NOTES-10) over HTTP: uploading, the gallery, a note's attachments, the files themselves and the cards of
links. The rules are in ``services/attachments.py``; this module adds the headers a file goes out with.

**Nothing an attachment holds runs in the page's context** (EC-4): every file carries ``X-Content-Type-Options:
nosniff`` and a policy of its own (``default-src 'none'`` and ``sandbox``; a PDF without ``sandbox``, which Chrome's
viewer refuses), and only what the server drew anew (pictures), a PDF or a video may be shown in the page
(``inline``). HTML, SVG and everything else come as a download (``Content-Disposition: attachment``), whatever their
name says; the name goes out only as ``filename*`` (UTF-8, percent-encoded) and a plain ASCII stand-in.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, FastAPI, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..errors import error
from ..models_attachments import Attachment
from ..services import attachments, linkpreview, notes, settings_service

logger = logging.getLogger("nexnotes.attachments")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    attachments.register()
    yield


router = APIRouter(prefix="/api", tags=["attachments"], lifespan=lifespan)

AttachmentId = Annotated[str, PathParam(min_length=16, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
NoteId = Annotated[str, PathParam(min_length=1, max_length=36)]

#: The policy of a file shown in the page or opened in its own tab: nothing of it runs.
SANDBOXED = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; " \
            "frame-ancestors 'self'"
#: A PDF in the browser's own viewer: no scripts of the page, but no ``sandbox`` (Chrome would not show it).
PDF_POLICY = "default-src 'none'; object-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; " \
             "frame-ancestors 'self'"
#: An attachment's content never changes under its id.
CACHE = "private, max-age=31536000, immutable"


def _ascii(name: str) -> str:
    plain = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip() or "file"
    return plain[:150]


def disposition(kind: str, name: str) -> str:
    return f"{kind}; filename=\"{_ascii(name)}\"; filename*=UTF-8''{quote(name, safe='')}"


def _send(path: Any, mime: str, *, shown: bool, name: str, pdf: bool = False) -> FileResponse:
    if not path.is_file():
        raise error("not_found", "Not found.", 404)
    headers = {
        "Content-Disposition": disposition("inline" if shown else "attachment", name),
        "Content-Security-Policy": PDF_POLICY if pdf and shown else SANDBOXED,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": CACHE,
    }
    # Whatever is only downloaded goes out as bytes, never as a type a browser would render.
    return FileResponse(path, media_type=mime if shown else "application/octet-stream", headers=headers)


# --- Uploading ----------------------------------------------------------------------------------------------------


@router.post("/attachments", status_code=201, summary="Upload an attachment into a note (the file as the body)")
async def upload(
    request: Request,
    response: Response,
    account: Account,
    note_id: Annotated[str, Query(max_length=36)],
    attachment_id: Annotated[str, Query(alias="id", max_length=32)],
    name: Annotated[str, Query(max_length=1000)] = "",
) -> dict[str, Any]:
    declared_text = request.headers.get("content-length")
    declared = int(declared_text) if declared_text and declared_text.isdigit() else None
    try:
        with SessionLocal() as db:
            started = attachments.begin(db, account, note_id, attachment_id, name, declared)
        if isinstance(started, Attachment):
            response.status_code = 200
            return attachments.out(started)
        work = await attachments.receive(started, request.stream())
        row, new = await asyncio.to_thread(attachments.finish, started, work)
    except attachments.AttachmentError as exc:
        raise exc.http() from exc
    except ClientDisconnect:
        # The connection went while the file came (EC-2): nothing was kept, the page offers to upload again.
        logger.info("An upload broke off note=%s", note_id)
        raise error("upload_broken", "The upload broke off.", 400) from None
    if not new:
        response.status_code = 200
    return attachments.out(row)


@router.get("/attachments/limits", summary="The limit per file, the storage of the account, link cards on or off")
def limits(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(type(account), account.id)
    return attachments.limits(db, row or account)


# --- Reading ------------------------------------------------------------------------------------------------------


@router.get("/attachments", summary="Every attachment of the account's notes (the gallery)")
def gallery(
    account: Account,
    db: DbSession,
    kind: Annotated[str | None, Query(pattern="^(" + "|".join(attachments.GALLERY_KINDS) + ")$")] = None,
    sort: Annotated[str, Query(pattern="^(newest|largest)$")] = "newest",
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 120,
) -> dict[str, Any]:
    return attachments.gallery(db, account, kind, sort, offset, limit)


@router.get("/notes/{note_id}/attachments", summary="The attachments a note names or was given")
def of_note(note_id: NoteId, account: Account, db: DbSession) -> dict[str, Any]:
    return {"items": attachments.of_note(db, account, note_id)}


@router.get("/attachments/{attachment_id}", summary="One attachment")
def one(attachment_id: AttachmentId, account: Account, db: DbSession) -> dict[str, Any]:
    return attachments.out(attachments.get_for(db, account, attachment_id))


@router.get("/attachments/{attachment_id}/file", summary="The file of an attachment")
def file(attachment_id: AttachmentId, account: Account, db: DbSession,
         download: Annotated[bool, Query()] = False) -> FileResponse:
    row = attachments.get_for(db, account, attachment_id)
    return _send(attachments.path_of(row.id), row.mime, shown=row.inline and not download, name=row.name,
                 pdf=row.mime == "application/pdf")


@router.get("/attachments/{attachment_id}/view", summary="The picture as every browser shows it")
def view(attachment_id: AttachmentId, account: Account, db: DbSession) -> FileResponse:
    row = attachments.get_for(db, account, attachment_id)
    if not row.has_view:
        if row.kind not in ("image", attachments.LINK_PICTURE) or not row.inline:
            raise error("not_found", "Not found.", 404)
        return _send(attachments.path_of(row.id), row.mime, shown=True, name=row.name)
    return _send(attachments.path_of(row.id, attachments.VIEW), "image/webp", shown=True, name=row.name + ".webp")


@router.get("/attachments/{attachment_id}/thumb", summary="The preview of an attachment")
def thumb(attachment_id: AttachmentId, account: Account, db: DbSession) -> FileResponse:
    row = attachments.get_for(db, account, attachment_id)
    if not row.has_thumb:
        if row.kind != attachments.LINK_PICTURE:
            raise error("not_found", "Not found.", 404)
        return _send(attachments.path_of(row.id), row.mime, shown=True, name=row.name)
    return _send(attachments.path_of(row.id, attachments.THUMB), "image/webp", shown=True, name=row.name + ".webp")


# --- Cards of links -----------------------------------------------------------------------------------------------


class LinkIn(BaseModel):
    url: str = Field(max_length=2048)


def _own_hosts(request: Request) -> set[str]:
    """The names the server answers to: a card never asks the server itself."""
    hosts = {(request.url.hostname or "").lower()}
    with SessionLocal() as db:
        public = settings_service.public_url(db)
    if public:
        hosts.add((urlsplit(public).hostname or "").lower())
    return {host for host in hosts if host}


@router.post("/notes/{note_id}/link-preview", summary="The card of a link pasted into the note, or none")
async def link_preview(note_id: NoteId, body: LinkIn, request: Request, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        note = notes.note_for(db, account, note_id, write=True)
        owner_id = note.owner_id
        if not settings_service.get(db, "link_previews"):
            # Switched off by the operator (AC-9): nothing is asked, the link stays plain.
            return {"preview": None, "reason": "off"}
    try:
        card = await asyncio.to_thread(linkpreview.fetch, body.url, _own_hosts(request))
    except linkpreview.NoCard as exc:
        return {"preview": None, "reason": exc.reason}
    picture_id = None
    if card.picture is not None:
        with SessionLocal() as db:
            row = attachments.store_bytes(db, note_id, owner_id, attachments.LINK_PICTURE, card.site or "link",
                                          card.picture)
            db.commit()
            picture_id = row.id
    return {"preview": {"href": card.href, "title": card.title, "description": card.description, "site": card.site,
                        "image": picture_id}, "reason": None}
