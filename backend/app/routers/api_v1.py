"""The API for programs (NOTES-25) under ``/api/v1/``, as the other apps of the family offer it: an API token in
``Authorization: Bearer``, errors as ``{"detail": {"code", "message"}}``, a description at ``/api/v1/docs``. The five
routes of the nexdeck card (NOTES-21) are part of it and answer as before.

Walls, in this order (``wall``):

1. A request that carries an ``Origin`` is refused (EC-10): the API is for programs, not web pages. The session
   cookie counts for nothing here.
2. The operator's switch (``api_enabled``, AC-5, EC-6): off, every route answers ``api_off``, before any token is
   looked at and without counting against anything.
3. A valid token (``api``, or an older card key) of an account that may sign in (``token_invalid``, EC-5, EC-9); wrong
   tokens count per sender like wrong passwords (``too_many_attempts``, AC-23).
4. The token's rate (``slow_down``, AC-23).
5. An older card key opens the card's routes only (``token_card_only``, AC-3).
6. A route that writes needs a token that may write (``token_reads_only``, AC-6).

Which note, folder or attachment the token may touch is ``services/apiaccess.py``; what goes out
``services/apiv1.py``. What is here stays as it is: new fields may come, nothing is renamed or removed; what would
break comes under ``/api/v2/`` beside it (AC-26).
"""

from __future__ import annotations

import asyncio
import html
import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .. import __version__
from ..db import SessionLocal
from ..deps import Account, client_ip
from ..models import TOKEN_API, TOKEN_DASHBOARD
from ..notedoc import doc as notedoc
from ..notedoc import edit
from ..notedoc.markdown import to_markdown, to_plain
from ..notedoc.room import Access
from ..security import brake as sign_in_brake
from ..services import apiaccess, apibrake, apiv1, attachments, dashboard, history, logs, notes, search
from ..services.apiaccess import Caller, Refused
from . import oauth
from .attachments import _send

logger = logging.getLogger("nexnotes.api")

PREFIX = "/api/v1"
#: Wrong tokens one sender may bring before it waits.
FREE_WRONG_TOKENS = 20
#: What ``/me`` names, for a program to ask before it uses something (AC-26). It only grows.
FEATURES = ["pinned", "notes", "check", "read", "search", "folders", "tags", "smart", "shares", "attachments",
            "trash"]


class Problem(BaseModel):
    code: str = Field(description="What went wrong, for programs: e.g. token_invalid, not_found, slow_down.")
    message: str = Field(description="The same in English, for people.")


class ProblemOut(BaseModel):
    detail: Problem


ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ProblemOut, "description": "`token_invalid`: no token, or one unknown, run out or blocked."},
    403: {"model": ProblemOut, "description": "`api_off`, `origin_refused`, `token_card_only`, `token_reads_only`, "
                                             "`not_allowed`."},
    429: {"model": ProblemOut, "description": "`slow_down` (more than 600 requests a minute, see `Retry-After`) or "
                                             "`too_many_attempts` (too many wrong tokens from this sender)."},
}
NOTE_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ProblemOut, "description": "`not_found`: not there, or not to be seen with this token."},
    409: {"model": ProblemOut, "description": "`note_locked`: the note is locked in the vault."},
    410: {"model": ProblemOut, "description": "`note_trashed`: the note is in the trash."},
}

router = APIRouter(prefix=PREFIX, tags=["api"], responses=ERRORS)
#: The description itself: for people signed in to nexnotes, not for tokens (AC-25).
docs_router = APIRouter(prefix=PREFIX, include_in_schema=False)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def wall(request: Request, *, card: bool = False, write: bool = False) -> Caller:
    if request.headers.get("origin"):
        raise Refused("origin_refused")
    with SessionLocal() as db:
        if not apiaccess.enabled(db):
            raise Refused("api_off")
        sender = "api:" + client_ip(request)
        wait = sign_in_brake.wait_seconds(sender, FREE_WRONG_TOKENS)
        if wait:
            raise Refused("too_many_attempts", headers={"Retry-After": str(wait)})
        caller = apiaccess.authenticate(db, _bearer(request), (TOKEN_API, TOKEN_DASHBOARD))
    if caller is None:
        sign_in_brake.failed(sender)
        raise Refused("token_invalid")
    if not apibrake.allow(caller.token_id):
        raise Refused("slow_down", headers={"Retry-After": "60"})
    logs.set_actor(caller.account.name)
    if caller.card_only and not card:
        raise Refused("token_card_only")
    if write and not caller.writes:
        raise Refused("token_reads_only")
    if request.method == "GET":
        # Reading only at the deep levels of the log (AC-24): the route and the token's number, never a content.
        logger.debug("API read path=%s token_id=%s", request.url.path, caller.token_id)
    return caller


def _card_reader(request: Request) -> Caller:
    return wall(request, card=True)


def _card_writer(request: Request) -> Caller:
    return wall(request, card=True, write=True)


def _reader(request: Request) -> Caller:
    return wall(request)


CardReader = Annotated[Caller, Depends(_card_reader)]
CardWriter = Annotated[Caller, Depends(_card_writer)]
Reader = Annotated[Caller, Depends(_reader)]
NoteId = Annotated[str, Path(min_length=1, max_length=36)]
Limit = Annotated[int, Query(ge=1, le=apiv1.PAGE_MAX, description="Notes on one page.")]
Cursor = Annotated[str | None, Query(max_length=40, description="`next_cursor` of the page before.")]


def _base(request: Request) -> str:
    with SessionLocal() as db:
        return oauth.base_url(request, db)


# --- Who the token is (AC-26) ---------------------------------------------------------------------------------------


@router.get("/me", summary="Who the token reads as, what it may, what this nexnotes offers")
def me(caller: CardReader) -> dict[str, Any]:
    account = caller.account
    return {"app": "nexnotes", "name": account.name, "display_name": account.display_name or account.name,
            "level": caller.level, "version": __version__, "features": FEATURES,
            "token": {"id": caller.token_id, "name": caller.token_name}, "access": caller.access(),
            "folders": caller.folder_ids, "expires_at": apiv1.iso(caller.expires_at)}


# --- The card (NOTES-21), kept as it was ----------------------------------------------------------------------------


@router.get("/dashboard", summary="The pinned notes for a card: title, first line, progress")
def pinned(caller: CardReader, request: Request,
           limit: Annotated[int, Query(ge=1, le=dashboard.MAX_PINNED)] = 12) -> JSONResponse:
    base = _base(request)
    with SessionLocal() as db:
        return JSONResponse(dashboard.pinned(db, caller.account, base, limit, caller.scope(db)))


# --- Notes (AC-8, AC-9) ---------------------------------------------------------------------------------------------


@router.get("/notes", summary="The notes the token sees, newest change first, a page at a time")
def list_notes(
    caller: CardReader,
    q: Annotated[str, Query(max_length=200, description="Words of the title.")] = "",
    folder: Annotated[str | None, Query(max_length=36, description="A folder's id, or `inbox`.")] = None,
    tag: Annotated[str, Query(max_length=200, description="Notes with this tag.")] = "",
    pinned: Annotated[bool | None, Query(description="Only pinned (true) or only not pinned (false).")] = None,
    changed_since: Annotated[datetime | None, Query(description="Changed after this moment (ISO 8601).")] = None,
    locked: Annotated[bool, Query(description="`true` lists locked notes too, with their title only.")] = False,
    limit: Limit = apiv1.PAGE,
    cursor: Cursor = None,
) -> dict[str, Any]:
    offset = apiv1.cursor_in(cursor)
    with SessionLocal() as db:
        where = apiv1.note_filters(db, caller, q=q, folder_id=folder, tag=tag, pinned=pinned,
                                   changed_since=changed_since, with_locked=locked)
        return apiv1.page_of(db, caller.account, where, offset, limit)


def _the_note(caller: Caller, note_id: str) -> tuple[Any, Access, str, dict[str, Any]]:
    with SessionLocal() as db:
        note, access = apiaccess.note(db, caller, note_id)
        stamp = dashboard.stamp_of(note)
        head = apiv1.note_head(db, caller.account, note)
        db.expunge(note)
        return note, access, stamp, head


def _reading(with_markdown: bool) -> Any:
    def read(doc: Any) -> tuple[str, list[edit.Task], str, str | None, str]:
        markdown = to_markdown(doc) if with_markdown else None
        return notedoc.title_of(doc), edit.list_tasks(doc), to_plain(doc), markdown, notedoc.state_tag(doc)

    return read


async def _in_room(note_id: str, change: Any, account_id: int | None = None) -> Any:
    try:
        return await notes.change(note_id, change, account_id=account_id)
    except HTTPException as exc:
        if exc.status_code == 409:
            raise Refused("note_locked") from exc
        raise
    except notedoc.FormatError as exc:
        raise Refused("note_format") from exc


async def _note_answer(caller: Caller, note_id: str, request: Request, with_markdown: bool) -> JSONResponse:
    note, access, stamp, head = await asyncio.to_thread(_the_note, caller, note_id)
    base = await asyncio.to_thread(_base, request)
    title, items, plain, markdown, etag = await _in_room(note.id, _reading(with_markdown))
    out = dashboard.card_of(note, access, caller.writes, base, (title, items, plain), stamp)
    out.update(head)
    out["etag"] = etag
    if markdown is not None:
        out["markdown"] = markdown[:apiv1.MAX_MARKDOWN]
        out["truncated"] = len(markdown) > apiv1.MAX_MARKDOWN
    return JSONResponse(out, headers={"ETag": f'"{etag}"'})


@router.get("/notes/{note_id}", responses=NOTE_ERRORS,
            summary="One note: its Markdown, its numbered checklist items, its state as `etag`")
async def one_note(note_id: NoteId, caller: CardReader, request: Request,
                   markdown: Annotated[bool | None, Query(description="`false` leaves the Markdown out.")] = None,
                   ) -> JSONResponse:
    # An older card key never asked for Markdown; an API token gets it unless it says no.
    return await _note_answer(caller, note_id, request, markdown if markdown is not None else not caller.card_only)


class CheckIn(BaseModel):
    checked: bool = True
    #: The item's text as it was read, always: a different item at that place by now is left alone.
    text: str = Field(max_length=4000)


@router.post("/notes/{note_id}/items/{index}", responses=NOTE_ERRORS,
             summary="Tick a checklist item off, or open it again")
async def check(note_id: NoteId, index: Annotated[int, Path(ge=0, le=1_000_000)], body: CheckIn,
                caller: CardWriter, request: Request) -> JSONResponse:
    found = await asyncio.to_thread(_the_note, caller, note_id)
    if found[1] != Access.WRITE:
        raise Refused("not_allowed")

    def toggle(doc: Any) -> bool | None:
        try:
            return edit.toggle_task(doc, index, body.checked, expect=body.text)
        except edit.TaskNotFound:
            return None

    with history.acting_via(caller.label):
        done = await _in_room(found[0].id, toggle, account_id=caller.account.id)
    if done is None:
        raise HTTPException(status_code=409, detail={
            "code": "item_changed", "message": "This item is not there any more, or it says something else now."})
    logger.info("API item ticked note=%s index=%s token_id=%s", found[0].id, index, caller.token_id)
    return await _note_answer(caller, found[0].id, request, not caller.card_only)


# --- Search (AC-10) -------------------------------------------------------------------------------------------------


@router.get("/search", summary="Full text search as the search page: text, tags, text read from pictures and PDFs")
def find(
    caller: Reader,
    q: Annotated[str, Query(min_length=1, max_length=search.QUERY_MAX,
                            description='Words match as prefixes; "a phrase", -word, #tag.')],
    folder: Annotated[str | None, Query(max_length=36, description="An own folder with its subfolders.")] = None,
    tag: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=apiv1.SEARCH_PAGE_MAX)] = apiv1.SEARCH_PAGE,
    cursor: Cursor = None,
) -> dict[str, Any]:
    offset = apiv1.cursor_in(cursor)
    with SessionLocal() as db:
        return apiv1.search_page(db, caller, q, folder_id=folder, tag=tag, offset=offset, limit=limit)


# --- Folders, tags, smart folders, shares (AC-11) -------------------------------------------------------------------


@router.get("/folders", summary="The inbox, the own folders as a tree, the folders shared with the account")
def folder_tree(caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        return apiv1.folder_tree(db, caller)


@router.get("/tags", summary="The tags of the notes the token sees, the most used first")
def tag_list(caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        return {"tags": apiv1.tag_list(db, caller)}


@router.get("/smart-folders", summary="The smart folders with their conditions and how many notes fit them")
def smart_list(caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        return {"smart_folders": apiv1.smart_list(db, caller)}


@router.get("/smart-folders/{smart_id}/notes", summary="The notes a smart folder shows, a page at a time")
def smart_notes(smart_id: NoteId, caller: Reader, limit: Limit = apiv1.PAGE, cursor: Cursor = None) -> dict[str, Any]:
    offset = apiv1.cursor_in(cursor)
    with SessionLocal() as db:
        return apiv1.smart_page(db, caller, smart_id, offset, limit)


@router.get("/shares/with-me", summary="What others share with the account, with the right")
def shared_with_me(caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        return apiv1.shared_with_me(db, caller)


# --- Attachments (AC-12), trash (AC-13) -----------------------------------------------------------------------------


@router.get("/notes/{note_id}/attachments", responses=NOTE_ERRORS, summary="The attachments of a note")
def note_attachments(note_id: NoteId, caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        note, _access = apiaccess.note(db, caller, note_id)
        return {"attachments": apiv1.attachments_of(db, caller, note.id)}


@router.get("/attachments/{attachment_id}/file", responses=NOTE_ERRORS, response_class=FileResponse,
            summary="The file of an attachment, as a download")
def attachment_file(attachment_id: Annotated[str, Path(min_length=1, max_length=64)], caller: Reader) -> FileResponse:
    with SessionLocal() as db:
        row = apiaccess.attachment(db, caller, attachment_id)
        return _send(attachments.path_of(row.id), row.mime, shown=False, name=row.name)


@router.get("/trash", summary="The own notes and folders in the trash, with the day each goes for good")
def trash_list(caller: Reader) -> dict[str, Any]:
    with SessionLocal() as db:
        return apiv1.trash_of(db, caller)


# --- The description (AC-25) ----------------------------------------------------------------------------------------

DOCS_TEXT = (
    "Programs read the notes of one account with an API token from Settings, Connections: "
    "`Authorization: Bearer nn_api_...`. A token never sees more than its account, never a locked note's content, "
    "and only the folders it is limited to. Errors come as `{\"detail\": {\"code\", \"message\"}}`. Requests with an "
    "`Origin` header are refused, so this page cannot try them out: use `curl` as in the examples. "
    "What stands under `/api/v1/` stays: fields may be added, none renamed or removed."
)


def _example(base: str, path: str, method: str) -> str:
    line = f'curl -H "Authorization: Bearer $NEXNOTES_TOKEN" "{base}{path}"'
    if method == "post":
        line = (f'curl -X POST -H "Authorization: Bearer $NEXNOTES_TOKEN" -H "Content-Type: application/json" '
                f'-d \'{{"checked": true, "text": "Milk"}}\' "{base}{path}"')
    return f"\n\n```sh\n{line}\n```"


def openapi(base: str) -> dict[str, Any]:
    """The description of every route under ``/api/v1/`` and nothing else, with an example each."""
    schema = get_openapi(title="nexnotes API", version=__version__, description=DOCS_TEXT, routes=router.routes,
                         servers=[{"url": base}])
    schema.setdefault("components", {})["securitySchemes"] = {
        "bearerAuth": {"type": "http", "scheme": "bearer", "description": "An API token (`nn_api_...`)."}}
    schema["security"] = [{"bearerAuth": []}]
    for path, operations in schema.get("paths", {}).items():
        for method, operation in operations.items():
            operation["description"] = (operation.get("description") or "") + _example(base, path, method)
    return schema


@docs_router.get("/openapi.json")
def openapi_json(_account: Account, request: Request) -> JSONResponse:
    return JSONResponse(openapi(_base(request)))


@docs_router.get("/docs")
def docs(_account: Account) -> HTMLResponse:
    with SessionLocal() as db:
        off = not apiaccess.enabled(db)
    notice = ('<p class="nn-api-off">The operator has switched the API off. Existing tokens work again once it is '
              "switched on.</p>") if off else ""
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape('nexnotes API')}</title>"
        '<link rel="stylesheet" href="/api-docs/swagger-ui.css"><link rel="stylesheet" href="/api-docs/docs.css">'
        f'</head><body>{notice}<div id="swagger-ui"></div>'
        '<script src="/api-docs/swagger-ui-bundle.js"></script><script src="/api-docs/init.js"></script>'
        "</body></html>"
    )
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})


def refused(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, Refused)
    return JSONResponse({"detail": {"code": exc.code, "message": exc.message, **exc.values}}, status_code=exc.status,
                        headers=exc.headers)


def bad_input(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, apiv1.BadInput)
    return JSONResponse({"detail": {"code": "invalid_input", "message": "The input is not valid.",
                                    "fields": [exc.field]}}, status_code=422)
