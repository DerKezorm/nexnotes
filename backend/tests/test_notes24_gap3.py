"""Interface 0.10 of the app: nextasks connected, changed and disconnected from the app (NOTESIOS-22 AC-7), and a
locked note brought over from another account sealed on the device (NOTESIOS-13 EC-4, NOTESIOS-16 AC-8).

The device is the test client of ``test_notes24.py``; nextasks is the stand-in of ``test_notes19.py``; the vault's
encryption is played by ``vault_client.py`` as the browser and the app do it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Note
from app.models_nextasks import NextasksConnection
from app.models_vault import SealedNote
from app.notedoc import doc as notedoc
from app.services import devices

from . import test_notes19
from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes13 import make_folder
from .test_notes19 import GOOD, HOME, PUBLIC, FakeNextasks, allow_home
from .test_notes24 import paired
from .vault_client import Device, b64, content_aad, seal, unseal

VAULT_PASSWORD = "Tresor-Passwort 2026"
LOCKED = "lK_fromICloud-7uYtReWq"
#: The stand-in nextasks of NOTES-19 as a fixture here.
fake = test_notes19.fake


@pytest.fixture(autouse=True)
def _forget(client) -> None:
    devices.forget()
    yield
    Live.close_all()


def code(answer) -> str:
    return answer.json()["detail"]["code"]


# --- nextasks from the app (NOTESIOS-22 AC-7) ---------------------------------------------------------------------


def test_notes24_notesios22_ac7_the_app_connects_changes_and_disconnects_nextasks(client, operator, fake: FakeNextasks):
    allow_home(client)
    device = paired(client)
    assert device.get("/nextasks").json()["connected"] is False
    made = device.put("/nextasks", {"url": f"  {HOME}  ", "token": GOOD})
    assert made.status_code == 200, made.text
    assert (made.json()["connected"], made.json()["name"], made.json()["url"]) == (True, "Robin", HOME)
    # The browser sees the same connection.
    assert client.get("/api/nextasks").json()["host"] == "nextasks.home"
    changed = device.put("/nextasks", {"url": PUBLIC, "token": GOOD})
    assert changed.status_code == 200 and changed.json()["host"] == "tasks.example.com"
    wrong = device.put("/nextasks", {"url": PUBLIC, "token": "ntk_" + "x" * 40})
    assert (wrong.status_code, code(wrong)) == (409, "nextasks_token_invalid")
    assert device.get("/nextasks").json()["host"] == "tasks.example.com", "a refused key changes nothing"
    gone = device.delete("/nextasks")
    assert gone.status_code == 204
    assert client.get("/api/nextasks").json()["connected"] is False
    # The browser's own routes stay the browser's.
    refused = client.put("/api/nextasks", json={"url": PUBLIC, "token": GOOD}, headers=device.headers)
    assert (refused.status_code, code(refused)) == (403, "browser_only")


def test_notes24_notesios22_ac7_a_connection_made_by_a_device_goes_with_the_device(client, operator, fake: FakeNextasks):
    device = paired(client)
    assert device.put("/nextasks", {"url": PUBLIC, "token": GOOD}).status_code == 200
    own = next(row for row in device.get("/devices").json() if row["this"])
    # Disconnected in the browser: nothing the device set outlives it (NOTES-24 AC-5).
    assert client.delete(f"/api/app-devices/{own['id']}").status_code in (200, 204)
    assert client.get("/api/nextasks").json()["connected"] is False
    with SessionLocal() as db:
        assert db.get(NextasksConnection, operator.id) is None
    # Connected in the browser, the connection is the account's and stays when a device goes.
    assert client.put("/api/nextasks", json={"url": PUBLIC, "token": GOOD}).status_code == 200
    other = paired(client, "Mila's iPad", "ipados")
    other_id = next(row for row in other.get("/devices").json() if row["this"])["id"]
    assert client.delete(f"/api/app-devices/{other_id}").status_code in (200, 204)
    assert client.get("/api/nextasks").json()["connected"] is True


# --- A locked note brought over (NOTESIOS-13 EC-4, NOTESIOS-16 AC-8) ------------------------------------------------


def _locked_body(browser: Device, state: bytes, **extra: object) -> dict:
    return {"id": LOCKED, "folder_id": "inbox", "title": "Kontodaten",
            "content": b64(seal(browser.nkey(LOCKED), state, content_aad(LOCKED, 1))), "epoch": browser.epoch,
            "paper": "lined", "color": "berry", "pinned": True, **extra}


def test_notes24_notesios13_ec4_a_locked_note_comes_sealed_and_is_never_plain_here(client, operator):
    browser = Device(client, operator.id)
    device = paired(client)
    secret = "IBAN geheim 1234"
    doc = notedoc.new_doc("Kontodaten", {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": secret}]}]})
    state = doc.get_update()
    # No vault in this account yet: the app sets one up first.
    missing = device.post("/locked-notes", {**_locked_body(Device(client, operator.id, key=b"k" * 32, epoch=1), state)})
    assert (missing.status_code, code(missing)) == (404, "vault_missing")
    browser.setup(VAULT_PASSWORD)
    made = device.post("/locked-notes", _locked_body(browser, state))
    assert made.status_code == 201, made.text
    body = made.json()
    assert (body["id"], body["locked"], body["title"], body["rev"], body["color"], body["pinned"]) == (
        LOCKED, True, "Kontodaten", 1, "berry", True)
    with SessionLocal() as db:
        note = db.get(Note, LOCKED)
        sealed = db.get(SealedNote, LOCKED)
        assert note is not None and sealed is not None
        assert (note.locked, note.ydoc, note.text, note.owner_id) == (True, b"", "", operator.id)
        assert secret.encode() not in sealed.content, "the server holds it only sealed"
        assert not list(db.scalars(select(Note.id).where(Note.text.contains("geheim"))))
    # The browser opens it with the vault of this account.
    plain, rev = browser.read(LOCKED)
    assert rev == 1 and plain == state
    # Sent again (the answer got lost): the same note, nothing doubles.
    again = device.post("/locked-notes", _locked_body(browser, state))
    assert again.status_code == 200 and again.json()["id"] == LOCKED
    # A new vault password meanwhile: sealed with the old epoch is refused.
    stale = device.post("/locked-notes", _locked_body(browser, state, id="lK_other-Note-7uYtReWqA", epoch=browser.epoch + 5))
    assert (stale.status_code, code(stale)) == (409, "vault_changed")
    # The note appears in `changes` as locked, without text.
    found = [row for row in device.get("/changes", cursor=0).json()["notes"] if row["id"] == LOCKED]
    assert found and found[0]["locked"] is True


def test_notes24_notesios16_ac8_a_locked_note_never_lands_shared_or_in_somebody_else_s_place(client, operator):
    browser = Device(client, operator.id)
    browser.setup(VAULT_PASSWORD)
    device = paired(client)
    state = notedoc.new_doc("Geheim", {"type": "doc", "content": []}).get_update()
    folder_id = make_folder(client, "Familie")
    anna = make_account("anna")
    assert client.put(f"/api/shares/folder/{folder_id}/people/{anna.id}", json={"level": "write"}).status_code == 200
    shared = device.post("/locked-notes", _locked_body(browser, state, folder_id=folder_id))
    assert (shared.status_code, code(shared)) == (409, "note_shared")
    with SessionLocal() as db:
        assert db.get(Note, LOCKED) is None, "nothing of a refused one is kept"
    # An id of a note the account cannot see.
    theirs = new_client(anna)
    from .test_notes3 import new_note

    other = new_note(theirs)["id"]
    taken = device.post("/locked-notes", _locked_body(browser, state, id=other))
    assert taken.status_code in (409, 422), taken.text
    # Sealed for the wrong note: the device's AAD binds the id, the browser cannot open it (never shown as another).
    wrong = _locked_body(browser, state, id="lK_wrongNote-7uYtReWqZ")
    assert device.post("/locked-notes", wrong).status_code == 201
    with pytest.raises(Exception):  # noqa: B017 - the tag does not fit: InvalidTag
        unseal(browser.nkey("lK_wrongNote-7uYtReWqZ"), seal(browser.nkey(LOCKED), state, content_aad(LOCKED, 1)),
               content_aad("lK_wrongNote-7uYtReWqZ", 1))
