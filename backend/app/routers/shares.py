"""Sharing over HTTP (NOTES-13, ``services/shares.py``): sharing with members, "Mit mir geteilt", the read links of an
account, and the page of a read link itself (``/l/<token>``), which needs no account.

The page of a link, its PDF and its pictures answer the same for every link that does not work (unknown, expired,
revoked, switched off, its note gone or locked): "Dieser Link gilt nicht mehr", status 404, nothing of the note
(EC-5, EC-6). Unknown tokens count against the sender (EC-7); past the brake every unknown one waits, with 429. A
link that exists always answers, so a stranger's misses behind the same proxy address stop nobody's links.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, FastAPI, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..db import SessionLocal
from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..models import Account as AccountRow
from ..models import Note
from ..models_attachments import Attachment
from ..services import attachments, export, share_page, shares
from .attachments import _send
from .export import _disposition, _pdf_place

logger = logging.getLogger("nexnotes.shares")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    shares.register()
    yield


router = APIRouter(tags=["sharing"], lifespan=lifespan)

Kind = Annotated[Literal["note", "folder"], PathParam()]
ItemId = Annotated[str, PathParam(min_length=1, max_length=36)]
#: What a token looks like (``secrets.token_urlsafe``); anything else is a miss without asking the database.
TOKEN_PATTERN = r"^[A-Za-z0-9_-]{20,96}$"


# --- Sharing with members -----------------------------------------------------------------------------------------


class LevelIn(BaseModel):
    level: Literal["read", "write"]


class MoveCheckIn(BaseModel):
    note_ids: list[Annotated[str, Field(max_length=36)]] = Field(max_length=500)
    target_id: str | None = Field(default=None, max_length=36)


@router.get("/api/shares/people", summary="Members of this server by name or address, to share with")
def people(db: DbSession, account: Account, q: Annotated[str, Query(max_length=100)] = "") -> list[dict[str, Any]]:
    return shares.find_people(db, account, q)


@router.get("/api/shares/with-me", summary="What others shared with the account, per owner, and what went")
def with_me(db: DbSession, account: Account) -> dict[str, Any]:
    return shares.with_me(db, account)


@router.delete("/api/shares/with-me/{kind}/{item_id}", status_code=204,
               summary="Leave a note or folder somebody shared (it stays theirs)")
def leave(kind: Kind, item_id: ItemId, db: DbSession, account: Account) -> Response:
    shares.leave(db, account, kind, item_id)
    return Response(status_code=204)


@router.delete("/api/shares/notices/{notice_id}", status_code=204, summary="Put away a notice of a share that ended")
def drop_notice(notice_id: int, db: DbSession, account: Account) -> Response:
    shares.drop_notice(db, account, notice_id)
    return Response(status_code=204)


@router.post("/api/shares/move-check", summary="Which notes would stop being shared when moved there (EC-2)")
def move_check(body: MoveCheckIn, db: DbSession, account: Account) -> dict[str, Any]:
    return {"notes": shares.move_check(db, account, body.note_ids, body.target_id)}


@router.get("/api/shared-folders/{folder_id}", summary="A folder shared with the account: owner, right, subfolders")
def shared_folder(folder_id: ItemId, db: DbSession, account: Account) -> dict[str, Any]:
    return shares.shared_folder(db, account, folder_id)


@router.get("/api/shares/{kind}/{item_id}", summary="Whom an own note or folder is shared with, and its read link")
def sharing(kind: Kind, item_id: ItemId, db: DbSession, account: Account) -> dict[str, Any]:
    return shares.sharing_of(db, account, kind, item_id)


@router.put("/api/shares/{kind}/{item_id}/people/{person_id}", summary="Share with a member, or change the right")
def share_with(kind: Kind, item_id: ItemId, person_id: int, body: LevelIn, db: DbSession,
               account: Account) -> dict[str, Any]:
    return shares.set_person(db, account, kind, item_id, person_id, body.level)


@router.delete("/api/shares/{kind}/{item_id}/people/{person_id}", summary="Stop sharing with a member")
def unshare(kind: Kind, item_id: ItemId, person_id: int, db: DbSession, account: Account) -> dict[str, Any]:
    return shares.remove_person(db, account, kind, item_id, person_id)


# --- Read links of the account --------------------------------------------------------------------------------------


class LinkIn(BaseModel):
    #: The last day the link works, as chosen in the calendar.
    expires_on: date
    #: The moment that day ends where the member is (its browser's midnight after it, with its offset); without it
    #: the day ends at midnight UTC.
    ends_at: datetime | None = None


@router.post("/api/notes/{note_id}/read-link", status_code=201,
             summary="A new link to read the note without an account (replaces the one before); shown once")
def make_link(note_id: ItemId, body: LinkIn, db: DbSession, account: Account) -> dict[str, Any]:
    return shares.make_link(db, account, note_id, body.expires_on, body.ends_at)


@router.get("/api/read-links", summary="Every read link of the account, with its note and last day")
def my_links(db: DbSession, account: Account) -> list[dict[str, Any]]:
    return shares.my_links(db, account)


@router.put("/api/read-links/{link_id}", summary="Another last day for a read link")
def change_link(link_id: int, body: LinkIn, db: DbSession, account: Account) -> dict[str, Any]:
    return shares.change_link(db, account, link_id, body.expires_on, body.ends_at)


@router.delete("/api/read-links/{link_id}", status_code=204, summary="Revoke a read link at once")
def revoke_link(link_id: int, db: DbSession, account: Account) -> Response:
    shares.revoke_link(db, account, link_id)
    return Response(status_code=204)


# --- The page of a read link (no account) ---------------------------------------------------------------------------

#: Headers of every answer under ``/l/``: nothing cached on the way (a revoked link ends at once), no address handed
#: on to the pages a note links to, nothing for search engines.
_PRIVATE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow"}


def _html(text: str, nonce: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(text, status_code=status,
                        headers={**_PRIVATE, "Content-Security-Policy": share_page.policy(nonce)})


def _gone(request: Request, *, slow: bool = False, wait: int = 0) -> HTMLResponse:
    lang, texts = share_page.language(request.headers.get("accept-language"))
    nonce = share_page.new_nonce()
    answer = _html(share_page.gone_page(lang=lang, texts=texts, nonce=nonce, slow=slow), nonce, 429 if slow else 404)
    if slow:
        answer.headers["Retry-After"] = str(max(1, wait))
    return answer


def _open(request: Request, token: str) -> tuple[Any, Any] | HTMLResponse:
    """The link and its note, or the answer for a link that does not work (and the brake for an unknown one).

    The brake counts and slows only unknown addresses (EC-7): a link that exists always gets its answer, whoever
    tried wrong ones from the same address before. Behind a proxy every visitor may share one address; a stranger's
    misses must not stop the links of everybody else."""
    key = "link:" + client_ip(request)
    if not re.fullmatch(TOKEN_PATTERN, token):
        return _miss(request, key)
    with SessionLocal() as db:
        link, note, known = shares.resolve(db, token)
        if not known:
            logger.info("Unknown read link opened")
            return _miss(request, key)
        if link is None or note is None:
            return _gone(request)
        db.expunge_all()
    return link, note


def _miss(request: Request, key: str) -> HTMLResponse:
    """An address no link has: counted, and slowed down once there were too many from the sender."""
    wait = shares.LINK_BRAKE.wait_seconds(key)
    if wait:
        return _gone(request, slow=True, wait=wait)
    shares.LINK_BRAKE.failed(key)
    return _gone(request)


@router.api_route("/l/{token}", methods=["GET", "HEAD"], include_in_schema=False)
def read_page(token: str, request: Request) -> Response:
    found = _open(request, token)
    if isinstance(found, Response):
        return found
    link, note = found
    lang, texts = share_page.language(request.headers.get("accept-language"))
    nonce = share_page.new_nonce()
    if share_page.is_preview_bot(request.headers.get("user-agent")):
        return _html(share_page.preview_page(lang=lang, title=note.title or texts["untitled"], nonce=nonce), nonce)
    with SessionLocal() as db:
        data = export.note_data(db, db.get(Note, note.id))
        allowed = {item.id for item in data.files}
        owner_row = db.get(AccountRow, note.owner_id)
        owner_name = (owner_row.display_name or owner_row.name) if owner_row is not None else ""

    def file_url(attachment_id: str, kind: str) -> str | None:
        if attachment_id not in allowed:
            return None
        return f"/l/{token}/a/{attachment_id}/{kind}"

    page = share_page.note_page(lang=lang, texts=texts, title=data.title or note.title, document=data.document,
                                owner=owner_name, expires_on=link.expires_on, pdf_url=f"/l/{token}/pdf",
                                file_url=file_url, nonce=nonce)
    return _html(page, nonce)


@router.get("/l/{token}/pdf", include_in_schema=False)
async def read_pdf(token: str, request: Request) -> Response:
    """"Als PDF laden" (AC-12), as the export draws it, one at a time per link."""
    found = await run_in_threadpool(_open, request, token)
    if isinstance(found, Response):
        return found
    link, note = found
    lang, _texts = share_page.language(request.headers.get("accept-language"))
    words = export.WORDS.get(lang, export.WORDS["en"])

    def build() -> tuple[str, bytes]:
        from ..services import export_pdf

        with SessionLocal() as db:
            data = export.note_data(db, db.get(Note, note.id))
            db.expunge_all()
        return export.safe_name(data.title, words["untitled"]) + ".pdf", export_pdf.build(
            data, words, lang if lang in export.WORDS else "en")

    async with _pdf_place(("link", link.id)):  # type: ignore[arg-type]
        name, body = await run_in_threadpool(build)
    return Response(body, media_type="application/pdf",
                    headers={**_PRIVATE, "Content-Disposition": _disposition(name)})


AttachmentId = Annotated[str, PathParam(min_length=16, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/l/{token}/a/{attachment_id}/{kind}", include_in_schema=False)
def read_file(token: str, attachment_id: AttachmentId, kind: Literal["view", "file"], request: Request) -> Response:
    """A picture or file of the note, only one the note names today (AC-12: "sonst nichts vom Server")."""
    found = _open(request, token)
    if isinstance(found, Response):
        return found
    _link, note = found
    with SessionLocal() as db:
        allowed = {item.id: item for item in attachments.files_of(db, note.id)}
        row = db.get(Attachment, attachment_id) if attachment_id in allowed else None
        if row is None or row.owner_id != note.owner_id:
            raise error("not_found", "Not found.", 404)
        db.expunge(row)
    if kind == "view":
        if row.has_view:
            answer = _send(attachments.path_of(row.id, attachments.VIEW), "image/webp", shown=True,
                           name=row.name + ".webp")
        elif row.kind in ("image", attachments.LINK_PICTURE, "drawing") and row.inline:
            answer = _send(attachments.path_of(row.id), row.mime, shown=True, name=row.name)
        else:
            raise error("not_found", "Not found.", 404)
    else:
        answer = _send(attachments.path_of(row.id), row.mime, shown=False, name=row.name)
    answer.headers.update(_PRIVATE)
    return answer
