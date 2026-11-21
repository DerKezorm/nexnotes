"""Tags over HTTP (NOTES-5): the list for the sidebar, the page of one tag (also as a list of notes with its view,
NOTES-6), renaming and deleting. The rules are in
``services/tags.py``; a tag in the address is its name with or without ``#`` (``/api/tags/einkauf``)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import APIRouter, FastAPI
from fastapi import Path as PathParam
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..services import tags


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Notes from before tags, or read with an older rule, are read again once.
    await asyncio.to_thread(tags.rebuild_if_needed)
    yield


router = APIRouter(prefix="/api/tags", tags=["tags"], lifespan=lifespan)

TagName = Annotated[str, PathParam(min_length=1, max_length=300)]


class RenameIn(BaseModel):
    name: str = Field(max_length=300)
    #: The new name is a tag that exists already: both become one (AC-7).
    merge: bool = False


@router.get("")
def list_tags(db: DbSession, account: Account) -> dict[str, Any]:
    found = tags.list_tags(db, account)
    return {"tags": found, "total": len(found)}


@router.get("/{name}")
def tag_page(name: TagName, db: DbSession, account: Account) -> dict[str, Any]:
    return tags.tag_page(db, account, name)


class ViewIn(BaseModel):
    """How the notes of a tag are sorted and grouped (as a folder's, ``routers/notes_list.py``)."""

    sort: Literal["updated", "created", "title"] | None = None
    direction: Literal["asc", "desc"] | None = None
    grouped: bool | None = None


@router.get("/{name}/notes")
def tag_list(name: TagName, db: DbSession, account: Account) -> JSONResponse:
    # Plain JSON types already: straight out, as the lists of folders (NOTES-6 EC-2).
    return JSONResponse(tags.tag_list(db, account, name))


@router.get("/{name}/stamp")
def tag_stamp(name: TagName, db: DbSession, account: Account) -> dict[str, str]:
    return {"stamp": tags.tag_stamp(db, account, name)}


@router.put("/{name}/view")
def save_view(name: TagName, body: ViewIn, db: DbSession, account: Account) -> dict[str, Any]:
    return tags.save_tag_view(db, account, name, body.model_dump())


@router.put("/{name}")
async def rename(name: TagName, body: RenameIn, account: Account) -> dict[str, Any]:
    return await tags.rename(account, name, body.name, merge=body.merge)


@router.delete("/{name}")
async def remove(name: TagName, account: Account) -> dict[str, Any]:
    return await tags.remove(account, name)
