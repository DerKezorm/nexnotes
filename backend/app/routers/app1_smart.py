"""Smart folders from the app (``/api/app/1``, interface 0.5, NOTESIOS-7): made with the device's id, changed, ordered,
deleted, and what fits one now.

Each route takes a device's token (``routers/app1.device``) and calls the same service as the browser
(``services/smart_folders.py``), so names, conditions and error codes are the browser's. A smart folder is its
owner's alone; any other id answers ``not_found``, as everything the account cannot see. ``changes`` carries them with
their numbers (``services/appsync.py``). The condition "Ordner" names the own inbox ``inbox``, as everywhere in the
app.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal
from ..errors import error
from ..models_smart import SmartFolder
from ..services import appsync, notes, notes_list, search, smart_folders
from .app1 import Device

logger = logging.getLogger("nexnotes.app")

router = APIRouter(prefix="/api/app/1", tags=["app"])

#: Wider than the rules (``search.CONDITIONS_MAX``, ``smart_folders.NAME_MAX``): too many or too long hears the rule's
#: code from the service, as the contract names it; only absurd sizes stop here.
Conditions = Annotated[list[Any], Field(max_length=1000)]
Zone = Annotated[str, Query(max_length=64)]


def _not_found() -> HTTPException:
    return error("not_found", "Not found.", 404)


def _own(db: Any, account_id: int, folder_id: str) -> SmartFolder:
    folder = db.get(SmartFolder, folder_id) if len(folder_id) <= 36 else None
    if folder is None or folder.owner_id != account_id:
        raise _not_found()
    return folder


def _out(db: Any, account_id: int, folder: SmartFolder) -> dict[str, Any]:
    return appsync.smart_out(folder, appsync.inbox_id(db, account_id))


@router.get("/smart-folders/presets", summary="The smart folders every account gets, to make one anew")
def presets(_found: Device) -> dict[str, Any]:
    return {"presets": [{"preset": name, "match": value["match"], "conditions": value["conditions"],
                         "icon": smart_folders.PRESET_ICONS[name]} for name, value in smart_folders.PRESETS.items()]}


class NewSmart(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=10_000)
    preset: str | None = Field(default=None, max_length=32)
    match: Literal["all", "any"] = "all"
    conditions: Conditions | None = None
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)


def _taken() -> HTTPException:
    return error("smart_folder_id_taken", "This smart folder id is taken.", 409)


@router.post("/smart-folders", status_code=201, summary="A smart folder with the device's id; the same id again is it")
def create(found: Device, body: NewSmart, response: Response) -> dict[str, Any]:
    account = found.account
    if not notes.DEVICE_ID.fullmatch(body.id):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    with SessionLocal() as db:
        existing = db.get(SmartFolder, body.id)
        if existing is not None:
            if existing.owner_id != account.id:
                raise _taken()
            # Sent again (the answer got lost): the folder as it is, nothing changes.
            response.status_code = 200
            return _out(db, account.id, existing)
        try:
            if body.preset:
                made = smart_folders.create_preset(db, account, body.preset, icon=body.icon, color=body.color,
                                                   folder_id=body.id)
            else:
                made = smart_folders.create(db, account, body.name, body.match,
                                            appsync.conditions_in(db, account.id, body.conditions), icon=body.icon,
                                            color=body.color, folder_id=body.id)
        except HTTPException as exc:
            # The same id at the same moment from a second request: the first one made it.
            db.rollback()
            again = db.get(SmartFolder, body.id)
            if again is None:
                raise
            if again.owner_id != account.id:
                raise _taken() from exc
            response.status_code = 200
            return _out(db, account.id, again)
        except IntegrityError:
            db.rollback()
            raise _taken() from None
        logger.info("Smart folder created by a device smart=%s", made.id)
        return _out(db, account.id, made)


class SmartPatch(BaseModel):
    name: str | None = Field(default=None, max_length=10_000)
    match: Literal["all", "any"] | None = None
    conditions: Conditions | None = None
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)


@router.patch("/smart-folders/{folder_id}", summary="Rename a smart folder, change its conditions, symbol, colour")
def change(folder_id: str, found: Device, body: SmartPatch) -> dict[str, Any]:
    account = found.account
    with SessionLocal() as db:
        _own(db, account.id, folder_id)
        # All or nothing: the service checks everything before it writes once.
        folder = smart_folders.update(db, account, folder_id, name=body.name, match=body.match,
                                      conditions=appsync.conditions_in(db, account.id, body.conditions),
                                      icon=body.icon, color=body.color)
        return _out(db, account.id, folder)


@router.delete("/smart-folders/{folder_id}", status_code=204, summary="A smart folder gone for good; no note changes")
def remove(folder_id: str, found: Device) -> Response:
    with SessionLocal() as db:
        _own(db, found.account.id, folder_id)
        smart_folders.remove(db, found.account, folder_id)
    return Response(status_code=204)


class OrderIn(BaseModel):
    ids: list[Annotated[str, Field(max_length=64)]] = Field(max_length=500)


@router.put("/smart-folders/order", summary="The order of the smart folders")
def order(found: Device, body: OrderIn) -> dict[str, Any]:
    account = found.account
    if len(set(body.ids)) != len(body.ids):
        raise error("smart_folder_order_invalid", "Every smart folder may be named once in the order.", 422)
    with SessionLocal() as db:
        own = set(db.scalars(select(SmartFolder.id).where(SmartFolder.owner_id == account.id)))
        # Ordered offline: a folder deleted elsewhere meanwhile is skipped, the rest keeps the order.
        ordered = smart_folders.reorder(db, account, [folder_id for folder_id in body.ids if folder_id in own])
        inbox = appsync.inbox_id(db, account.id)
        return {"smart_folders": [appsync.smart_out(folder, inbox) for folder in ordered]}


@router.get("/smart-folders/{folder_id}/notes", summary="The notes that fit a smart folder now, by the server")
def fitting(folder_id: str, found: Device, tz: Zone = "") -> dict[str, Any]:
    account = found.account
    with SessionLocal() as db:
        folder = _own(db, account.id, folder_id)
        asked = search.Asked(account=account, tz=search.zone(tz), now=smart_folders.now())
        where = search.matching(db, asked, folder.conditions or [], folder.match)
        ids = [row.id for row in db.execute(select(*notes_list.LIST_COLUMNS).where(where)
                                            .order_by(*notes_list.NEWEST_FIRST))]
        return {"ids": ids, "broken": asked.broken}


def save_view(db: Any, account: Any, key: str, wanted: dict[str, Any]) -> dict[str, Any]:
    """``PUT /views`` for ``s:<id>`` (``routers/app1_member.py``): the own smart folder's view, with ``mode``."""
    folder = _own(db, account.id, key[2:])
    saved = smart_folders.save_view(db, account, folder.id, wanted)
    return {"key": key, "sort": saved["sort"], "direction": saved["direction"], "grouped": saved["grouped"],
            "mode": saved["mode"]}
