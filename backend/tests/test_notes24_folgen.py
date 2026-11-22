"""NOTES-24 follow-ups 2, 3 and 9 of the app (interface 0.4): folders, how lists look and tags from the app
(NOTESIOS-5, 6), tags and the account in ``changes`` (NOTESIOS-5, 6, 8), the member's own settings (NOTESIOS-1
AC-11). Everything with a device's token, through ``/api/app/1``; the browser sees the same.

The test client of the interface is the one of ``test_notes24.py``.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Folder, NoteListView
from app.services import devices

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import stored, wait_for
from .test_notes13 import make_folder
from .test_notes13_link import make_link, png, switch_links
from .test_notes24 import paired, without_presets

#: Ids as the app makes them: base64url with ``_``, ``-`` and letters past ``f``.
FOLDER = "fZ_household-Box9xQwErT"
CHILD = "kq-Shopping_Lists7uYtRe"
NOTE = "nX_packingList-2wErTyUi"


@pytest.fixture(autouse=True)
def _forget(client) -> None:
    devices.forget()
    yield
    Live.close_all()


def folder_row(folder_id: str) -> Folder:
    with SessionLocal() as db:
        row = db.get(Folder, folder_id)
        assert row is not None
        db.expunge(row)
        return row


def code(answer) -> str:
    return answer.json()["detail"]["code"]


# --- Folge 2: folders (NOTESIOS-5) --------------------------------------------------------------------------------


def test_notes24_folge2_notesios5_ac1_folders_made_with_the_device_s_id_once(client, operator):
    device = paired(client)
    made = device.post("/folders", {"id": FOLDER, "name": "Household", "icon": "", "color": "honey"})
    assert made.status_code == 201, made.text
    body = made.json()
    assert (body["id"], body["name"], body["parent_id"], body["color"], body["deleted_at"]) == (
        FOLDER, "Household", None, "honey", None)
    assert body["icon"] == "folder" and body["seq"] > 0
    # Sent again (the answer got lost): the same folder, nothing doubles, nothing changes.
    again = device.post("/folders", {"id": FOLDER, "name": "Something else"})
    assert again.status_code == 200 and again.json()["name"] == "Household"
    with SessionLocal() as db:
        assert len(list(db.scalars(select(Folder).where(Folder.kind != "inbox")))) == 1
    child = device.post("/folders", {"id": CHILD, "name": "Shopping", "parent_id": FOLDER})
    assert child.status_code == 201 and child.json()["parent_id"] == FOLDER
    # The browser sees them.
    tree = client.get("/api/folders").json()["folders"]
    assert {entry["id"] for entry in tree} == {FOLDER, CHILD}
    # Another account's id is taken; a bad id or the inbox as parent are refused like in the browser.
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        taken = lenas.post("/folders", {"id": FOLDER, "name": "Mine"})
        assert taken.status_code == 409 and code(taken) == "folder_id_taken"
    assert device.post("/folders", {"id": "short", "name": "X"}).status_code == 422
    assert code(device.post("/folders", {"id": "aAaAaAaAaAaAaAaAaAaAaA", "name": "X", "parent_id": "inbox"})) \
        == "folder_target_not_allowed"
    assert code(device.post("/folders", {"id": "bBbBbBbBbBbBbBbBbBbBbB", "name": "household"})) == "folder_name_taken"
    assert code(device.post("/folders", {"id": "cCcCcCcCcCcCcCcCcCcCcC", "name": "x" * 61})) == "folder_name_too_long"


def test_notes24_folge2_notesios5_ac1_rename_style_move_trash_restore_and_order(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.post("/folders", {"id": CHILD, "name": "Shopping", "parent_id": FOLDER})
    changed = device.patch(f"/folders/{CHILD}", {"name": "Groceries", "icon": "star", "color": "#12ab34"})
    assert changed.status_code == 200, changed.text
    assert (changed.json()["name"], changed.json()["icon"], changed.json()["color"]) == ("Groceries", "star", "#12ab34")
    assert code(device.patch(f"/folders/{CHILD}", {"icon": "no-such-symbol"})) == "folder_style_unknown"
    # Moved to the top, and back in; never into itself (EC-1).
    assert device.patch(f"/folders/{CHILD}", {"parent_id": None}).json()["parent_id"] is None
    assert device.patch(f"/folders/{CHILD}", {"parent_id": FOLDER}).json()["parent_id"] == FOLDER
    assert code(device.patch(f"/folders/{FOLDER}", {"parent_id": CHILD})) == "folder_into_itself"
    # A note in it goes to the trash with it and comes back with it.
    device.new_note(NOTE, "List", folder_id=CHILD)
    gone = device.delete(f"/folders/{FOLDER}")
    assert gone.status_code == 200 and gone.json() == {"id": FOLDER, "folders": 1, "notes": 1}
    assert folder_row(CHILD).deleted_at is not None and stored(NOTE).deleted_at is not None
    back = device.post(f"/folders/{FOLDER}/restore")
    assert back.status_code == 200 and back.json()["deleted_at"] is None
    assert folder_row(CHILD).deleted_at is None and stored(NOTE).deleted_at is None
    # The own order on every device (NOTES-4 AC-11).
    for name, folder_id in (("Alpha", "aAaAaAaAaAaAaAaAaAaAaA"), ("Beta", "bBbBbBbBbBbBbBbBbBbBbB")):
        device.post("/folders", {"id": folder_id, "name": name})
    ordered = device.put("/folders/order", {"parent_id": None, "ids": ["bBbBbBbBbBbBbBbBbBbBbB", FOLDER]})
    assert ordered.status_code == 200, ordered.text
    assert [entry["id"] for entry in ordered.json()["folders"]] == [
        "bBbBbBbBbBbBbBbBbBbBbB", FOLDER, "aAaAaAaAaAaAaAaAaAaAaA"]
    assert [entry["position"] for entry in ordered.json()["folders"]] == [0, 1, 2]
    # Somebody else's folder is not there for the device.
    lena = make_account("lena")
    with new_client(lena) as other:
        theirs = make_folder(other, "Lena's")
    assert device.patch(f"/folders/{theirs}", {"name": "Taken"}).status_code == 404
    assert device.delete(f"/folders/{theirs}").status_code == 404


# --- Folge 2: how lists look (NOTESIOS-6) -------------------------------------------------------------------------


def test_notes24_folge2_notesios6_ac2_look_and_views_from_the_app_count_in_the_browser(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    look = device.put("/look", {"style": "compact", "hints": False})
    assert look.status_code == 200 and look.json() == {"style": "compact", "hints": False}
    me = client.get("/api/auth/me").json()
    assert (me["list_style"], me["list_hints"]) == ("compact", False)
    assert code(device.put("/look", {"style": "spiral"})) == "list_style_unknown"
    for key, sort in ((FOLDER, "title"), ("inbox", "created"), ("all", "updated")):
        saved = device.put("/views", {"key": key, "sort": sort, "direction": "asc", "grouped": False})
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"key": key, "sort": sort, "direction": "asc", "grouped": False}
    with SessionLocal() as db:
        rows = {row.key: row for row in db.scalars(select(NoteListView))}
    assert rows[FOLDER].sort == "title" and rows["all"].direction == "asc" and len(rows) == 3
    assert device.put("/views", {"key": "zZzZzZzZzZzZzZzZzZzZzZ", "sort": "title"}).status_code == 404
    assert device.put("/views", {"key": FOLDER, "sort": "random"}).status_code == 422


# --- Folge 2: tags (NOTESIOS-5) -----------------------------------------------------------------------------------


def test_notes24_folge2_notesios5_ac7_tags_renamed_merged_and_deleted_from_the_app(client, operator):
    device = paired(client)
    first = client.post("/api/notes", json={"markdown": "Milk #shopping"}).json()
    second = client.post("/api/notes", json={"markdown": "Bread #market"}).json()
    renamed = device.put("/tags/shopping", {"name": "groceries"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["changed"] == 1
    assert wait_for(lambda: "#groceries" in stored(first["id"]).text)
    refused = device.put("/tags/market", {"name": "groceries"})
    assert refused.status_code == 409 and code(refused) == "tag_exists"
    merged = device.put("/tags/market", {"name": "groceries", "merge": True})
    assert merged.status_code == 200 and merged.json()["changed"] == 1
    assert wait_for(lambda: "#groceries" in stored(second["id"]).text)
    removed = device.delete("/tags/groceries")
    assert removed.status_code == 200 and removed.json()["changed"] == 2
    assert wait_for(lambda: "#" not in stored(first["id"]).text and "#" not in stored(second["id"]).text)
    assert "Milk" in stored(first["id"]).text


# --- Folge 3: tags and the account in changes (NOTESIOS-5, 6, 8) ---------------------------------------------------


def test_notes24_folge3_notes_bring_their_tags_and_new_tags_give_a_new_number(client, operator):
    device = paired(client)
    note = client.post("/api/notes", json={"markdown": "Plan #Trip and #budget #trip"}).json()
    first = device.changes()
    entry = next(item for item in first["notes"] if item["id"] == note["id"])
    assert sorted(entry["tags"]) == ["Trip", "budget", "trip"]
    # The tag renamed elsewhere: the note comes again with its new tags.
    assert client.put("/api/tags/budget", json={"name": "money"}).status_code == 200
    assert wait_for(lambda: "#money" in stored(note["id"]).text)
    again = device.changes()
    entry = next(item for item in again["notes"] if item["id"] == note["id"])
    assert "money" in entry["tags"] and "budget" not in entry["tags"]


def test_notes24_folge3_tags_written_without_a_text_change_give_a_new_number(client, operator):
    """The tags are read anew when the rules change (``tags.rebuild_if_needed``): no update of the text, still a
    change for the app."""
    from collections import Counter

    from app.services import tags

    device = paired(client)
    note = client.post("/api/notes", json={"markdown": "Plain"}).json()
    device.changes()
    with SessionLocal() as db:
        tags.write_tags(db, note["id"], Counter({"extra": 1}))
        db.commit()
    found = device.changes()
    assert [(item["id"], item["tags"]) for item in found["notes"]] == [(note["id"], ["extra"])]
    with SessionLocal() as db:
        tags.write_tags(db, note["id"], Counter({"extra": 1}))
        db.commit()
    assert device.changes()["notes"] == []


def test_notes24_folge3_the_account_comes_when_it_changed_and_in_every_full_list(client, operator):
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    first = device.changes()
    assert first["full"] is True
    account = first["account"]
    assert account["name"] == "Tester" and account["paper"] == "blank" and account["views"] == []
    assert account["list_look"] == {"style": "list", "hints": True}
    # Nothing of it changed: no account.
    assert "account" not in device.changes()
    device.put("/look", {"style": "cards"})
    device.put("/views", {"key": "inbox", "sort": "title"})
    device.put("/views", {"key": FOLDER, "grouped": False})
    found = device.changes()
    assert found["account"]["list_look"]["style"] == "cards"
    views = {view["key"]: view for view in found["account"]["views"]}
    assert views["inbox"]["sort"] == "title" and views[FOLDER]["grouped"] is False
    assert "account" not in device.changes()
    # A view alone is a change of the account too.
    device.put("/views", {"key": "all", "sort": "created"})
    assert {view["key"] for view in device.changes()["account"]["views"]} == {"inbox", FOLDER, "all"}
    # Name, picture and paper from the browser come too.
    client.put("/api/me/profile", json={"display_name": "Mila"})
    assert device.changes()["account"]["name"] == "Mila"
    client.put("/api/me/paper", json={"paper": "grid"})
    assert device.changes()["account"]["paper"] == "grid"
    # A full list always has it.
    device.cursor = 0
    assert device.changes()["account"]["name"] == "Mila"


def test_notes24_folge3_a_locked_note_shows_no_tags(client, operator):
    device = paired(client)
    note = client.post("/api/notes", json={"markdown": "Secret #pin"}).json()
    with SessionLocal() as db:
        from app.models import Note

        db.get(Note, note["id"]).locked = True
        db.commit()
    entry = next(item for item in device.changes()["notes"] if item["id"] == note["id"])
    assert entry["tags"] == [] and entry["locked"] is True


def test_notes24_folge3_a_new_look_wakes_the_waiting(client, operator, monkeypatch):
    from app.routers import app1 as app1_router

    monkeypatch.setattr(app1_router, "WAIT_SECONDS", 0.5)
    device = paired(client)
    device.changes()
    assert device.get("/wait", cursor=device.cursor).json() == {"cursor": device.cursor}
    device.put("/look", {"hints": False})
    assert device.get("/wait", cursor=device.cursor).json()["cursor"] > device.cursor


# --- Folge 9: the member's own settings (NOTESIOS-1 AC-11) ---------------------------------------------------------


def test_notes24_folge9_notesios1_ac11_name_picture_and_paper_from_the_app(client, operator):
    device = paired(client)
    named = device.client.put("/api/app/1/profile", headers=device.headers, json={"display_name": "  Mila  "})
    assert named.status_code == 200 and named.json()["name"] == "Mila"
    assert named.json()["email"] == "tester@example.com"
    assert code(device.client.put("/api/app/1/profile", headers=device.headers, json={"display_name": " "})) \
        == "display_name_empty"
    pictured = device.client.put("/api/app/1/avatar", headers=device.headers, content=png())
    assert pictured.status_code == 200, pictured.text
    stamp = pictured.json()["avatar"]
    assert stamp
    picture = client.get(f"/api/avatars/{operator.id}", params={"v": stamp}, headers=device.headers)
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/webp"
    assert device.client.put("/api/app/1/avatar", headers=device.headers, content=b"not a picture").status_code == 422
    assert device.delete("/avatar").json()["avatar"] == ""
    paper = device.client.put("/api/app/1/paper", headers=device.headers, json={"paper": "grid"})
    assert paper.status_code == 200 and paper.json() == {"paper": "grid"}
    assert device.get("/me").json()["paper"] == "grid"
    assert client.get("/api/auth/me").json()["paper"] == "grid"
    assert code(device.client.put("/api/app/1/paper", headers=device.headers, json={"paper": "felt"})) \
        == "paper_unknown"


def test_notes24_folge9_notesios1_ac11_devices_seen_and_disconnected_from_the_app(client, operator):
    phone = paired(client, "iPhone")
    pad = paired(client, "iPad", "ipados")
    listed = phone.get("/devices").json()
    assert [(entry["name"], entry["kind"], entry["this"]) for entry in listed] == [
        ("iPhone", "ios", True), ("iPad", "ipados", False)]
    assert all("push" in entry and "last_seen_at" in entry for entry in listed)
    pad_id = listed[1]["id"]
    assert phone.delete(f"/devices/{pad_id}").status_code == 204
    assert pad.get("/me").json()["detail"]["code"] == "device_disconnected"
    # Another account's device is not there for it; its own it may disconnect too.
    lena = make_account("lena")
    with new_client(lena) as other:
        lenas = paired(other)
        lenas_id = lenas.get("/me").json()["device"]["id"]
    assert phone.delete(f"/devices/{lenas_id}").status_code == 404
    assert lenas.get("/me").status_code == 200
    phone_id = listed[0]["id"]
    assert phone.delete(f"/devices/{phone_id}").status_code == 204
    assert phone.get("/me").json()["detail"]["code"] == "device_disconnected"


def test_notes24_folge9_notesios1_ac11_read_links_seen_and_revoked_from_the_app(client, operator):
    switch_links(True)
    device = paired(client)
    note = client.post("/api/notes", json={"markdown": "Recipe"}).json()
    link = make_link(client, note["id"])
    listed = device.get("/read-links").json()
    assert [(entry["id"], entry["note_id"], entry["title"]) for entry in listed] == [
        (link["id"], note["id"], stored(note["id"]).title)]
    assert "path" not in listed[0]
    lena = make_account("lena")
    with new_client(lena) as other:
        theirs = other.post("/api/notes", json={"markdown": "Lena's"}).json()
        their_link = make_link(other, theirs["id"])
    assert device.delete(f"/read-links/{their_link['id']}").status_code == 404
    assert device.delete(f"/read-links/{link['id']}").status_code == 204
    assert device.get("/read-links").json() == []
    assert client.get("/api/read-links").json() == []


def test_notes24_folge9_the_address_stays_in_the_browser(client, operator):
    device = paired(client)
    device.client.put("/api/app/1/profile", headers=device.headers, json={"display_name": "Mila",
                                                                          "email": "else@example.com"})
    with SessionLocal() as db:
        assert db.get(Account, operator.id).email == "tester@example.com"


# --- Nachprüfung (N1 to N8) ---------------------------------------------------------------------------------------


def test_notes24_folge3_the_account_is_not_lost_between_pages(client, operator, monkeypatch):
    """N1: a change of the account before many notes: the run in pages still brings it, on the page of its change."""
    from app.services import appsync

    monkeypatch.setattr(appsync, "PAGE", 3)
    without_presets(operator.id)
    device = paired(client)
    device.changes()
    device.put("/views", {"key": "all", "sort": "title"})
    for index in range(6):
        device.new_note(f"N{index:021d}", f"Note {index}")
    pages = [device.changes()]
    while pages[-1]["more"]:
        pages.append(device.changes())
    assert len(pages) >= 2
    accounts = [page["account"] for page in pages if "account" in page]
    assert len(accounts) == 1 and accounts[0]["views"][0]["sort"] == "title"
    assert "account" in pages[0] and pages[0]["more"] is True
    assert "account" not in device.changes()
    # A full run in pages: the account on its first page, once.
    device.cursor = 0
    full = [device.changes()]
    while full[-1]["more"]:
        full.append(device.changes())
    assert len(full) >= 2 and all(page["full"] for page in full)
    assert ["account" in page for page in full] == [True] + [False] * (len(full) - 1)


def test_notes24_folge3_a_view_changed_again_comes_again(client, operator):
    """N3: not only a new view, also one changed later gives the account a new number."""
    device = paired(client)
    device.put("/views", {"key": "all", "sort": "created"})
    device.changes()
    assert "account" not in device.changes()
    device.put("/views", {"key": "all", "sort": "title"})
    found = device.changes()
    assert [(view["key"], view["sort"]) for view in found["account"]["views"]] == [("all", "title")]


def test_notes24_folge3_smart_folder_views_come_and_their_deletion_counts(client, operator):
    """N6: views of smart folders are in ``account.views`` (since NOTESIOS-7, with ``mode``); deleting such a folder
    gives the account a new number (its view went in bulk)."""
    device = paired(client)
    smart = client.post("/api/smart-folders", json={"name": "Open", "match": "all",
                                                    "conditions": [{"kind": "tasks", "op": "open"}]})
    assert smart.status_code == 201, smart.text
    smart_id = smart.json()["id"]
    assert client.put(f"/api/smart-folders/{smart_id}/view", json={"sort": "title"}).status_code == 200
    device.put("/views", {"key": "all", "sort": "created"})
    first = device.changes()
    assert [(view["key"], view.get("mode")) for view in first["account"]["views"]] == [
        ("all", None), (f"s:{smart_id}", "list")]
    assert client.delete(f"/api/smart-folders/{smart_id}").status_code == 204
    with SessionLocal() as db:
        assert db.scalar(select(NoteListView).where(NoteListView.key == f"s:{smart_id}")) is None
    assert [view["key"] for view in device.changes()["account"]["views"]] == ["all"]


def test_notes24_folge2_notesios5_ac1_a_folder_patch_is_all_or_nothing(client, operator):
    """N2: refused, nothing of the change is kept."""
    device = paired(client)
    device.post("/folders", {"id": FOLDER, "name": "Household"})
    device.post("/folders", {"id": CHILD, "name": "Shopping", "parent_id": FOLDER})
    device.post("/folders", {"id": "aAaAaAaAaAaAaAaAaAaAaA", "name": "Groceries"})
    refused = device.patch(f"/folders/{FOLDER}", {"name": "Renamed", "color": "red", "parent_id": CHILD})
    assert refused.status_code == 400 and code(refused) == "folder_into_itself"
    row = folder_row(FOLDER)
    assert (row.name, row.color, row.parent_id) == ("Household", "", None)
    # The name the folder would carry in its new place is taken there: nothing moves, nothing is renamed.
    taken = device.patch(f"/folders/{CHILD}", {"name": "groceries", "parent_id": None})
    assert taken.status_code == 409 and code(taken) == "folder_name_taken"
    row = folder_row(CHILD)
    assert (row.name, row.parent_id) == ("Shopping", FOLDER)
    unknown_symbol = device.patch(f"/folders/{CHILD}", {"name": "Fresh", "icon": "no-such-symbol"})
    assert code(unknown_symbol) == "folder_style_unknown" and folder_row(CHILD).name == "Shopping"
    # Both together when both are right.
    done = device.patch(f"/folders/{CHILD}", {"name": "Fresh", "parent_id": None})
    assert done.status_code == 200 and (done.json()["name"], done.json()["parent_id"]) == ("Fresh", None)


def test_notes24_folge2_notesios5_ac4_the_inbox_stays_as_it_is(client, operator):
    """N4: the inbox, by ``inbox`` or by its own id, is neither renamed, moved nor deleted."""
    device = paired(client)
    with SessionLocal() as db:
        from app.services.inbox import inbox_for

        inbox = inbox_for(db, operator.id).id
        db.commit()
    for folder_id in ("inbox", inbox):
        for answer in (device.patch(f"/folders/{folder_id}", {"name": "Mine"}), device.delete(f"/folders/{folder_id}")):
            assert code(answer) == "inbox_fixed", (folder_id, answer.text)
    with SessionLocal() as db:
        assert db.get(Folder, inbox).deleted_at is None and db.get(Folder, inbox).kind == "inbox"


def test_notes24_folge9_notesios1_ac11_the_name_follows_the_browser_s_rule(client, operator):
    """N5: over 200 characters refused like in the browser, never cut silently; kept at most 80 like there."""
    device = paired(client)
    too_long = device.put("/profile", {"display_name": "x" * 201})
    assert too_long.status_code == 422
    assert client.put("/api/me/profile", json={"display_name": "x" * 201}).status_code == 422
    with SessionLocal() as db:
        assert db.get(Account, operator.id).display_name == "Tester"
    long = device.put("/profile", {"display_name": "y" * 150})
    browser = client.put("/api/me/profile", json={"display_name": "y" * 150})
    assert long.json()["name"] == browser.json()["display_name"]


def _png_header(width: int, height: int) -> bytes:
    """A PNG that says it is this large, without the pixels: what a decompression bomb looks like up front."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")


def test_notes24_folge9_notesios1_ac11_a_picture_bomb_is_too_large(client, operator):
    """N8: over Pillow's own limit (and over ours) the answer is ``avatar_too_large``, not "no picture"."""
    device = paired(client)
    for size in (20_000, 8_000):
        answer = device.client.put("/api/app/1/avatar", headers=device.headers, content=_png_header(size, size))
        assert answer.status_code == 422 and code(answer) == "avatar_too_large", (size, answer.text)
