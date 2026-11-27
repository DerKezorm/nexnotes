"""NOTES-24 Anbindung der iOS-App: pairing by QR code and by the sign-in page, the devices, ``/api/app/1``.

A test client of the interface (``App``) plays the app: it keeps its own Yjs documents with pycrdt, writes offline,
brings its updates with its state vector (``sync``) and asks what changed since its cursor (``changes``, ``wait``).
"""

from __future__ import annotations

import base64
import threading
import time
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from pycrdt import Doc
from sqlalchemy import func, select, update

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, Note, NoteUpdate, utcnow
from app.models_app import AppCode, AppPairing, AppTombstone
from app.models_notify import PushDevice
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.routers import app1 as app1_router
from app.security import brake
from app.services import accounts, appsync, devices

from .conftest import PASSWORD, TAB, make_account, new_client
from .notes_live import Live
from .test_notes3 import stored, token_for, wait_for
from .test_notes13 import make_folder, share, unshare


@pytest.fixture(autouse=True)
def _forget(client) -> None:
    """Live connections left open by a failing test are closed before the test client goes."""
    devices.forget()
    yield
    Live.close_all()


# --- The test client of the interface ------------------------------------------------------------------------------


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text)


class App:
    """One paired device: its token, its cursor, its own documents."""

    def __init__(self, client: TestClient, token: str) -> None:
        self.client = client
        self.token = token
        self.docs: dict[str, Doc] = {}
        self.cursor = 0

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def get(self, path: str, **params: object):
        return self.client.get(f"/api/app/1{path}", headers=self.headers, params=params)

    def post(self, path: str, body: object = None):
        return self.client.post(f"/api/app/1{path}", headers=self.headers, json=body)

    def put(self, path: str, body: object):
        return self.client.put(f"/api/app/1{path}", headers=self.headers, json=body)

    def patch(self, path: str, body: object):
        return self.client.patch(f"/api/app/1{path}", headers=self.headers, json=body)

    def delete(self, path: str):
        return self.client.delete(f"/api/app/1{path}", headers=self.headers)

    def new_note(self, note_id: str, title: str, text: str = "", folder_id: str = "inbox", **extra: object) -> dict:
        doc = notedoc.new_doc(title, {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}] if text else []}]})
        self.docs[note_id] = doc
        answer = self.post("/notes", {"id": note_id, "folder_id": folder_id, "update": b64(doc.get_update()),
                                      **extra})
        assert answer.status_code in (200, 201), answer.text
        return answer.json()

    def write(self, note_id: str, text: str) -> bytes:
        """Writes offline: the update stays with the app until the next ``sync``."""
        doc = self.docs[note_id]
        before = doc.get_state()
        edit.append_paragraph(doc, text)
        return doc.get_update(before)

    def sync(self, *note_ids: str, updates: dict[str, bytes] | None = None) -> dict[str, dict]:
        updates = updates or {}
        body = {"notes": [{"id": note_id, "sv": b64(self.docs.setdefault(note_id, _empty()).get_state()),
                           "update": b64(updates[note_id]) if note_id in updates else None}
                          for note_id in note_ids]}
        answer = self.post("/sync", body)
        assert answer.status_code == 200, answer.text
        out = {}
        for item in answer.json()["notes"]:
            out[item["id"]] = item
            if "update" in item:
                self.docs[item["id"]].apply_update(unb64(item["update"]))
        return out

    def changes(self) -> dict:
        answer = self.get("/changes", cursor=self.cursor)
        assert answer.status_code == 200, answer.text
        found = answer.json()
        self.cursor = found["cursor"]
        return found

    def text(self, note_id: str) -> str:
        return to_plain(self.docs[note_id])


def _empty() -> Doc:
    doc = Doc()
    notedoc.shared(doc)
    return doc


NOTE_A = "AAAAAAAAAAAAAAAAAAAAAA"
NOTE_B = "BBBBBBBBBBBBBBBBBBBBBB"
NOTE_C = "CCCCCCCCCCCCCCCCCCCCCC"


def browser_devices(client: TestClient) -> list[dict]:
    """``GET /api/app-devices`` of the browser (module geraete, G48: an object, newest first), oldest first."""
    answer = client.get("/api/app-devices")
    assert answer.status_code == 200, answer.text
    return sorted(answer.json()["devices"], key=lambda entry: entry["id"])


def pairing(client: TestClient) -> dict:
    answer = client.post("/api/app-pairing", json={"address": "https://notes.example.com"})
    assert answer.status_code == 201, answer.text
    return answer.json()


def pickup(client: TestClient, made: dict, name: str = "Mila's iPhone", kind: str = "ios"):
    return client.post(f"/api/app/1/pairing/{made['id']}/key",
                       json={"secret": made["secret"], "device_name": name, "device_kind": kind})


def paired(client: TestClient, name: str = "Mila's iPhone", kind: str = "ios") -> App:
    """A device of the account signed in at ``client`` (its browser), paired by QR code."""
    answer = pickup(client, pairing(client), name, kind)
    assert answer.status_code == 200, answer.text
    return App(client, answer.json()["token"])


def without_presets(account_id: int) -> None:
    """The smart folders every account gets (NOTES-7) are numbered too (NOTESIOS-7): tests that count the objects of
    a page of ``changes`` start without them."""
    from sqlalchemy import delete

    from app.models_smart import SmartFolder

    with SessionLocal() as db:
        db.execute(delete(SmartFolder).where(SmartFolder.owner_id == account_id))
        db.commit()


def note_updates(note_id: str) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(NoteUpdate).where(NoteUpdate.note_id == note_id)) or 0)


def stored_text(note_id: str) -> str:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        updates = [row.update for row in db.query(NoteUpdate).filter_by(note_id=note_id).order_by(NoteUpdate.id)]
        return to_plain(notedoc.load(note.ydoc, updates))


# --- AC-1, EC-3: the QR code ---------------------------------------------------------------------------------------


def test_notes24_ac1_qr_code_pairs_one_device_for_ten_minutes(client, operator):
    made = pairing(client)
    link = urlsplit(made["link"])
    assert (link.scheme, link.netloc) == ("nexnotes", "connect")
    query = parse_qs(link.query)
    # Module geraete (G6): the address under both names, ``server`` for nexnotes' app.
    assert query == {"server": ["https://notes.example.com"], "address": ["https://notes.example.com"],
                     "pairing": [made["id"]], "secret": [made["secret"]]}
    assert made["qr_svg"].startswith("<svg") and "viewBox" in made["qr_svg"]
    with SessionLocal() as db:
        row = db.get(AppPairing, made["id"])
        assert row is not None and row.secret_hash != made["secret"]
        assert timedelta(minutes=9) < row.expires_at - utcnow() <= timedelta(minutes=10)
    assert client.get(f"/api/app-pairing/{made['id']}").json() == {"state": "waiting", "device": None}

    answer = pickup(client, made, "Mila's iPhone", "ios")
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["token"].startswith("nnd_")
    assert answer.headers["cache-control"] == "no-store"
    assert body["account"] == {"id": operator.id, "name": "Tester", "login": "tester",
                               "email": "tester@example.com", "avatar": "", "operator": True}
    assert body["device"]["name"] == "Mila's iPhone" and body["device"]["kind"] == "ios"
    state = client.get(f"/api/app-pairing/{made['id']}").json()
    assert state["state"] == "used" and state["device"]["id"] == body["device"]["id"]
    assert App(client, body["token"]).get("/me").status_code == 200

    # One device per code.
    assert pickup(client, made, "Another iPad", "ipados").status_code == 410
    # A new code ("neu erzeugen") pairs the next one; a code withdrawn pairs nobody.
    again = pairing(client)
    assert client.delete(f"/api/app-pairing/{again['id']}").status_code == 204
    assert pickup(client, again).status_code == 410
    assert pickup(client, pairing(client), "iPad", "ipados").status_code == 200


def test_notes24_ac1_a_code_runs_out_after_ten_minutes(client, operator):
    made = pairing(client)
    with SessionLocal() as db:
        db.execute(update(AppPairing).where(AppPairing.id == made["id"])
                   .values(expires_at=utcnow() - timedelta(seconds=1)))
        db.commit()
    assert client.get(f"/api/app-pairing/{made['id']}").json()["state"] == "expired"
    answer = pickup(client, made)
    assert answer.status_code == 410 and answer.json()["detail"]["code"] == "pairing_gone"


def test_notes24_ac1_only_a_browser_makes_codes_and_only_its_own_are_seen(client, operator):
    device = paired(client)
    assert client.post("/api/app-pairing", headers=device.headers).json()["detail"]["code"] == "browser_only"
    made = pairing(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        assert other.get(f"/api/app-pairing/{made['id']}").status_code == 404
        assert other.delete(f"/api/app-pairing/{made['id']}").status_code == 404


def test_notes24_ec3_wrong_used_or_expired_codes_are_refused_and_count_at_the_brake(client, operator):
    made = pairing(client)
    wrong = client.post(f"/api/app/1/pairing/{made['id']}/key", json={"secret": "x" * 43, "device_name": "iPhone"})
    assert wrong.status_code == 410 and wrong.json()["detail"]["code"] == "pairing_gone"
    unknown = client.post("/api/app/1/pairing/nothing-here/key", json={"secret": made["secret"]})
    assert unknown.status_code == 410
    used = pickup(client, made)
    assert used.status_code == 200
    assert pickup(client, made).status_code == 410
    # Failures count at the sign-in brake of the sender: after a few, everyone of it waits, right or wrong.
    for _ in range(brake.FREE):
        client.post(f"/api/app/1/pairing/{made['id']}/key", json={"secret": "wrong"})
    braked = pickup(client, pairing(client))
    assert braked.status_code == 429
    assert braked.json()["detail"]["code"] == "too_many_attempts"
    assert int(braked.headers["retry-after"]) > 0


# --- AC-2: the address and the sign-in page -------------------------------------------------------------------------


def _connect(client: TestClient, state: str = "S" * 22) -> str:
    answer = client.post("/api/app-connect", json={"state": state})
    assert answer.status_code == 200, answer.text
    # Module geraete (G48): the page's link back into the app is ``redirect``.
    link = urlsplit(answer.json()["redirect"])
    assert (link.scheme, link.netloc) == ("nexnotes", "connected")
    query = parse_qs(link.query)
    assert query["state"] == [state]
    return query["code"][0]


def test_notes24_ac2_the_sign_in_page_hands_the_app_a_one_time_code(client, operator):
    code = _connect(client)
    with SessionLocal() as db:
        row = db.scalar(select(AppCode))
        assert row is not None and row.code_hash != code and row.state == "S" * 22
        assert timedelta(minutes=4) < row.expires_at - utcnow() <= timedelta(minutes=5)
    answer = client.post("/api/app/1/pairing/code", json={"code": code, "device_name": "iPad", "device_kind": "ipados"})
    assert answer.status_code == 200, answer.text
    assert answer.json()["account"]["id"] == operator.id
    assert answer.json()["device"]["kind"] == "ipados"
    assert App(client, answer.json()["token"]).get("/me").status_code == 200
    # Once only.
    again = client.post("/api/app/1/pairing/code", json={"code": code, "device_name": "iPad"})
    assert again.status_code == 410 and again.json()["detail"]["code"] == "pairing_gone"


def test_notes24_ac2_a_code_runs_out_after_five_minutes_and_needs_a_state(client, operator):
    code = _connect(client)
    with SessionLocal() as db:
        db.execute(update(AppCode).values(expires_at=utcnow() - timedelta(seconds=1)))
        db.commit()
    assert client.post("/api/app/1/pairing/code", json={"code": code}).status_code == 410
    assert client.post("/api/app/1/pairing/code", json={"code": "made-up"}).status_code == 410
    for state in ("", "short", "with spaces in it", "x" * 129, "<script>alert(1)</script>"):
        assert client.post("/api/app-connect", json={"state": state}).status_code == 422


def test_notes24_ac2_works_after_signing_in_with_the_password(operator):
    with TestClient(app, base_url="http://testserver", headers=TAB) as browser:
        assert browser.post("/api/app-connect", json={"state": "S" * 22}).status_code == 401
        signed = browser.post("/api/auth/login", json={"name": "tester", "password": PASSWORD})
        assert signed.status_code == 200, signed.text
        code = _connect(browser)
        assert browser.post("/api/app/1/pairing/code", json={"code": code}).status_code == 200


def test_notes24_ac2_a_device_cannot_make_codes_for_more_devices(client, operator):
    device = paired(client)
    answer = client.post("/api/app-connect", json={"state": "S" * 22}, headers=device.headers)
    assert answer.status_code == 403


# --- EC-2: versions -------------------------------------------------------------------------------------------------


def test_notes24_ec2_hello_says_which_interface_the_server_speaks(client):
    with TestClient(app, base_url="http://testserver") as stranger:
        answer = stranger.get("/api/app/1/hello")
    assert answer.status_code == 200
    body = answer.json()
    assert body["app"] == "nexnotes" and body["api"] == 1 and body["min_api"] == 1
    assert body["version"] and isinstance(body["sign_in"], list)
    # An app of a newer interface finds none and says "update the server"; an older one none either.
    assert client.get("/api/app/2/hello").status_code == 404
    assert client.get("/api/app/0/hello").status_code == 404


def test_notes24_ec2_hello_names_the_ways_in(client, operator):
    from app.services import settings_service

    with SessionLocal() as db:
        settings_service.save(db, {"password_login": True})
    assert client.get("/api/app/1/hello").json()["sign_in"] == ["password"]


# --- AC-3, EC-6: text ------------------------------------------------------------------------------------------------


def test_notes24_ac3_what_the_app_wrote_offline_is_stored_and_reaches_open_browsers(client, operator):
    device = paired(client)
    made = device.new_note(NOTE_A, "Packing list", "socks")
    assert made["id"] == NOTE_A and made["folder_id"] == "inbox" and made["right"] == "owner"
    assert stored(NOTE_A).owner_id == operator.id
    assert wait_for(lambda: stored(NOTE_A).title == "Packing list")

    browser = Live(client, NOTE_A, token_for(operator))
    assert browser.pump(lambda: "socks" in browser.text)
    # Offline in the app and in the browser at the same time: both stay.
    offline = device.write(NOTE_A, "toothbrush")
    edit.append_paragraph(browser.doc, "charger")
    browser.settle()
    answer = device.sync(NOTE_A, updates={NOTE_A: offline})[NOTE_A]
    assert "error" not in answer
    # Stored before the answer went out, and in the open browser at once.
    assert "toothbrush" in stored_text(NOTE_A)
    assert browser.pump(lambda: "toothbrush" in browser.text)
    assert "charger" in device.text(NOTE_A) and "toothbrush" in device.text(NOTE_A)
    assert answer["sv"] and answer["title"] == "Packing list" and answer["seq"] > 0
    with SessionLocal() as db:
        assert db.get(Note, NOTE_A).updated_by_id == operator.id


def test_notes24_ac3_reading_without_an_update_gives_what_the_app_lacks(client, operator):
    device = paired(client)
    note = client.post("/api/notes", json={"markdown": "from the browser"}).json()
    found = device.sync(note["id"])[note["id"]]
    assert "error" not in found
    assert "from the browser" in device.text(note["id"])
    before, text = note_updates(note["id"]), device.text(note["id"])
    again = device.sync(note["id"])[note["id"]]
    assert again["sv"] == found["sv"] and device.text(note["id"]) == text
    assert note_updates(note["id"]) == before


def test_notes24_ac3_no_right_unknown_and_locked_notes_take_nothing(client, operator):
    device = paired(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        theirs = other.post("/api/notes", json={"markdown": "Lena's"}).json()
        share(other, "note", theirs["id"], operator, "read")
    found = device.sync(theirs["id"])[theirs["id"]]
    assert "error" not in found and "Lena's" in device.text(theirs["id"])
    before = note_updates(theirs["id"])
    refused = device.sync(theirs["id"], updates={theirs["id"]: device.write(theirs["id"], "mine")})[theirs["id"]]
    assert refused == {"id": theirs["id"], "error": "no_right"}
    assert note_updates(theirs["id"]) == before

    assert device.sync("ZZZZZZZZZZZZZZZZZZZZZZ")["ZZZZZZZZZZZZZZZZZZZZZZ"]["error"] == "not_found"
    device.new_note(NOTE_B, "Secret")
    with SessionLocal() as db:
        db.get(Note, NOTE_B).locked = True
        db.commit()
    locked = device.sync(NOTE_B, updates={NOTE_B: device.write(NOTE_B, "plain")})[NOTE_B]
    assert locked["error"] == "note_locked"
    too_many = device.post("/sync", {"notes": [{"id": NOTE_A, "sv": ""}] * 51})
    assert too_many.status_code == 422 and too_many.json()["detail"]["code"] == "too_many_notes"
    bad = device.post("/sync", {"notes": [{"id": NOTE_B, "sv": "", "update": "not base64!"}]})
    assert bad.json()["notes"][0]["error"] == "invalid_update"


def test_notes24_ac3_a_share_withdrawn_takes_nothing_more(client, operator):
    lena = make_account("lena")
    with new_client(lena) as other:
        theirs = other.post("/api/notes", json={"markdown": "Lena's list"}).json()
        share(other, "note", theirs["id"], operator, "write")
        device = paired(client)
        device.sync(theirs["id"])
        pending = device.write(theirs["id"], "milk")
        unshare(other, "note", theirs["id"], operator)
    before = note_updates(theirs["id"])
    answer = device.sync(theirs["id"], updates={theirs["id"]: pending})[theirs["id"]]
    # Not seen any more: not told apart from a note that is not there.
    assert answer["error"] == "not_found"
    assert note_updates(theirs["id"]) == before


def test_notes24_ec6_the_same_update_twice_changes_nothing(client, operator):
    device = paired(client)
    device.new_note(NOTE_A, "Shopping")
    pending = device.write(NOTE_A, "bread")
    device.sync(NOTE_A, updates={NOTE_A: pending})
    count = note_updates(NOTE_A)
    # The answer got lost on the way: the app sends the same again.
    again = device.sync(NOTE_A, updates={NOTE_A: pending})[NOTE_A]
    assert "error" not in again
    assert note_updates(NOTE_A) == count
    assert stored_text(NOTE_A).count("bread") == 1
    # The same id again is the same note, nothing doubles.
    same = device.post("/notes", {"id": NOTE_A, "folder_id": "inbox", "update": b64(device.docs[NOTE_A].get_update())})
    assert same.status_code == 200 and same.json()["id"] == NOTE_A
    assert unb64(same.json()["sv"]) == device.docs[NOTE_A].get_state()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Note)) == 1
    assert stored_text(NOTE_A).count("bread") == 1


def test_notes24_ec6_after_a_restart_the_app_sends_again_and_nothing_doubles(operator):
    with new_client(operator) as first:
        device = paired(first)
        device.new_note(NOTE_A, "Trip")
        pending = device.write(NOTE_A, "passport")
        device.sync(NOTE_A, updates={NOTE_A: pending})
    # The server stopped (its rooms folded) and started again; the app never heard the answer.
    with new_client(operator) as second:
        device.client = second
        answer = device.sync(NOTE_A, updates={NOTE_A: pending})[NOTE_A]
        assert "error" not in answer
        assert stored_text(NOTE_A).count("passport") == 1
        assert device.text(NOTE_A).count("passport") == 1


def test_notes24_ec6_two_devices_write_the_same_note_offline(client, operator):
    phone = paired(client, "iPhone")
    pad = paired(client, "iPad", "ipados")
    phone.new_note(NOTE_A, "Plan")
    pad.sync(NOTE_A)
    one = phone.write(NOTE_A, "from the phone")
    two = pad.write(NOTE_A, "from the pad")
    pad.sync(NOTE_A, updates={NOTE_A: two})
    phone.sync(NOTE_A, updates={NOTE_A: one})
    pad.sync(NOTE_A)
    for device in (phone, pad):
        assert "from the phone" in device.text(NOTE_A) and "from the pad" in device.text(NOTE_A)
    assert phone.text(NOTE_A) == pad.text(NOTE_A) == stored_text(NOTE_A)


# --- Notes ------------------------------------------------------------------------------------------------------------


def test_notes24_ac3_notes_made_moved_trashed_and_restored_by_the_app(client, operator):
    device = paired(client)
    folder = make_folder(client, "Household")
    made = device.new_note(NOTE_A, "Chores", paper="lined", icon="", folder_id=folder)
    assert made["folder_id"] == folder and made["paper"] == "lined" and "sv" in made
    assert device.post("/notes", {"id": "short", "update": b64(b"x")}).status_code == 422
    assert device.post("/notes", {"id": NOTE_C, "folder_id": "inbox", "update": "@@"}).status_code == 422
    assert stored(NOTE_A).folder_id == folder

    flagged = device.patch(f"/notes/{NOTE_A}", {"title_check": True})
    assert flagged.json()["title_check"] is True and stored(NOTE_A).title_check is True
    assert device.patch(f"/notes/{NOTE_A}", {"title_ok": True}).json()["title_check"] is False
    moved = device.patch(f"/notes/{NOTE_A}", {"folder_id": "inbox", "pinned": True, "color": "red"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["folder_id"] == "inbox" and moved.json()["pinned"] is True
    assert device.patch(f"/notes/{NOTE_A}", {"paper": "felt"}).status_code == 422
    assert device.delete(f"/notes/{NOTE_A}").status_code == 204
    assert stored(NOTE_A).deleted_at is not None
    back = device.post(f"/notes/{NOTE_A}/restore")
    assert back.status_code == 200 and back.json()["deleted_at"] is None


def test_notes24_ac3_a_reader_may_pin_but_not_change(client, operator):
    lena = make_account("lena")
    with new_client(lena) as other:
        theirs = other.post("/api/notes", json={"markdown": "Lena's"}).json()
        share(other, "note", theirs["id"], operator, "read")
    device = paired(client)
    assert device.patch(f"/notes/{theirs['id']}", {"pinned": True}).json()["pinned"] is True
    refused = device.patch(f"/notes/{theirs['id']}", {"paper": "grid"})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "no_right"
    assert device.delete(f"/notes/{theirs['id']}").status_code == 403
    assert device.patch("/notes/ZZZZZZZZZZZZZZZZZZZZZZ", {"pinned": True}).status_code == 404


# --- AC-4, EC-4: what changed ---------------------------------------------------------------------------------------


def test_notes24_ac4_after_a_long_pause_only_what_changed_comes(client, operator):
    device = paired(client)
    for note_id in (NOTE_A, NOTE_B, NOTE_C):
        device.new_note(note_id, f"Note {note_id[0]}")
    folder = make_folder(client, "Garden")
    first = device.changes()
    assert first["full"] is True and first["more"] is False
    assert {note["id"] for note in first["notes"]} == {NOTE_A, NOTE_B, NOTE_C}
    assert [entry["id"] for entry in first["folders"]] == [folder]
    assert device.changes()["notes"] == []

    # A long pause: in the browser one note gets text, one is moved, the folder renamed.
    browser = Live(client, NOTE_B, token_for(operator))
    assert browser.pump(lambda: browser.synced)
    edit.append_paragraph(browser.doc, "seeds")
    browser.settle()
    browser.disconnect()
    assert client.post("/api/folders/move", json={"target_id": folder, "folder_ids": [],
                                                   "note_ids": [NOTE_C]}).status_code == 200
    assert client.patch(f"/api/folders/{folder}", json={"name": "Vegetable garden"}).status_code == 200
    found = device.changes()
    assert found["full"] is False
    assert {note["id"] for note in found["notes"]} == {NOTE_B, NOTE_C}
    assert [entry["name"] for entry in found["folders"]] == ["Vegetable garden"]
    by_id = {note["id"]: note for note in found["notes"]}
    assert by_id[NOTE_C]["folder_id"] == folder
    # The note whose seq grew is synced on its own; the others stay as they are.
    assert "error" not in device.sync(NOTE_B)[NOTE_B]
    assert "seeds" in device.text(NOTE_B)
    assert device.changes()["notes"] == []
    # A change of the server's own (text put back, a shape mended: no account, no "changed by") counts as well.
    extra = notedoc.load(None, [device.docs[NOTE_A].get_update()])
    before = extra.get_state()
    edit.append_paragraph(extra, "put back")
    with SessionLocal() as db:
        db.add(NoteUpdate(note_id=NOTE_A, update=extra.get_update(before), account_id=None))
        db.commit()
    assert [note["id"] for note in device.changes()["notes"]] == [NOTE_A]


def test_notes24_ac4_pages_of_at_most_500_never_end_inside_one_change(client, operator, monkeypatch):
    without_presets(operator.id)
    device = paired(client)
    ids = [f"N{index:021d}" for index in range(7)]
    for note_id in ids:
        device.new_note(note_id, note_id)
    with SessionLocal() as db:
        account = db.get(Account, operator.id)
        page = appsync.changes(db, account, 0, page=3)
        assert page["more"] is True and len(page["notes"]) == 3
        rest = appsync.changes(db, account, page["cursor"], page=3)
        last = appsync.changes(db, account, rest["cursor"], page=3)
        assert last["more"] is False
        seen = [note["id"] for got in (page, rest, last) for note in got["notes"]]
        assert sorted(seen) == sorted(ids)
        # Five notes under one number (a bulk change): the page takes all five rather than cutting them.
        db.execute(update(Note).where(Note.id.in_(ids[:5])).values(color="red"))
        db.commit()
        together = appsync.changes(db, account, last["cursor"], page=3)
        assert len(together["notes"]) == 5 and together["more"] is False


def test_notes24_ac4_shared_notes_and_folders_come_with_their_right_and_go_when_withdrawn(client, operator):
    lena = make_account("lena")
    device = paired(client)
    device.changes()
    with new_client(lena) as other:
        folder = make_folder(other, "Holiday")
        inside = other.post("/api/notes", json={"markdown": "Tent", "folder_id": folder}).json()
        alone = other.post("/api/notes", json={"markdown": "Recipe"}).json()
        share(other, "folder", folder, operator, "write")
        share(other, "note", alone["id"], operator, "read")
        found = device.changes()
        notes_by_id = {note["id"]: note for note in found["notes"]}
        assert notes_by_id[inside["id"]]["right"] == "write" and notes_by_id[inside["id"]]["folder_id"] == folder
        # Shared alone: its folder (Lena's inbox) is not the app's to know.
        assert notes_by_id[alone["id"]]["right"] == "read" and notes_by_id[alone["id"]]["folder_id"] is None
        assert [entry["id"] for entry in found["folders"]] == [folder]
        assert found["folders"][0]["parent_id"] is None

        unshare(other, "folder", folder, operator)
        gone = device.changes()
        assert {(entry["kind"], entry["id"]) for entry in gone["removed"]} == {("folder", folder),
                                                                               ("note", inside["id"])}
        # Lena herself still sees it: her devices never hear of it as removed.
        lenas = paired(other, "Lena's iPhone")
        assert lenas.changes()["removed"] == []


def test_notes24_ac4_deleted_for_good_comes_as_removed(client, operator):
    device = paired(client)
    device.new_note(NOTE_A, "Old")
    device.new_note(NOTE_B, "Keep")
    device.changes()
    assert device.delete(f"/notes/{NOTE_A}").status_code == 204
    trashed = device.changes()
    assert [note["id"] for note in trashed["notes"]] == [NOTE_A] and trashed["notes"][0]["deleted_at"]
    assert client.delete(f"/api/trash/notes/{NOTE_A}").status_code in (200, 204)
    found = device.changes()
    assert found["removed"] == [{"kind": "note", "id": NOTE_A}]
    assert found["notes"] == []


def test_notes24_ec4_a_cursor_older_than_the_tombstones_gets_the_full_list(client, operator):
    device = paired(client)
    device.new_note(NOTE_A, "Gone soon")
    device.new_note(NOTE_B, "Stays")
    device.changes()
    old_cursor = device.cursor
    device.delete(f"/notes/{NOTE_A}")
    client.delete(f"/api/trash/notes/{NOTE_A}")
    # A year and more later: the tombstone is gone, the old cursor says nothing any more.
    with SessionLocal() as db:
        db.execute(update(AppTombstone).values(created_at=utcnow() - timedelta(days=appsync.KEEP_DAYS + 1)))
        db.commit()
    assert appsync.drop_old_tombstones() == 1
    device.cursor = old_cursor
    found = device.changes()
    assert found["full"] is True and found["removed"] == []
    assert [note["id"] for note in found["notes"]] == [NOTE_B]
    # The full list read in pages: the next cursor is above the floor, an ordinary answer.
    assert device.changes()["full"] is False


def test_notes24_ec4_every_page_of_a_full_list_says_full(client, operator, monkeypatch):
    without_presets(operator.id)
    monkeypatch.setattr(appsync, "PAGE", 3)
    device = paired(client)
    ids = [f"N{index:021d}" for index in range(7)]
    for note_id in ids:
        device.new_note(note_id, note_id)
    pages = [device.changes()]
    while pages[-1]["more"]:
        pages.append(device.changes())
    assert len(pages) == 3 and all(page["full"] for page in pages)
    assert sorted(note["id"] for page in pages for note in page["notes"]) == sorted(ids)
    # The full list is over: the next answer is an ordinary one.
    after = device.changes()
    assert after["full"] is False and after["notes"] == []


def test_notes24_ec4_a_cursor_from_a_server_restored_from_a_backup_gets_the_full_list(client, operator):
    device = paired(client)
    device.new_note(NOTE_A, "One")
    device.cursor = 10**9
    found = device.changes()
    assert found["full"] is True and [note["id"] for note in found["notes"]] == [NOTE_A]


def test_notes24_ac4_notes_from_before_get_numbers_of_their_own(client, operator):
    note = client.post("/api/notes", json={"markdown": "old"}).json()
    with SessionLocal() as db:
        db.execute(Note.__table__.update().values(sync_seq=0))
        db.commit()
    appsync.stamp_unnumbered()
    assert stored(note["id"]).sync_seq > 0
    device = paired(client)
    assert [entry["id"] for entry in device.changes()["notes"]] == [note["id"]]


# --- wait -------------------------------------------------------------------------------------------------------------


@pytest.mark.timing
def test_notes24_ac4_wait_answers_at_once_when_something_changed(client, operator, monkeypatch):
    device = paired(client)
    device.changes()
    result: dict = {}

    def waiting() -> None:
        with new_client() as other:
            started = time.monotonic()
            answer = other.get("/api/app/1/wait", params={"cursor": device.cursor}, headers=device.headers)
            result["answer"], result["took"] = answer, time.monotonic() - started

    thread = threading.Thread(target=waiting)
    thread.start()
    assert wait_for(lambda: bool(appsync._waiting))
    device.new_note(NOTE_A, "Wake up")
    thread.join(timeout=20)
    assert not thread.is_alive()
    assert result["answer"].status_code == 200
    assert result["answer"].json()["cursor"] > device.cursor
    # Woken by the commit, not found by the look every few seconds (``WAIT_RECHECK``).
    assert result["took"] < app1_router.WAIT_RECHECK - 1


def test_notes24_ac4_wait_gives_the_same_cursor_after_its_time(client, operator, monkeypatch):
    monkeypatch.setattr(app1_router, "WAIT_SECONDS", 0.3)
    device = paired(client)
    device.changes()
    answer = device.get("/wait", cursor=device.cursor)
    assert answer.json() == {"cursor": device.cursor}
    # Changes of somebody else's notes it does not see wake nothing for it.
    lena = make_account("lena")
    with new_client(lena) as other:
        other.post("/api/notes", json={"markdown": "Lena's"})
    assert device.get("/wait", cursor=device.cursor).json() == {"cursor": device.cursor}


def test_notes24_ec1_wait_ends_for_a_device_disconnected_meanwhile(client, operator, monkeypatch):
    monkeypatch.setattr(app1_router, "WAIT_RECHECK", 0.1)
    device = paired(client)
    device.changes()
    result: dict = {}

    def waiting() -> None:
        with new_client() as other:
            result["answer"] = other.get("/api/app/1/wait", params={"cursor": device.cursor}, headers=device.headers)

    thread = threading.Thread(target=waiting)
    thread.start()
    # The request waits before the device goes.
    assert wait_for(lambda: bool(appsync._waiting))
    with SessionLocal() as db:
        token_id = db.scalar(select(ApiToken.id).where(ApiToken.kind == "device"))
    assert client.delete(f"/api/app-devices/{token_id}").status_code == 204
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert result["answer"].status_code == 401
    assert result["answer"].json()["detail"]["code"] == "device_disconnected"


# --- AC-5, AC-7, EC-1, EC-5: devices ----------------------------------------------------------------------------------


def test_notes24_ac5_devices_with_name_kind_last_contact_and_notifications(client, operator):
    phone = paired(client, "iPhone von Mila", "ios")
    mac = paired(client, "Mac mini", "mac")
    assert browser_devices(client)[1]["last_seen_at"] is None
    assert mac.get("/me").status_code == 200
    assert phone.client.put("/api/app/1/push", headers=phone.headers,
                            json={"ticket": "t-1", "key": base64.b64encode(b"\x09" * 32).decode()}).status_code == 204
    listed = browser_devices(client)
    assert [(entry["name"], entry["kind"], entry["push"]) for entry in listed] == [
        ("iPhone von Mila", "ios", True), ("Mac mini", "mac", False)]
    assert all(entry["created_at"] and entry["last_seen_at"] for entry in listed)
    lena = make_account("lena")
    with new_client(lena) as other:
        assert browser_devices(other) == []
        assert other.delete(f"/api/app-devices/{listed[0]['id']}").status_code == 404


def test_notes24_ac5_a_disconnected_device_reaches_nothing_from_that_moment(client, operator):
    phone = paired(client, "iPhone")
    pad = paired(client, "iPad", "ipados")
    phone.new_note(NOTE_A, "Mine")
    phone_id = phone.get("/me").json()["device"]["id"]
    assert client.delete(f"/api/app-devices/{phone_id}").status_code == 204
    refused = phone.get("/changes", cursor=0)
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "device_disconnected"
    # Also on the browser's routes.
    assert client.get(f"/api/notes/{NOTE_A}", headers=phone.headers).status_code == 401
    assert pad.get("/me").status_code == 200
    assert [entry["name"] for entry in browser_devices(client)] == ["iPad"]


def test_notes24_ac5_the_app_disconnects_itself(client, operator):
    phone = paired(client)
    assert phone.delete("/device").status_code == 204
    assert phone.get("/me").json()["detail"]["code"] == "device_disconnected"
    assert browser_devices(client) == []


def test_notes24_ac7_another_own_device_comes_in_on_its_own(client, operator):
    phone = paired(client, "iPhone")
    answer = phone.post("/devices", {"device_name": "iPad", "device_kind": "ipados"})
    assert answer.status_code == 201, answer.text
    pad = App(client, answer.json()["token"])
    assert answer.json()["account"]["id"] == operator.id
    with SessionLocal() as db:
        row = db.get(ApiToken, answer.json()["device"]["id"])
        assert row.via_token_id == phone.get("/me").json()["device"]["id"]
    assert [entry["name"] for entry in browser_devices(client)] == ["iPhone", "iPad"]
    # Each is disconnected alone.
    assert client.delete(f"/api/app-devices/{answer.json()['device']['id']}").status_code == 204
    assert pad.get("/me").status_code == 401 and phone.get("/me").status_code == 200
    # No factory of tokens. The module counts the devices of the last hour that are still there (G33): the iPad
    # disconnected above no longer counts.
    for _ in range(devices.SIBLINGS_PER_HOUR):
        assert phone.post("/devices", {"device_name": "x"}).status_code == 201
    too_many = phone.post("/devices", {"device_name": "x"})
    assert too_many.status_code == 429 and too_many.headers["retry-after"] == "3600"


def test_notes24_ec1_a_disconnected_device_brings_offline_text_and_nothing_is_taken(client, operator):
    device = paired(client)
    device.new_note(NOTE_A, "Notes")
    pending = device.write(NOTE_A, "written offline")
    device.delete("/device")
    before = note_updates(NOTE_A)
    answer = device.post("/sync", {"notes": [{"id": NOTE_A, "sv": "", "update": b64(pending)}]})
    assert answer.status_code == 401 and answer.json()["detail"]["code"] == "device_disconnected"
    assert note_updates(NOTE_A) == before and "written offline" not in stored_text(NOTE_A)


def test_notes24_ec5_a_blocked_or_deleted_account_turns_its_devices_away(client, operator):
    lena = make_account("lena")
    with new_client(lena) as other:
        device = paired(other)
        device.new_note(NOTE_A, "Lena's")
        pending = device.write(NOTE_A, "after the block")
        with SessionLocal() as db:
            accounts.block(db, db.get(Account, lena.id))
        answer = device.post("/sync", {"notes": [{"id": NOTE_A, "sv": "", "update": b64(pending)}]})
        assert answer.status_code == 401 and answer.json()["detail"]["code"] == "account_blocked"
        assert "after the block" not in stored_text(NOTE_A)
        with SessionLocal() as db:
            accounts.unblock(db, db.get(Account, lena.id))
        # The device rested during the block and works again without pairing anew (G26, konten 1.1.5).
        assert device.get("/me").status_code == 200
    nina = make_account("nina")
    with new_client(nina) as other:
        device = paired(other)
        with SessionLocal() as db:
            accounts.delete_account(db, db.get(Account, nina.id))
        assert device.get("/changes").json()["detail"]["code"] == "account_blocked"


# --- AC-6: the push ticket ----------------------------------------------------------------------------------------


def test_notes24_ac6_the_push_ticket_is_kept_for_the_device(client, operator):
    device = paired(client)
    key = base64.b64encode(b"\x09" * 32).decode()
    assert device.client.put("/api/app/1/push", headers=device.headers, json={"ticket": "t-1", "key": key}).status_code \
        == 204
    with SessionLocal() as db:
        row = db.scalar(select(PushDevice))
        assert row is not None and row.ticket == "t-1" and row.key == key
    bad = device.client.put("/api/app/1/push", headers=device.headers, json={"ticket": "t-1", "key": "short"})
    assert bad.status_code == 422
    assert device.delete("/push").status_code == 204
    with SessionLocal() as db:
        assert db.scalar(select(PushDevice)) is None


def test_notes24_me_names_the_account_the_device_and_the_limits(client, operator):
    device = paired(client, "iPhone")
    body = device.get("/me").json()
    assert body["account"]["login"] == "tester" and body["device"]["name"] == "iPhone"
    assert body["paper"] == "blank" and set(body["list_look"]) == {"style", "hints", "hint_kinds"}
    assert body["limits"]["sync_notes"] == 50 and body["limits"]["changes_page"] == 500
    assert set(body["offers"]) >= {"push"}


def test_notes24_the_app_needs_no_tab_header_but_a_token(client, operator):
    with TestClient(app, base_url="http://testserver") as bare:
        assert bare.get("/api/app/1/me").json()["detail"]["code"] == "device_disconnected"
        assert bare.get("/api/app/1/me", headers={"Authorization": "Bearer nn_api_x"}).status_code == 401
        device = paired(client)
        device.client = bare
        assert device.post("/sync", {"notes": []}).status_code == 200


def test_notes24_notesios1_the_app_hears_whether_the_account_runs_the_server(client: TestClient, operator) -> None:
    """NOTESIOS-1 (23.11.2026): the app names the browser's server pages (server, accounts, log) only to the operator;
    a member's device hears ``operator: false`` in ``/me`` and when it pairs."""
    assert paired(client).get("/me").json()["account"]["operator"] is True
    lena = make_account("lena")
    with new_client(lena) as other:
        made = pairing(other)
        answer = pickup(other, made)
        assert answer.status_code == 200, answer.text
        assert answer.json()["account"]["operator"] is False
        assert App(other, answer.json()["token"]).get("/me").json()["account"]["operator"] is False


def test_notes24_notesios5_a_quick_note_tells_the_app_where_it_came_from(client: TestClient, operator) -> None:
    """NOTESIOS-5 AC-4 (23.11.2026): ``changes`` carries the origin of a note (contract 0.12), so another device of the
    same account shows "from the share sheet" too; a note without one carries an empty origin."""
    device = paired(client)
    device.new_note("01HZQUICKORIGIN0000000000A", "Recipe link", "https://example.com/recipe", origin="share:Safari")
    device.new_note("01HZQUICKORIGIN0000000000B", "Plain")
    other = paired(client)
    notes = {item["id"]: item for item in other.changes()["notes"]}
    assert notes["01HZQUICKORIGIN0000000000A"]["origin"] == "share:Safari"
    assert notes["01HZQUICKORIGIN0000000000B"]["origin"] == ""


def test_notes24_notesios21_changes_carry_when_a_note_was_pinned(client: TestClient, operator) -> None:
    """NOTESIOS-21 (23.11.2026): ``changes`` carries when a note was pinned (contract 0.13), so the app's Markdown
    export writes ``pinned_at`` like the server's. An own note carries its pin, a note of somebody else the member's own
    pin of it, a note not pinned none."""
    from datetime import UTC, datetime

    from app.models_shares import SharePin

    sharer = make_account("sharer")
    with new_client(sharer) as other:
        theirs = other.post("/api/notes", json={"markdown": "Shared list"}).json()
        share(other, "note", theirs["id"], operator, "read")
    device = paired(client)
    device.new_note(NOTE_A, "Pinned")
    device.new_note(NOTE_B, "Loose")
    assert device.patch(f"/notes/{NOTE_A}", {"pinned": True}).json()["pinned"] is True
    assert device.patch(f"/notes/{theirs['id']}", {"pinned": True}).json()["pinned"] is True
    own_pin = datetime(2026, 11, 20, 8, 15, 30, 250000, tzinfo=UTC)
    member_pin = datetime(2026, 11, 21, 17, 0, 5, tzinfo=UTC)
    with SessionLocal() as db:
        db.execute(update(Note).where(Note.id == NOTE_A).values(pinned_at=own_pin))
        db.execute(update(SharePin).where(SharePin.note_id == theirs["id"]).values(pinned_at=member_pin))
        db.commit()
    notes = {item["id"]: item for item in paired(client).changes()["notes"]}
    assert notes[NOTE_A]["pinned_at"] == "2026-11-20T08:15:30.250000Z"
    assert notes[theirs["id"]]["pinned_at"] == "2026-11-21T17:00:05Z"
    assert notes[NOTE_B]["pinned"] is False and notes[NOTE_B]["pinned_at"] is None
