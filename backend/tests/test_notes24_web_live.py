"""NOTES-24: what a device changes over ``/api/app/1`` (share sheet, widget, quick note, shortcut, the app itself)
reaches a browser that is open, without reloading it, as a change from a second browser does.

An open page asks two stamps every few seconds: its list's (``/api/note-list/stamp``, NOTES-6 EC-6) and the tree's
(``/api/folders/stamp``: the tree, the tiles, the inbox's number, the smart folders). Whatever a device changes moves
the ones that show it; the page loads again only then.
"""

from __future__ import annotations

import pytest

from app.services import attachments, devices, history, notes, ocr, search, trash, workqueue

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import stored
from .test_notes10 import add_blocks, block
from .test_notes13 import make_folder
from .test_notes13_link import png
from .test_notes24 import paired

NOTE = "wB_sharedLink-7uYtReWqZx"
NOTE_2 = "wB_widgetNote-2wErTyUiOp"
FOLDER = "wF_household-Box9xQwErT"
SMART = "wS_openTasks-9xQwErTyUi"


@pytest.fixture(autouse=True)
def _setup(client, monkeypatch: pytest.MonkeyPatch) -> None:
    devices.forget()
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)
    attachments.register()
    history.register()
    trash.register()
    ocr.register()
    search.register_hooks()
    monkeypatch.setattr(workqueue, "AUTO", False)
    workqueue.stopping.clear()
    yield
    workqueue.stop()
    workqueue.stopping.clear()
    Live.close_all()


def tree_stamp(client) -> str:
    """What the open page's tree asks every few seconds, with the browser's session."""
    answer = client.get("/api/folders/stamp")
    assert answer.status_code == 200, answer.text
    return answer.json()["stamp"]


def list_stamp(client, folder_id: str | None = None) -> str:
    answer = client.get("/api/note-list/stamp", params={"folder_id": folder_id} if folder_id else {})
    assert answer.status_code == 200, answer.text
    return answer.json()["stamp"]


def tree(client) -> dict:
    answer = client.get("/api/folders")
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_notes24_web_live_a_note_from_the_share_sheet_reaches_the_open_browser(client, operator):
    device = paired(client)
    shown = tree(client)
    inbox = shown["inbox"]["id"]
    # The tree carries the stamp it belongs to; nothing changed, nothing moves.
    assert shown["stamp"] == tree_stamp(client) == tree_stamp(client)
    before = (shown["stamp"], list_stamp(client, inbox), list_stamp(client))
    assert shown["inbox"]["count"] == 0 and shown["places"]["all"] == 0

    device.new_note(NOTE, "Recipe link", "https://example.com/recipe", origin="share:Safari")

    after = (tree_stamp(client), list_stamp(client, inbox), list_stamp(client))
    assert all(old != new for old, new in zip(before, after, strict=True)), (before, after)
    again = tree(client)
    assert again["stamp"] == after[0]
    assert again["inbox"]["count"] == 1 and again["places"]["all"] == 1
    listed = client.get("/api/note-list", params={"folder_id": inbox}).json()["items"]
    assert [(item["id"], item["origin"]) for item in listed] == [(NOTE, "share:Safari")]


def test_notes24_web_live_text_the_device_syncs_moves_the_stamps(client, operator):
    device = paired(client)
    inbox = tree(client)["inbox"]["id"]
    device.new_note(NOTE, "Shopping", "Milk")
    before = (tree_stamp(client), list_stamp(client, inbox))
    update = device.write(NOTE, "Bread")
    assert device.sync(NOTE, updates={NOTE: update})[NOTE].get("error") is None
    after = (tree_stamp(client), list_stamp(client, inbox))
    assert before[0] != after[0] and before[1] != after[1]
    assert "Bread" in client.get("/api/note-list", params={"folder_id": inbox}).json()["items"][0]["preview"]


def test_notes24_web_live_fields_the_device_changes_move_the_stamps(client, operator):
    device = paired(client)
    folder = make_folder(client, "Household")
    inbox = tree(client)["inbox"]["id"]
    device.new_note(NOTE, "Chores")
    # What a list shows moves both stamps (the symbol before the title too, NOTES-3 AC-18).
    for change in ({"color": "red"}, {"pinned": True}, {"title_check": True}, {"title_ok": True}, {"icon": "star"}):
        before = (tree_stamp(client), list_stamp(client, inbox))
        answer = device.patch(f"/notes/{NOTE}", change)
        assert answer.status_code == 200, answer.text
        after = (tree_stamp(client), list_stamp(client, inbox))
        assert before[0] != after[0] and before[1] != after[1], change
    # The paper no list shows: the tree's stamp still hears of it.
    before = tree_stamp(client)
    assert device.patch(f"/notes/{NOTE}", {"paper": "lined"}).status_code == 200
    assert tree_stamp(client) != before
    # Sorted in on the phone: the inbox's number and the folder's follow.
    before = tree_stamp(client)
    assert device.patch(f"/notes/{NOTE}", {"folder_id": folder}).status_code == 200
    assert tree_stamp(client) != before
    shown = tree(client)
    assert shown["inbox"]["count"] == 0
    assert {item["id"]: item["count"] for item in shown["folders"]}[folder] == 1


def test_notes24_web_live_trash_and_back_from_the_device(client, operator):
    device = paired(client)
    inbox = tree(client)["inbox"]["id"]
    device.new_note(NOTE, "Old list")
    before = (tree_stamp(client), list_stamp(client, inbox))
    assert device.delete(f"/notes/{NOTE}").status_code == 204
    gone = (tree_stamp(client), list_stamp(client, inbox))
    assert gone[0] != before[0] and gone[1] != before[1]
    assert tree(client)["places"]["all"] == 0
    assert device.post(f"/notes/{NOTE}/restore").status_code == 200
    back = (tree_stamp(client), list_stamp(client, inbox))
    assert back[0] != gone[0] and back[1] != gone[1]
    assert tree(client)["places"]["all"] == 1


def test_notes24_web_live_attachments_and_recognised_text_from_the_device(client, operator):
    device = paired(client)
    device.new_note(NOTE, "Lease")
    before = tree_stamp(client)
    scan = client.post("/api/attachments", params={"note_id": NOTE, "id": attachments.new_id(), "name": "Lease.png",
                                                   "as": "scan", "text": "device"},
                       content=png(), headers=device.headers)
    assert scan.status_code in (200, 201), scan.text
    add_blocks(NOTE, operator.id, block("image", scan.json()))
    added = tree_stamp(client)
    assert added != before
    texted = client.put(f"/api/attachments/{scan.json()['id']}/text", headers=device.headers,
                        json={"pages": [{"text": "Garden Street 12", "language": "en"}]})
    assert texted.status_code == 200, texted.text
    assert tree_stamp(client) != added


def test_notes24_web_live_folders_and_smart_folders_made_on_the_device(client, operator):
    device = paired(client)
    before = tree_stamp(client)
    made = device.post("/folders", {"id": FOLDER, "name": "Garden"})
    assert made.status_code == 201, made.text
    folder_made = tree_stamp(client)
    assert folder_made != before
    assert FOLDER in {item["id"] for item in tree(client)["folders"]}
    assert device.patch(f"/folders/{FOLDER}", {"name": "Garden 2027"}).status_code == 200
    renamed = tree_stamp(client)
    assert renamed != folder_made
    smart = device.post("/smart-folders", {"id": SMART, "name": "To do", "match": "all",
                                           "conditions": [{"kind": "tasks", "op": "open"}]})
    assert smart.status_code == 201, smart.text
    assert tree_stamp(client) != renamed


def test_notes24_web_live_another_account_s_changes_leave_the_stamp_alone(client, operator):
    paired(client)
    mine = tree_stamp(client)
    lena = make_account("lena")
    with new_client(lena) as other:
        paired(other).new_note(NOTE_2, "Lena's note")
    assert stored(NOTE_2).owner_id == lena.id
    assert tree_stamp(client) == mine


def test_notes24_web_live_the_stamp_needs_a_sign_in(client, operator):
    with new_client() as bare:
        assert bare.get("/api/folders/stamp").status_code == 401
