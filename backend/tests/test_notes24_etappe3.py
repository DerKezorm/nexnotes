"""NOTES-24 for the app features of stage 3: NOTESIOS-13 (bringing notes over from another account), NOTESIOS-14
(sharing, read links, shared with me, writing together) and NOTESIOS-15 (notifications), interface 0.6 of
``/api/app/1``. Everything with a device's token; the browser sees the same. The test client of the interface is the
one of ``test_notes24.py``.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.main import app
from app.models import Account, Folder, Note
from app.models_notify import NotifyOutbox
from app.models_shares import ReadLink, Share
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.services import apppush, devices, history, notes, notify, push_crypto, shares

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import stored, token_for, wait_for
from .test_notes13 import make_folder, share
from .test_notes13_link import day, ends, switch_links
from .test_notes14 import START, Recorder, add, tick_after
from .test_notes24 import App, b64, note_updates, paired, stored_text

#: Ids as the app makes them: base64url with ``_``, ``-`` and letters past ``f``.
NOTE = "nX_packingList-2wErTyUi"
NOTE_2 = "pQ-gardenPlan_7uYtReWqZ"
NOTE_3 = "rT_recipeBook-5yUiOpAsD"
FOLDER = "fZ_fromIcloud-Box9xQwEr"
FOLDER_2 = "gY-household_Box8wErTyU"
FOLDER_3 = "hX_kitchen-Shelf7eRtYuI"


@pytest.fixture(autouse=True)
def _setup(client) -> None:
    devices.forget()
    shares.LINK_BRAKE.forget()
    notify.forget_viewing()
    history.clock.reset()
    yield
    Live.close_all()
    notify.forget_viewing()
    history.clock.reset()


@pytest.fixture
def lena() -> Account:
    return make_account("lena")


@pytest.fixture
def as_lena(lena: Account):
    with new_client(lena) as other:
        yield other


@pytest.fixture
def relayed(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()
    recorder.status = 200
    monkeypatch.setattr(apppush, "POST", recorder.app)
    return recorder


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def state_of(title: str, *paragraphs: str) -> str:
    """The whole Yjs state of a note made elsewhere (the iCloud account), as the app sends it."""
    doc = notedoc.new_doc(title, {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]} for text in paragraphs]})
    return b64(doc.get_update())


def by_id(entries: list[dict]) -> dict[str, dict]:
    return {entry["id"]: entry for entry in entries}


# --- NOTESIOS-13: bringing notes over -----------------------------------------------------------------------------


def test_notes24_notesios13_ac1_a_note_brought_over_keeps_its_text_and_looks(client, operator):
    device = paired(client)
    made_at = "2025-03-04T05:06:07Z"
    changed_at = "2026-01-02T03:04:05Z"
    body = {"id": NOTE, "folder_id": "inbox", "update": state_of("Packing list", "socks", "#travel"),
            "paper": "grid", "icon": "star", "color": "honey", "pinned": True, "created_at": made_at,
            "updated_at": changed_at, "origin": ""}
    first = device.post("/notes", body)
    assert first.status_code == 201, first.text
    note = first.json()
    assert (note["title"], note["paper"], note["icon"], note["color"], note["pinned"], note["created_at"],
            note["updated_at"]) == ("Packing list", "grid", "star", "honey", True, made_at, changed_at)
    assert note["owner"] is None and note["shared"] is False
    assert note["updated_by"]["id"] == operator.id
    assert "socks" in stored_text(NOTE)
    # The transfer broke off and the app sends it again: the same note, nothing doubles, nothing changes.
    before = stored_text(NOTE)
    again = device.post("/notes", {**body, "color": "berry", "pinned": False, "paper": "dots"})
    assert again.status_code == 200, again.text
    assert (again.json()["color"], again.json()["pinned"], again.json()["paper"]) == ("honey", True, "grid")
    assert stored_text(NOTE) == before and stored_text(NOTE).count("socks") == 1
    # The browser has it with its times.
    seen = client.get(f"/api/notes/{NOTE}").json()
    assert seen["title"] == "Packing list"
    # A time in the future counts as now; an unknown colour takes nothing.
    future = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    later = device.post("/notes", {"id": NOTE_2, "update": state_of("Later"), "updated_at": future}).json()
    assert datetime.fromisoformat(later["updated_at"]) <= datetime.now(UTC)
    refused = device.post("/notes", {"id": NOTE_3, "update": state_of("Odd"), "color": "plaid"})
    assert refused.status_code == 422 and code(refused) == "note_color_unknown"
    with SessionLocal() as db:
        assert db.get(Note, NOTE_3) is None


def test_notes24_notesios13_ac3_everything_in_pieces_resumable_and_never_twice(client, operator, lena):
    device = paired(client)
    make_folder(client, "From iCloud")
    first = {"folders": [{"id": FOLDER, "name": "From iCloud"},
                         {"id": FOLDER_2, "name": "Household", "parent_id": FOLDER, "icon": "star",
                          "color": "honey"}],
             "notes": [{"id": NOTE, "folder_id": FOLDER_2, "update": state_of("Shopping", "eggs"),
                        "created_at": "2025-01-01T10:00:00Z"},
                       {"id": NOTE_2, "folder_id": "inbox", "update": state_of("Quick", "call back")}]}
    answer = device.post("/import", first)
    assert answer.status_code == 200, answer.text
    folders = by_id(answer.json()["folders"])
    # A folder of the same name beside it: "(2)", as when something comes back from the trash (EC-3).
    assert folders[FOLDER] == {"id": FOLDER, "state": "created", "name": "From iCloud (2)"}
    assert folders[FOLDER_2]["state"] == "created" and folders[FOLDER_2]["name"] == "Household"
    made = by_id(answer.json()["notes"])
    assert made[NOTE]["state"] == "created" and made[NOTE]["seq"] > 0 and made[NOTE_2]["state"] == "created"
    with SessionLocal() as db:
        household = db.get(Folder, FOLDER_2)
        assert household.parent_id == FOLDER and household.icon == "star"
        assert db.get(Note, NOTE).folder_id == FOLDER_2
    # The app was ended half way and sends the first piece again, then the next one (EC-2): nothing doubles.
    updates_before = note_updates(NOTE)
    again = device.post("/import", first).json()
    assert {entry["state"] for entry in again["folders"] + again["notes"]} == {"existed"}
    assert by_id(again["folders"])[FOLDER]["name"] == "From iCloud (2)"
    assert stored_text(NOTE).count("eggs") == 1
    assert note_updates(NOTE) <= updates_before + 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Folder).where(Folder.name.like("From iCloud%"),
                                                                       Folder.owner_id == operator.id)) == 2
    with new_client(lena) as other:
        lenas_folder = make_folder(other, "Lena's")
    second = device.post("/import", {
        "folders": [{"id": FOLDER_3, "name": "Kitchen", "parent_id": FOLDER_2},
                    {"id": "bad", "name": "Broken"},
                    {"id": "zZ_noParent-Here4rTyUiOp", "name": "Lost", "parent_id": "nO_suchFolder-5tYuIoPaS"},
                    {"id": "iN_boxChild-6yUiOpAsDf", "name": "Into inbox", "parent_id": "inbox"},
                    {"id": "eM_ptyName-7uIoPaSdFgH", "name": "   "}],
        "notes": [{"id": NOTE_3, "folder_id": FOLDER_3, "update": state_of("Recipe", "flour"), "pinned": True},
                  {"id": "bR_okenUpdate-8iOpAsDfG", "update": "not base64!"},
                  {"id": "nF_oFolder-9oPaSdFgHjK", "folder_id": lenas_folder, "update": state_of("Hers?")}]})
    assert second.status_code == 200, second.text
    folders = by_id(second.json()["folders"])
    assert folders[FOLDER_3]["state"] == "created"
    assert folders["bad"]["error"] == "invalid_input"
    assert folders["zZ_noParent-Here4rTyUiOp"]["error"] == "folder_not_found"
    assert folders["iN_boxChild-6yUiOpAsDf"]["error"] == "folder_target_not_allowed"
    assert folders["eM_ptyName-7uIoPaSdFgH"]["error"] == "folder_name_missing"
    notes_made = by_id(second.json()["notes"])
    assert notes_made[NOTE_3]["state"] == "created"
    assert notes_made["bR_okenUpdate-8iOpAsDfG"]["error"] == "invalid_update"
    assert notes_made["nF_oFolder-9oPaSdFgHjK"]["error"] == "folder_not_found"
    with SessionLocal() as db:
        # Nothing of a refused entry stays.
        assert db.get(Note, "bR_okenUpdate-8iOpAsDfG") is None and db.get(Note, "nF_oFolder-9oPaSdFgHjK") is None
        assert db.get(Folder, "zZ_noParent-Here4rTyUiOp") is None
        assert db.get(Note, NOTE_3).folder_id == FOLDER_3 and db.get(Note, NOTE_3).pinned_at is not None
    # Everything comes in ``changes`` on the next device, numbered.
    ipad = paired(client, "Mila's iPad", "ipados")
    found = ipad.changes()
    assert {FOLDER, FOLDER_2, FOLDER_3} <= {entry["id"] for entry in found["folders"]}
    listed = by_id(found["notes"])
    assert listed[NOTE]["folder_id"] == FOLDER_2 and listed[NOTE]["created_at"] == "2025-01-01T10:00:00Z"
    assert listed[NOTE_2]["folder_id"] == "inbox" and listed[NOTE_3]["pinned"] is True
    # Too much in one piece.
    many = device.post("/import", {"notes": [{"id": f"mA_ny{index:02d}-0aSdFgHjKl", "update": state_of("x")}
                                             for index in range(51)]})
    assert many.status_code == 422 and code(many) == "too_many_notes"
    many = device.post("/import", {"folders": [{"id": f"mF_ld{index:03d}-0aSdFgHjK", "name": f"F{index}"}
                                               for index in range(201)]})
    assert many.status_code == 422 and code(many) == "too_many_folders"


def test_notes24_notesios13_ids_of_others_are_taken(client, operator, lena):
    with new_client(lena) as other:
        lenas = paired(other, "Lena's iPhone")
        lenas.new_note(NOTE, "Lena's note", "private")
        assert lenas.post("/folders", {"id": FOLDER, "name": "Lena's folder"}).status_code == 201
    device = paired(client)
    answer = device.post("/import", {"folders": [{"id": FOLDER, "name": "Mine"}],
                                     "notes": [{"id": NOTE, "update": state_of("Mine", "overwrite")}]}).json()
    assert answer["folders"][0]["error"] == "folder_id_taken"
    assert answer["notes"][0]["error"] == "note_id_taken"
    # Nothing of Lena's changed, and nothing of hers came out.
    assert "overwrite" not in stored_text(NOTE)
    assert "private" not in json.dumps(answer)
    with SessionLocal() as db:
        assert db.get(Folder, FOLDER).name == "Lena's folder"


# --- NOTESIOS-14: sharing -----------------------------------------------------------------------------------------


def test_notes24_notesios14_ac1_share_change_and_end_from_the_app(client, operator, lena, as_lena):
    device = paired(client)
    device.new_note(NOTE, "Shopping", "eggs")
    folder = device.post("/folders", {"id": FOLDER, "name": "Household"}).json()
    device.changes()
    # Members by name or address, never oneself, at least two letters.
    assert device.get("/people", q="l").json() == {"people": []}
    found = device.get("/people", q="lena").json()["people"]
    assert [(person["id"], person["name"], person["email"]) for person in found] == [(lena.id, "Lena",
                                                                                        "lena@example.com")]
    assert device.get("/people", q="tester").json()["people"] == []
    # Shared to write; the same again changes the right, never a second share (EC-9, NOTESIOS-14 EC-7).
    shared = device.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "write"})
    assert shared.status_code == 200, shared.text
    assert [(person["id"], person["level"]) for person in shared.json()["people"]] == [(lena.id, "write")]
    again = device.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "read"}).json()
    assert [(person["id"], person["level"]) for person in again["people"]] == [(lena.id, "read")]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Share).where(Share.note_id == NOTE)) == 1
    # The browser sees the same.
    assert client.get(f"/api/shares/note/{NOTE}").json()["people"][0]["level"] == "read"
    assert device.get(f"/shares/note/{NOTE}").json()["people"][0]["id"] == lena.id
    # The own devices hear that it is shared now (the list marks it).
    own = by_id(device.changes()["notes"])
    assert own[NOTE]["shared"] is True and own[NOTE]["owner"] is None
    # A folder too, with everything in it.
    device.new_note(NOTE_2, "Plan", "", folder_id=FOLDER)
    device.changes()
    assert device.put(f"/shares/folder/{folder['id']}/people/{lena.id}", {"level": "write"}).status_code == 200
    seen = device.changes()
    assert by_id(seen["folders"])[FOLDER]["shared"] is True and by_id(seen["notes"])[NOTE_2]["shared"] is True
    # Lena's devices: what is shared with her, with its right and its owner.
    lenas = paired(as_lena, "Lena's iPhone")
    hers = lenas.changes()
    note = by_id(hers["notes"])[NOTE]
    assert note["right"] == "read" and note["owner"] == {"id": operator.id, "name": "Tester", "avatar": ""}
    assert note["shared"] is False and note["folder_id"] is None
    held = by_id(hers["folders"])[FOLDER]
    assert held["right"] == "write" and held["owner"]["id"] == operator.id and held["shared"] is False
    assert by_id(hers["notes"])[NOTE_2]["right"] == "write"
    # Ended: at once, and Lena's devices hear it went.
    ended = device.delete(f"/shares/note/{NOTE}/people/{lena.id}")
    assert ended.status_code == 200 and ended.json()["people"] == []
    assert device.delete(f"/shares/note/{NOTE}/people/{lena.id}").status_code == 200
    assert {(entry["kind"], entry["id"]) for entry in lenas.changes()["removed"]} == {("note", NOTE)}
    assert by_id(device.changes()["notes"])[NOTE]["shared"] is False


def test_notes24_notesios14_ac1_only_the_owner_shares(client, operator, lena, as_lena):
    nina = make_account("nina")
    lenas = paired(as_lena, "Lena's iPhone")
    lenas.new_note(NOTE, "Lena's", "hers")
    lenas.new_note(NOTE_2, "Lena's private", "secret")
    assert lenas.post("/folders", {"id": FOLDER, "name": "Lena's folder"}).status_code == 201
    assert lenas.post("/folders", {"id": FOLDER_2, "name": "Lena's private folder"}).status_code == 201
    lenas.put(f"/shares/note/{NOTE}/people/{operator.id}", {"level": "write"})
    lenas.put(f"/shares/folder/{FOLDER}/people/{operator.id}", {"level": "write"})
    device = paired(client)
    # Shared with the account, even to write: it may not pass it on or widen anything (NOTES-13 AC-11).
    for path in (f"/shares/note/{NOTE}", f"/shares/folder/{FOLDER}"):
        assert device.get(path).status_code == 403 and code(device.get(path)) == "no_right"
        widened = device.put(f"{path}/people/{nina.id}", {"level": "write"})
        assert widened.status_code == 403 and code(widened) == "no_right"
        assert code(device.put(f"{path}/people/{operator.id}", {"level": "write"})) == "no_right"
        assert code(device.delete(f"{path}/people/{operator.id}")) == "no_right"
    # Not seen at all: as if it were not there.
    for path in (f"/shares/note/{NOTE_2}", f"/shares/folder/{FOLDER_2}", "/shares/note/nO_suchNote-5tYuIoPaS"):
        assert device.get(path).status_code == 404 and code(device.get(path)) == "not_found"
        assert code(device.put(f"{path}/people/{nina.id}", {"level": "read"})) == "not_found"
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Share).where(Share.account_id == nina.id)) == 0
        assert db.scalar(select(Share.level).where(Share.note_id == NOTE)) == "write"
    # The browser's rules for the own things.
    device.new_note(NOTE_3, "Mine", "")
    assert code(device.put(f"/shares/note/{NOTE_3}/people/{operator.id}", {"level": "read"})) == "share_self"
    assert code(device.put(f"/shares/note/{NOTE_3}/people/987654", {"level": "read"})) == "person_not_found"
    assert device.put(f"/shares/note/{NOTE_3}/people/{lena.id}", {"level": "own"}).status_code == 422
    with SessionLocal() as db:
        inbox = db.scalar(select(Folder.id).where(Folder.owner_id == operator.id, Folder.kind == "inbox"))
    assert code(device.put(f"/shares/folder/{inbox}/people/{lena.id}", {"level": "read"})) == "share_inbox"


def test_notes24_notesios14_ac2_shared_with_me_leaving_and_notices(client, operator, lena, as_lena):
    lenas = paired(as_lena, "Lena's iPhone")
    lenas.new_note(NOTE, "Lena's list", "milk")
    assert lenas.post("/folders", {"id": FOLDER, "name": "Holiday"}).status_code == 201
    lenas.new_note(NOTE_2, "Tent", "", folder_id=FOLDER)
    lenas.put(f"/shares/note/{NOTE}/people/{operator.id}", {"level": "read"})
    lenas.put(f"/shares/folder/{FOLDER}/people/{operator.id}", {"level": "write"})
    device = paired(client)
    listing = device.get("/shared").json()
    assert listing["count"] == 2
    group = listing["groups"][0]
    assert group["owner"]["id"] == lena.id and group["owner"]["name"] == "Lena"
    items = {(item["kind"], item["id"]): item for item in group["items"]}
    assert items[("note", NOTE)]["level"] == "read" and items[("folder", FOLDER)]["level"] == "write"
    assert items[("folder", FOLDER)]["notes"] == 1
    assert items[("note", NOTE)]["updated_at"].endswith("Z")
    device.changes()
    # Leaving: it stays Lena's; twice, or what came only through a folder, is not there to leave.
    assert device.delete(f"/shared/note/{NOTE}").status_code == 204
    assert device.delete(f"/shared/note/{NOTE}").status_code == 404
    assert device.delete(f"/shared/note/{NOTE_2}").status_code == 404
    assert {(entry["kind"], entry["id"]) for entry in device.changes()["removed"]} == {("note", NOTE)}
    with SessionLocal() as db:
        assert db.get(Note, NOTE).owner_id == lena.id and db.get(Note, NOTE).deleted_at is None
    # Lena ends the folder: a notice says so, and goes when put away.
    lenas.delete(f"/shares/folder/{FOLDER}/people/{operator.id}")
    notices = device.get("/shared").json()["notices"]
    assert [(notice["reason"], notice["kind"], notice["title"], notice["owner"]) for notice in notices] == [
        ("ended", "folder", "Holiday", "Lena")]
    assert notices[0]["at"].endswith("Z")
    assert device.delete(f"/shared/notices/{notices[0]['id']}").status_code == 204
    assert device.delete(f"/shared/notices/{notices[0]['id']}").status_code == 204
    assert device.get("/shared").json() == {"groups": [], "count": 0, "notices": []}


def test_notes24_notesios14_ec4_a_note_made_in_a_folder_shared_to_write_is_the_owner_s(client, operator, lena,
                                                                                    as_lena):
    lenas = paired(as_lena, "Lena's iPhone")
    assert lenas.post("/folders", {"id": FOLDER, "name": "Shared to write"}).status_code == 201
    assert lenas.post("/folders", {"id": FOLDER_2, "name": "Shared to read"}).status_code == 201
    lenas.put(f"/shares/folder/{FOLDER}/people/{operator.id}", {"level": "write"})
    lenas.put(f"/shares/folder/{FOLDER_2}/people/{operator.id}", {"level": "read"})
    device = paired(client)
    made = device.new_note(NOTE, "Written offline", "by me", folder_id=FOLDER)
    assert made["right"] == "write" and made["owner"]["id"] == lena.id and made["folder_id"] == FOLDER
    assert stored(NOTE).owner_id == lena.id
    # Into a folder shared only to read: none.
    refused = device.post("/notes", {"id": NOTE_2, "folder_id": FOLDER_2, "update": state_of("No")})
    assert refused.status_code == 404 and code(refused) == "folder_not_found"
    # Bringing over into it: the same rule.
    answer = device.post("/import", {"notes": [{"id": NOTE_3, "folder_id": FOLDER_2,
                                                "update": state_of("No")}]}).json()
    assert answer["notes"][0]["error"] == "folder_not_found"
    # Lena sees who wrote last.
    hers = by_id(lenas.changes()["notes"])[NOTE]
    assert hers["right"] == "owner" and hers["updated_by"]["id"] == operator.id
    assert hers["updated_by"]["name"] == "Tester"


def test_notes24_notesios14_ac3_read_links_from_the_app(client, operator, lena, as_lena):
    switch_links(True)
    device = paired(client)
    device.new_note(NOTE, "Recipe", "flour")
    until = day(7)
    made = device.post(f"/notes/{NOTE}/read-link", {"expires_on": until, "ends_at": ends(until)})
    assert made.status_code == 201, made.text
    link = made.json()
    assert link["path"].startswith("/l/") and link["note_id"] == NOTE and link["title"] == "Recipe"
    assert link["expires_on"] == until and link["expires_at"].endswith("Z") and link["expired"] is False
    with TestClient(app, base_url="http://testserver") as visitor:
        assert visitor.get(link["path"]).status_code == 200
        # A second one (a double tap) replaces it: exactly one link, the first address stops (NOTESIOS-14 EC-7).
        second = device.post(f"/notes/{NOTE}/read-link", {"expires_on": until, "ends_at": ends(until)}).json()
        assert visitor.get(link["path"]).status_code == 404
        assert visitor.get(second["path"]).status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ReadLink).where(ReadLink.note_id == NOTE)) == 1
    # The sharing sheet shows it without its address; another day keeps the address.
    shown = device.get(f"/shares/note/{NOTE}").json()
    assert shown["links"] is True and shown["link"]["id"] == second["id"] and "path" not in shown["link"]
    later = day(30)
    changed = device.put(f"/read-links/{second['id']}", {"expires_on": later, "ends_at": ends(later)})
    assert changed.status_code == 200 and changed.json()["expires_on"] == later and "path" not in changed.json()
    today = day(0)
    soon = device.post(f"/notes/{NOTE}/read-link", {"expires_on": today, "ends_at": ends(today)})
    assert code(soon) == "link_expiry_too_soon"
    # A note of somebody else, seen or not; a link of somebody else.
    lenas = paired(as_lena, "Lena's iPhone")
    lenas.new_note(NOTE_2, "Lena's shared", "x")
    lenas.new_note(NOTE_3, "Lena's private", "y")
    lenas.put(f"/shares/note/{NOTE_2}/people/{operator.id}", {"level": "write"})
    refused = device.post(f"/notes/{NOTE_2}/read-link", {"expires_on": until})
    assert refused.status_code == 403 and code(refused) == "no_right"
    hidden = device.post(f"/notes/{NOTE_3}/read-link", {"expires_on": until})
    assert hidden.status_code == 404 and code(hidden) == "not_found"
    lenas_link = lenas.post(f"/notes/{NOTE_3}/read-link", {"expires_on": until}).json()
    assert code(device.put(f"/read-links/{lenas_link['id']}", {"expires_on": later})) == "not_found"
    assert code(device.delete(f"/read-links/{lenas_link['id']}")) == "not_found"
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ReadLink).where(ReadLink.note_id.in_([NOTE_2]))) == 0
    # Switched off by the operator (AC-7).
    switch_links(False)
    off = device.post(f"/notes/{NOTE}/read-link", {"expires_on": until})
    assert off.status_code == 403 and code(off) == "share_links_off"
    assert device.get(f"/shares/note/{NOTE}").json()["links"] is False


# --- NOTESIOS-14: writing together --------------------------------------------------------------------------------


def _bearer(app_device: App) -> dict[str, str]:
    return {"authorization": f"Bearer {app_device.token}"}


def _names_in_room(note_id: str) -> set[str]:
    return {peer.name for rooms in list(notes._rooms.values()) if (room := rooms.room_of(note_id)) is not None
            for peer in room.peers}


def test_notes24_notesios14_ac4_the_app_writes_live_with_its_token(client, operator, lena, as_lena):
    device = paired(client)
    device.new_note(NOTE, "Together", "start")
    device.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "write"})
    lenas = paired(as_lena, "Lena's iPad", "ipados")
    browser = Live(client, NOTE, token_for(operator))
    assert browser.pump(lambda: browser.synced and "start" in browser.text)
    # Lena's iPad in the same room (with Lena's token, whatever cookie the connection carries).
    ipad = Live(client, NOTE, headers=_bearer(lenas))
    assert ipad.pump(lambda: ipad.synced and "start" in ipad.text)
    assert ipad.closed is None
    edit.append_paragraph(ipad.doc, "from the iPad")
    assert browser.pump(lambda: "from the iPad" in browser.text)
    assert wait_for(lambda: "from the iPad" in stored_text(NOTE))
    edit.append_paragraph(browser.doc, "from the browser")
    assert ipad.pump(lambda: "from the browser" in ipad.text)
    # The room knows the iPad as Lena's account, by her name.
    assert wait_for(lambda: _names_in_room(NOTE) == {"Tester", "Lena"})
    with SessionLocal() as db:
        assert db.get(Note, NOTE).updated_by_id in (operator.id, lena.id)
    # Read only: what the iPad writes is dropped.
    device.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "read"})
    assert ipad.pump(lambda: ipad.closed is not None)
    reader = Live(client, NOTE, headers=_bearer(lenas))
    assert reader.pump(lambda: reader.synced)
    edit.append_paragraph(reader.doc, "not taken")
    reader.settle()
    assert "not taken" not in stored_text(NOTE)


def test_notes24_notesios14_ec1_the_live_room_lets_no_device_in_without_its_right(client, operator, lena, as_lena):
    device = paired(client)
    device.new_note(NOTE, "Mine", "private")
    lenas = paired(as_lena, "Lena's iPhone")
    # Lena's device, not shared with her: no room, nothing of the note.
    stranger = Live(client, NOTE, headers=_bearer(lenas))
    assert stranger.pump(lambda: stranger.closed is not None)
    assert stranger.closed == 4403 and "private" not in stranger.text
    # A token that opens nothing: sign in again.
    nothing = Live(client, NOTE, headers={"authorization": "Bearer nnd_" + "x" * 40})
    assert nothing.pump(lambda: nothing.closed is not None) and nothing.closed == 4401
    # A page of another site cannot use it either.
    foreign = Live(client, NOTE, headers={**_bearer(device), "origin": "https://evil.example.com"})
    assert foreign.pump(lambda: foreign.closed is not None) and foreign.closed == 4403
    # The own device gets in; disconnected meanwhile, its connection closes at once.
    own = Live(client, NOTE, headers=_bearer(device))
    assert own.pump(lambda: own.synced and "private" in own.text)
    ids = [row["id"] for row in device.get("/devices").json()]
    assert client.delete(f"/api/app-devices/{ids[0]}").status_code == 204
    assert own.pump(lambda: own.closed is not None, timeout=5.0) and own.closed == 4403
    again = Live(client, NOTE, headers=_bearer(device))
    assert again.pump(lambda: again.closed is not None) and again.closed == 4401
    # A share ended while Lena's device has the note open: it closes (NOTESIOS-14 EC-1).
    other = paired(client, "Mila's iPad", "ipados")
    other.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "write"})
    open_one = Live(client, NOTE, headers=_bearer(lenas))
    assert open_one.pump(lambda: open_one.synced)
    other.delete(f"/shares/note/{NOTE}/people/{lena.id}")
    assert open_one.pump(lambda: open_one.closed is not None, timeout=5.0) and open_one.closed == 4403


# --- NOTESIOS-15: notifications -----------------------------------------------------------------------------------


def test_notes24_notesios15_ac1_the_bell_from_the_app(client, operator, lena, as_lena):
    device = paired(client)
    device.new_note(NOTE, "Shopping", "eggs")
    device.new_note(NOTE_2, "Private", "")
    assert device.post("/folders", {"id": FOLDER, "name": "Household"}).status_code == 201
    device.put(f"/shares/note/{NOTE}/people/{lena.id}", {"level": "write"})
    device.put(f"/shares/folder/{FOLDER}/people/{lena.id}", {"level": "read"})
    assert device.get(f"/notify/note/{NOTE}").json() == {"kind": "note", "id": NOTE, "on": False, "via": None,
                                                         "shared": True}
    on = device.put(f"/notify/note/{NOTE}", {"on": True})
    assert on.status_code == 200 and on.json()["on"] is True
    # The browser sees the same switch: it is the account's.
    assert client.get(f"/api/notify/note/{NOTE}").json()["on"] is True
    assert device.put(f"/notify/folder/{FOLDER}", {"on": True}).json()["on"] is True
    # Only for what is shared; nothing for what the account does not see.
    refused = device.put(f"/notify/note/{NOTE_2}", {"on": True})
    assert refused.status_code == 409 and code(refused) == "notify_not_shared"
    lenas = paired(as_lena, "Lena's iPhone")
    lenas.new_note(NOTE_3, "Lena's private", "")
    assert lenas.post("/folders", {"id": FOLDER_2, "name": "Lena's private folder"}).status_code == 201
    for path in (f"/notify/note/{NOTE_3}", f"/notify/folder/{FOLDER_2}", "/notify/note/nO_suchNote-5tYuIoPaS"):
        assert device.get(path).status_code == 404 and code(device.get(path)) == "not_found"
        assert code(device.put(path, {"on": True})) == "not_found"
    # Lena may switch it for what is shared with her, in the folder too.
    assert lenas.put(f"/notify/folder/{FOLDER}", {"on": True}).json()["on"] is True
    assert lenas.put(f"/notify/note/{NOTE}", {"on": True}).json()["on"] is True


def _push_device(account: Account, app_device: App) -> str:
    """The device signs up for notifications as the app does (``PUT /push``); the private key reads them."""
    key = X25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                            serialization.PublicFormat.Raw)).decode()
    ticket = f"ticket-{account.id}-{app_device.token[-8:]}"
    assert app_device.put("/push", {"ticket": ticket, "key": public}).status_code == 204
    return base64.b64encode(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                              serialization.NoEncryption())).decode()


def test_notes24_notesios15_ac3_the_message_names_account_server_and_place(client, operator, lena, as_lena,
                                                                          relayed):
    history.clock.set(START)
    device = paired(client)
    private = _push_device(operator, device)
    answer = client.post("/api/notes", json={"title": "Shopping", "markdown": "## List\n\n- [ ] Milk\n\nmore"})
    note_id = answer.json()["id"]
    share(client, "note", note_id, lena, "write")
    assert device.put(f"/notify/note/{note_id}", {"on": True}).status_code == 200
    add(note_id, lena, "Eggs")
    assert tick_after(minutes=3)[1] == 1
    _url, body, _ = relayed.calls[0]
    shown = json.loads(push_crypto.decrypt(body["enc"], private))
    server = device.get("/me").json()["server_id"]
    assert len(server) == 16 and server == apppush.server_id()
    assert (shown["account"], shown["server"], shown["who"], shown["note"], shown["type"]) == (
        operator.id, server, "Lena", "Shopping", "changed")
    # The place: the index of the text block as the browser counts it, and its line.
    with SessionLocal() as db:
        lines = notify._lines_now(db, note_id)
    assert [text for text, _checked in lines].index("Eggs") == shown["at"] and shown["at"] >= 2
    assert shown["anchor"] == {"block": shown["at"], "text": "Eggs"}
    assert shown["locked"] is False and shown["note_id"] == note_id
    assert "Eggs" not in json.dumps(body) and "Lena" not in json.dumps(body)
    # A long line is cut short.
    add(note_id, lena, "x" * 300)
    tick_after(minutes=3)
    longer = json.loads(push_crypto.decrypt(relayed.calls[-1][1]["enc"], private))
    assert len(longer["anchor"]["text"]) == notify.ANCHOR_CHARS and longer["anchor"]["text"].endswith("…")


def test_notes24_notesios15_ec6_a_device_showing_the_note_gets_nothing_of_it(client, operator, lena, as_lena,
                                                                            relayed):
    history.clock.set(START)
    device = paired(client)
    ipad = paired(client, "Mila's iPad", "ipados")
    _push_device(operator, device)
    _push_device(operator, ipad)
    note_id = client.post("/api/notes", json={"title": "Shopping", "markdown": "- [ ] Milk"}).json()["id"]
    share(client, "note", note_id, lena, "write")
    device.put(f"/notify/note/{note_id}", {"on": True})
    # The iPhone shows the note in view when the bundle goes (the app repeats it): only the iPad hears of it.
    add(note_id, lena, "Eggs")
    history.clock.advance(minutes=3)
    assert device.put("/viewing", {"note_id": note_id}).status_code == 204
    notify.tick()
    with SessionLocal() as db:
        targets = list(db.scalars(select(NotifyOutbox.target_id).where(NotifyOutbox.channel == "app")))
    ids = {row["name"]: row["id"] for row in device.get("/devices").json()}
    assert targets == [ids["Mila's iPad"]]
    # Left the note: both again. Another note is not this one.
    assert device.put("/viewing", {"note_id": None}).status_code == 204
    add(note_id, lena, "Butter")
    tick_after(minutes=3)
    with SessionLocal() as db:
        targets = list(db.scalars(select(NotifyOutbox.target_id).where(NotifyOutbox.channel == "app")))
    assert sorted(targets[1:]) == sorted([ids["Mila's iPad"], ids["Mila's iPhone"]])
    # The word "I show it" holds for a while only: not repeated, it ends.
    add(note_id, lena, "Cheese")
    device.put("/viewing", {"note_id": note_id})
    tick_after(seconds=notify.QUIET.total_seconds() + notify.VIEWING_FOR.total_seconds() + 1)
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NotifyOutbox).where(NotifyOutbox.channel == "app")) == 5


def test_notes24_notesios15_the_features_and_the_server_mark(client, operator):
    device = paired(client)
    features = client.get("/api/app/1/hello").json()["features"]
    assert {"import", "sharing", "live", "notify"} <= set(features)
    first = device.get("/me").json()["server_id"]
    with new_client(make_account("nina")) as other:
        assert paired(other, "Nina's iPhone").get("/me").json()["server_id"] == first
