"""Tags over HTTP (NOTES-5): the list for the sidebar, the page of one tag, renaming and deleting. The rules are in
``services/tags.py``; a tag in the address is its name with or without ``#`` (``/api/tags/einkauf``)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI
from fastapi import Path as PathParam
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


@router.put("/{name}")
async def rename(name: TagName, body: RenameIn, account: Account) -> dict[str, Any]:
    return await tags.rename(account, name, body.name, merge=body.merge)


@router.delete("/{name}")
async def remove(name: TagName, account: Account) -> dict[str, Any]:
    return await tags.remove(account, name)
