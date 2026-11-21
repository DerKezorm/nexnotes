"""The writing half of the API for programs (NOTES-25 AC-14 to AC-22), beside the reading half
(``routers/api_v1.py``), behind the same walls and in the same description; every route here needs a token that may
write.

A change of a note's text (appending, ticking, replacing it, an uploaded file at its end) goes through the note's live
room as the account through the token (``history.acting_via("api:<name>")``): open editors follow at once, nothing
typed meanwhile is lost, the history names "<account> via API token <name>", and members the note is shared with hear
of it as of any change of the account (AC-22). Replacing the whole text needs the state it is based on (``etag`` in
``If-Match`` or ``base``): any change since gives ``note_changed`` and changes nothing (AC-17, EC-4).

Every writing request is logged with the token's number, the route and the id of the note or folder; never the token,
a title or a text (AC-24).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ..db import SessionLocal
from ..errors import error
from ..models_api import EXTERNAL_REF_MAX
from ..notedoc import doc as notedoc
from ..notedoc import edit
from ..services import apiaccess, apiwrite, attachments, history, notes, tags
from ..services.apiaccess import Caller, Refused
from .api_v1 import ERRORS, NOTE_ERRORS, PREFIX, NoteId, _in_room, _note_answer, wall

logger = logging.getLogger("nexnotes.api")

router = APIRouter(prefix=PREFIX, tags=["api"], responses=ERRORS)


def _writer(request: Request) -> Caller:
    return wall(request, write=True)


Writer = Annotated[Caller, Depends(_writer)]
FolderId = Annotated[str, Path(min_length=1, max_length=36)]


def _expected(request: Request, base: str | None = None) -> str | None:
    """The state a change is based on: ``If-Match`` (with or without quotes, ``W/``) or ``base``."""
    header = (request.headers.get("if-match") or "").strip()
    header = header.removeprefix("W/")
    header = header.strip().strip('"')
    return header or (base.strip() if base else None) or None


def _check(caller: Caller, note_id: str) -> str:
    with SessionLocal() as db:
        return apiaccess.note(db, caller, note_id, write=True)[0].id


async def _state(note_id: str) -> str:
    return await _in_room(note_id, notedoc.state_tag)


def _changed(current: str) -> Refused:
    return Refused("note_changed", headers={"ETag": f'"{current}"'}, etag=current)


# --- New notes (AC-14, EC-13) ---------------------------------------------------------------------------------------


class NoteIn(BaseModel):
    markdown: str | None = Field(default=None, description="The text as Markdown, at most 512 KB.")
    title: str | None = Field(default=None, max_length=1000, description="At most 120 characters.")
    folder_id: str | None = Field(default=None, max_length=36, description="A folder's id or `inbox`.")
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)
    paper: str | None = Field(default=None, max_length=8)
    pinned: bool = False
    external_ref: str | None = Field(default=None, min_length=1, max_length=EXTERNAL_REF_MAX,
                                     description="Your own reference: the same again gives the same note (200).")


@router.post("/notes", status_code=201, responses=NOTE_ERRORS,
             summary="Make a note from Markdown; in the inbox unless a folder is named")
async def make_note(body: NoteIn, caller: Writer, request: Request) -> JSONResponse:
    note_id, new = await asyncio.to_thread(apiwrite.create, caller, body)
    answer = await _note_answer(caller, note_id, request, True)
    answer.status_code = 201 if new else 200
    return answer


# --- The head (AC-15) -----------------------------------------------------------------------------------------------


class NoteChange(BaseModel):
    title: str | None = Field(default=None, max_length=1000)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)
    paper: str | None = Field(default=None, max_length=8)
    pinned: bool | None = None
    folder_id: str | None = Field(default=None, max_length=36, description="Move the note (its owner only).")


@router.patch("/notes/{note_id}", responses=NOTE_ERRORS,
              summary="Change title, symbol, color, paper, pinning or folder of a note")
async def change_note(note_id: NoteId, body: NoteChange, caller: Writer, request: Request) -> JSONResponse:
    fields = set(body.model_fields_set)
    if not fields:
        raise apiwrite.invalid("title")
    if "title" in fields:
        apiwrite.checked_title(body.title)
    expected = _expected(request)
    if expected:
        found = await asyncio.to_thread(_check, caller, note_id)
        current = await _state(found)
        if current != expected:
            raise _changed(current)
    head = fields - {"title"}
    if head:
        moved = await asyncio.to_thread(apiwrite.change_head, caller, note_id, body, head)
        if moved:
            notes.nudge_all()
    if "title" in fields:
        found = await asyncio.to_thread(_check, caller, note_id)
        with history.acting_via(caller.label):
            await notes.set_title(caller.account, found, body.title or "")
        logger.info("API note changed note=%s fields=title token_id=%s", found, caller.token_id)
    return await _note_answer(caller, note_id, request, True)


# --- The text (AC-16, AC-17, EC-4) ----------------------------------------------------------------------------------


class AppendIn(BaseModel):
    markdown: str


@router.post("/notes/{note_id}/append", responses=NOTE_ERRORS, summary="Add Markdown at the end of a note")
async def append(note_id: NoteId, body: AppendIn, caller: Writer, request: Request) -> JSONResponse:
    markdown = apiwrite.checked_markdown(body.markdown)
    if not markdown.strip():
        raise apiwrite.invalid("markdown")
    found = await asyncio.to_thread(_check, caller, note_id)
    with history.acting_via(caller.label):
        await _in_room(found, lambda doc: edit.append_markdown(doc, markdown), caller.account.id)
    logger.info("API text appended note=%s token_id=%s", found, caller.token_id)
    return await _note_answer(caller, found, request, True)


class ContentIn(BaseModel):
    markdown: str
    #: The ``etag`` the text was read with, when ``If-Match`` is not sent.
    base: str | None = Field(default=None, max_length=64)


@router.put("/notes/{note_id}/content", responses={
    **NOTE_ERRORS, 412: {"description": "`note_changed`: the note changed since; the answer names its `etag`."},
    428: {"description": "`precondition_required`: neither `If-Match` nor `base`."}},
    summary="Replace the whole text; paragraphs that stay the same keep everything they had")
async def replace(note_id: NoteId, body: ContentIn, caller: Writer, request: Request) -> JSONResponse:
    expected = _expected(request, body.base)
    if not expected:
        raise Refused("precondition_required")
    markdown = apiwrite.checked_markdown(body.markdown)
    found = await asyncio.to_thread(_check, caller, note_id)

    def run(doc: Any) -> tuple[str, Any]:
        # Asked and written under the room's lock: nothing comes between.
        current = notedoc.state_tag(doc)
        if current != expected:
            return "changed", current
        return "done", edit.replace_markdown(doc, markdown)

    with history.acting_via(caller.label):
        outcome, value = await _in_room(found, run, caller.account.id)
    if outcome == "changed":
        raise _changed(value)
    logger.info("API text replaced note=%s kept=%s removed=%s added=%s token_id=%s", found, value["kept"],
                value["removed"], value["added"], caller.token_id)
    return await _note_answer(caller, found, request, True)


# --- Trash (AC-18) --------------------------------------------------------------------------------------------------


@router.delete("/notes/{note_id}", status_code=204, responses=NOTE_ERRORS,
               summary="Put a note into the trash (never away for good)")
async def trash_note(note_id: NoteId, caller: Writer) -> Response:
    found = await asyncio.to_thread(_check, caller, note_id)
    await notes.delete_note(caller.account, found)
    logger.info("API note to the trash note=%s token_id=%s", found, caller.token_id)
    return Response(status_code=204)


@router.post("/notes/{note_id}/restore", responses=NOTE_ERRORS, summary="Bring a note back from the trash")
async def restore_note(note_id: NoteId, caller: Writer, request: Request) -> JSONResponse:
    found = await asyncio.to_thread(apiwrite.restore_note, caller, note_id)
    return await _note_answer(caller, found, request, True)


# --- Attachments (AC-21) --------------------------------------------------------------------------------------------


@router.post("/notes/{note_id}/attachments", status_code=201, responses={
    **NOTE_ERRORS, 413: {"description": "`attachment_too_large`: larger than the operator allows per file."},
    507: {"description": "`storage_limit_reached`: the storage of the account is full."}},
    summary="Upload a file (the request body) as a block at the end of the note")
async def upload(note_id: NoteId, caller: Writer, request: Request,
                 name: Annotated[str, Query(max_length=1000, description="The file's name.")] = "") -> JSONResponse:
    found = await asyncio.to_thread(_check, caller, note_id)
    declared_text = request.headers.get("content-length")
    declared = int(declared_text) if declared_text and declared_text.isdigit() else None
    started: attachments.Upload | Any = None
    try:
        with SessionLocal() as db:
            started = attachments.begin(db, caller.account, found, attachments.new_id(), name or "file", declared)
        work = await attachments.receive(started, request.stream())
        row, _new = await asyncio.to_thread(attachments.finish, started, work)
    except attachments.AttachmentError as exc:
        raise exc.http() from exc
    except ClientDisconnect:
        raise error("upload_broken", "The upload broke off.", 400) from None
    finally:
        if isinstance(started, attachments.Upload):
            attachments.release(started)
    block = {"type": "image" if row.kind == "image" else "attachment", "attrs": {"id": row.id, "name": row.name}}
    with history.acting_via(caller.label):
        await _in_room(found, lambda doc: edit.append_blocks(doc, [block]), caller.account.id)
    logger.info("API file uploaded note=%s attachment=%s token_id=%s", found, row.id, caller.token_id)
    out = attachments.out(row)
    return JSONResponse({"id": out["id"], "name": out["name"], "kind": out["kind"], "mime": out["mime"],
                         "size": out["size"], "file": f"/api/v1/attachments/{out['id']}/file"}, status_code=201)


# --- Folders (AC-19) ------------------------------------------------------------------------------------------------


class FolderIn(BaseModel):
    name: str = Field(max_length=1000, description="At most 60 characters.")
    parent_id: str | None = Field(default=None, max_length=36)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)


class FolderChange(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)
    parent_id: str | None = Field(default=None, max_length=36, description="Move it; null to the top.")


@router.post("/folders", status_code=201, summary="Make a folder, at the top or in another own folder")
def make_folder(body: FolderIn, caller: Writer) -> dict[str, Any]:
    return apiwrite.make_folder(caller, body)


@router.patch("/folders/{folder_id}", summary="Rename, give a symbol or color, or move an own folder")
def change_folder(folder_id: FolderId, body: FolderChange, caller: Writer) -> dict[str, Any]:
    out, moved = apiwrite.change_folder(caller, folder_id, body, set(body.model_fields_set))
    if moved:
        notes.nudge_all()
    return out


@router.delete("/folders/{folder_id}", summary="Put an own folder with everything in it into the trash")
def trash_folder(folder_id: FolderId, caller: Writer) -> dict[str, Any]:
    done = apiwrite.trash_folder(caller, folder_id)
    notes.nudge_all()
    return done


@router.post("/folders/{folder_id}/restore", summary="Bring a folder back from the trash with what went with it")
def restore_folder(folder_id: FolderId, caller: Writer) -> dict[str, Any]:
    return apiwrite.restore_folder(caller, folder_id)


# --- Tags (AC-20) ---------------------------------------------------------------------------------------------------


class TagChange(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    #: Onto a tag that exists already: only with ``merge`` (else ``tag_exists``).
    merge: bool = False


@router.patch("/tags/{name}", summary="Rename a tag in the account's own notes")
async def rename_tag(name: Annotated[str, Path(min_length=1, max_length=200)], body: TagChange,
                     caller: Writer) -> dict[str, Any]:
    with SessionLocal() as db:
        scope = caller.scope(db)
    with history.acting_via(caller.label):
        done = await tags.rename(caller.account, name, body.name, merge=body.merge, folders=scope)
    logger.info("API tag renamed notes=%s token_id=%s", done["changed"], caller.token_id)
    return {"name": done["label"], "changed": done["changed"], "kept": done["kept"]}
