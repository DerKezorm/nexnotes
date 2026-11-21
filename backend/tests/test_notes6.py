"""NOTES-6 Liste und Kacheln: the server's part (the list in one go, views per folder on every device, pinning and
colors, checklist progress, the stamp lists load again by, and the docking points for sharing, tags and locks)."""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import insert

from app.db import SessionLocal
from app.models import Account, Note, utcnow
from app.notedoc import edit
from app.notedoc.room import Access
from app.services import notes, notes_list
from app.services.inbox import inbox_for

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored, token_for, wait_for


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


def make_folder(client, name: str) -> str:
    answer = client.post("/api/folders", json={"name": name})
    assert answer.status_code in (200, 201), answer.text
    return answer.json()["id"]


def listed(client, folder_id: str | None = None) -> dict:
    answer = client.get("/api/note-list", params={"folder_id": folder_id} if folder_id else None)
    assert answer.status_code == 200, answer.text
    return answer.json()


def stamp(client, folder_id: str | None = None) -> str:
    return client.get("/api/note-list/stamp", params={"folder_id": folder_id} if folder_id else None).json()["stamp"]


# --- AC-1, AC-4, AC-5: the view per folder, on every device -------------------------------------------------------


def test_notes6_ac1_the_view_is_kept_per_folder_on_every_device(client, operator):
    house = make_folder(client, "Haushalt")
    work = make_folder(client, "Arbeit")
    answer = client.put("/api/note-list/view", json={"folder_id": house, "mode": "tiles"})
    assert answer.status_code == 200 and answer.json()["mode"] == "tiles"
    # A second device of the same account sees the same choice, the other folder and "All notes" keep theirs.
    with new_client(operator) as phone:
        assert listed(phone, house)["view"]["mode"] == "tiles"
        assert listed(phone, work)["view"]["mode"] == "list"
        assert listed(phone)["view"]["mode"] == "list"
        phone.put("/api/note-list/view", json={"mode": "tiles"})
    assert listed(client)["view"]["mode"] == "tiles"
    assert listed(client, work)["view"]["mode"] == "list"
    # Another account has a view of its own.
    other = make_account("other")
    with new_client(other) as theirs:
        assert listed(theirs)["view"]["mode"] == "list"
        assert theirs.put("/api/note-list/view", json={"folder_id": house, "mode": "list"}).status_code == 404


def test_notes6_ac4_sorting_and_direction_are_kept_per_folder(client, operator):
    house = make_folder(client, "Haushalt")
    for sort in ("updated", "created", "title"):
        for direction in ("asc", "desc"):
            saved = client.put("/api/note-list/view", json={"folder_id": house, "sort": sort, "direction": direction})
            assert saved.status_code == 200
            assert listed(client, house)["view"] | {"mode": "x", "grouped": "x"} == \
                {"mode": "x", "grouped": "x", "sort": sort, "direction": direction}
    assert listed(client)["view"]["sort"] == "updated"
    refused = client.put("/api/note-list/view", json={"folder_id": house, "sort": "colour"})
    assert refused.status_code == 422
    assert client.put("/api/note-list/view", json={"folder_id": house, "direction": "up"}).status_code == 422
    assert client.put("/api/note-list/view", json={"folder_id": str(uuid.uuid4()), "sort": "title"}).status_code == 404


def test_notes6_ac5_grouping_by_date_is_on_from_the_start_and_kept(client, operator):
    house = make_folder(client, "Haushalt")
    assert listed(client, house)["view"] == notes_list.DEFAULT_VIEW
    assert notes_list.DEFAULT_VIEW["grouped"] is True
    client.put("/api/note-list/view", json={"folder_id": house, "grouped": False})
    with new_client(operator) as phone:
        view = listed(phone, house)["view"]
    assert view["grouped"] is False and view["mode"] == "list" and view["sort"] == "updated"


def test_notes6_ac1_ac4_a_list_of_fifty_notes_comes_whole_newest_change_first(client, operator):
    house = make_folder(client, "Haushalt")
    made = [new_note(client, folder_id=house, title=f"Note {index}") for index in range(50)]
    base = utcnow() - timedelta(days=200)
    with SessionLocal() as db:
        for index, item in enumerate(made):
            row = db.get(Note, item["id"])
            assert row is not None
            row.updated_at = base + timedelta(days=4 * index)
            row.created_at = base - timedelta(days=index)
        db.commit()
    found = listed(client, house)
    assert found["counts"] == {"own": 50, "shared": 0}
    assert [item["title"] for item in found["items"]] == [f"Note {index}" for index in reversed(range(50))]
    first = found["items"][0]
    for field in ("id", "title", "preview", "created_at", "updated_at", "pinned", "color", "tasks", "folder_id"):
        assert field in first


# --- AC-6, AC-8, EC-8: pins and colors ----------------------------------------------------------------------------


def test_notes6_ac6_pinning_marks_the_note_without_changing_its_date(client, operator):
    note = new_note(client, title="Einkauf Samstag")
    before = stored(note["id"]).updated_at
    answer = client.put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
    assert answer.status_code == 200 and answer.json()["pinned"] is True
    assert stored(note["id"]).pinned_at is not None
    assert stored(note["id"]).updated_at == before
    assert listed(client)["items"][0]["pinned"] is True
    assert client.get(f"/api/notes/{note['id']}").json()["pinned"] is True
    # Pinning twice keeps the first moment; unpinning clears it.
    first = stored(note["id"]).pinned_at
    client.put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
    assert stored(note["id"]).pinned_at == first
    assert client.put(f"/api/notes/{note['id']}/pin", json={"pinned": False}).json()["pinned"] is False
    assert stored(note["id"]).pinned_at is None
    other = make_account("other")
    with new_client(other) as theirs:
        assert theirs.put(f"/api/notes/{note['id']}/pin", json={"pinned": True}).status_code == 404


def test_notes6_ac8_a_color_from_the_fixed_row(client, operator):
    note = new_note(client, title="Geschenkideen")
    answer = client.put(f"/api/notes/{note['id']}/color", json={"color": "green"})
    assert answer.status_code == 200 and answer.json()["color"] == "green"
    assert listed(client)["items"][0]["color"] == "green"
    refused = client.put(f"/api/notes/{note['id']}/color", json={"color": "#ff0000"})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "note_color_unknown"
    assert stored(note["id"]).color == "green"
    assert client.put(f"/api/notes/{note['id']}/color", json={"color": ""}).json()["color"] == ""
    other = make_account("other")
    with new_client(other) as theirs:
        assert theirs.put(f"/api/notes/{note['id']}/color", json={"color": "red"}).status_code == 404


def test_notes6_ac6_ac8_who_only_reads_a_shared_note_neither_pins_nor_colors_it(client, operator, monkeypatch):
    note = new_note(client, title="Elternabend")
    reader = make_account("reader")
    writer = make_account("writer")

    def shared(_db, account: Account, shared_note: Note):
        # Sharing (NOTES-13) answers through this docking point: one reads the note, the other writes in it.
        if shared_note.id != note["id"]:
            return None
        return {reader.id: Access.READ, writer.id: Access.WRITE}.get(account.id)

    monkeypatch.setattr(notes, "ACCESS_RULES", [shared])
    with new_client(reader) as theirs:
        # The note is there for them to read ...
        assert theirs.get(f"/api/notes/{note['id']}").status_code == 200
        # ... but neither pinned nor colored by them.
        assert theirs.put(f"/api/notes/{note['id']}/pin", json={"pinned": True}).status_code == 404
        assert theirs.put(f"/api/notes/{note['id']}/color", json={"color": "red"}).status_code == 404
    assert stored(note["id"]).pinned_at is None and stored(note["id"]).color in ("", None)
    # Who may write passes the same check (where pin and color live with sharing is NOTES-13's call).
    with new_client(writer) as theirs:
        assert theirs.put(f"/api/notes/{note['id']}/pin", json={"pinned": True}).status_code == 200
        assert theirs.put(f"/api/notes/{note['id']}/color", json={"color": "red"}).status_code == 200


def test_notes6_ec8_a_pinned_note_comes_back_pinned_from_the_trash(client, operator):
    alone = new_note(client, title="Allein")
    house = make_folder(client, "Haushalt")
    inside = new_note(client, title="Im Ordner", folder_id=house)
    for note in (alone, inside):
        client.put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
        client.put(f"/api/notes/{note['id']}/color", json={"color": "sky"})
    assert client.delete(f"/api/notes/{alone['id']}").status_code == 204
    assert client.delete(f"/api/folders/{house}").status_code in (200, 204)
    assert listed(client)["items"] == []
    assert client.post(f"/api/notes/{alone['id']}/restore").status_code == 200
    assert client.post(f"/api/folders/{house}/restore").status_code == 200
    items = {item["id"]: item for item in listed(client)["items"]}
    assert items[alone["id"]]["pinned"] is True and items[alone["id"]]["color"] == "sky"
    assert items[inside["id"]]["pinned"] is True and items[inside["id"]]["color"] == "sky"


def test_notes6_ec8_a_pinned_note_comes_back_pinned_through_the_trash_page(client, operator):
    house = make_folder(client, "Haushalt")
    first = new_note(client, title="Müllabfuhr", folder_id=house)
    loose = new_note(client, title="Einkauf", folder_id=house)
    cellar = make_folder(client, "Keller")
    deep = new_note(client, title="Vorräte", folder_id=cellar)
    for note in (first, deep):
        assert client.put(f"/api/notes/{note['id']}/pin", json={"pinned": True}).status_code == 200
    client.put(f"/api/notes/{first['id']}/color", json={"color": "red"})
    moments = {note["id"]: stored(note["id"]).pinned_at for note in (first, deep)}
    # Deleted alone, and deleted with its folder.
    assert client.delete(f"/api/notes/{first['id']}").status_code == 204
    assert client.delete(f"/api/folders/{cellar}").status_code in (200, 204)
    assert [item["id"] for item in listed(client, house)["items"]] == [loose["id"]]
    before = stamp(client, house)
    trashed = {item["id"] for item in client.get("/api/trash").json()["items"]}
    assert first["id"] in trashed and cellar in trashed
    # Back the way the trash page brings them.
    assert client.post(f"/api/trash/notes/{first['id']}/restore").status_code == 200
    assert client.post(f"/api/trash/folders/{cellar}/restore").status_code == 200
    # An open list sees it come back, pinned as before, with its color and the same moment of pinning.
    assert stamp(client, house) != before
    items = {item["id"]: item for item in listed(client, house)["items"]}
    assert items[first["id"]]["pinned"] is True and items[first["id"]]["color"] == "red"
    assert items[loose["id"]]["pinned"] is False
    assert listed(client, cellar)["items"][0]["pinned"] is True
    assert {note_id: stored(note_id).pinned_at for note_id in moments} == moments


# --- AC-7: all notes, own and shared ------------------------------------------------------------------------------


def test_notes6_ac7_all_notes_shows_own_and_shared_with_both_counts(client, operator, monkeypatch):
    house = make_folder(client, "Haushalt")
    new_note(client, title="Eins")
    new_note(client, title="Zwei", folder_id=house)
    lena = make_account("lena")
    with new_client(lena) as theirs:
        shared = new_note(theirs, title="Elternabend Notizen")
        gone = new_note(theirs, title="Gelöscht")
        private = new_note(theirs, title="Nur für Lena")
        theirs.delete(f"/api/notes/{gone['id']}")

    def shared_with(_db, account: Account) -> list[str]:
        # Sharing names its notes; one of them deleted, and one of the account's own named by mistake.
        own = [note.id for note in _db.query(Note).filter_by(owner_id=account.id)]
        return [shared["id"], gone["id"], *own] if account.id == operator.id else []

    monkeypatch.setattr(notes_list, "SHARED_NOTES", [shared_with])
    found = listed(client)
    assert found["counts"] == {"own": 2, "shared": 1}
    ids = [item["id"] for item in found["items"]]
    assert shared["id"] in ids and private["id"] not in ids and gone["id"] not in ids and len(ids) == 3
    theirs_item = next(item for item in found["items"] if item["id"] == shared["id"])
    assert theirs_item["owner"] == {"id": lena.id, "name": lena.shown_name}
    assert all("owner" not in item for item in found["items"] if item["id"] != shared["id"])
    # A folder shows its own notes only.
    in_house = listed(client, house)
    assert in_house["counts"] == {"own": 1, "shared": 0} and [item["title"] for item in in_house["items"]] == ["Zwei"]
    # Without any sharing, "All notes" is the account's own.
    monkeypatch.setattr(notes_list, "SHARED_NOTES", [])
    assert listed(client)["counts"] == {"own": 2, "shared": 0}


def test_notes6_ac2_further_fields_come_through_the_extras(client, operator, monkeypatch):
    note = new_note(client, title="Handwerker Bad", markdown="Fliesenleger kommt Montag")
    asked: list[int] = []

    def tags(_db, _account, rows):
        asked.append(len(rows))
        return {row.id: {"tags": ["bad"], "shared": {"count": 1, "names": ["Anna"]}} for row in rows}

    monkeypatch.setattr(notes_list, "ITEM_EXTRAS", [tags])
    item = listed(client)["items"][0]
    assert item["tags"] == ["bad"] and item["shared"] == {"count": 1, "names": ["Anna"]}
    assert item["id"] == note["id"] and item["preview"] == "Fliesenleger kommt Montag"
    assert asked == [1]  # once per list, not once per note


# --- AC-3: checklist progress -------------------------------------------------------------------------------------


def test_notes6_ac3_checklists_count_and_follow_the_editor(client, operator):
    note = new_note(client, title="Einkauf", markdown="- [x] Milch\n- [ ] Brot\n- [ ] Tomaten\n  - [x] rote")
    assert listed(client)["items"][0]["tasks"] == {"done": 2, "total": 4}
    plain = new_note(client, title="Ohne Liste", markdown="Nur Text")
    assert next(item for item in listed(client)["items"] if item["id"] == plain["id"])["tasks"] is None
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    assert edit.toggle_task(live.doc, 1, True)
    edit.append_task(live.doc, "Spülmittel")

    def progress():
        item = next(item for item in listed(client)["items"] if item["id"] == note["id"])
        return item["tasks"]

    assert wait_for(lambda: progress() == {"done": 3, "total": 5}, timeout=5.0), progress()
    live.close()


def test_notes6_ac3_notes_from_before_are_counted_once(client, operator):
    note = new_note(client, title="Alt", markdown="- [x] eins\n- [ ] zwei")
    with SessionLocal() as db:
        row = db.get(Note, note["id"])
        assert row is not None
        row.tasks_done = row.tasks_total = None
        db.commit()
        assert notes_list.count_missing(db) >= 1
        assert notes_list.count_missing(db) == 0
    assert stored(note["id"]).tasks_done == 1 and stored(note["id"]).tasks_total == 2


# --- EC-2: 10,000 notes ---------------------------------------------------------------------------------------------


def test_notes6_ec2_ten_thousand_notes_load_in_under_a_second(client, operator):
    with SessionLocal() as db:
        inbox = inbox_for(db, operator.id).id
        db.commit()
        now = utcnow()
        rows = [
            {"id": str(uuid.uuid4()), "owner_id": operator.id, "folder_id": inbox, "title": f"Notiz {index}",
             "text": f"Zeile eins der Notiz {index}\nZweite Zeile mit etwas mehr Text " * 3, "ydoc": b"x" * 2000,
             "created_at": now - timedelta(minutes=index), "updated_at": now - timedelta(minutes=index),
             "tasks_done": 1, "tasks_total": 3 if index % 4 == 0 else 0, "listed_at": now, "color": "",
             "title_check": False, "origin": ""}
            for index in range(10_000)
        ]
        db.execute(insert(Note), rows)
        db.commit()
    started = time.perf_counter()
    found = listed(client)
    took = time.perf_counter() - started
    assert found["counts"]["own"] == 10_000 and len(found["items"]) == 10_000
    assert took < 1.0, f"{took:.2f} s"
    started = time.perf_counter()
    stamp(client)
    assert time.perf_counter() - started < 0.2


# --- EC-3, EC-5 -----------------------------------------------------------------------------------------------------


def test_notes6_ec3_a_locked_note_gives_its_title_and_lock_only(client, operator, monkeypatch):
    secret = new_note(client, title="WLAN-Gäste und Codes", markdown="- [ ] Passwort: geheim #wlan")
    open_note = new_note(client, title="Offen", markdown="Sichtbar")
    monkeypatch.setattr(notes_list, "LOCK_CHECKS", [lambda _db, rows: [row.id for row in rows if row.id == secret["id"]]])
    monkeypatch.setattr(notes_list, "ITEM_EXTRAS", [
        notes_list.tags_of,
        lambda _db, _account, rows: {row.id: {"media": {"kind": "image", "count": 2}} for row in rows},
    ])
    items = {item["id"]: item for item in listed(client)["items"]}
    locked = items[secret["id"]]
    assert locked["locked"] is True and locked["title"] == "WLAN-Gäste und Codes"
    assert locked["preview"] == "" and locked["tasks"] is None
    assert "tags" not in locked and "media" not in locked
    assert "geheim" not in client.get("/api/note-list").text
    assert items[open_note["id"]]["preview"] == "Sichtbar" and "locked" not in items[open_note["id"]]


def test_notes6_ec5_html_and_script_come_as_plain_text(client, operator):
    title = '<script>alert("x")</script><b>Fett</b>'
    new_note(client, title=title, markdown='<img src=x onerror="alert(1)"> & <i>kursiv</i>')
    answer = client.get("/api/note-list")
    assert answer.headers["content-type"].startswith("application/json")
    item = answer.json()["items"][0]
    assert item["title"] == title
    assert item["preview"] == '<img src=x onerror="alert(1)"> & <i>kursiv</i>'


# --- EC-6: changes from another device ------------------------------------------------------------------------------


def test_notes6_ec6_the_stamp_follows_changes_from_another_session(client, operator):
    house = make_folder(client, "Haushalt")
    note = new_note(client, title="Handwerker Bad", folder_id=house)
    first_all, first_house = stamp(client), stamp(client, house)
    assert stamp(client) == first_all  # nothing changed, nothing to load
    with new_client(operator) as phone:
        live = Live(phone, note["id"], token_for(operator))
        assert live.pump(lambda: live.synced)
        edit.append_paragraph(live.doc, "Fliesenleger kommt Montag")
        assert wait_for(lambda: "Fliesenleger" in listed(client, house)["items"][0]["preview"], timeout=4.0)
        live.close()
        after_text = stamp(client, house)
        assert after_text != first_house and stamp(client) != first_all
        # Pinning and coloring change nothing but what a list shows: the stamp moves all the same.
        phone.put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
        after_pin = stamp(client, house)
        assert after_pin != after_text
        phone.put(f"/api/notes/{note['id']}/color", json={"color": "red"})
        assert stamp(client, house) != after_pin
        # Moved away on the phone: the folder's stamp moves.
        before_move = stamp(client, house)
        moved = phone.post("/api/folders/move", json={"note_ids": [note["id"]], "folder_ids": [],
                                                   "target_id": inbox_id(operator)})
        assert moved.status_code == 200, moved.text
        assert stamp(client, house) != before_move
    assert client.get("/api/note-list/stamp", params={"folder_id": str(uuid.uuid4())}).status_code == 404


def inbox_id(account: Account) -> str:
    with SessionLocal() as db:
        found = inbox_for(db, account.id).id
        db.commit()
        return found


def test_notes6_ac2_a_list_item_carries_what_get_notes_gives(client, operator):
    """The list reads its columns itself (EC-2); it must not fall behind ``GET /api/notes``: a field added there (a tag,
    a mark) belongs in the list too."""
    note = new_note(client, title="Einkauf", markdown="- [x] Milch\n- [ ] Brot")
    client.put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
    client.put(f"/api/notes/{note['id']}/color", json={"color": "teal"})
    plain = client.get("/api/notes").json()[0]
    item = listed(client)["items"][0]
    for key in ("created_at", "updated_at"):
        assert datetime.fromisoformat(item.pop(key)) == datetime.fromisoformat(plain.pop(key))
    assert {key: item[key] for key in plain} == plain


def test_notes6_ac2_the_tags_of_a_note_come_with_the_list(client, operator):
    tagged = new_note(client, title="Handwerker Bad", markdown="Fliesenleger kommt Montag #bad #Haus")
    plain = new_note(client, title="Ohne", markdown="Nichts")
    items = {item["id"]: item for item in listed(client)["items"]}
    assert sorted(items[tagged["id"]]["tags"], key=str.lower) == ["bad", "Haus"]
    assert items[plain["id"]]["tags"] == []
    in_inbox = {item["id"]: item for item in listed(client, inbox_id(operator))["items"]}
    assert in_inbox[tagged["id"]]["tags"] == items[tagged["id"]]["tags"]
