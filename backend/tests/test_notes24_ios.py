"""NOTES-24 for the app features NOTESIOS-7 (smart folders), NOTESIOS-9 (history and trash), NOTESIOS-10 (attachments)
and follow-up 6 (what the server can): interface 0.5 of ``/api/app/1``. Everything with a device's token; the
browser sees the same. The test client of the interface is the one of ``test_notes24.py``.
"""

from __future__ import annotations

import base64
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Note, NoteListView
from app.models_smart import SmartFolder
from app.notedoc import doc as notedoc
from app.notedoc.markdown import to_plain
from app.services import accounts, attachments, devices, history, notes, ocr, search, trash, workqueue

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import stored, wait_for
from .test_notes10 import add_blocks, block
from .test_notes11 import FakeEngine
from .test_notes13 import make_folder, share
from .test_notes13_link import png
from .test_notes15 import T0, session
from .test_notes24 import paired

#: Ids as the app makes them: base64url with ``_``, ``-`` and letters past ``f``.
SMART = "sM_openTasks-9xQwErTyUi"
SMART_2 = "kq-Recent_Week7uYtReWq"
NOTE = "nX_packingList-2wErTyUi"
NOTE_2 = "pQ-gardenPlan_7uYtReWqZ"
COPY = "cP_versionCopy-4rTyUiOp"
FOLDER = "fZ_household-Box9xQwErT"


@pytest.fixture(autouse=True)
def _setup(client, monkeypatch: pytest.MonkeyPatch) -> None:
    devices.forget()
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)
    attachments.register()
    history.register()
    trash.register()
    ocr.register()
    search.register_hooks()
    history.clock.reset()
    # No recognition in the background: the tests say when a page is read.
    monkeypatch.setattr(workqueue, "AUTO", False)
    workqueue.stopping.clear()
    yield
    workqueue.stop()
    workqueue.stopping.clear()
    history.clock.reset()
    Live.close_all()


def code(answer) -> str:
    return answer.json()["detail"]["code"]


OPEN = [{"kind": "tasks", "op": "open"}]


# --- NOTESIOS-7: smart folders ---------------------------------------------------------------------------------------


def test_notes24_notesios7_ac3_smart_folders_made_with_the_device_s_id_once(client, operator):
    device = paired(client)
    made = device.post("/smart-folders", {"id": SMART, "name": "To do", "match": "all", "conditions": OPEN,
                                          "icon": "star", "color": "honey"})
    assert made.status_code == 201, made.text
    body = made.json()
    assert (body["id"], body["name"], body["preset"], body["match"], body["conditions"], body["icon"],
            body["color"]) == (SMART, "To do", "", "all", OPEN, "star", "honey")
    assert body["seq"] > 0
    # Sent again (the answer got lost): the same folder, nothing changes.
    again = device.post("/smart-folders", {"id": SMART, "name": "Something else", "conditions": OPEN})
    assert again.status_code == 200 and again.json()["name"] == "To do"
    with SessionLocal() as db:
        assert db.scalar(select(SmartFolder).where(SmartFolder.name == "Something else")) is None
    # The browser has it.
    assert SMART in {item["id"] for item in client.get("/api/smart-folders").json()["items"]}
    # The browser's rules.
    assert code(device.post("/smart-folders", {"id": SMART_2, "name": "to DO", "conditions": OPEN})) \
        == "smart_folder_exists"
    assert code(device.post("/smart-folders", {"id": SMART_2, "name": "Offene Checklisten", "conditions": OPEN})) \
        == "smart_folder_exists"
    assert code(device.post("/smart-folders", {"id": SMART_2, "name": "x" * 61, "conditions": OPEN})) \
        == "smart_folder_name_invalid"
    assert code(device.post("/smart-folders", {"id": SMART_2, "name": "Odd", "conditions": [{"kind": "moon"}]})) \
        == "smart_condition_invalid"
    assert code(device.post("/smart-folders", {"id": SMART_2, "name": "Odd", "conditions": OPEN,
                                               "icon": "no-such-symbol"})) == "folder_style_unknown"
    assert device.post("/smart-folders", {"id": "short", "name": "Odd", "conditions": OPEN}).status_code == 422
    # The inbox is ``inbox`` for the app, its id on the server.
    inboxed = device.post("/smart-folders", {"id": SMART_2, "name": "In the inbox",
                                             "conditions": [{"kind": "folder", "op": "in", "id": "inbox"}]})
    assert inboxed.status_code == 201, inboxed.text
    assert inboxed.json()["conditions"][0]["id"] == "inbox"
    with SessionLocal() as db:
        kept = db.get(SmartFolder, SMART_2)
        assert kept is not None and kept.conditions[0]["id"] not in ("inbox", "")
    # Another account's id is taken; its folders are not there for the device.
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        taken = lenas.post("/smart-folders", {"id": SMART, "name": "Mine", "conditions": OPEN})
        assert taken.status_code == 409 and code(taken) == "smart_folder_id_taken"


def test_notes24_notesios7_ac5_presets_come_and_come_back(client, operator):
    device = paired(client)
    listed = device.get("/smart-folders/presets").json()["presets"]
    assert [entry["preset"] for entry in listed] == ["open_tasks", "recent", "attachments"]
    assert listed[0]["conditions"] == OPEN
    # Every account has them from the start, numbered: the first full list brings them.
    first = device.changes()
    presets = {entry["preset"]: entry for entry in first["smart_folders"]}
    assert set(presets) == {"open_tasks", "recent", "attachments"}
    assert all(entry["seq"] > 0 and entry["name"] == "" for entry in presets.values())
    # Deleted and made anew from the preset, with its name in the app's language.
    gone = presets["attachments"]["id"]
    assert device.delete(f"/smart-folders/{gone}").status_code == 204
    back = device.post("/smart-folders", {"id": SMART, "preset": "attachments"})
    assert back.status_code == 201, back.text
    assert (back.json()["preset"], back.json()["name"], back.json()["icon"]) == ("attachments", "", "paperclip")
    assert back.json()["conditions"] == [{"kind": "attachment", "type": "any"}]
    twice = device.post("/smart-folders", {"id": SMART_2, "preset": "attachments"})
    assert twice.status_code == 409 and code(twice) == "smart_folder_exists"
    assert code(device.post("/smart-folders", {"id": SMART_2, "preset": "moon"})) == "smart_condition_invalid"
    # A folder of one's own by a preset's name stands in its way.
    recent = presets["recent"]["id"]
    assert device.delete(f"/smart-folders/{recent}").status_code == 204
    own = device.post("/smart-folders", {"id": SMART_2, "name": "Recently edited", "conditions": OPEN})
    assert own.status_code == 201, own.text
    clash = device.post("/smart-folders", {"id": "rE_cent-again0000000000", "preset": "recent"})
    assert clash.status_code == 409 and clash.json()["detail"]["name"] == "Recently edited"


def test_notes24_notesios7_ac3_changed_ordered_deleted_on_every_device_with_numbers(client, operator):
    phone = paired(client)
    pad = paired(client, "Mila's iPad", "ipados")
    pad.changes()
    phone.post("/smart-folders", {"id": SMART, "name": "To do", "conditions": OPEN})
    seen = pad.changes()
    assert [entry["id"] for entry in seen["smart_folders"]] == [SMART]
    first_seq = seen["smart_folders"][0]["seq"]
    assert pad.changes()["smart_folders"] == []
    # Changed: a new number, the change on the other device.
    changed = phone.patch(f"/smart-folders/{SMART}", {"name": "Open", "match": "any",
                                                      "conditions": [*OPEN, {"kind": "pinned"}], "color": "#12ab34"})
    assert changed.status_code == 200, changed.text
    later = pad.changes()["smart_folders"]
    assert [(entry["name"], entry["match"], entry["color"]) for entry in later] == [("Open", "any", "#12ab34")]
    assert later[0]["seq"] > first_seq
    # All or nothing: a name taken keeps the colour too.
    refused = phone.patch(f"/smart-folders/{SMART}", {"name": "Offene Checklisten", "color": "honey"})
    assert refused.status_code == 409
    with SessionLocal() as db:
        assert db.get(SmartFolder, SMART).color == "#12ab34"
    # Made in the browser: it comes too.
    browser = client.post("/api/smart-folders", json={"name": "Pinned", "conditions": [{"kind": "pinned"}]}).json()
    assert [entry["id"] for entry in pad.changes()["smart_folders"]] == [browser["id"]]
    # The order, ids it does not know skipped (deleted elsewhere meanwhile).
    ordered = phone.put("/smart-folders/order", {"ids": [browser["id"], "gOnE_elsewhere0000000000", SMART]})
    assert ordered.status_code == 200, ordered.text
    positions = {entry["id"]: entry["position"] for entry in ordered.json()["smart_folders"]}
    assert (positions[browser["id"]], positions[SMART]) == (0, 1)
    assert {entry["id"] for entry in pad.changes()["smart_folders"]} >= {browser["id"], SMART}
    assert code(phone.put("/smart-folders/order", {"ids": [SMART, SMART]})) == "smart_folder_order_invalid"
    # Deleted: a tombstone of its own kind; not one note changes (EC-7).
    phone.new_note(NOTE, "List", "- [ ] pack")
    pad.changes()
    note_seq = stored(NOTE).sync_seq
    assert phone.delete(f"/smart-folders/{SMART}").status_code == 204
    after = pad.changes()
    assert {"kind": "smart", "id": SMART} in after["removed"]
    assert after["notes"] == [] and stored(NOTE).sync_seq == note_seq
    assert phone.delete(f"/smart-folders/{SMART}").status_code == 404


def test_notes24_notesios7_another_account_s_smart_folders_are_not_there(client, operator):
    device = paired(client)
    device.post("/smart-folders", {"id": SMART, "name": "Mine", "conditions": OPEN})
    lena = make_account("lena")
    # Mila shares something with Lena: still no tombstone of her smart folders reaches Lena (S3).
    device.new_note(NOTE, "Shared")
    share(client, "note", NOTE, lena, "read")
    with new_client(lena) as other:
        lenas = paired(other)
        theirs = lenas.changes()
        assert SMART not in {entry["id"] for entry in theirs["smart_folders"]}
        for answer in (lenas.patch(f"/smart-folders/{SMART}", {"name": "Taken"}),
                       lenas.delete(f"/smart-folders/{SMART}"),
                       lenas.get(f"/smart-folders/{SMART}/notes"),
                       lenas.get("/attachments", smart=SMART),
                       lenas.put("/views", {"key": f"s:{SMART}", "sort": "title"})):
            assert answer.status_code == 404 and code(answer) == "not_found", answer.text
        # An order naming it leaves it alone.
        assert lenas.put("/smart-folders/order", {"ids": [SMART]}).status_code == 200
    with SessionLocal() as db:
        mine = db.get(SmartFolder, SMART)
        assert (mine.name, mine.position) == ("Mine", 3)
    # Deleting it tells only its owner's devices.
    device.delete(f"/smart-folders/{SMART}")
    with new_client(lena) as other:
        again = paired(other, "Lena's iPad")
        again.changes()
        assert again.changes()["removed"] == []
        lenas.changes()
    with SessionLocal() as db:
        from app.models_app import AppTombstone

        stones = list(db.scalars(select(AppTombstone).where(AppTombstone.object_id == SMART)))
    assert [(stone.kind, stone.account_id) for stone in stones] == [("smart", operator.id)]


def test_notes24_notesios7_ac7_views_of_smart_folders_come_with_the_account(client, operator):
    device = paired(client)
    device.post("/smart-folders", {"id": SMART, "name": "Files", "conditions": [{"kind": "attachment", "type": "any"}]})
    device.changes()
    saved = device.put("/views", {"key": f"s:{SMART}", "sort": "title", "mode": "gallery"})
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"key": f"s:{SMART}", "sort": "title", "direction": "desc", "grouped": True,
                            "mode": "gallery"}
    views = {view["key"]: view for view in device.changes()["account"]["views"]}
    assert views[f"s:{SMART}"]["mode"] == "gallery" and views[f"s:{SMART}"]["sort"] == "title"
    # The browser sees it.
    assert client.get(f"/api/smart-folders/{SMART}/notes").json()["view"]["mode"] == "gallery"
    assert device.put("/views", {"key": f"s:{SMART}", "mode": "tiles"}).status_code == 422
    # Gone with the folder: the account comes anew without it.
    device.delete(f"/smart-folders/{SMART}")
    with SessionLocal() as db:
        assert db.scalar(select(NoteListView).where(NoteListView.key == f"s:{SMART}")) is None
    assert f"s:{SMART}" not in {view["key"] for view in device.changes()["account"]["views"]}


def test_notes24_notesios7_ec1_what_fits_by_the_server_and_what_points_nowhere(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.new_note(NOTE, "Shopping", "- [ ] milk", folder_id=FOLDER)
    device.new_note(NOTE_2, "Garden", "lawn")
    device.post("/smart-folders", {"id": SMART, "name": "Household", "conditions": [
        {"kind": "folder", "op": "tree", "id": FOLDER}]})
    fits = device.get(f"/smart-folders/{SMART}/notes", tz="Europe/Berlin")
    assert fits.status_code == 200, fits.text
    assert wait_for(lambda: device.get(f"/smart-folders/{SMART}/notes").json()["ids"] == [NOTE])
    device.delete(f"/folders/{FOLDER}")
    device.post("/trash/empty", {"until": "2999-01-01T00:00:00Z"})
    gone = device.get(f"/smart-folders/{SMART}/notes").json()
    assert gone["ids"] == [] and gone["broken"]


# --- NOTESIOS-9: history ---------------------------------------------------------------------------------------------


def _versioned(device, operator_id: int) -> list[dict]:
    device.new_note(NOTE, "Plan", "first idea")
    session(NOTE, operator_id, ["second thought"], T0)
    history.clock.set(T0 + timedelta(hours=2))
    session(NOTE, operator_id, ["third"], T0 + timedelta(hours=2))
    listed = device.get(f"/notes/{NOTE}/versions")
    assert listed.status_code == 200, listed.text
    return listed.json()["versions"]


def test_notes24_notesios9_ac1_versions_listed_read_whole_and_restored(client, operator):
    device = paired(client)
    found = _versioned(device, operator.id)
    assert len(found) == 2 and found[0]["current"] is True
    assert found[0]["authors"] == [{"id": operator.id, "name": "Tester", "via": ""}]
    page = device.get(f"/notes/{NOTE}/versions", limit=1).json()
    assert len(page["versions"]) == 1 and page["next"] == found[0]["id"] and page["can_restore"] is True
    assert [entry["id"] for entry in device.get(f"/notes/{NOTE}/versions", before=page["next"]).json()["versions"]] \
        == [found[1]["id"]]
    old = found[1]
    read = device.get(f"/notes/{NOTE}/versions/{old['id']}")
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["title"] == "Plan" and "second thought" in body["text"] and "third" not in body["text"]
    # The Yjs state is a document of its own: the app opens it with its editor.
    doc = notedoc.load(base64.b64decode(body["state"]))
    assert notedoc.title_of(doc) == "Plan" and "third" not in to_plain(doc)
    assert device.get(f"/notes/{NOTE}/versions/999999").status_code == 404
    # Restored: the note as it was before, the version current; ``changes`` brings it with a new number.
    pad = paired(client, "Mila's iPad", "ipados")
    pad.changes()
    restored = device.post(f"/notes/{NOTE}/versions/{old['id']}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["restored_from"] == old["created_at"] and restored.json()["note"]["id"] == NOTE
    assert "third" not in to_plain(notedoc.load(stored(NOTE).ydoc, _updates(NOTE)))
    assert NOTE in {entry["id"] for entry in pad.changes()["notes"]}
    assert device.get(f"/notes/{NOTE}/versions").json()["versions"][0]["restored_from"] == old["created_at"]


def _updates(note_id: str) -> list[bytes]:
    from app.models import NoteUpdate

    with SessionLocal() as db:
        return list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id).order_by(NoteUpdate.id)))


def test_notes24_notesios9_ac1_copy_of_a_version_with_the_device_s_id_once(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.new_note(NOTE, "Plan", "first idea", folder_id=FOLDER)
    session(NOTE, operator.id, ["second thought"], T0)
    version = device.get(f"/notes/{NOTE}/versions").json()["versions"][0]
    made = device.post(f"/notes/{NOTE}/versions/{version['id']}/copy", {"id": COPY, "when": "22.11.2026"})
    assert made.status_code == 201, made.text
    assert (made.json()["id"], made.json()["folder_id"]) == (COPY, FOLDER)
    assert made.json()["title"].startswith("Plan") and "22.11.2026" in made.json()["title"]
    again = device.post(f"/notes/{NOTE}/versions/{version['id']}/copy", {"id": COPY})
    assert again.status_code == 200 and again.json()["id"] == COPY
    with SessionLocal() as db:
        assert db.scalar(select(Note.id).where(Note.title.like("Plan (%"), Note.id != COPY)) is None
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        lenas.new_note(NOTE_2, "Lena's")
    taken = device.post(f"/notes/{NOTE}/versions/{version['id']}/copy", {"id": NOTE_2})
    assert taken.status_code == 409 and code(taken) == "note_id_taken"
    assert device.post(f"/notes/{NOTE}/versions/{version['id']}/copy", {"id": "bad id"}).status_code == 422


def test_notes24_notesios9_ac1_versions_of_others_readers_and_locked_notes(client, operator):
    device = paired(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        lenas.new_note(NOTE, "Lena's plan", "first")
        session(NOTE, lena.id, ["second"], T0)
        version = lenas.get(f"/notes/{NOTE}/versions").json()["versions"][0]["id"]
        # Not shared: nothing of it is there.
        for answer in (device.get(f"/notes/{NOTE}/versions"), device.get(f"/notes/{NOTE}/versions/{version}"),
                       device.post(f"/notes/{NOTE}/versions/{version}/restore"),
                       device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": COPY})):
            assert answer.status_code == 404 and code(answer) == "not_found", answer.text
        # Shared to read: look, but neither restore nor copy.
        share(other, "note", NOTE, operator, "read")
        assert device.get(f"/notes/{NOTE}/versions").json()["can_restore"] is False
        assert device.get(f"/notes/{NOTE}/versions/{version}").status_code == 200
        for answer in (device.post(f"/notes/{NOTE}/versions/{version}/restore"),
                       device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": COPY})):
            assert answer.status_code == 403 and code(answer) == "no_right", answer.text
        # Shared to write: restore.
        share(other, "note", NOTE, operator, "write")
        assert device.post(f"/notes/{NOTE}/versions/{version}/restore").status_code == 200
    # A locked note's versions are not restored here.
    device.new_note(NOTE_2, "Secret", "first")
    session(NOTE_2, operator.id, ["second"], T0 + timedelta(hours=3))
    mine = device.get(f"/notes/{NOTE_2}/versions").json()["versions"][0]["id"]
    with SessionLocal() as db:
        db.get(Note, NOTE_2).locked = True
        db.commit()
    locked = device.post(f"/notes/{NOTE_2}/versions/{mine}/restore")
    assert locked.status_code == 409 and code(locked) == "note_locked"
    assert code(device.post(f"/notes/{NOTE_2}/versions/{mine}/copy", {"id": COPY})) == "note_locked"
    # In the trash a note has no history here (as in the browser).
    device.new_note(SMART, "Trashed")
    device.delete(f"/notes/{SMART}")
    assert device.get(f"/notes/{SMART}/versions").status_code == 404


# --- NOTESIOS-9: trash -----------------------------------------------------------------------------------------------


def test_notes24_notesios9_ac3_trash_listed_with_its_deadline_gone_for_good_and_emptied(client, operator):
    device = paired(client)
    pad = paired(client, "Mila's iPad", "ipados")
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.new_note(NOTE, "Shopping", folder_id=FOLDER)
    device.new_note(NOTE_2, "Loose")
    device.new_note(COPY, "Kept")
    assert device.delete(f"/notes/{NOTE_2}").status_code == 204
    assert device.delete(f"/folders/{FOLDER}").status_code == 200
    listed = device.get("/trash")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["trash_days"] == 90 and body["totals"] == {"notes": 2, "folders": 1}
    items = {item["id"]: item for item in body["items"]}
    assert set(items) == {NOTE_2, FOLDER}  # the note that went with its folder is no entry of its own
    assert items[NOTE_2]["origin"]["id"] == "inbox" and items[NOTE_2]["lands"] == "inbox"
    assert items[FOLDER]["notes"] == 1 and items[NOTE_2]["days_left"] == 90 and items[NOTE_2]["warn"] is False
    assert items[NOTE_2]["expires_at"] > items[NOTE_2]["deleted_at"]
    pad.changes()
    gone = device.delete(f"/trash/notes/{NOTE_2}")
    assert gone.status_code == 200 and gone.json() == {"notes": 1, "folders": 0}
    assert {"kind": "note", "id": NOTE_2} in pad.changes()["removed"]
    # Gone already, or never in the trash: not found (the app counts it as done).
    assert device.delete(f"/trash/notes/{NOTE_2}").status_code == 404
    assert device.delete(f"/trash/notes/{COPY}").status_code == 404
    emptied = device.post("/trash/empty", {"until": body["now"]})
    assert emptied.status_code == 200 and emptied.json() == {"notes": 1, "folders": 1}
    removed = pad.changes()["removed"]
    assert {"kind": "folder", "id": FOLDER} in removed and {"kind": "note", "id": NOTE} in removed
    assert device.get("/trash").json()["items"] == []
    assert stored(COPY).deleted_at is None


def test_notes24_notesios9_ec4_back_from_the_trash_twice_is_once(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.new_note(NOTE, "Shopping", folder_id=FOLDER)
    device.delete(f"/notes/{NOTE}")
    device.delete(f"/folders/{FOLDER}")
    for _ in range(2):
        back = device.post(f"/notes/{NOTE}/restore")
        assert back.status_code == 200 and back.json()["deleted_at"] is None
        # Its folder is in the trash: it lands in the inbox (EC-1).
        assert back.json()["folder_id"] == "inbox"
        folder = device.post(f"/folders/{FOLDER}/restore")
        assert folder.status_code == 200 and folder.json()["deleted_at"] is None
    assert device.get("/trash").json()["items"] == []


def test_notes24_notesios9_ac3_the_trash_of_others_is_not_there(client, operator):
    device = paired(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        lenas.new_note(NOTE, "Lena's own")
        lenas.new_note(NOTE_2, "Shared to write")
        share(other, "note", NOTE_2, operator, "write")
        lenas.delete(f"/notes/{NOTE}")
        theirs_folder = make_folder(other, "Lena's folder")
        assert other.delete(f"/api/folders/{theirs_folder}").status_code in (200, 204)
        # Mila deletes the note shared with her: it lies in Lena's trash, not in hers.
        device.changes()
        assert device.delete(f"/notes/{NOTE_2}").status_code == 204
        assert device.get("/trash").json()["items"] == []
        assert {item["id"] for item in lenas.get("/trash").json()["items"]} >= {NOTE, NOTE_2}
        for answer in (device.delete(f"/trash/notes/{NOTE}"), device.delete(f"/trash/notes/{NOTE_2}"),
                       device.delete(f"/trash/folders/{theirs_folder}")):
            assert answer.status_code == 404 and code(answer) == "not_found", answer.text
        assert device.post("/trash/empty", {"until": "2999-01-01T00:00:00Z"}).json() == {"notes": 0, "folders": 0}
        assert stored(NOTE).deleted_at is not None
        # Lena empties hers: whoever saw the shared note hears that it went.
        assert lenas.delete(f"/trash/notes/{NOTE_2}").status_code == 200
    assert {"kind": "note", "id": NOTE_2} in device.changes()["removed"]


# --- NOTESIOS-10: attachments ----------------------------------------------------------------------------------------


def _upload(device, note_id: str, data: bytes, name: str, attachment_id: str | None = None, **params):
    return device.client.post("/api/attachments", params={"note_id": note_id, "id": attachment_id or
                                                          attachments.new_id(), "name": name, **params},
                              content=data, headers=device.headers)


def test_notes24_notesios10_the_browser_s_routes_take_the_device_s_token(client, operator):
    device = paired(client)
    device.new_note(NOTE, "Holiday")
    headers = device.headers
    limits = client.get("/api/attachments/limits", headers=headers)
    assert limits.status_code == 200 and set(limits.json()) >= {"max_mb", "used", "limit", "full", "link_previews"}
    picture_id = "pI_holidayPhoto-7uYtReW"
    made = _upload(device, NOTE, png(), "Beach.png", picture_id)
    assert made.status_code == 201, made.text
    again = _upload(device, NOTE, png(), "Beach.png", picture_id)
    assert again.status_code == 200 and again.json()["id"] == picture_id
    add_blocks(NOTE, operator.id, block("image", made.json()))
    listed = client.get(f"/api/notes/{NOTE}/attachments", headers=headers)
    assert listed.status_code == 200 and [item["id"] for item in listed.json()["items"]] == [picture_id]
    assert client.get(f"/api/attachments/{picture_id}", headers=headers).json()["kind"] == "image"
    whole = client.get(f"/api/attachments/{picture_id}/file", headers=headers)
    assert whole.status_code == 200 and whole.content[:4] == b"\x89PNG"
    part = client.get(f"/api/attachments/{picture_id}/file", headers={**headers, "Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == b"\x89PNG"
    assert client.get(f"/api/attachments/{picture_id}/view", headers=headers).status_code == 200
    assert client.get(f"/api/attachments/{picture_id}/thumb", headers=headers).status_code in (200, 404)
    # Another account's device reaches none of it.
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        for path in (f"/api/attachments/{picture_id}", f"/api/attachments/{picture_id}/file",
                     f"/api/notes/{NOTE}/attachments"):
            assert other.get(path, headers=lenas.headers).status_code == 404
        assert _upload(lenas, NOTE, png(), "Mine.png").status_code == 404
    # Disconnected: the browser's routes say so as ``/api/app/1`` does.
    assert device.delete("/device").status_code == 204
    refused = client.get("/api/attachments/limits", headers=headers)
    assert refused.status_code == 401 and code(refused) == "device_disconnected"
    nina = make_account("nina")
    with new_client(nina) as other:
        ninas = paired(other)
        with SessionLocal() as db:
            accounts.block(db, db.get(Account, nina.id))
        blocked = other.get("/api/attachments/limits", headers=ninas.headers)
        assert blocked.status_code == 401 and code(blocked) == "account_blocked"
    # Anything else that is no device's token still hears "sign in".
    assert code(client.get("/api/attachments/limits", headers={"Authorization": "Bearer nonsense"})) \
        == "sign_in_required"


def test_notes24_notesios10_ac6_the_gallery_for_the_app(client, operator):
    device = paired(client)
    device.new_note(NOTE, "Holiday")
    device.new_note(NOTE_2, "Plans")
    first = _upload(device, NOTE, png(), "Beach.png").json()
    second = _upload(device, NOTE_2, png((200, 20, 20)), "Red.png").json()
    add_blocks(NOTE, operator.id, block("image", first))
    add_blocks(NOTE_2, operator.id, block("image", second))
    everything = device.get("/attachments")
    assert everything.status_code == 200, everything.text
    assert everything.json()["total"] == 2 and everything.json()["counts"]["image"] == 2
    assert {item["note"]["id"] for item in everything.json()["items"]} == {NOTE, NOTE_2}
    assert device.get("/attachments", kind="pdf").json()["total"] == 0
    assert device.get("/attachments", kind="moon").status_code == 422
    device.post("/smart-folders", {"id": SMART, "name": "Holiday files", "conditions": [
        {"kind": "text", "value": "Holiday"}]})
    assert wait_for(lambda: [item["note"]["id"] for item in device.get("/attachments", smart=SMART).json()["items"]]
                    == [NOTE])
    assert device.get("/attachments", smart="nO_such_smart_folder00").status_code == 404
    # Another account's gallery holds none of it.
    lena = make_account("lena")
    with new_client(lena) as other:
        assert paired(other).get("/attachments").json()["total"] == 0


def _scan_with_text(device, note_id: str, words: str, kind: str = "scan") -> str:
    params = {"as": kind, "text": "device"} if kind == "scan" else {"as": kind}
    made = _upload(device, note_id, png(), f"{kind}.png", **params)
    assert made.status_code == 201, made.text
    texted = device.client.put(f"/api/attachments/{made.json()['id']}/text", headers=device.headers,
                               json={"pages": [{"text": words, "language": "en"}]})
    assert texted.status_code == 200, texted.text
    return made.json()["id"]


def test_notes24_notesios10_recognised_text_comes_for_the_search_offline(client, operator):
    device = paired(client)
    pad = paired(client, "Mila's iPad", "ipados")
    device.new_note(NOTE, "Lease")
    scan = _upload(device, NOTE, png(), "Lease.png", **{"as": "scan", "text": "device"}).json()
    add_blocks(NOTE, operator.id, block("image", scan))
    pad.changes()
    before = stored(NOTE).sync_seq
    texted = client.put(f"/api/attachments/{scan['id']}/text", headers=device.headers,
                        json={"pages": [{"text": "Garden Street 12", "language": "en"}]})
    assert texted.status_code == 200, texted.text
    # The note naming it gets a new number and a new stamp.
    assert stored(NOTE).sync_seq > before
    seen = {entry["id"]: entry for entry in pad.changes()["notes"]}
    assert seen[NOTE]["texts"] != ""
    stamp = seen[NOTE]["texts"]
    asked = pad.post("/texts", {"notes": [NOTE, "nO_such_note_000000000"]})
    assert asked.status_code == 200, asked.text
    found = {entry["id"]: entry for entry in asked.json()["notes"]}
    assert found[NOTE]["texts"] == stamp
    assert found[NOTE]["attachments"] == [{"id": scan["id"], "kind": "scan", "name": "Lease.png",
                                            "pages": [{"page": 1, "text": "Garden Street 12", "language": "en"}]}]
    assert found["nO_such_note_000000000"] == {"id": "nO_such_note_000000000", "error": "not_found"}
    # New text, new stamp; the same text, the same.
    client.put(f"/api/attachments/{scan['id']}/text", headers=device.headers,
               json={"pages": [{"text": "Garden Street 14", "language": "en"}]})
    newer = {entry["id"]: entry for entry in pad.changes()["notes"]}[NOTE]["texts"]
    assert newer not in ("", stamp)
    # Too many at once.
    assert pad.post("/texts", {"notes": [f"n{index:021d}" for index in range(51)]}).status_code == 422
    # Another account: not found; a locked note: no text.
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        assert lenas.post("/texts", {"notes": [NOTE]}).json()["notes"] == [{"id": NOTE, "error": "not_found"}]
    with SessionLocal() as db:
        db.get(Note, NOTE).locked = True
        db.commit()
    locked = pad.post("/texts", {"notes": [NOTE]}).json()["notes"][0]
    assert (locked["texts"], locked["attachments"]) == ("", [])
    assert {entry["id"]: entry for entry in pad.changes()["notes"]}[NOTE]["texts"] == ""


def test_notes24_notesios10_text_the_server_reads_gives_a_new_number(client, operator, monkeypatch):
    engine = FakeEngine()
    monkeypatch.setattr(ocr, "ENGINE", engine)
    monkeypatch.setattr(ocr, "engine_info", lambda **_: ocr.EngineInfo(True, tuple(ocr.TESSERACT)))
    device = paired(client)
    device.new_note(NOTE, "Receipt")
    made = _upload(device, NOTE, png(), "Receipt.png").json()
    add_blocks(NOTE, operator.id, block("image", made))
    device.changes()
    engine.pages[made["id"]] = ["Bakery 4,20"]
    ocr.turn(made["id"])
    entry = {item["id"]: item for item in device.changes()["notes"]}.get(NOTE)
    assert entry is not None and entry["texts"] != ""
    pages = device.post("/texts", {"notes": [NOTE]}).json()["notes"][0]["attachments"][0]["pages"]
    assert pages == [{"page": 1, "text": "Bakery 4,20", "language": pages[0]["language"]}]
    # Read over several turns (a long PDF): every turn that reads a page gives the note a new number.
    longer = _upload(device, NOTE, png((10, 200, 10)), "Long.png").json()
    add_blocks(NOTE, operator.id, block("image", longer))
    engine.pages[longer["id"]] = [f"page {number}" for number in range(1, ocr.PAGES_PER_TURN + 1)] + ["the last"]
    ocr.turn(longer["id"])
    stamp = {item["id"]: item for item in device.changes()["notes"]}[NOTE]["texts"]
    ocr.turn(longer["id"])
    later = {item["id"]: item for item in device.changes()["notes"]}.get(NOTE)
    assert later is not None and later["texts"] not in ("", stamp)


def test_notes24_notesios10_folge10_the_device_s_text_of_a_sketch_is_found(client, operator):
    device = paired(client)
    device.new_note(NOTE, "Sketches")
    sketch = _upload(device, NOTE, png(), "Sketch.png", **{"as": "drawing"})
    assert sketch.status_code == 201 and sketch.json()["kind"] == "drawing", sketch.text
    add_blocks(NOTE, operator.id, {"type": "drawing", "attrs": {"id": sketch.json()["id"], "name": "Sketch.png"}})
    before = client.get(f"/api/attachments/{sketch.json()['id']}/text", headers=device.headers).json()
    assert before["state"] == "none"
    texted = client.put(f"/api/attachments/{sketch.json()['id']}/text", headers=device.headers,
                        json={"pages": [{"text": "zeppelin hangar", "language": "en"}]})
    assert texted.status_code == 200, texted.text
    assert texted.json()["items"][0]["source"] == "device"
    # One page for a sketch.
    two = client.put(f"/api/attachments/{sketch.json()['id']}/text", headers=device.headers,
                     json={"pages": [{"text": "a"}, {"text": "b"}]})
    assert two.status_code == 422
    assert wait_for(lambda: NOTE in {item["id"] for item in client.get("/api/search", params={"q": "zeppelin"})
                                     .json()["items"]})
    texts = device.post("/texts", {"notes": [NOTE]}).json()["notes"][0]["attachments"]
    assert [(entry["kind"], entry["pages"][0]["text"]) for entry in texts] == [("drawing", "zeppelin hangar")]
    # Still no text for a file.
    other = _upload(device, NOTE, b"plain bytes", "notes.bin")
    refused = client.put(f"/api/attachments/{other.json()['id']}/text", headers=device.headers,
                         json={"pages": [{"text": "x"}]})
    assert refused.status_code == 422 and code(refused) == "text_not_possible"


# --- Follow-up 6: what the server can --------------------------------------------------------------------------------


def test_notes24_folge6_hello_and_me_say_what_the_server_can(client, operator, monkeypatch):
    from app.services import settings_service

    hello = client.get("/api/app/1/hello").json()
    assert hello["features"][:5] == ["smart_folders", "history", "trash", "gallery", "texts"]
    monkeypatch.setattr(ocr, "engine_info", lambda **_: ocr.EngineInfo(False, ()))
    device = paired(client)
    me = device.get("/me").json()
    assert (me["limits"]["trash_days"], me["limits"]["history_days"]) == (90, 365)
    assert me["offers"]["ocr"] is False and isinstance(me["offers"]["link_previews"], bool)
    assert set(me["storage"]) == {"used", "limit", "full"} and me["storage"]["full"] is False
    with SessionLocal() as db:
        settings_service.save(db, {"link_previews": False, "share_links": False, "trash_days": 30})
        db.get(Account, operator.id).storage_limit = 0
        db.commit()
    monkeypatch.setattr(ocr, "engine_info", lambda **_: ocr.EngineInfo(True, ("de",)))
    me = device.get("/me").json()
    assert (me["offers"]["link_previews"], me["offers"]["share_links"], me["offers"]["ocr"]) == (False, False, True)
    assert me["limits"]["trash_days"] == 30 and me["storage"] == {"used": me["storage"]["used"], "limit": 0,
                                                                 "full": True}


def test_notes24_notesios7_smart_folders_in_changes_have_the_contract_s_fields(client, operator):
    """The fields of a smart folder in ``changes`` are exactly those of the contract."""
    device = paired(client)
    device.post("/smart-folders", {"id": SMART, "name": "To do", "conditions": OPEN})
    entry = next(item for item in device.changes()["smart_folders"] if item["id"] == SMART)
    assert set(entry) == {"id", "name", "preset", "match", "conditions", "icon", "color", "position", "created_at",
                          "updated_at", "seq"}


# --- Review of 0.5 (S1 to S10) ------------------------------------------------------------------------------------


def test_notes24_notesios10_texts_never_show_what_a_writer_slipped_into_a_shared_note(client, operator):
    """S1, S9: in a note of somebody else only what its owner put there counts, as in the browser; a reference
    without a row of its own counts as not vouched either."""
    from app.models_attachments import AttachmentMention

    device = paired(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        lenas.new_note(NOTE, "Private")
        private = _scan_with_text(lenas, NOTE, "bank details")
        lenas.new_note(NOTE_2, "Shared plan")
        own = _scan_with_text(lenas, NOTE_2, "garden layout")
        add_blocks(NOTE_2, lena.id, {"type": "image", "attrs": {"id": own, "name": "scan.png"}})
        share(other, "note", NOTE_2, operator, "write")
        # Mila, who may write, puts a reference to the owner's private scan into the shared note.
        add_blocks(NOTE_2, operator.id, {"type": "image", "attrs": {"id": private, "name": "x.png"}})
        answer = device.post("/texts", {"notes": [NOTE_2]}).json()["notes"][0]
        assert [entry["id"] for entry in answer["attachments"]] == [own]
        stamp = answer["texts"]
        assert {item["id"]: item for item in device.changes()["notes"]}[NOTE_2]["texts"] == stamp
        # Without a row in the table of mentions it still does not count (as ``attachments._vouched``).
        with SessionLocal() as db:
            db.query(AttachmentMention).filter_by(note_id=NOTE_2, attachment_id=private).delete()
            db.commit()
        again = device.post("/texts", {"notes": [NOTE_2]}).json()["notes"][0]
        assert [entry["id"] for entry in again["attachments"]] == [own] and again["texts"] == stamp
        # Its owner sees both: her own note, her own scans.
        mine = lenas.post("/texts", {"notes": [NOTE_2]}).json()["notes"][0]["attachments"]
        assert {entry["id"] for entry in mine} == {own, private}


def test_notes24_notesios10_text_forgotten_in_bulk_gives_a_new_number(client, operator):
    """S4: text that goes without new pages (a note locked, ``ocr._forget``) gives the notes naming it a number."""
    device = paired(client)
    device.new_note(NOTE, "Lease")
    scan = _scan_with_text(device, NOTE, "Garden Street 12")
    add_blocks(NOTE, operator.id, {"type": "image", "attrs": {"id": scan, "name": "scan.png"}})
    assert {item["id"]: item for item in device.changes()["notes"]}[NOTE]["texts"] != ""
    with SessionLocal() as db:
        ocr._forget(db, scan)
        db.commit()
    after = {item["id"]: item for item in device.changes()["notes"]}.get(NOTE)
    assert after is not None and after["texts"] == ""


def test_notes24_notesios9_ac1_a_copy_takes_no_id_of_another_note(client, operator, monkeypatch):
    """S2, S10: the same id again is the copy made before; any other note's id is taken; two at once make one."""
    from app.routers import app1_trash

    device = paired(client)
    device.new_note(NOTE, "Plan", "first idea")
    session(NOTE, operator.id, ["second thought"], T0)
    version = device.get(f"/notes/{NOTE}/versions").json()["versions"][0]["id"]
    device.new_note(NOTE_2, "Unrelated own note")
    own = device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": NOTE_2})
    assert own.status_code == 409 and code(own) == "note_id_taken"
    lena = make_account("lena")
    shared_id = "lN_sharedToRead-0aSdFgH"
    with new_client(lena) as other:
        paired(other).new_note(shared_id, "Shared to read")
        share(other, "note", shared_id, operator, "read")
    theirs = device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": shared_id})
    assert theirs.status_code == 409 and code(theirs) == "note_id_taken"
    # A copy of another version under the id of the first copy is no repeat either.
    assert device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": COPY}).status_code == 201
    session(NOTE, operator.id, ["third"], T0 + timedelta(hours=2))
    newer = device.get(f"/notes/{NOTE}/versions").json()["versions"][0]["id"]
    assert code(device.post(f"/notes/{NOTE}/versions/{newer}/copy", {"id": COPY})) == "note_id_taken"
    # Two requests at once: the second finds the id taken only when it writes, and answers with the first's copy.
    real = app1_trash._same_copy
    calls = {"n": 0}

    def late(*args):
        calls["n"] += 1
        return None if calls["n"] == 1 else real(*args)

    monkeypatch.setattr(app1_trash, "_same_copy", late)
    raced = device.post(f"/notes/{NOTE}/versions/{version}/copy", {"id": COPY})
    assert raced.status_code == 200 and raced.json()["id"] == COPY


def test_notes24_notesios9_times_of_history_and_trash_in_utc_with_z(client, operator):
    """S6: as everywhere in the interface."""
    device = paired(client)
    found = _versioned(device, operator.id)
    for entry in found:
        assert entry["created_at"].endswith("Z") and entry["started_at"].endswith("Z")
    read = device.get(f"/notes/{NOTE}/versions/{found[1]['id']}").json()
    assert read["created_at"].endswith("Z") and read["started_at"].endswith("Z")
    restored = device.post(f"/notes/{NOTE}/versions/{found[1]['id']}/restore").json()
    assert restored["restored_from"] == found[1]["created_at"]
    assert device.get(f"/notes/{NOTE}/versions").json()["versions"][0]["restored_from"].endswith("Z")
    # The trash goes by the server's clock again (the versions above were made on a clock set back).
    history.clock.reset()
    device.delete(f"/notes/{NOTE}")
    listed = device.get("/trash").json()
    item = listed["items"][0]
    assert listed["now"].endswith("Z") and item["deleted_at"].endswith("Z") and item["expires_at"].endswith("Z")
    assert device.post("/trash/empty", {"until": listed["now"]}).json() == {"notes": 1, "folders": 0}


def test_notes24_notesios7_too_long_or_too_many_hear_the_rule(client, operator):
    """S7: a name past 200 characters and more than 50 conditions hear the rule's code, not ``invalid_input``."""
    device = paired(client)
    long_name = device.post("/smart-folders", {"id": SMART, "name": "x" * 300, "conditions": OPEN})
    assert long_name.status_code == 422 and code(long_name) == "smart_folder_name_invalid"
    many = device.post("/smart-folders", {"id": SMART, "name": "Many", "conditions": OPEN * 60})
    assert many.status_code == 422 and code(many) == "smart_condition_invalid"
    device.post("/smart-folders", {"id": SMART, "name": "Fine", "conditions": OPEN})
    assert code(device.patch(f"/smart-folders/{SMART}", {"name": "y" * 300})) == "smart_folder_name_invalid"
    assert code(device.patch(f"/smart-folders/{SMART}", {"conditions": OPEN * 60})) == "smart_condition_invalid"
