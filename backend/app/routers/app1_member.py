"""What a member arranges from the app (``/api/app/1``, interface 0.4): folders (NOTESIOS-5), how lists look
(NOTESIOS-6), tags (NOTESIOS-5) and the member's own settings (NOTESIOS-1 AC-11).

Each route takes a device's token (``routers/app1.device``) and calls the same services as the browser, so rules and
error codes are the browser's. Folders are the account's own only; a folder shared with it is changed in the browser
for now (NOTESIOS-14). Everything here gives what it changed a new number for ``changes`` (``services/appsync.py``).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal
from ..errors import error
from ..models import Account as AccountRow
from ..models import Folder, utcnow
from ..services import appsync, avatars, folders, nextasks, notes, notes_list, shares, tags
from ..services.inbox import inbox_for
from ..services.nextasks import NextasksError
from .app1 import Device, account_out

logger = logging.getLogger("nexnotes.app")

router = APIRouter(prefix="/api/app/1", tags=["app"])


# --- Folders (NOTESIOS-5) ---------------------------------------------------------------------------------------


def _folder_out(db: Any, account_id: int, folder: Folder) -> dict[str, Any]:
    return appsync.view_of(db, account_id, folders=[folder]).folder(folder)


def _parent(db: Any, account_id: int, parent_id: str | None) -> str | None:
    """``inbox`` is no place for a folder; the browser's rule answers."""
    if parent_id == "inbox":
        return inbox_for(db, account_id).id
    return parent_id or None


class NewFolder(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(max_length=1000)
    parent_id: str | None = Field(default=None, max_length=64)
    icon: str = Field(default="", max_length=64)
    color: str = Field(default="", max_length=16)


@router.post("/folders", status_code=201, summary="A new folder with the device's id; the same id again is the same")
def create_folder(found: Device, body: NewFolder, response: Response) -> dict[str, Any]:
    account = found.account
    if not notes.DEVICE_ID.fullmatch(body.id):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    with SessionLocal() as db:
        existing = db.get(Folder, body.id)
        if existing is not None:
            if existing.owner_id != account.id:
                raise error("folder_id_taken", "This folder id is taken.", 409)
            response.status_code = 200
            return _folder_out(db, account.id, existing)
        try:
            folders.create(db, account.id, name=body.name, parent_id=_parent(db, account.id, body.parent_id),
                           icon=body.icon, color=body.color, folder_id=body.id)
        except IntegrityError:
            # The same id at the same moment from a second request: the first one made it.
            db.rollback()
            existing = db.get(Folder, body.id)
            if existing is None or existing.owner_id != account.id:
                raise error("folder_id_taken", "This folder id is taken.", 409) from None
            response.status_code = 200
            return _folder_out(db, account.id, existing)
        made = db.get(Folder, body.id)
        assert made is not None
        logger.info("Folder created by a device folder=%s", made.id)
        return _folder_out(db, account.id, made)


class FolderPatch(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    icon: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, max_length=16)
    parent_id: str | None = Field(default=None, max_length=64)


def _own_folder(db: Any, account_id: int, folder_id: str) -> Folder:
    if folder_id == "inbox":
        raise error("inbox_fixed", "The inbox cannot be renamed, moved or deleted.")
    folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
    if folder is None or folder.owner_id != account_id:
        raise error("not_found", "Not found.", 404)
    return folder


@router.patch("/folders/{folder_id}", summary="Rename, symbol, colour, move a folder")
def change_folder(folder_id: str, found: Device, body: FolderPatch) -> dict[str, Any]:
    account = found.account
    nudge = False
    moving = "parent_id" in body.model_fields_set
    with SessionLocal() as db:
        _own_folder(db, account.id, folder_id)
        target = _parent(db, account.id, body.parent_id) if moving else None
        # All or nothing: everything checked first, then written.
        folders.check_change(db, account.id, folder_id, name=body.name, icon=body.icon, color=body.color,
                             moving=moving, target_id=target)
        if body.name is not None or body.icon is not None or body.color is not None:
            folders.change(db, account.id, folder_id, name=body.name, icon=body.icon, color=body.color)
        if moving:
            folders.move(db, account.id, target_id=target, folder_ids=[folder_id], note_ids=[])
            nudge = shares.moves_change_rights(db, account.id)
        result = _folder_out(db, account.id, _own_folder(db, account.id, folder_id))
    if nudge:
        notes.nudge_all()
    return result


@router.delete("/folders/{folder_id}", summary="A folder into the trash, with its subfolders and notes")
def trash_folder(folder_id: str, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _own_folder(db, found.account.id, folder_id)
        done = folders.trash(db, found.account.id, folder_id)
    notes.nudge_all()
    return {"id": done["id"], "folders": done["folders"], "notes": done["notes"]}


@router.post("/folders/{folder_id}/restore", summary="A folder back from the trash, with what went with it")
def restore_folder(folder_id: str, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _own_folder(db, found.account.id, folder_id)
        folders.restore(db, found.account.id, folder_id)
        return _folder_out(db, found.account.id, _own_folder(db, found.account.id, folder_id))


class OrderIn(BaseModel):
    parent_id: str | None = Field(default=None, max_length=64)
    ids: list[str] = Field(max_length=1000)


@router.put("/folders/order", summary="The order of the folders under one parent")
def order_folders(found: Device, body: OrderIn) -> dict[str, Any]:
    account = found.account
    with SessionLocal() as db:
        folders.reorder(db, account.id, parent_id=_parent(db, account.id, body.parent_id), ids=body.ids)
        parent = _parent(db, account.id, body.parent_id)
        rows = db.scalars(select(Folder).where(Folder.owner_id == account.id, Folder.parent_id.is_(None)
                                               if parent is None else Folder.parent_id == parent,
                                               Folder.deleted_at.is_(None), Folder.kind != "inbox")
                          .order_by(Folder.position, Folder.name))
        rows = list(rows)
        view = appsync.view_of(db, account.id, folders=rows)
        return {"folders": [view.folder(row) for row in rows]}


# --- How lists look (NOTESIOS-6) ---------------------------------------------------------------------------------


class HintKindsIn(BaseModel):
    """Each kind of hint on or off (contract 0.11, NOTESIOS-6 AC-1); a kind left out stays as it is."""
    checklist: bool | None = None
    attachments: bool | None = None
    tags: bool | None = None


class LookIn(BaseModel):
    style: str | None = Field(default=None, max_length=16)
    #: All hints on or off at once (apps before 0.11); ``hint_kinds`` then sets the kinds it names.
    hints: bool | None = None
    hint_kinds: HintKindsIn | None = None


@router.put("/look", summary="How every list of the account looks")
def set_look(found: Device, body: LookIn) -> dict[str, Any]:
    with SessionLocal() as db:
        row = db.get(AccountRow, found.account.id)
        assert row is not None
        kinds = body.hint_kinds.model_dump() if body.hint_kinds is not None else None
        return notes_list.set_list_look(db, row, body.style, body.hints, kinds)


class ViewIn(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    sort: str | None = Field(default=None, pattern="^(updated|created|title)$")
    direction: str | None = Field(default=None, pattern="^(asc|desc)$")
    grouped: bool | None = None
    #: Only for a smart folder (``s:<id>``, interface 0.5): its notes or the gallery of their attachments.
    mode: str | None = Field(default=None, pattern="^(list|gallery)$")


@router.put("/views", summary="Sort and grouping of one list")
def set_view(found: Device, body: ViewIn) -> dict[str, Any]:
    from .app1_smart import save_view as save_smart_view

    account = found.account
    wanted = {"sort": body.sort, "direction": body.direction, "grouped": body.grouped}
    with SessionLocal() as db:
        if body.key.startswith("s:"):
            return save_smart_view(db, account, body.key, {**wanted, "mode": body.mode})
        if body.key.startswith("tag:"):
            saved = tags.save_tag_view(db, account, body.key[4:], wanted)
        else:
            folder_id = inbox_for(db, account.id).id if body.key == "inbox" else body.key
            saved = notes_list.save_view(db, account, folder_id, wanted)
    return {"key": body.key, "sort": saved["sort"], "direction": saved["direction"], "grouped": saved["grouped"]}


# --- Tags (NOTESIOS-5) -------------------------------------------------------------------------------------------


class TagRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    merge: bool = False


@router.put("/tags/{name}", summary="Rename a tag in the own notes, or merge it into another")
async def rename_tag(name: str, found: Device, body: TagRename) -> dict[str, Any]:
    return await tags.rename(found.account, name, body.name, merge=body.merge)


@router.delete("/tags/{name}", summary="Take a tag out of the own notes")
async def remove_tag(name: str, found: Device) -> dict[str, Any]:
    return await tags.remove(found.account, name)


# --- The member's own settings (NOTESIOS-1 AC-11) ----------------------------------------------------------------


class ProfileIn(BaseModel):
    #: The browser's limit (``routers/auth.py``): longer is refused, not cut.
    display_name: str = Field(max_length=200)


@router.put("/profile", summary="The own name (the address only in the browser)")
def set_profile(found: Device, body: ProfileIn) -> dict[str, Any]:
    from ..services import accounts

    with SessionLocal() as db:
        row = db.get(AccountRow, found.account.id)
        assert row is not None
        shown = accounts.clean_display_name(body.display_name)
        if not shown:
            raise error("display_name_empty", "Enter a name.", 422)
        row.display_name = shown
        db.commit()
        return account_out(row)


@router.put("/avatar", summary="The own profile picture (the picture as the body)")
async def set_avatar(found: Device, request: Request) -> dict[str, Any]:
    data = await request.body()
    try:
        picture = avatars.make(data)
    except avatars.AvatarError as exc:
        raise error(exc.code, exc.message, 422, max_mb=avatars.MAX_BYTES // (1024 * 1024)) from exc
    with SessionLocal() as db:
        row = db.get(AccountRow, found.account.id)
        assert row is not None
        row.avatar = picture
        row.avatar_at = utcnow()
        db.commit()
        return account_out(row)


@router.delete("/avatar", summary="Remove the own profile picture")
def remove_avatar(found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        row = db.get(AccountRow, found.account.id)
        assert row is not None
        row.avatar = None
        row.avatar_at = None
        db.commit()
        return account_out(row)


class PaperIn(BaseModel):
    paper: str = Field(max_length=16)


@router.put("/paper", summary="The paper new notes start on")
def set_paper(found: Device, body: PaperIn) -> dict[str, str]:
    paper = notes.check_paper(body.paper)
    with SessionLocal() as db:
        row = db.get(AccountRow, found.account.id)
        assert row is not None
        preferences = dict(row.preferences) if isinstance(row.preferences, dict) else {}
        preferences["paper"] = paper
        row.preferences = preferences
        db.commit()
    return {"paper": paper}


@router.get("/read-links", summary="The own read links")
def read_links(found: Device) -> list[dict[str, Any]]:
    with SessionLocal() as db:
        return shares.my_links(db, found.account)


@router.delete("/read-links/{link_id}", status_code=204, summary="Revoke a read link")
def revoke_read_link(link_id: int, found: Device) -> Response:
    with SessionLocal() as db:
        shares.revoke_link(db, found.account, link_id)
    return Response(status_code=204)


# --- nextasks (NOTESIOS-22 AC-7, interface 0.10) ----------------------------------------------------------------


class NextasksIn(BaseModel):
    url: str = Field(min_length=1, max_length=nextasks.MAX_URL)
    token: str = Field(min_length=1, max_length=nextasks.MAX_TOKEN)


@router.get("/nextasks", summary="The member's nextasks: connected, where, as whom")
def nextasks_status(found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        return nextasks.connection_out(db, nextasks.connection_of(db, found.account.id), found.account.id)


@router.put("/nextasks", summary="Connect nextasks or change its key from the app; checked at once")
def nextasks_connect(found: Device, body: NextasksIn) -> dict[str, Any]:
    """As ``PUT /api/nextasks`` of the browser (NOTES-19 AC-5), with the rules and codes of it. The connection
    belongs to this device: disconnecting the device ends it (nothing a device sets outlives it)."""
    account = found.account
    try:
        with nextasks.outgoing(account.id, connecting=True), SessionLocal() as db:
            row = nextasks.connect(db, account.id, body.url, body.token, device_id=found.device.id)
            return nextasks.connection_out(db, row, account.id)
    except NextasksError as exc:
        raise exc.http() from exc


@router.delete("/nextasks", status_code=204, summary="Disconnect nextasks from the app; tasks and marks stay")
def nextasks_disconnect(found: Device) -> Response:
    with SessionLocal() as db:
        nextasks.disconnect(db, found.account.id)
    return Response(status_code=204)
