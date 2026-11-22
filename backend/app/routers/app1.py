"""The own app for iPhone, iPad and Mac: ``/api/app/1`` (NOTES-24; the wording in ``nexnotes-ios/docs/vertrag-app1.md``,
``api`` 1).

**A promise to the own app.** The app in the App Store and the servers out there are never updated at the same time.
As long as ``app/1`` stands in the address nothing here breaks: new fields may come, none is renamed or taken away. A
change that must break goes to ``/api/app/2`` beside it, and ``hello`` says which ones the server speaks (EC-2).

Walls: a device's token in ``Authorization: Bearer nnd_…`` on every call but ``hello`` and the two pickups of a
pairing (a cookie opens nothing here). A disconnected device hears ``401 device_disconnected`` (EC-1), one of a blocked
or deleted account ``401 account_blocked`` (EC-5); neither takes anything. The pickups stand behind the sign-in brake.

**Text by state vector.** The app keeps its own Yjs document per note and brings its update with its state vector;
the update goes the way a browser's goes in the live room (stored before the answer, at once in every open browser,
the same update twice changes nothing), and the answer is what the app lacks (AC-3, EC-6). What changed since a cursor
comes from ``changes`` and ``wait`` (``services/appsync.py``, AC-4, EC-4).

Errors are ``{"detail": {"code", "message"}}`` as everywhere in nexnotes.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, update

from .. import __version__
from ..db import SessionLocal
from ..deps import client_ip
from ..errors import detail, error
from ..models import Account as AccountRow
from ..models import ApiToken, Note
from ..models_notify import PushDevice
from ..notedoc import schema as s
from ..notedoc.room import Access
from ..security import brake as sign_in_brake
from ..services import apppush, appsync, devices, folders, logs, notes, notes_list, settings_service, shares
from ..services.devices import Caller, PairingError, Refusal
from ..services.inbox import inbox_for
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import providers

logger = logging.getLogger("nexnotes.app")

@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    appsync.register()
    # Notes and folders from before the counter get their numbers.
    await asyncio.to_thread(appsync.stamp_unnumbered)
    yield


router = APIRouter(prefix="/api/app/1", tags=["app"], lifespan=lifespan)

#: The interface this server speaks, and the oldest one it still answers.
API = 1
MIN_API = 1
#: How long ``wait`` holds a request open; how often it looks at the device again meanwhile.
WAIT_SECONDS = 25.0
WAIT_RECHECK = 5.0
#: Notes one ``sync`` takes at most.
SYNC_NOTES = 50
#: The parts of the interface beyond 0.4 this server has (``hello``): an app tells an older server by their absence.
FEATURES = ("smart_folders", "history", "trash", "gallery", "texts", "import", "sharing", "live", "notify")


def _refused(code: str, text: str, status: int, retry: int | None = None) -> HTTPException:
    headers = {"Retry-After": str(retry)} if retry is not None else None
    return HTTPException(status_code=status, detail=detail(code, text), headers=headers)


_REFUSALS = {
    "device_disconnected": "This device was disconnected. Connect it again.",
    "account_blocked": "This account is blocked or deleted.",
    "second_factor_required": "Set up your second factor in the browser first, then connect again.",
}


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def _caller(token: str | None) -> Caller:
    with SessionLocal() as db:
        try:
            return devices.authenticate(db, token)
        except Refusal as refusal:
            raise _refused(refusal.code, _REFUSALS[refusal.code], 401) from refusal


def device(request: Request) -> Caller:
    found = _caller(_bearer(request))
    logs.set_actor(found.account.name)
    return found


Device = Annotated[Caller, Depends(device)]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def account_out(account: AccountRow) -> dict[str, Any]:
    return {"id": account.id, "name": account.display_name or account.name, "login": account.name,
            "email": account.email or "", "avatar": _iso(account.avatar_at) or ""}


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: str | None) -> bytes | None:
    """Standard base64 (padding optional); None for a text that is none."""
    if value is None:
        return b""
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
    except (binascii.Error, ValueError):
        return None


# --- Server version (EC-2) ------------------------------------------------------------------------------------------


@router.get("/hello", summary="Which interface this server speaks (no sign-in)")
def hello() -> dict[str, Any]:
    with SessionLocal() as db:
        ways = []
        if settings_service.get(db, "password_login"):
            ways.append("password")
        if providers.public_list(SqlStore(db)):
            ways.append("oidc")
    return {"app": "nexnotes", "api": API, "min_api": MIN_API, "version": __version__, "sign_in": ways,
            "features": list(FEATURES)}


# --- Pairing (no token; behind the sign-in brake) ------------------------------------------------------------------


class DeviceIn(BaseModel):
    device_name: str = Field(default="", max_length=200)
    device_kind: str = Field(default="", max_length=16)


class KeyIn(DeviceIn):
    secret: str = Field(default="", max_length=200)


class CodeIn(DeviceIn):
    code: str = Field(default="", max_length=200)


def _paired(token: str, account: AccountRow, row: ApiToken, status: int = 200) -> JSONResponse:
    body = {"token": token, "account": account_out(account), "device": devices.device_out(row)}
    # A token must not stay behind in any cache.
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


def _pickup(request: Request, take: Any) -> JSONResponse:
    """The brake counts per sender: there is no account to count at before the code is known (EC-3)."""
    key = "app-pairing:" + client_ip(request)
    wait = sign_in_brake.wait_seconds(key)
    if wait:
        raise _refused("too_many_attempts", "Too many attempts. Try again later.", 429, wait)
    with SessionLocal() as db:
        try:
            token, account, row = take(db)
        except PairingError as exc:
            if exc.code == "pairing_gone":
                sign_in_brake.failed(key)
                logger.warning("Pairing refused")
            raise error(exc.code, exc.text, exc.status, **exc.values) from exc
        db.expunge(account)
    sign_in_brake.succeeded(key)
    return _paired(token, account, row)


@router.post("/pairing/{pairing_id}/key", summary="The device's token for the QR code")
def pickup_by_secret(pairing_id: str, body: KeyIn, request: Request) -> JSONResponse:
    return _pickup(request, lambda db: devices.by_secret(db, pairing_id, body.secret, body.device_name,
                                                         body.device_kind))


@router.post("/pairing/code", summary="The device's token for the code of the sign-in page")
def pickup_by_code(body: CodeIn, request: Request) -> JSONResponse:
    return _pickup(request, lambda db: devices.by_code(db, body.code, body.device_name, body.device_kind))


@router.post("/devices", status_code=201, summary="A token of its own for another device of this account")
def bring_in(found: Device, body: DeviceIn) -> JSONResponse:
    """The connection travels over iCloud to the account's other devices; each comes in under its own name (AC-7)."""
    with SessionLocal() as db:
        try:
            token, row = devices.sibling(db, found.account, found.device, body.device_name, body.device_kind)
        except PairingError as exc:
            retry = exc.values.pop("retry_after", None)
            raise _refused(exc.code, exc.text, exc.status, retry) from exc
    return _paired(token, found.account, row, status=201)


# --- The own device -----------------------------------------------------------------------------------------------


@router.get("/me", summary="The account, this device, what the server offers")
def me(found: Device) -> dict[str, Any]:
    """What the server can (NOTES-24, follow-up 6): its limits, the operator's switches, the account's storage."""
    from ..services import attachments, ocr

    account = found.account
    with SessionLocal() as db:
        upload = settings_service.upload_max_mb(db)
        share_links = bool(settings_service.get(db, "share_links"))
        link_previews = bool(settings_service.get(db, "link_previews"))
        trash_days = settings_service.trash_days(db)
        history_days = settings_service.history_days(db)
        row = db.get(AccountRow, account.id)
        stored = attachments.limits(db, row or account)
    return {
        "account": account_out(account),
        "device": devices.device_out(found.device),
        "paper": notes.default_paper(account),
        "list_look": notes_list.list_look(account),
        "limits": {"sync_notes": SYNC_NOTES, "changes_page": appsync.PAGE, "wait_seconds": int(WAIT_SECONDS),
                   "update_bytes": s.MAX_UPDATE, "note_bytes": s.MAX_DOC, "upload_mb": upload,
                   "trash_days": trash_days, "history_days": history_days},
        "offers": {"push": bool(apppush.relay_url()), "share_links": share_links, "link_previews": link_previews,
                   "ocr": bool(ocr.engine_info().available)},
        "storage": {"used": stored["used"], "limit": stored["limit"], "full": stored["full"]},
        # The mark notifications name this server by (NOTESIOS-15): the same for every account and call.
        "server_id": apppush.server_id(),
    }


@router.delete("/device", status_code=204, summary="This device disconnects itself")
def forget_device(found: Device) -> Response:
    with SessionLocal() as db:
        devices.disconnect(db, found.account.id, found.device.id)
    return Response(status_code=204)


class PushIn(BaseModel):
    ticket: str = Field(min_length=1, max_length=apppush.TICKET_MAX)
    key: str = Field(min_length=1, max_length=100)


@router.put("/push", status_code=204, summary="Notifications for this device: the relay's ticket and the key")
def push_on(found: Device, body: PushIn) -> Response:
    """Kept as nextasks keeps it (``apppush.remember``) and used for NOTES-14 (AC-6)."""
    with SessionLocal() as db:
        try:
            apppush.remember(db, found.account.id, found.device.id, body.ticket, body.key)
        except ValueError as exc:
            raise error("push_ticket_invalid", "The ticket or the key is not usable.", 422) from exc
    return Response(status_code=204)


@router.delete("/push", status_code=204, summary="No more notifications for this device")
def push_off(found: Device) -> Response:
    with SessionLocal() as db:
        db.execute(delete(PushDevice).where(PushDevice.token_id == found.device.id))
        db.commit()
    return Response(status_code=204)


# --- What changed (AC-4, EC-4) ------------------------------------------------------------------------------------


Cursor = Annotated[int, Query(ge=0, le=2**62)]


@router.get("/changes", summary="Everything the account sees that changed after the cursor")
def changes(found: Device, cursor: Cursor = 0) -> dict[str, Any]:
    """Every page of a full list says ``full``: the device's token remembers the cursor of the last such page."""
    device = found.device
    with SessionLocal() as db:
        going_on = device.full_cursor is not None and device.full_cursor == cursor
        started = device.full_start if going_on else appsync.current(db)[0]
        answer = appsync.changes(db, found.account, cursor, appsync.PAGE, going_on=going_on,
                                 since=started if going_on else None)
        mark, start = (answer["cursor"], started) if answer["full"] and answer["more"] else (None, None)
        if (mark, start) != (device.full_cursor, device.full_start):
            db.execute(update(ApiToken).where(ApiToken.id == device.id).values(full_cursor=mark, full_start=start))
            db.commit()
        return answer


def _changed_since(token: str | None, cursor: int) -> int | None:
    found = _caller(token)
    with SessionLocal() as db:
        return appsync.changed_since(db, found.account, cursor)


@router.get("/wait", summary="Answers as soon as something changed after the cursor, at the latest after 25 s")
async def wait(found: Device, request: Request, cursor: Cursor = 0) -> dict[str, int]:
    """Nothing is held while waiting: neither a thread nor a database connection. Commits that numbered a change wake
    the waiting (at most every ``appsync.WAKE_EVERY`` seconds), which look again; a device disconnected meanwhile hears
    so within a few seconds. A device waits once: asking again ends its waiting request before."""
    token = _bearer(request)
    deadline = time.monotonic() + WAIT_SECONDS
    with appsync.Waiter(found.device.id) as waiter:
        while True:
            waiter.arm()
            found_cursor = await asyncio.to_thread(_changed_since, token, cursor)
            if found_cursor is not None:
                return {"cursor": found_cursor}
            left = deadline - time.monotonic()
            if left <= 0 or waiter.replaced or await request.is_disconnected():
                return {"cursor": cursor}
            await waiter.wait(min(left, WAIT_RECHECK))


# --- Text (AC-3, EC-6) --------------------------------------------------------------------------------------------


class SyncNote(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    sv: str | None = Field(default=None, max_length=1_000_000)
    update: str | None = Field(default=None, max_length=4 * s.MAX_UPDATE)


class SyncIn(BaseModel):
    notes: list[SyncNote] = Field(default_factory=list)


async def _sync_one(account: AccountRow, item: SyncNote) -> dict[str, Any]:
    vector = _unb64(item.sv)
    if vector is None:
        return {"id": item.id, "error": "invalid_state_vector"}
    update = _unb64(item.update) if item.update is not None else b""
    if update is None:
        return {"id": item.id, "error": "invalid_update"}
    if len(update) > s.MAX_UPDATE:
        return {"id": item.id, "error": "too_large"}
    done = await notes.sync_from_device(account, item.id, vector, update or None)
    if done.error:
        return {"id": item.id, "error": done.error}
    return {"id": item.id, "sv": _b64(done.state_vector), "update": _b64(done.lacking), "title": done.title,
            "seq": done.seq}


@router.post("/sync", summary="Text of up to 50 notes: the device's updates in, what it lacks out")
async def sync(found: Device, body: SyncIn) -> dict[str, Any]:
    if len(body.notes) > SYNC_NOTES:
        raise error("too_many_notes", f"At most {SYNC_NOTES} notes per call.", 422, max=SYNC_NOTES)
    return {"notes": [await _sync_one(found.account, item) for item in body.notes]}


# --- Notes --------------------------------------------------------------------------------------------------------


class NewNote(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    folder_id: str | None = Field(default=None, max_length=64)
    update: str = Field(max_length=4 * s.MAX_UPDATE)
    paper: str | None = Field(default=None, max_length=16)
    icon: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, max_length=16)
    pinned: bool | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    origin: str = Field(default="", max_length=100)


def _utc(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value


def check_note_color(color: str | None) -> None:
    from ..services.folders import FOLDER_COLORS

    if color and color not in FOLDER_COLORS:
        raise error("note_color_unknown", "Choose a color from the list.", 422)


def finish_new(account: AccountRow, note_id: str, *, color: str | None, pinned: bool | None,
               updated_at: datetime | None) -> None:
    """What a note brought from elsewhere keeps besides its text (NOTESIOS-13): colour, pin and when it was last
    changed there (not after now). Only on its first creation."""
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None:
            return
        if color:
            note.color = color
        if pinned:
            notes_list.set_pinned(db, account, note_id, True)
        if updated_at is not None:
            note.updated_at = min(updated_at.astimezone(UTC), datetime.now(UTC))
        db.commit()


def _folder(db: Any, account: AccountRow, folder_id: str | None) -> str | None:
    """``inbox`` (or none) is the own inbox."""
    if folder_id in (None, "", "inbox"):
        return inbox_for(db, account.id).id
    return folder_id


def _out(account: AccountRow, note_id: str, **extra: Any) -> dict[str, Any]:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None:
            raise error("not_found", "Not found.", 404)
        return {**appsync.note_out(db, account.id, note), **extra}


def _discard(note_id: str) -> None:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        if row is not None:
            db.delete(row)
            db.commit()


async def make_note(account: AccountRow, body: NewNote) -> tuple[bool, Any]:
    """A note with the device's id and its update (``POST /notes``, ``POST /import``): whether it is new, and what
    the sync gave. The same id again applies the update once more (nothing doubles); colour, pin and times count on
    the first creation only."""
    update = _unb64(body.update)
    if not update:
        raise error("invalid_update", "The update is not valid.", 422, fields=["update"])
    made = _utc(body.created_at)
    check_note_color(body.color)

    def make() -> bool:
        with SessionLocal() as db:
            _note, new = notes.create_from_device(db, account, note_id=body.id, folder_id=_folder(db, account,
                                                  body.folder_id), paper=body.paper, icon=body.icon,
                                                  created_at=made, origin=body.origin)
            return new

    new = await asyncio.to_thread(make)
    done = await notes.sync_from_device(account, body.id, b"", update)
    if done.error:
        if new:
            await asyncio.to_thread(_discard, body.id)
        status = {"not_found": 404, "no_right": 403, "note_locked": 409, "too_large": 413}.get(done.error, 422)
        raise error(done.error, "The update was not taken.", status)
    if new:
        await asyncio.to_thread(finish_new, account, body.id, color=body.color, pinned=body.pinned,
                                updated_at=_utc(body.updated_at))
    return new, done


@router.post("/notes", status_code=201, summary="A new note with the device's id; the same id again is the same note")
async def create(found: Device, body: NewNote, response: Response) -> dict[str, Any]:
    account = found.account
    new, done = await make_note(account, body)
    if not new:
        response.status_code = 200
    return await asyncio.to_thread(_out, account, body.id, sv=_b64(done.state_vector))


class NotePatch(BaseModel):
    paper: str | None = Field(default=None, max_length=16)
    icon: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, max_length=16)
    folder_id: str | None = Field(default=None, max_length=64)
    pinned: bool | None = None
    title_ok: bool | None = None
    #: ``true`` sets "Titel prüfen" (a title the app suggested); ``title_ok: true`` takes it away.
    title_check: bool | None = None


def _right(db: Any, account: AccountRow, note_id: str) -> Access:
    """WRITE or READ (in the trash too), else ``not_found``."""
    note = db.get(Note, note_id) if len(note_id) <= 36 else None
    right = notes.right_to(db, account, note)
    if right not in (Access.WRITE, Access.READ):
        raise error("not_found", "Not found.", 404)
    return right


def _no_right() -> HTTPException:
    return error("no_right", "Only reading is allowed here.", 403)


@router.patch("/notes/{note_id}", summary="Paper, symbol, color, folder, pin, title ok")
def patch(note_id: str, body: NotePatch, found: Device) -> dict[str, Any]:
    account = found.account
    nudge = False
    with SessionLocal() as db:
        right = _right(db, account, note_id)
        writing = any(value is not None for value in (body.paper, body.icon, body.color, body.folder_id)) \
            or bool(body.title_ok) or bool(body.title_check)
        if writing and right != Access.WRITE:
            raise _no_right()
        if body.paper is not None:
            notes.set_paper(db, account, note_id, body.paper)
        if body.icon is not None:
            notes.set_icon(db, account, note_id, body.icon)
        if body.color is not None:
            notes_list.set_color(db, account, note_id, body.color)
        if body.title_ok:
            notes.title_ok(db, account, note_id)
        elif body.title_check:
            note = db.get(Note, note_id)
            assert note is not None
            note.title_check = True
            db.commit()
        if body.pinned is not None:
            notes_list.set_pinned(db, account, note_id, body.pinned)
        if body.folder_id is not None:
            note = db.get(Note, note_id)
            assert note is not None
            if note.owner_id != account.id:
                raise _no_right()
            target = _folder(db, account, body.folder_id)
            if note.folder_id != target:
                folders.move(db, account.id, target_id=target, folder_ids=[], note_ids=[note_id])
                nudge = shares.moves_change_rights(db, account.id)
    if nudge:
        notes.nudge_all()
    return _out(account, note_id)


@router.delete("/notes/{note_id}", status_code=204, summary="Into the trash")
async def trash(note_id: str, found: Device) -> Response:
    def check() -> None:
        with SessionLocal() as db:
            if _right(db, found.account, note_id) != Access.WRITE:
                raise _no_right()

    await asyncio.to_thread(check)
    await notes.delete_note(found.account, note_id)
    return Response(status_code=204)


@router.post("/notes/{note_id}/restore", summary="Back from the trash")
def restore(note_id: str, found: Device) -> dict[str, Any]:
    with SessionLocal() as db:
        if _right(db, found.account, note_id) != Access.WRITE:
            raise _no_right()
        notes.restore(db, found.account, note_id)
    return _out(found.account, note_id)

