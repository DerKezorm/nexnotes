"""Sharing and notifications from the app (``/api/app/1``, interface 0.6): sharing notes and folders with members,
"shared with me", read links (NOTESIOS-14) and the bell per note and folder (NOTESIOS-15).

Each route takes a device's token (``routers/app1.device``) and calls the services of the browser (``services/
shares.py``, ``services/notify.py``), so rules and error codes are the browser's. On top come the app's rules: what
the account does not see answers ``404 not_found`` everywhere; what it sees but may not do (share a note somebody
shared with it) ``403 no_right``. Only the owner shares (NOTES-13 AC-11).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Response
from fastapi import Path as PathParam
from pydantic import BaseModel

from ..db import SessionLocal
from ..errors import error
from ..models import Folder, Note
from ..notedoc.room import Access
from ..services import notes, notify, shares
from .app1 import Device

router = APIRouter(prefix="/api/app/1", tags=["app"])

Kind = Annotated[Literal["note", "folder"], PathParam()]
ItemId = Annotated[str, PathParam(min_length=1, max_length=64)]


def _z(value: Any) -> Any:
    """Times as the app reads them: ISO 8601 UTC with ``Z``."""
    if isinstance(value, str) and value.endswith("+00:00"):
        return value[:-6] + "Z"
    return value


def _person(entry: dict[str, Any]) -> dict[str, Any]:
    return {**entry, "avatar": _z(entry.get("avatar")) or ""}


def _sharing(found: dict[str, Any]) -> dict[str, Any]:
    out = {**found, "people": [_person(entry) for entry in found["people"]],
           "through_folder": [_person(entry) for entry in found["through_folder"]]}
    if out.get("link") is not None:
        out["link"] = _link(out["link"])
    return out


def _link(found: dict[str, Any]) -> dict[str, Any]:
    return {key: _z(value) for key, value in found.items()}


def _check_own(db: Any, account: Any, kind: str, item_id: str) -> None:
    """The app's rule before the browser's: not seen ``not_found``, seen but somebody else's ``no_right``."""
    if len(item_id) > 36:
        raise error("not_found", "Not found.", 404)
    if kind == "note":
        note = db.get(Note, item_id)
        right = notes.right_to(db, account, note) if note is not None else Access.NONE
        if note is None or right not in (Access.WRITE, Access.READ):
            raise error("not_found", "Not found.", 404)
        if note.owner_id != account.id:
            raise error("no_right", "Only the owner shares.", 403)
        return
    folder = db.get(Folder, item_id)
    if folder is None:
        raise error("not_found", "Not found.", 404)
    if folder.owner_id != account.id:
        if notes.folder_right(db, account, folder) in (Access.WRITE, Access.READ):
            raise error("no_right", "Only the owner shares.", 403)
        raise error("not_found", "Not found.", 404)


# --- Members (NOTESIOS-14 AC-1) --------------------------------------------------------------------------------------


@router.get("/people", summary="Members of this server by name or address, to share with")
def people(found: Device, q: Annotated[str, Query(max_length=100)] = "") -> dict[str, Any]:
    with SessionLocal() as db:
        return {"people": [_person(entry) for entry in shares.find_people(db, found.account, q)]}


@router.get("/shares/{kind}/{item_id}", summary="Whom an own note or folder is shared with, and its read link")
def sharing(kind: Kind, item_id: ItemId, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _check_own(db, found.account, kind, item_id)
        return _sharing(shares.sharing_of(db, found.account, kind, item_id))


class LevelIn(BaseModel):
    level: Literal["read", "write"]


@router.put("/shares/{kind}/{item_id}/people/{person_id}", summary="Share with a member, or change the right")
def share_with(kind: Kind, item_id: ItemId, person_id: int, body: LevelIn, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _check_own(db, found.account, kind, item_id)
        return _sharing(shares.set_person(db, found.account, kind, item_id, person_id, body.level))


@router.delete("/shares/{kind}/{item_id}/people/{person_id}", summary="Stop sharing with a member")
def unshare(kind: Kind, item_id: ItemId, person_id: int, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _check_own(db, found.account, kind, item_id)
        return _sharing(shares.remove_person(db, found.account, kind, item_id, person_id))


# --- Shared with me (NOTESIOS-14 AC-2) -------------------------------------------------------------------------------


@router.get("/shared", summary="What others shared with the account, per owner, and what ended")
def shared_with_me(found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        listing = shares.with_me(db, found.account)
    for group in listing["groups"]:
        group["owner"] = _person(group["owner"])
        group["items"] = [{**item, "updated_at": _z(item.get("updated_at"))} for item in group["items"]]
    listing["notices"] = [{**notice, "at": _z(notice["at"])} for notice in listing["notices"]]
    return listing


@router.delete("/shared/notices/{notice_id}", status_code=204, summary="Put away a notice of a share that ended")
def drop_notice(notice_id: int, found: Device) -> Response:
    with SessionLocal() as db:
        shares.drop_notice(db, found.account, notice_id)
    return Response(status_code=204)


@router.delete("/shared/{kind}/{item_id}", status_code=204, summary="Leave what somebody shared with the account")
def leave(kind: Kind, item_id: ItemId, found: Device) -> Response:
    with SessionLocal() as db:
        shares.leave(db, found.account, kind, item_id)
    return Response(status_code=204)


# --- Read links (NOTESIOS-14 AC-3, AC-7) -----------------------------------------------------------------------------


class LinkIn(BaseModel):
    expires_on: date
    ends_at: datetime | None = None


@router.post("/notes/{note_id}/read-link", status_code=201,
             summary="A new link to read the note (replaces the one before); its address comes only now")
def make_link(note_id: ItemId, body: LinkIn, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        _check_own(db, found.account, "note", note_id)
        return _link(shares.make_link(db, found.account, note_id, body.expires_on, body.ends_at))


@router.put("/read-links/{link_id}", summary="Another last day for a read link")
def change_link(link_id: int, body: LinkIn, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        return _link(shares.change_link(db, found.account, link_id, body.expires_on, body.ends_at))


# --- Notifications (NOTESIOS-15) -------------------------------------------------------------------------------------


def _bell(found: dict[str, Any]) -> dict[str, Any]:
    return {key: found[key] for key in ("kind", "id", "on", "via", "shared")}


def _seen_note(db: Any, account: Any, note_id: str) -> None:
    """The bell of a note the account does not see: ``not_found`` (also one in the trash, as in the browser)."""
    note = db.get(Note, note_id) if len(note_id) <= 36 else None
    if note is None or notes.right_to(db, account, note) not in (Access.WRITE, Access.READ):
        raise error("not_found", "Not found.", 404)


@router.get("/notify/{kind}/{item_id}", summary="Whether notifications are on for a note or folder")
def bell(kind: Kind, item_id: ItemId, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        if kind == "note":
            _seen_note(db, found.account, item_id)
            return _bell(notify.note_settings(db, found.account, item_id, None))
        return _bell(notify.folder_settings(db, found.account, item_id, None))


class SwitchIn(BaseModel):
    on: bool


@router.put("/notify/{kind}/{item_id}", summary="Notifications on or off for a shared note or folder")
def set_bell(kind: Kind, item_id: ItemId, body: SwitchIn, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        if kind == "note":
            _seen_note(db, found.account, item_id)
            return _bell(notify.set_note(db, found.account, item_id, body.on, None))
        return _bell(notify.set_folder(db, found.account, item_id, body.on, None))


class ViewingIn(BaseModel):
    note_id: str | None = None


@router.put("/viewing", status_code=204, summary="This device shows a note in view right now, or none")
def viewing(body: ViewingIn, found: Device) -> Response:
    """No notification of that note reaches this device meanwhile (NOTESIOS-15 EC-6), as for a browser."""
    note_id = (body.note_id or "")[:64] or None
    notify.device_viewing(found.device.id, note_id)
    return Response(status_code=204)
