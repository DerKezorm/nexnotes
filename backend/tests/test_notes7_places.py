""""Mit mir geteilt" is a fixed place again (23.11.2026): the tiles at the top of the sidebar (NOTES-4 AC-16) with their
numbers, and the preset ``shared_with_me`` of NOTES-7 AC-7 gone: new accounts get three presets, nobody can ask for
the fourth, the ones there were go with a tombstone for the app, and its names stay taken (EC-6)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Account, NoteListView
from app.models_app import AppTombstone
from app.models_smart import SmartFolder
from app.services import devices, smart_folders

from .conftest import make_account, new_client
from .test_notes7 import TASKS, folder, note, set_fields, smart_rows
from .test_notes13 import share
from .test_notes24 import paired

OLD = "sH_withMe-old0000000000"
OLD_LENA = "sH_withMe-lena000000000"


@pytest.fixture(autouse=True)
def _devices(client) -> None:
    devices.forget()


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def old_preset(owner_id: int, folder_id: str, name: str = "", position: int = 3) -> None:
    """A "Mit mir geteilt" as every account got it until 23.11.2026."""
    with SessionLocal() as db:
        db.add(SmartFolder(id=folder_id, owner_id=owner_id, name=name,
                           name_key=name.casefold() if name else "\x1fpreset:shared_with_me",
                           preset="shared_with_me", match="all", conditions=[{"kind": "shared", "op": "with_me"}],
                           icon="people", color="", position=position))
        db.commit()


def stones(folder_id: str) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(AppTombstone)
                             .where(AppTombstone.kind == "smart", AppTombstone.object_id == folder_id)) or 0)


# --- NOTES-7 AC-7: three presets --------------------------------------------------------------------------------------


def test_notes7_ac7_a_new_account_has_three_presets(client, operator):
    lena = make_account("lena-three")
    assert [row.preset for row in smart_rows(lena)] == ["open_tasks", "recent", "attachments"]
    device = paired(client)
    listed = device.get("/smart-folders/presets").json()["presets"]
    assert [entry["preset"] for entry in listed] == ["open_tasks", "recent", "attachments"]
    assert "shared_with_me" not in {entry["preset"] for entry in device.changes()["smart_folders"]}


def test_notes7_ac7_asking_for_the_preset_shared_with_me_is_refused(client, operator):
    device = paired(client)
    answer = device.post("/smart-folders", {"id": OLD, "preset": "shared_with_me"})
    assert answer.status_code == 422 and code(answer) == "smart_condition_invalid", answer.text
    assert answer.json()["detail"]["reason"] == "preset"
    with SessionLocal() as db:
        assert db.get(SmartFolder, OLD) is None
        with pytest.raises(HTTPException) as refused:
            smart_folders.create_preset(db, db.get(Account, operator.id), "shared_with_me")
        assert refused.value.status_code == 422
    assert [row.preset for row in smart_rows(operator)] == ["open_tasks", "recent", "attachments"]


def test_notes7_ac7_the_preset_shared_with_me_there_was_goes_with_a_tombstone(client, operator):
    """A database from before 23.11.2026: two accounts with "Mit mir geteilt" (one renamed it, one looked at it by
    title). At the start it goes from both, with its view; the app hears of it in ``removed``; a second start changes
    nothing and writes no second tombstone; the other presets and folders of one's own stay."""
    lena = make_account("lena-old")
    own = client.post("/api/smart-folders", json={"name": "Mein Ordner", "conditions": [TASKS]}).json()
    old_preset(operator.id, OLD)
    old_preset(lena.id, OLD_LENA, name="Von anderen")
    assert client.put(f"/api/smart-folders/{OLD}/view", json={"sort": "title"}).status_code == 200
    device = paired(client)
    assert OLD in {entry["id"] for entry in device.changes()["smart_folders"]}
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    with SessionLocal() as db:
        assert db.get(SmartFolder, OLD) is None and db.get(SmartFolder, OLD_LENA) is None
        assert db.scalar(select(func.count()).select_from(NoteListView)
                         .where(NoteListView.key == f"s:{OLD}")) == 0
    after = device.changes()
    assert {"kind": "smart", "id": OLD} in after["removed"]
    assert OLD_LENA not in {entry["id"] for entry in after["removed"]}
    assert (stones(OLD), stones(OLD_LENA)) == (1, 1)
    with SessionLocal() as db:
        owner = db.scalar(select(AppTombstone.account_id).where(AppTombstone.object_id == OLD_LENA))
    assert owner == lena.id
    # Once: the next start finds none and leaves no tombstone.
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    assert (stones(OLD), stones(OLD_LENA)) == (1, 1)
    assert device.changes()["removed"] == []
    assert [row.preset or row.id for row in smart_rows(operator)] == ["open_tasks", "recent", "attachments", own["id"]]
    assert [row.preset for row in smart_rows(lena)] == ["open_tasks", "recent", "attachments"]
    assert client.get(f"/api/smart-folders/{OLD}").status_code == 404


# --- NOTES-7 EC-6: the names of the fixed place stay taken ------------------------------------------------------------


def test_notes7_ec6_the_names_of_shared_with_me_stay_taken(client, operator):
    for name, said in (("Mit mir geteilt", "Mit mir geteilt"), (" mit MIR geteilt ", "Mit mir geteilt"),
                       ("Shared with me", "Shared with me"), ("SHARED WITH ME", "Shared with me")):
        answer = client.post("/api/smart-folders", json={"name": name, "conditions": [TASKS]})
        assert answer.status_code == 409 and code(answer) == "smart_folder_exists", name
        assert answer.json()["detail"]["name"] == said
    made = client.post("/api/smart-folders", json={"name": "Geteilt", "conditions": [TASKS]}).json()
    assert client.put(f"/api/smart-folders/{made['id']}", json={"name": "Mit mir geteilt"}).status_code == 409
    device = paired(client)
    answer = device.post("/smart-folders", {"id": OLD, "name": "Shared with me", "conditions": [TASKS]})
    assert answer.status_code == 409 and code(answer) == "smart_folder_exists"
    assert device.patch(f"/smart-folders/{made['id']}", {"name": "shared with me"}).status_code == 409
    # Close is free.
    assert client.post("/api/smart-folders", json={"name": "Mit mir geteilt 2", "conditions": [TASKS]}).status_code \
        == 201


# --- NOTES-4 AC-16: the numbers of the tiles ---------------------------------------------------------------------------


def test_notes4_ac16_the_tree_carries_the_numbers_of_the_tiles(client, operator):
    """"Alle Notizen" counts as its list (own and shared, alive), "Mit mir geteilt" the notes shared with the account
    (directly and through a folder), the inbox's mark the notes there marked "Titel prüfen" that are not locked."""
    first = client.get("/api/folders").json()
    base = first["places"]
    assert set(base) == {"all", "shared", "inbox_title_check"}
    box = folder(client, "Arbeit")
    note(client, "Im Ordner", "", box)
    check = note(client, "Prüfen")
    set_fields(check, title_check=True)
    locked = note(client, "Gesperrt prüfen")
    set_fields(locked, title_check=True, locked=True)
    elsewhere = note(client, "Prüfen woanders", "", box)
    set_fields(elsewhere, title_check=True)
    gone = note(client, "Weg")
    assert client.delete(f"/api/notes/{gone}").status_code == 204
    anna = make_account("anna-tiles")
    with new_client(anna) as theirs:
        theirs.get("/api/folders")
        direct = note(theirs, "Direkt")
        trip = folder(theirs, "Reise")
        note(theirs, "Im geteilten Ordner", "", trip)
        note(theirs, "Nicht geteilt")
        share(theirs, "note", direct, operator)
        share(theirs, "folder", trip, operator)
        anna_places = theirs.get("/api/folders").json()["places"]
    places = client.get("/api/folders").json()["places"]
    listing = client.get("/api/note-list").json()["counts"]
    assert places == {"all": base["all"] + 4 + 2, "shared": 2, "inbox_title_check": base["inbox_title_check"] + 1}
    assert places["all"] == listing["own"] + listing["shared"] and places["shared"] == listing["shared"]
    # What Anna shares is no "shared with me" for her.
    assert anna_places["shared"] == 0
