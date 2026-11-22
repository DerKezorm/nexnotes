"""NOTES-24 after the review: ids of the app on every browser route, what a device's token may not do, what a note
of somebody else gives away, a full list read in pages, tombstones only for those concerned, the attachments of the
app (AC-8), waking the waiting, one note holding up no other, a required second factor.

The test client of the interface is the one of ``test_notes24.py``.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, ApiToken, Note
from app.notedoc import doc as notedoc
from app.notedoc.room import Folded, Rooms
from app.services import apitokens, appsync, attachments, devices, settings_service

from .conftest import PASSWORD, make_account, new_client
from .notes_live import Live
from .test_notes3 import stored, token_for, wait_for
from .test_notes11 import picture
from .test_notes13 import make_folder, share
from .test_notes24 import b64, note_updates, paired

#: An id as the app makes it: base64url with ``_``, ``-`` and letters past ``f``, no hex at all.
APP_ID = "q3_Zk-9xYbWvTu8sRp7oNm"
MB = 1024 * 1024


@pytest.fixture(autouse=True)
def _forget(client) -> None:
    devices.forget()
    yield
    Live.close_all()


# --- B1: the app's ids on every browser route -------------------------------------------------------------------------


def test_notes24_ac3_a_note_of_the_app_works_on_every_browser_route(client, operator):
    device = paired(client)
    device.new_note(APP_ID, "From the phone", "milk")
    folder = make_folder(client, "Box")
    lena = make_account("lena")
    note = f"/api/notes/{APP_ID}"
    calls = [
        ("GET", note, None), ("PUT", f"{note}/paper", {"paper": "grid"}), ("PUT", f"{note}/icon", {"icon": ""}),
        ("PUT", f"{note}/title", {"title": "Renamed"}), ("POST", f"{note}/title/ok", None),
        ("PUT", f"{note}/pin", {"pinned": True}), ("PUT", f"{note}/color", {"color": ""}),
        ("GET", f"{note}/history", None), ("GET", f"{note}/attachments", None),
        ("GET", f"/api/export/notes/{APP_ID}/markdown", None), ("GET", f"/api/shares/note/{APP_ID}", None),
        ("PUT", f"/api/shares/note/{APP_ID}/people/{lena.id}", {"level": "read"}),
        ("GET", f"/api/notify/note/{APP_ID}", None), ("GET", "/api/nextasks/links?note_id=" + APP_ID, None),
        ("POST", "/api/shares/move-check", {"note_ids": [APP_ID], "target_id": folder}),
        ("POST", "/api/folders/move", {"target_id": folder, "folder_ids": [], "note_ids": [APP_ID]}),
        ("POST", f"{note}/duplicate", None),
        ("DELETE", note, None), ("POST", f"/api/trash/notes/{APP_ID}/restore", None),
    ]
    for method, path, body in calls:
        answer = client.request(method, path, json=body)
        assert answer.status_code < 400, (method, path, answer.status_code, answer.text)
    assert stored(APP_ID).folder_id == folder
    live = Live(client, APP_ID, token_for(operator))
    assert live.pump(lambda: "milk" in live.text)
    live.disconnect()
    # The API for programs.
    with SessionLocal() as db:
        _row, token = apitokens.make(db, db.get(Account, operator.id), "script", kind="api", level="write")
    assert client.get(f"/api/v1/notes/{APP_ID}", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # Into the trash and gone for good from the browser.
    assert client.delete(note).status_code == 204
    gone = client.delete(f"/api/trash/notes/{APP_ID}")
    assert gone.status_code < 400, gone.text
    with SessionLocal() as db:
        assert db.get(Note, APP_ID) is None


# --- B2, B6, B7: notes of somebody else ---------------------------------------------------------------------------


def test_notes24_ac3_sync_gives_nothing_of_a_note_the_account_does_not_see(client, operator):
    lena = make_account("lena")
    with new_client(lena) as other:
        private = other.post("/api/notes", json={"markdown": "Lena's secret"}).json()
    device = paired(client)
    before = note_updates(private["id"])
    seen = device.sync(private["id"], updates={private["id"]: b"\x00\x00"})[private["id"]]
    # Not told apart from a note that does not exist (B6), nothing of it, nothing taken.
    assert seen == {"id": private["id"], "error": "not_found"}
    assert device.sync("ZZZZZZZZZZZZZZZZZZZZZZ")["ZZZZZZZZZZZZZZZZZZZZZZ"] == {
        "id": "ZZZZZZZZZZZZZZZZZZZZZZ", "error": "not_found"}
    read = device.post("/sync", {"notes": [{"id": private["id"], "sv": ""}]}).json()["notes"][0]
    assert read == {"id": private["id"], "error": "not_found"} and "Lena" not in str(read)
    assert note_updates(private["id"]) == before


def test_notes24_ac3_an_id_of_another_note_is_taken(client, operator):
    lena = make_account("lena")
    with new_client(lena) as other:
        private = other.post("/api/notes", json={"markdown": "Lena's"}).json()
        shared = other.post("/api/notes", json={"markdown": "Lena's list"}).json()
        share(other, "note", shared["id"], operator, "read")
    device = paired(client)
    doc = notedoc.new_doc("Mine")
    for taken in (private["id"], shared["id"]):
        answer = device.post("/notes", {"id": taken, "folder_id": "inbox", "update": b64(doc.get_update())})
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "note_id_taken"
    with SessionLocal() as db:
        assert db.get(Note, private["id"]).owner_id == lena.id


# --- B3, B11: what a device's token may not do --------------------------------------------------------------------


def test_notes24_ac5_a_device_reaches_nothing_that_outlives_disconnecting_it(client, operator):
    device = paired(client)
    headers = device.headers
    refused = [
        ("POST", "/api/tokens", {"name": "keep me", "level": "write", "mcp": False, "folders": None, "days": None}),
        ("GET", "/api/tokens", None),
        ("PUT", "/api/auth/password", {"current": PASSWORD, "new": "another long password"}),
        ("POST", "/api/auth/totp/begin", None),
        ("GET", "/api/oidc/me", None),
        ("PUT", "/api/me/profile", {"email": "taken@example.com"}),
        ("PUT", "/api/nextasks", {"url": "https://tasks.example.com", "token": "ntk_x"}),
        ("POST", "/api/oauth/authorize", {"client_id": "x"}),
        ("GET", "/api/settings", None),
        ("GET", "/api/accounts", None),
        ("GET", "/api/backups", None),
    ]
    for method, path, body in refused:
        answer = client.request(method, path, json=body, headers=headers)
        assert answer.status_code == 403, (method, path, answer.status_code, answer.text)
        assert answer.json()["detail"]["code"] == "browser_only", (method, path)
    with SessionLocal() as db:
        assert db.scalar(select(ApiToken).where(ApiToken.kind == "api")) is None
        assert db.get(Account, operator.id).email == "tester@example.com"
    # Its name it may change, the address staying as it is.
    named = client.put("/api/me/profile", json={"display_name": "Mila", "email": "tester@example.com"},
                       headers=headers)
    assert named.status_code == 200 and named.json()["display_name"] == "Mila"
    # The browser itself may.
    assert client.get("/api/tokens").status_code == 200


def test_notes24_ac5_a_new_password_or_signing_out_everywhere_disconnects_the_devices(client, operator):
    phone = paired(client, "iPhone")
    answer = client.put("/api/auth/password", json={"current": PASSWORD, "new": "another long password",
                                                    "password_confirm": "another long password"})
    assert answer.status_code == 204, answer.text
    assert phone.get("/me").json()["detail"]["code"] == "device_disconnected"
    pad = paired(client, "iPad", "ipados")
    assert client.post("/api/auth/logout-all").status_code == 204
    assert pad.get("/me").json()["detail"]["code"] == "device_disconnected"
    assert client.get("/api/app-devices").json() == []


# --- B12: a second factor required ------------------------------------------------------------------------------


def test_notes24_ec5_a_required_second_factor_sends_the_device_to_sign_in_again(client, operator):
    device = paired(client)
    device.new_note(APP_ID, "Mine")
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": True})
    for answer in (device.get("/changes"), device.get("/me"),
                   client.get(f"/api/notes/{APP_ID}", headers=device.headers)):
        assert answer.status_code == 401 and answer.json()["detail"]["code"] == "second_factor_required"
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": False})
    assert device.get("/me").status_code == 200


# --- B4: a full list read in pages ----------------------------------------------------------------------------------


def test_notes24_ec4_what_goes_for_good_between_the_pages_of_a_full_list_comes_as_removed(client, operator,
                                                                                         monkeypatch):
    monkeypatch.setattr(appsync, "PAGE", 3)
    device = paired(client)
    ids = [f"N{index:021d}" for index in range(7)]
    for note_id in ids:
        device.new_note(note_id, note_id)
    first = device.changes()
    assert first["full"] is True and first["more"] is True
    went = first["notes"][0]["id"]
    # Between the pages it goes for good in the browser.
    assert client.delete(f"/api/notes/{went}").status_code == 204
    assert client.delete(f"/api/trash/notes/{went}").status_code < 400
    pages = [first]
    while pages[-1]["more"]:
        pages.append(device.changes())
    assert all(page["full"] for page in pages)
    assert {"kind": "note", "id": went} in pages[-1]["removed"]
    assert all(page["removed"] == [] for page in pages[:-1])
    # Afterwards an ordinary answer, without the tombstone again.
    assert device.changes()["removed"] == []


# --- B5: tombstones only for those concerned -----------------------------------------------------------------------


def test_notes24_ac4_tombstones_reach_nobody_uninvolved(client, operator):
    lena = make_account("lena")
    nina = make_account("nina")
    with new_client(lena) as other, new_client(nina) as third:
        shared = other.post("/api/notes", json={"markdown": "For Tester"}).json()
        share(other, "note", shared["id"], operator, "read")
        private = other.post("/api/notes", json={"markdown": "Lena alone"}).json()
        lenas = paired(other, "Lena's iPhone")
        ninas = paired(third, "Nina's iPhone")
        testers = paired(client, "Tester's iPhone")
        for device in (lenas, ninas, testers):
            device.changes()
        assert other.delete(f"/api/notes/{private['id']}").status_code == 204
        assert other.delete(f"/api/trash/notes/{private['id']}").status_code < 400
        assert lenas.changes()["removed"] == [{"kind": "note", "id": private["id"]}]
        # Nina shares nothing with Lena: she never hears of Lena's notes.
        assert ninas.changes()["removed"] == []
        with SessionLocal() as db:
            assert db.scalar(select(appsync.AppTombstone).where(appsync.AppTombstone.account_id.is_(None))) is None
            concerned = set(db.scalars(select(appsync.AppTombstone.account_id)))
        assert nina.id not in concerned


# --- B8: attachments from the app (AC-8) ---------------------------------------------------------------------------


def test_notes24_ac8_a_scan_with_text_from_the_app_and_the_web_s_limits(client, operator):
    device = paired(client)
    device.new_note(APP_ID, "Lease")
    headers = device.headers
    scan = client.post("/api/attachments", params={"note_id": APP_ID, "id": attachments.new_id(), "name": "Scan.jpg",
                                                   "as": "scan", "text": "device"},
                       content=picture(), headers=headers)
    assert scan.status_code == 201, scan.text
    assert scan.json()["kind"] == "scan"
    texted = client.put(f"/api/attachments/{scan.json()['id']}/text", headers=headers,
                        json={"pages": [{"text": "Lease Garden Street", "language": "en"}]})
    assert texted.status_code == 200, texted.text
    assert texted.json()["items"][0]["source"] == "device"
    # The limits of the web: the operator's largest file, and the account's storage.
    with SessionLocal() as db:
        settings_service.save(db, {"upload_max_mb": 1})
    large = client.post("/api/attachments", params={"note_id": APP_ID, "id": attachments.new_id(), "name": "big.bin"},
                        content=b"\1" * (MB + 1), headers=headers)
    assert large.status_code == 413 and large.json()["detail"]["code"] == "attachment_too_large"
    used = client.get("/api/attachments/limits", headers=headers).json()["used"]
    with SessionLocal() as db:
        db.get(Account, operator.id).storage_limit = used
        db.commit()
    full = client.post("/api/attachments", params={"note_id": APP_ID, "id": attachments.new_id(), "name": "a.bin"},
                       content=b"\1" * 10, headers=headers)
    assert full.status_code == 507 and full.json()["detail"]["code"] == "storage_limit_reached"


# --- B9: waking the waiting ----------------------------------------------------------------------------------------


def test_notes24_ac4_commits_close_together_wake_the_waiting_once(monkeypatch):
    # A wake still waiting from a test before (its timer) goes off first, so that it is not counted here.
    time.sleep(appsync.WAKE_EVERY * 2)
    woken: list[float] = []
    monkeypatch.setattr(appsync, "_wake_now", lambda: woken.append(time.monotonic()))
    monkeypatch.setattr(appsync, "_last_wake", 0.0)
    monkeypatch.setattr(appsync, "_wake_pending", False)
    for _ in range(50):
        appsync.wake()
    assert len(woken) == 1
    assert wait_for(lambda: len(woken) == 2, timeout=2)
    assert woken[1] - woken[0] >= appsync.WAKE_EVERY * 0.9
    # Fifty commits, two wakes (a commit of another thread of the run may add one).
    time.sleep(appsync.WAKE_EVERY * 2)
    assert len(woken) <= 3


def test_notes24_ac4_a_device_waits_once(client, operator):
    device = paired(client)
    device.changes()

    def waiting(into: dict) -> None:
        with new_client() as other:
            started = time.monotonic()
            into["answer"] = other.get("/api/app/1/wait", params={"cursor": device.cursor}, headers=device.headers)
            into["took"] = time.monotonic() - started

    first_result: dict = {}
    second_result: dict = {}
    one = threading.Thread(target=waiting, args=(first_result,), daemon=True)
    one.start()
    assert wait_for(lambda: bool(appsync._by_device))
    first = next(iter(appsync._by_device.values()))
    # The app asks again (its connection broke): the first request ends with the cursor it had.
    two = threading.Thread(target=waiting, args=(second_result,), daemon=True)
    two.start()
    one.join(timeout=10)
    ended_early = not one.is_alive()
    # A change ends the second (and the first too, were it still waiting).
    device.new_note(APP_ID, "Ends the second")
    two.join(timeout=15)
    one.join(timeout=15)
    assert ended_early and first.replaced
    assert first_result["answer"].json() == {"cursor": device.cursor} and first_result["took"] < 10
    assert second_result["answer"].json()["cursor"] > device.cursor


# --- B10: one note holds up no other -------------------------------------------------------------------------------


class SlowStore:
    """Loading note ``slow`` waits until let go; everything else answers at once."""

    def __init__(self) -> None:
        self.gate = asyncio.Event()

    async def load(self, note_id: str):
        if note_id == "slow":
            await self.gate.wait()
        return None, []

    async def save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
        return 1

    async def fold(self, note_id: str, folded: Folded) -> None:
        return None

    async def summary(self, note_id: str, title: str, text: str) -> None:
        return None


def test_notes24_ac3_a_note_being_loaded_holds_up_no_other():
    async def run() -> None:
        store = SlowStore()

        async def check(_peer):
            raise AssertionError("no connection here")

        rooms = Rooms(store, check)
        doc = notedoc.new_doc("From the app")
        slow = asyncio.create_task(rooms.apply("slow", doc.get_update(), account_id=1, state_vector=b""))
        await asyncio.sleep(0.05)
        # Another note is read and changed while the first one still loads.
        await asyncio.wait_for(rooms.change("other", lambda d: None), timeout=1)
        await asyncio.wait_for(rooms.apply("other", None, account_id=1, state_vector=b""), timeout=1)
        assert not slow.done()
        store.gate.set()
        vector, _lacking, title = await asyncio.wait_for(slow, timeout=1)
        assert title == "From the app" and vector == doc.get_state()
        assert rooms.note_locks == {}

    asyncio.run(run())


def test_notes24_ac3_a_room_opened_meanwhile_starts_from_what_was_stored():
    """The same note: a room that opens while a device's update is stored waits for it and starts with it."""

    async def run() -> None:
        stored_updates: list[bytes] = []
        gate = asyncio.Event()

        class Store(SlowStore):
            async def load(self, note_id: str):
                return None, list(stored_updates)

            async def save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
                await gate.wait()
                stored_updates.append(update)
                return len(stored_updates)

        async def check(_peer):
            raise AssertionError("no connection here")

        rooms = Rooms(Store(), check)
        doc = notedoc.new_doc("Stored first")
        saving = asyncio.create_task(rooms.apply("n", doc.get_update(), account_id=1, state_vector=b""))
        await asyncio.sleep(0.05)
        opening = asyncio.create_task(rooms._open("n"))
        await asyncio.sleep(0.05)
        assert not opening.done()
        gate.set()
        await saving
        room = await opening
        assert notedoc.title_of(room.doc) == "Stored first"

    asyncio.run(run())

