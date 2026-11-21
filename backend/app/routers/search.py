"""Search over notes (NOTES-9): hits with excerpts and marks, filters, and the tags to filter by. The rules are in
``services/search.py``."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, FastAPI, Query

from ..deps import Account, DbSession
from ..services import search

search.register_hooks()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Notes missing from the index (a database from before the search, a restored backup) go in before the first
    # request; a thread, so the start does not stop the event loop.
    await asyncio.to_thread(search.register)
    yield


router = APIRouter(prefix="/api/search", tags=["search"], lifespan=lifespan)

FolderId = Annotated[str | None, Query(max_length=36, pattern=r"^[0-9a-fA-F-]+$")]


@router.get("")
def find(db: DbSession, account: Account,
         q: Annotated[str, Query(max_length=search.QUERY_MAX)] = "",
         folder_id: FolderId = None,
         tag: Annotated[str, Query(max_length=search.TAG_MAX + 1)] = "",
         since: datetime | None = None,
         until: datetime | None = None,
         date_field: Literal["updated", "created"] = "updated",
         offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
         limit: Annotated[int, Query(ge=1, le=search.PAGE_MAX)] = search.PAGE) -> dict[str, Any]:
    filters = search.Filters(
        folder_ids=search.folder_tree(db, account, folder_id) if folder_id else None,
        tag=search.fold(search.clean_tag(tag)) if tag else "",
        since=since,
        until=until,
        date_field=date_field,
    )
    result = search.search(db, account, q, filters, offset=offset, limit=limit)
    return {
        "total": result.total,
        "offset": result.offset,
        "items": result.items,
        "unfiltered": result.unfiltered,
        "terms": result.terms,
        "tags": result.tags,
    }


@router.get("/tags")
def tags(db: DbSession, account: Account) -> list[dict[str, Any]]:
    return search.tags(db, account)
