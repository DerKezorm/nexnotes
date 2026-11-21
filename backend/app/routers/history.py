"""The history of a note (NOTES-15) over HTTP: the versions a page at a time, one version, restoring, a copy, and the
last restore for an open editor. The rules are in ``services/history.py``."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, Query
from pydantic import BaseModel, Field

from ..config import get_settings
from ..db import SessionLocal
from ..deps import Account, DbSession
from ..services import history
from .notes import note_out


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    history.register()
    stop = asyncio.Event()
    ticker = None if get_settings().disable_background else asyncio.create_task(history.run_forever(stop))
    try:
        yield
    finally:
        stop.set()
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        # What was written last before a stop waits in ``note_edits`` and becomes a version at the first tick after
        # the next start.


router = APIRouter(prefix="/api/notes", tags=["history"], lifespan=lifespan)


class CopyIn(BaseModel):
    #: The version's date as the person's device writes it, for the copy's title.
    when: str | None = Field(default=None, max_length=100)


@router.get("/{note_id}/history")
def listing(note_id: str, account: Account, db: DbSession, before: int | None = Query(default=None, ge=1),
            limit: int = Query(default=history.PAGE, ge=1, le=history.PAGE_MAX)) -> dict[str, Any]:
    return history.listing(db, account, note_id, before=before, limit=limit)


@router.get("/{note_id}/history/restored")
def restored(note_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    return {"last": history.last_restore(db, account, note_id)}


@router.get("/{note_id}/history/{version_id}")
def read(note_id: str, version_id: int, account: Account, db: DbSession) -> dict[str, Any]:
    return history.read(db, account, note_id, version_id)


@router.post("/{note_id}/history/{version_id}/restore")
async def restore(note_id: str, version_id: int, account: Account) -> dict[str, Any]:
    return await history.restore(account, note_id, version_id)


@router.post("/{note_id}/history/{version_id}/copy", status_code=201)
def copy(note_id: str, version_id: int, body: CopyIn, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        note = history.copy(db, account, note_id, version_id, body.when)
        return note_out(db, note, account)
