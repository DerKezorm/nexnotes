"""The trash (NOTES-15) over HTTP: the list, back, gone for good, emptying. The rules are in ``services/trash.py``."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI
from fastapi import Path as PathParam
from pydantic import BaseModel

from ..deps import Account, DbSession
from ..services import trash


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    trash.register()
    yield


router = APIRouter(prefix="/api/trash", tags=["trash"], lifespan=lifespan)

Id = Annotated[str, PathParam(min_length=1, max_length=36, pattern=r"^[0-9a-fA-F-]+$")]


class EmptyIn(BaseModel):
    #: The moment the page listed the trash (``now`` of ``GET /api/trash``): what was deleted after it stays.
    until: datetime


@router.get("")
def listing(account: Account, db: DbSession) -> dict[str, Any]:
    return trash.listing(db, account)


@router.post("/notes/{note_id}/restore")
def restore_note(note_id: Id, account: Account, db: DbSession) -> dict[str, Any]:
    return trash.restore_note(db, account, note_id)


@router.post("/folders/{folder_id}/restore")
def restore_folder(folder_id: Id, account: Account, db: DbSession) -> dict[str, Any]:
    return trash.restore_folder(db, account, folder_id)


@router.delete("/notes/{note_id}")
async def purge_note(note_id: Id, account: Account) -> dict[str, int]:
    return await trash.purge_note(account, note_id)


@router.delete("/folders/{folder_id}")
async def purge_folder(folder_id: Id, account: Account) -> dict[str, int]:
    return await trash.purge_folder(account, folder_id)


@router.post("/empty")
async def empty(body: EmptyIn, account: Account) -> dict[str, int]:
    return await trash.empty(account, body.until)
