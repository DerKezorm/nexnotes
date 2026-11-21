"""Smart folders over HTTP (NOTES-7): make, change, order and delete them, the preview while making one, and the list
of notes one shows (``services/smart_folders.py``; the conditions are the search's, ``services/search.py``)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import APIRouter, FastAPI, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..services import attachments, smart_folders


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    yield


router = APIRouter(prefix="/api/smart-folders", tags=["smart-folders"], lifespan=lifespan)

#: The device's time zone by its name (``Europe/Berlin``): periods count from today there (EC-3).
Zone = Annotated[str, Query(max_length=64)]
Conditions = Annotated[list[Any], Field(max_length=50)]


class FolderIn(BaseModel):
    name: str = Field(max_length=200)
    match: Literal["all", "any"] = "all"
    conditions: Conditions


class FolderChange(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    match: Literal["all", "any"] | None = None
    conditions: Conditions | None = None


class OrderIn(BaseModel):
    ids: list[Annotated[str, Field(max_length=36)]] = Field(max_length=500)


class PreviewIn(BaseModel):
    match: Literal["all", "any"] = "all"
    conditions: Conditions
    tz: str = Field(default="", max_length=64)


class ViewIn(BaseModel):
    #: ``gallery``: the attachments of its notes (a smart folder with the condition "Anhang").
    mode: Literal["list", "tiles", "gallery"] | None = None
    sort: Literal["updated", "created", "title"] | None = None
    direction: Literal["asc", "desc"] | None = None
    grouped: bool | None = None


@router.get("")
def list_folders(db: DbSession, account: Account) -> dict[str, Any]:
    return {"items": [smart_folders.out(folder) for folder in smart_folders.list_for(db, account)]}


@router.post("", status_code=201)
def make(body: FolderIn, db: DbSession, account: Account) -> dict[str, Any]:
    return smart_folders.out(smart_folders.create(db, account, body.name, body.match, body.conditions))


@router.put("/order")
def order(body: OrderIn, db: DbSession, account: Account) -> dict[str, Any]:
    return {"items": [smart_folders.out(folder) for folder in smart_folders.reorder(db, account, body.ids)]}


@router.post("/preview")
def preview(body: PreviewIn, db: DbSession, account: Account) -> JSONResponse:
    return JSONResponse(smart_folders.preview(db, account, body.match, body.conditions, body.tz))


@router.get("/{folder_id}")
def read_folder(folder_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    return smart_folders.out(smart_folders.own(db, account, folder_id))


@router.put("/{folder_id}")
def change(folder_id: str, body: FolderChange, db: DbSession, account: Account) -> dict[str, Any]:
    folder = smart_folders.update(db, account, folder_id, name=body.name, match=body.match,
                                  conditions=body.conditions)
    return smart_folders.out(folder)


@router.delete("/{folder_id}", status_code=204)
def remove(folder_id: str, db: DbSession, account: Account) -> Response:
    smart_folders.remove(db, account, folder_id)
    return Response(status_code=204)


@router.get("/{folder_id}/notes")
def notes(folder_id: str, db: DbSession, account: Account, tz: Zone = "") -> JSONResponse:
    # Plain JSON types already: straight out, as the lists of folders (NOTES-6 EC-2).
    return JSONResponse(smart_folders.read(db, account, folder_id, tz))


@router.get("/{folder_id}/stamp")
def stamp(folder_id: str, db: DbSession, account: Account, tz: Zone = "") -> dict[str, str]:
    return {"stamp": smart_folders.stamp(db, account, folder_id, tz)}


@router.put("/{folder_id}/view")
def save_view(folder_id: str, body: ViewIn, db: DbSession, account: Account) -> dict[str, Any]:
    return smart_folders.save_view(db, account, folder_id, body.model_dump())


GalleryKind = Annotated[str | None, Query(pattern="^(" + "|".join(attachments.GALLERY_KINDS) + ")$")]


@router.get("/{folder_id}/attachments")
def gallery(
    folder_id: str,
    db: DbSession,
    account: Account,
    tz: Zone = "",
    kind: GalleryKind = None,
    sort: Annotated[str, Query(pattern="^(newest|largest)$")] = "newest",
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 120,
) -> dict[str, Any]:
    """The attachments of the notes that fit now, in the shape of ``/api/attachments`` (the gallery)."""
    return smart_folders.gallery(db, account, folder_id, tz, kind, sort, offset, limit)
