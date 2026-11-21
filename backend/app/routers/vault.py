"""The vault (NOTES-16) over HTTP: setting it up, opening it, a new password, starting anew, locking and unlocking
notes, saving a locked note. Everything the server gets of a locked note is encrypted on the device; the rules are in
``services/vault.py``."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ..db import SessionLocal
from ..deps import Account, DbSession, confirm_fresh
from ..errors import error
from ..services import vault

logger = logging.getLogger("nexnotes.vault")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    vault.register()
    await asyncio.to_thread(vault.catch_up)
    yield


router = APIRouter(prefix="/api/vault", tags=["vault"], lifespan=lifespan)

NoteId = Annotated[str, PathParam(min_length=1, max_length=36)]
B64 = Field(max_length=4096)


class Kdf(BaseModel):
    name: str = Field(max_length=16)
    hash: str = Field(max_length=16)
    iterations: int
    salt: str = Field(max_length=128)


class SetupIn(BaseModel):
    kdf: Kdf
    wrapped_key: str = B64
    auth: str = B64
    #: "Ich habe verstanden, dass ein vergessenes Passwort nicht zurückgesetzt werden kann." (AC-1)
    understood: bool = False


class UnlockIn(BaseModel):
    auth: str = B64


class PasswordIn(BaseModel):
    auth_old: str = B64
    kdf: Kdf
    wrapped_key: str = B64
    auth: str = B64


class ResetIn(SetupIn):
    #: The number of locked notes the device named; they go for good (EC-2).
    count: int = Field(ge=0)
    #: The account's password once more, and a code of its second factor when it has one (``deps.confirm_fresh``);
    #: an account of a provider signs in there again instead.
    current_password: str = Field(default="", max_length=200)
    code: str = Field(default="", max_length=40)


class UnlockNoteIn(BaseModel):
    #: The names of the attachments as the device read them from their encrypted header.
    names: dict[str, str] = Field(default_factory=dict, max_length=10_000)


class SaveIn(BaseModel):
    note: str = Field(max_length=36)
    #: The encrypted Yjs state, base64.
    content: str
    base_rev: int
    #: The revision the content is sealed for (in its AAD): ``rev`` of the note now plus one.
    rev: int
    epoch: int
    title: str = Field(default="", max_length=1000)
    restored_from: int | None = None


@router.get("", summary="The account's vault: set up, how to derive its keys, its epoch, the locked notes")
def get_vault(db: DbSession, account: Account) -> dict[str, Any]:
    return vault.status(db, account)


@router.post("/setup", status_code=201, summary="Set the vault up (the first lock)")
def setup(body: SetupIn, db: DbSession, account: Account) -> dict[str, Any]:
    return vault.setup(db, account, body.kdf.model_dump(), body.wrapped_key, body.auth, body.understood)


@router.post("/unlock", summary="The wrapped vault key for the right check value; wrong ones are counted")
def unlock(body: UnlockIn, db: DbSession, account: Account) -> dict[str, Any]:
    return vault.unlock(db, account, body.auth)


@router.post("/password", summary="A new vault password: the same key wrapped anew")
def change_password(body: PasswordIn, db: DbSession, account: Account) -> dict[str, Any]:
    return vault.change_password(db, account, body.auth_old, body.kdf.model_dump(), body.wrapped_key, body.auth)


@router.post("/reset", summary="Forgotten password: a new vault, every locked note goes for good")
async def reset(body: ResetIn, request: Request, account: Account) -> dict[str, Any]:
    # A stolen session must not be enough to destroy every locked note: the member proves it is them once more.
    def confirm() -> None:
        with SessionLocal() as db:
            confirm_fresh(request, db, account, body.current_password, body.code)

    await asyncio.to_thread(confirm)
    return await vault.reset(account, body.count, body.kdf.model_dump(), body.wrapped_key, body.auth,
                             body.understood)


# --- Locking and unlocking ----------------------------------------------------------------------------------------


@router.post("/notes/{note_id}/lock/start", summary="Begin locking a note: what the device must encrypt")
async def lock_start(note_id: NoteId, account: Account) -> dict[str, Any]:
    return await vault.lock_start(account, note_id)


@router.post("/notes/{note_id}/lock", summary="Finish locking a note once every part is laid down")
async def lock_finish(note_id: NoteId, account: Account) -> dict[str, Any]:
    return await vault.lock_finish(account, note_id)


@router.post("/notes/{note_id}/lock/cancel", status_code=204, summary="Break a lock off")
async def lock_cancel(note_id: NoteId, account: Account) -> None:
    await vault.lock_cancel(account, note_id, vault.LOCK)


@router.post("/notes/{note_id}/unlock/start", summary="Begin unlocking a note: everything encrypted it holds")
async def unlock_start(note_id: NoteId, account: Account) -> dict[str, Any]:
    return await vault.unlock_start(account, note_id)


@router.post("/notes/{note_id}/unlock", summary="Finish unlocking a note once every plain part is laid down")
async def unlock_finish(note_id: NoteId, body: UnlockNoteIn, account: Account) -> dict[str, Any]:
    return await vault.unlock_finish(account, note_id, body.names)


@router.post("/notes/{note_id}/unlock/cancel", status_code=204, summary="Break an unlock off")
async def unlock_cancel(note_id: NoteId, account: Account) -> None:
    await vault.lock_cancel(account, note_id, vault.UNLOCK)


@router.put("/stage", summary="One part of a lock or unlock (the bytes as the body)")
async def stage(
    request: Request,
    account: Account,
    note: Annotated[str, Query(max_length=36)],
    step: Annotated[str, Query(max_length=8)],
    part: Annotated[str, Query(max_length=60)],
) -> dict[str, Any]:
    try:
        size = await vault.stage(account, note, step, part, request.stream())
    except ClientDisconnect:
        raise error("upload_broken", "The upload broke off.", 400) from None
    return {"part": part, "size": size}


# --- A locked note open on a device -------------------------------------------------------------------------------


@router.get("/notes/{note_id}", summary="The encrypted content of a locked note and its revision")
def sealed(note_id: NoteId, db: DbSession, account: Account) -> dict[str, Any]:
    return vault.sealed_of(db, account, note_id)


@router.post("/save", summary="Save a locked note (encrypted on the device)")
async def save(body: SaveIn, account: Account) -> dict[str, Any]:
    return await asyncio.to_thread(vault.save, account, body.note, body.content, body.base_rev, body.epoch,
                                   body.title, body.restored_from, body.rev)


@router.put("/attachments", status_code=201, summary="A new attachment of a locked note, encrypted on the device")
async def put_attachment(
    request: Request,
    account: Account,
    note: Annotated[str, Query(max_length=36)],
    attachment_id: Annotated[str, Query(alias="id", max_length=32)],
) -> dict[str, Any]:
    declared_text = request.headers.get("content-length")
    declared = int(declared_text) if declared_text and declared_text.isdigit() else None
    try:
        return await vault.store_attachment(account, note, attachment_id, request.stream(), declared)
    except ClientDisconnect:
        raise error("upload_broken", "The upload broke off.", 400) from None
