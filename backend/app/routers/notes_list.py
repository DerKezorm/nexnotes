"""Lists of notes over HTTP (NOTES-6): a folder's notes or all of them with the account's view, the stamp lists ask
for to load again, the view per folder, pinning and colors (``services/notes_list.py``)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..services import notes_list
from .notes import item_out


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    notes_list.register()
    with SessionLocal() as db:
        counted = notes_list.count_missing(db)
    if counted:
        notes_list.logger.info("Checklists counted notes=%s", counted)
    yield


router = APIRouter(tags=["note-list"], lifespan=lifespan)


class ViewIn(BaseModel):
    #: The folder; left out (or ``all``): "All notes".
    folder_id: str | None = Field(default=None, max_length=36)
    mode: Literal["list", "tiles"] | None = None
    sort: Literal["updated", "created", "title"] | None = None
    direction: Literal["asc", "desc"] | None = None
    grouped: bool | None = None


class PinIn(BaseModel):
    pinned: bool


class ColorIn(BaseModel):
    color: str = Field(max_length=16)


@router.get("/api/note-list")
def read_list(db: DbSession, account: Account, folder_id: str | None = Query(default=None, max_length=36)
              ) -> JSONResponse:
    # Plain JSON types already: straight out, without FastAPI's walk over 10,000 items (EC-2).
    return JSONResponse(notes_list.read(db, account, folder_id))


@router.get("/api/note-list/stamp")
def read_stamp(db: DbSession, account: Account, folder_id: str | None = Query(default=None, max_length=36)
               ) -> dict[str, str]:
    return {"stamp": notes_list.stamp(db, account, folder_id)}


@router.put("/api/note-list/view")
def save_view(body: ViewIn, db: DbSession, account: Account) -> dict[str, Any]:
    return notes_list.save_view(db, account, body.folder_id, body.model_dump())


@router.put("/api/notes/{note_id}/pin")
def pin(note_id: str, body: PinIn, db: DbSession, account: Account) -> dict[str, Any]:
    note = notes_list.set_pinned(db, account, note_id, body.pinned)
    return {**item_out(note), "pinned": notes_list.pinned_for(db, account, note)}


@router.put("/api/notes/{note_id}/color")
def color(note_id: str, body: ColorIn, db: DbSession, account: Account) -> dict[str, Any]:
    return item_out(notes_list.set_color(db, account, note_id, body.color))
