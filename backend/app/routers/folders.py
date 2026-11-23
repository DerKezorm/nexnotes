"""Folders and the inbox (NOTES-4): the tree of the sidebar, making, renaming, symbol and colour, moving folders and
notes, the member's order, the trash and the way back from it. The rules are in ``services/folders.py``."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from fastapi import Path as PathParam
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..services import appsync, folders, guide, notes_list
from ..services import notes as notes_service
from ..services import shares as shares_service
from ..services.inbox import inbox_for

router = APIRouter(prefix="/api/folders", tags=["folders"])

FolderId = Annotated[str, PathParam(min_length=1, max_length=36, pattern=r"^[A-Za-z0-9_-]+$")]
#: An id in a body: the same shape as in the address.
Id = Annotated[str, Field(min_length=1, max_length=36, pattern=r"^[A-Za-z0-9_-]+$")]
#: The most folders or notes one move carries.
MOVE_MAX = 1000


class FolderIn(BaseModel):
    # Longer than the limit on purpose: the service cleans first, then says "at most 60" in its own words.
    name: str = Field(max_length=1000)
    parent_id: Id | None = None
    icon: str = Field(default="", max_length=32)
    color: str = Field(default="", max_length=16)


class FolderChange(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)


class MoveIn(BaseModel):
    #: The folder to move into; ``None`` is the top (folders only).
    target_id: Id | None = None
    folder_ids: list[Id] = Field(default_factory=list, max_length=MOVE_MAX)
    note_ids: list[Id] = Field(default_factory=list, max_length=MOVE_MAX)


class OrderIn(BaseModel):
    parent_id: Id | None = None
    ids: list[Id] = Field(max_length=MOVE_MAX)


@router.get("")
def tree(account: Account, db: DbSession) -> dict[str, Any]:
    # A new account's guide (NOTES-26) still in the queue is there before the folders are shown.
    guide.catch_up(db, account.id)
    # Read before the tree: a change made while it is read shows in the next stamp, never lost between the two. The
    # inbox first, made on the first request, so that making it does not count as a change.
    inbox_for(db, account.id)
    seen = appsync.seen_stamp(db, account)
    found = folders.tree(db, account.id)
    # The numbers of the tiles above the tree (NOTES-4 AC-16): "Alle Notizen", "Mit mir geteilt", "Titel prüfen".
    found["places"] = notes_list.places(db, account, found["inbox"]["id"])
    found["stamp"] = seen
    return found


@router.get("/stamp")
def stamp(account: Account, db: DbSession) -> dict[str, str]:
    """Changes whenever the tree, its tiles or the smart folders would show something else, also when a device, MCP or
    the API changed it (NOTES-24): the browser asks every few seconds and loads the tree again only then."""
    return {"stamp": appsync.seen_stamp(db, account)}


@router.post("", status_code=201)
def create(body: FolderIn, account: Account, db: DbSession) -> dict[str, Any]:
    return folders.create(db, account.id, name=body.name, parent_id=body.parent_id, icon=body.icon, color=body.color)


@router.get("/inbox")
def inbox(account: Account, db: DbSession) -> dict[str, Any]:
    return folders.inbox_view(db, account.id)


@router.post("/move")
def move(body: MoveIn, account: Account, db: DbSession) -> dict[str, int]:
    done = folders.move(db, account.id, target_id=body.target_id, folder_ids=body.folder_ids, note_ids=body.note_ids)
    # Out of a shared folder (NOTES-13 EC-2) or into one: whoever has a moved note open is checked again at once, so
    # that a writer who lost the right stops now, not after the room's next round (AC-5).
    if shares_service.moves_change_rights(db, account.id):
        notes_service.nudge_all()
    return done


@router.put("/order")
def order(body: OrderIn, account: Account, db: DbSession) -> list[dict[str, Any]]:
    return folders.reorder(db, account.id, parent_id=body.parent_id, ids=body.ids)


@router.get("/{folder_id}/impact")
def impact(folder_id: FolderId, account: Account, db: DbSession) -> dict[str, int]:
    return folders.impact(db, account.id, folder_id)


@router.patch("/{folder_id}")
def change(folder_id: FolderId, body: FolderChange, account: Account, db: DbSession) -> dict[str, Any]:
    return folders.change(db, account.id, folder_id, name=body.name, icon=body.icon, color=body.color)


@router.delete("/{folder_id}")
def trash(folder_id: FolderId, account: Account, db: DbSession) -> dict[str, Any]:
    done = folders.trash(db, account.id, folder_id)
    # Its notes may be open elsewhere (shared, NOTES-13; NOTES-4 EC-9): every editor looks again and hears they went.
    notes_service.nudge_all()
    return done


@router.post("/{folder_id}/restore")
def restore(folder_id: FolderId, account: Account, db: DbSession) -> dict[str, Any]:
    return folders.restore(db, account.id, folder_id)
