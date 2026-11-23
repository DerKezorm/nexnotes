"""How every list of notes of an account looks (list, cards, compact, tiles; hints on or off): one choice of the
account, kept on the server for every device and every list, instead of rows or tiles per folder. Folder views from
before that kept tiles become lists; the gallery of a smart folder stays that folder's own."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, NoteListView
from app.services import notes, notes_list

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note
from .test_notes7 import attach


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


def look(client) -> tuple[str, bool]:
    me = client.get("/api/auth/me").json()
    return me["list_style"], me["list_hints"]


def test_list_look_starts_as_a_list_with_hints(client, operator):
    assert look(client) == ("list", True)
    assert notes_list.DEFAULT_LOOK == {"style": "list", "hints": True, "hint_kinds": {"checklist": True, "attachments": True, "tags": True}}


def test_list_look_is_kept_for_the_account_on_every_device(client, operator):
    for style in ("cards", "compact", "tiles", "list"):
        answer = client.put("/api/me/list-look", json={"style": style})
        assert answer.status_code == 200, answer.text
        assert answer.json()["list_style"] == style and answer.json()["list_hints"] is True
    client.put("/api/me/list-look", json={"style": "compact"})
    # Only what is given changes: the hints alone leave the style.
    answer = client.put("/api/me/list-look", json={"hints": False})
    assert (answer.json()["list_style"], answer.json()["list_hints"]) == ("compact", False)
    with new_client(operator) as phone:
        assert look(phone) == ("compact", False)
        phone.put("/api/me/list-look", json={"style": "tiles", "hints": True})
    assert look(client) == ("tiles", True)
    # Every list says the same: the folders' views carry no look of their own.
    folder = client.post("/api/folders", json={"name": "Haushalt"}).json()["id"]
    assert client.get("/api/note-list", params={"folder_id": folder}).json()["view"]["mode"] == "list"
    # Another account keeps its own.
    with new_client(make_account("other-look")) as theirs:
        assert look(theirs) == ("list", True)


def test_list_look_refuses_unknown_values_with_422(client, operator):
    client.put("/api/me/list-look", json={"style": "cards"})
    refused = client.put("/api/me/list-look", json={"style": "grid"})
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "list_style_unknown"
    for body in ({"style": "x" * 40}, {"style": 3}, {"hints": "yes"}, {"hints": 1}):
        assert client.put("/api/me/list-look", json=body).status_code == 422, body
    # Nothing of a refused change was kept.
    assert look(client) == ("cards", True)
    # A stored value the server does not know (written by hand) reads as the default.
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.preferences = {**(row.preferences or {}), "list_style": "grid", "list_hints": "yes"}
        db.commit()
    assert look(client) == ("list", True)


def test_list_look_folder_views_as_tiles_from_before_become_lists(client, operator):
    """Who had tiles in a folder before: the account's look is "list", the folder's ``mode`` is not read any more,
    except a smart folder's gallery."""
    folder = client.post("/api/folders", json={"name": "Rezepte"}).json()["id"]
    gallery_key = "s:gallery-folder"
    with SessionLocal() as db:
        db.add(NoteListView(account_id=operator.id, key=folder, mode="tiles", sort="title", direction="asc",
                            grouped=False))
        db.add(NoteListView(account_id=operator.id, key="all", mode="tiles"))
        db.add(NoteListView(account_id=operator.id, key=gallery_key, mode="gallery"))
        db.commit()
    # Read before the start's clean-up: tiles kept per folder show as the list, the sort stays.
    view = client.get("/api/note-list", params={"folder_id": folder}).json()["view"]
    assert view == {"mode": "list", "sort": "title", "direction": "asc", "grouped": False}
    assert client.get("/api/note-list").json()["view"]["mode"] == "list"
    with SessionLocal() as db:
        assert notes_list.forget_tile_modes(db) == 2
        assert notes_list.forget_tile_modes(db) == 0
        modes = {row.key: row.mode for row in db.scalars(select(NoteListView)
                                                         .where(NoteListView.account_id == operator.id))}
    assert modes == {folder: "list", "all": "list", gallery_key: "gallery"}
    with SessionLocal() as db:
        assert notes_list.view_of(db, operator, gallery_key)["mode"] == "gallery"
    assert look(client) == ("list", True)
    # The sort of the folder survived the clean-up.
    assert client.get("/api/note-list", params={"folder_id": folder}).json()["view"]["sort"] == "title"


def test_list_look_hints_the_list_carries_how_many_attachments_a_note_has(client, operator):
    """The hint "attachments" needs the count of every kind (not only pictures), for the whole list in one go; a
    locked note gives none."""
    photos = new_note(client, title="Urlaub")["id"]
    attach(photos, "image")
    attach(photos, "pdf")
    attach(photos, "file")
    papers = new_note(client, title="Vertrag")["id"]
    attach(papers, "pdf")
    bare = new_note(client, title="Ohne")["id"]
    locked = new_note(client, title="Gesperrt")["id"]
    attach(locked, "file")
    with SessionLocal() as db:
        from app.models import Note

        row = db.get(Note, locked)
        assert row is not None
        row.locked = True
        db.commit()
    items = {item["id"]: item for item in client.get("/api/note-list").json()["items"]}
    assert items[photos]["attachments"] == 3
    assert items[photos]["media"]["kind"] == "image" and items[photos]["media"]["count"] == 1
    assert items[papers]["attachments"] == 1 and "media" not in items[papers]
    assert "attachments" not in items[bare]
    assert "attachments" not in items[locked]


# --- The hints kind by kind (NOTES-6, NOTESIOS-6 AC-1) -------------------------------------------------------------


def kinds(client) -> dict[str, bool]:
    return client.get("/api/auth/me").json()["list_hint_kinds"]


def test_notes6_notesios6_ac1_hints_switch_kind_by_kind_and_the_old_switch_still_counts(client, operator):
    """Checklists, attachments and tags each on or off for the account; ``hints`` stays the one switch older apps and
    browsers read (on while any kind shows) and send (all three at once)."""
    assert kinds(client) == {"checklist": True, "attachments": True, "tags": True}
    answer = client.put("/api/me/list-look", json={"hint_kinds": {"tags": False}})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["list_hint_kinds"] == {"checklist": True, "attachments": True, "tags": False}
    assert body["list_hints"] is True, "on while a kind shows"
    # Only the kinds named change; the style stays.
    client.put("/api/me/list-look", json={"style": "cards", "hint_kinds": {"checklist": False}})
    assert kinds(client) == {"checklist": False, "attachments": True, "tags": False}
    assert look(client) == ("cards", True)
    client.put("/api/me/list-look", json={"hint_kinds": {"attachments": False}})
    assert look(client) == ("cards", False), "the last kind off: off for older readers too"
    # An older browser or app sends the one switch: all three follow.
    client.put("/api/me/list-look", json={"hints": True})
    assert kinds(client) == {"checklist": True, "attachments": True, "tags": True}
    # Both at once: the switch first, then the kinds named.
    client.put("/api/me/list-look", json={"hints": False, "hint_kinds": {"tags": True}})
    assert kinds(client) == {"checklist": False, "attachments": False, "tags": True}
    # Unknown kinds and values that are no booleans are refused, nothing changes.
    for body in ({"hint_kinds": {"pictures": True}}, {"hint_kinds": {"tags": "no"}}, {"hint_kinds": True}):
        assert client.put("/api/me/list-look", json=body).status_code == 422, body
    assert kinds(client) == {"checklist": False, "attachments": False, "tags": True}
    # Another account keeps its own.
    with new_client(make_account("other-kinds")) as theirs:
        assert kinds(theirs) == {"checklist": True, "attachments": True, "tags": True}


def test_notes6_notesios6_ac1_accounts_with_the_old_switch_keep_it_as_three_kinds(client, operator):
    """An account that kept ``list_hints`` as one switch: it reads as all three kinds at once, and the start turns it
    into the three kinds; a stored kind the server does not know reads as on."""
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.preferences = {**(row.preferences or {}), "list_hints": False}
        db.commit()
    assert kinds(client) == {"checklist": False, "attachments": False, "tags": False}
    assert look(client) == ("list", False)
    with SessionLocal() as db:
        assert notes_list.spread_hint_switches(db) == 1
        assert notes_list.spread_hint_switches(db) == 0
        row = db.get(Account, operator.id)
        assert row is not None
        assert row.preferences["list_hints"] == {"checklist": False, "attachments": False, "tags": False}
        row.preferences = {**row.preferences, "list_hints": {"checklist": False, "tags": "yes"}}
        db.commit()
    assert kinds(client) == {"checklist": False, "attachments": True, "tags": True}
