"""NOTES-13 Teilen: notes and folders shared with members, "Mit mir geteilt", no passing on, the trash of the owner.

Three accounts throughout: the operator ``tester`` owns, Anna and Lena are members it shares with. The read links have
their own file (``test_notes13_link.py``); what earlier features waited for is in ``test_notes13_earlier.py``.
"""

from __future__ import annotations

import io
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Note
from app.models_shares import Share, SharePin
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.services import accounts, attachments, notes, shares

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored, stored_doc, token_for, wait_for


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


@pytest.fixture
def anna() -> Account:
    return make_account("anna")


@pytest.fixture
def lena() -> Account:
    return make_account("lena")


@pytest.fixture
def as_anna(anna: Account) -> Iterator[TestClient]:
    with new_client(anna) as client:
        yield client
        # Its live connections end before the client does, or leaving it would wait for them.
        Live.close_all()


@pytest.fixture
def as_lena(lena: Account) -> Iterator[TestClient]:
    with new_client(lena) as client:
        yield client
        # Its live connections end before the client does, or leaving it would wait for them.
        Live.close_all()


def share(client: TestClient, kind: str, item_id: str, person: Account, level: str = "read") -> dict:
    answer = client.put(f"/api/shares/{kind}/{item_id}/people/{person.id}", json={"level": level})
    assert answer.status_code == 200, answer.text
    return answer.json()


def unshare(client: TestClient, kind: str, item_id: str, person: Account) -> dict:
    answer = client.delete(f"/api/shares/{kind}/{item_id}/people/{person.id}")
    assert answer.status_code == 200, answer.text
    return answer.json()


def make_folder(client: TestClient, name: str, parent: str | None = None) -> str:
    answer = client.post("/api/folders", json={"name": name, "parent_id": parent})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def all_notes(client: TestClient, folder_id: str | None = None) -> dict:
    answer = client.get("/api/note-list", params={"folder_id": folder_id} if folder_id else {})
    assert answer.status_code == 200, answer.text
    return answer.json()


def titles(listing: dict) -> list[str]:
    return sorted(item["title"] for item in listing["items"])


def with_me(client: TestClient) -> dict:
    answer = client.get("/api/shares/with-me")
    assert answer.status_code == 200, answer.text
    return answer.json()


def can_write(client: TestClient, note_id: str) -> bool:
    return client.put(f"/api/notes/{note_id}/paper", json={"paper": "blank"}).status_code == 200


def png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (24, 24), (200, 40, 40)).save(out, "PNG")
    return out.getvalue()


# --- AC-1: sharing with members of the server -------------------------------------------------------------------------


def test_notes13_ac1_the_owner_finds_members_by_name_or_address_and_gives_read_or_write(client, operator, anna, lena):
    found = client.get("/api/shares/people", params={"q": "ANN"}).json()
    assert [person["name"] for person in found] == ["Anna"]
    assert client.get("/api/shares/people", params={"q": "lena@example"}).json()[0]["id"] == lena.id
    # Never oneself, nothing for a single letter (the list of members is not handed out whole).
    assert client.get("/api/shares/people", params={"q": "tester"}).json() == []
    assert client.get("/api/shares/people", params={"q": "a"}).json() == []
    # Nobody blocked.
    with SessionLocal() as db:
        accounts.block(db, db.get(Account, lena.id))
    assert client.get("/api/shares/people", params={"q": "lena"}).json() == []
    with SessionLocal() as db:
        row = db.get(Account, lena.id)
        row.blocked_at = None
        db.commit()

    note = new_note(client, title="Linsensuppe")
    share(client, "note", note["id"], anna, "write")
    dialog = share(client, "note", note["id"], lena, "read")
    assert [(person["name"], person["level"]) for person in dialog["people"]] == [("Anna", "write"), ("Lena", "read")]
    assert dialog["title"] == "Linsensuppe"
    # A right that is neither: refused.
    answer = client.put(f"/api/shares/note/{note['id']}/people/{anna.id}", json={"level": "admin"})
    assert answer.status_code == 422


# --- AC-2, EC-1: a shared folder takes everything in it ------------------------------------------------------------


def test_notes13_ac2_notes_and_subfolders_made_in_a_shared_folder_are_shared_with_the_same_right(
        client, operator, anna, lena, as_anna, as_lena):
    family = make_folder(client, "Familie")
    share(client, "folder", family, anna, "write")
    share(client, "folder", family, lena, "read")
    later = new_note(client, title="Einkauf", folder_id=family)
    deeper = make_folder(client, "Urlaub", family)
    deep = new_note(client, title="Packliste", folder_id=deeper)
    for note in (later, deep):
        assert as_anna.get(f"/api/notes/{note['id']}").status_code == 200
        assert as_lena.get(f"/api/notes/{note['id']}").status_code == 200
        assert can_write(as_anna, note["id"])
        assert not can_write(as_lena, note["id"])
    # The shared folder lists its notes for the members, its subfolders are named.
    assert titles(all_notes(as_lena, family)) == ["Einkauf"]
    assert [folder["name"] for folder in as_lena.get(f"/api/shared-folders/{family}").json()["folders"]] == ["Urlaub"]
    assert titles(all_notes(as_lena, deeper)) == ["Packliste"]
    # A writer makes a note in the folder: it belongs to the owner and everyone sees it.
    made = as_anna.post("/api/notes", json={"title": "Von Anna", "folder_id": family})
    assert made.status_code == 201, made.text
    assert stored(made.json()["id"]).owner_id == operator.id
    assert "Von Anna" in titles(all_notes(client, family))
    assert as_lena.get(f"/api/notes/{made.json()['id']}").status_code == 200
    # A reader makes none.
    assert as_lena.post("/api/notes", json={"title": "Von Lena", "folder_id": family}).status_code == 404


def test_notes13_ec1_a_shared_folder_moved_into_one_not_shared_stays_shared(client, operator, anna, as_anna):
    family = make_folder(client, "Familie")
    other = make_folder(client, "Privat")
    note = new_note(client, title="Einkauf", folder_id=family)
    share(client, "folder", family, anna, "read")
    moved = client.post("/api/folders/move", json={"target_id": other, "folder_ids": [family]})
    assert moved.status_code == 200, moved.text
    assert as_anna.get(f"/api/notes/{note['id']}").status_code == 200
    assert [item["title"] for group in with_me(as_anna)["groups"] for item in group["items"]] == ["Familie"]


# --- AC-3: "Mit mir geteilt" and "Alle Notizen" -------------------------------------------------------------------------


def test_notes13_ac3_what_was_shared_shows_by_owner_with_the_right_and_in_all_notes(client, operator, anna, lena,
                                                                                     as_anna, as_lena):
    mine = new_note(as_lena, title="Lenas eigene")
    recipe = new_note(client, title="Geburtstagsliste")
    family = make_folder(client, "Familienurlaub 2027")
    new_note(client, title="Hotel", folder_id=family)
    new_note(client, title="Flug", folder_id=family)
    share(client, "note", recipe["id"], lena, "read")
    share(client, "folder", family, lena, "write")
    grill = new_note(as_anna, title="Grillabend Zutaten")
    share(as_anna, "note", grill["id"], lena, "write")

    listing = with_me(as_lena)
    assert [group["owner"]["name"] for group in listing["groups"]] == ["Anna", "Tester"]
    tester = listing["groups"][1]["items"]
    assert [(item["kind"], item["title"], item["level"]) for item in tester] == [
        ("folder", "Familienurlaub 2027", "write"), ("note", "Geburtstagsliste", "read")]
    assert tester[0]["notes"] == 2
    assert listing["count"] == 3
    # "Alle Notizen": own and shared, with both counts and the owner of each shared one.
    everything = all_notes(as_lena)
    assert everything["counts"] == {"own": 1, "shared": 4}
    assert titles(everything) == sorted(["Lenas eigene", "Geburtstagsliste", "Hotel", "Flug", "Grillabend Zutaten"])
    owners = {item["title"]: item.get("owner", {}).get("name") for item in everything["items"]}
    assert owners["Hotel"] == "Tester" and owners["Grillabend Zutaten"] == "Anna" and owners["Lenas eigene"] is None
    assert mine["id"] in {item["id"] for item in everything["items"]}


# --- AC-4: reading only ----------------------------------------------------------------------------------------------


def test_notes13_ac4_a_reader_reads_searches_copies_and_exports_but_changes_nothing(client, operator, lena, as_lena):
    note = new_note(client, title="Rezept", markdown="250 g rote Linsen")
    share(client, "note", note["id"], lena, "read")
    head = as_lena.get(f"/api/notes/{note['id']}").json()
    assert head["can_write"] is False and head["level"] == "read" and head["can_share"] is False
    found = as_lena.get("/api/search", params={"q": "linsen"}).json()
    assert [hit["id"] for hit in found["items"]] == [note["id"]]
    copy = as_lena.post(f"/api/notes/{note['id']}/duplicate")
    assert copy.status_code == 201
    assert stored(copy.json()["id"]).owner_id == lena.id
    assert as_lena.get(f"/api/export/notes/{note['id']}/markdown").status_code == 200
    # Nothing changes: title, symbol, paper, color, deleting, attaching.
    assert as_lena.put(f"/api/notes/{note['id']}/title", json={"title": "Meins"}).status_code == 404
    assert as_lena.put(f"/api/notes/{note['id']}/icon", json={"icon": ""}).status_code == 404
    assert as_lena.put(f"/api/notes/{note['id']}/paper", json={"paper": "grid"}).status_code == 404
    assert as_lena.put(f"/api/notes/{note['id']}/color", json={"color": ""}).status_code == 404
    assert as_lena.delete(f"/api/notes/{note['id']}").status_code == 404
    assert as_lena.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(), "name": "a.png"},
                        content=png()).status_code == 404
    assert stored(note["id"]).title == "Rezept"
    # Live: the reader gets the text, its own changes are not kept.
    reader = Live(as_lena, note["id"], token_for(lena))
    assert reader.pump(lambda: reader.synced)
    assert "rote Linsen" in reader.text
    edit.append_paragraph(reader.doc, "von Lena")
    reader.settle(0.3)
    assert "von Lena" not in to_plain(stored_doc(note["id"]))


# --- AC-5: taken back or changed while open ---------------------------------------------------------------------------


def test_notes13_ac5_taking_back_or_lowering_a_right_counts_at_once_and_says_who(client, operator, anna, as_anna):
    note = new_note(client, title="Elternabend Notizen", markdown="Tagesordnung")
    share(client, "note", note["id"], anna, "write")
    writer = Live(as_anna, note["id"], token_for(anna))
    assert writer.pump(lambda: writer.synced)
    # Writing becomes reading: the connection closes with 4409 and comes back as a reader.
    share(client, "note", note["id"], anna, "read")
    assert writer.pump(lambda: writer.closed is not None)
    assert writer.closed == 4409
    reader = Live(as_anna, note["id"], token_for(anna))
    assert reader.pump(lambda: reader.synced)
    # Taken back: closed with 4403, nothing more of it reachable, and "Mit mir geteilt" says so.
    unshare(client, "note", note["id"], anna)
    assert reader.pump(lambda: reader.closed is not None)
    assert reader.closed == 4403
    assert as_anna.get(f"/api/notes/{note['id']}").status_code == 404
    notices = with_me(as_anna)["notices"]
    assert [(notice["title"], notice["owner"], notice["reason"]) for notice in notices] == [
        ("Elternabend Notizen", "Tester", "ended")]
    assert as_anna.delete(f"/api/shares/notices/{notices[0]['id']}").status_code == 204
    assert with_me(as_anna)["notices"] == []


# --- AC-6: leaving --------------------------------------------------------------------------------------------------


def test_notes13_ac6_leaving_takes_it_away_for_the_member_and_keeps_everything_for_the_owner(
        client, operator, anna, lena, as_anna, as_lena):
    family = make_folder(client, "Schule")
    inside = new_note(client, title="Zeugnis", folder_id=family)
    share(client, "folder", family, anna, "read")
    share(client, "folder", family, lena, "read")
    assert as_anna.put(f"/api/notes/{inside['id']}/pin", json={"pinned": True}).status_code == 200
    assert as_anna.delete(f"/api/shares/with-me/folder/{family}").status_code == 204
    assert as_anna.get(f"/api/notes/{inside['id']}").status_code == 404
    assert with_me(as_anna)["groups"] == [] and with_me(as_anna)["notices"] == []
    assert titles(all_notes(as_anna)) == []
    with SessionLocal() as db:
        assert db.scalar(select(SharePin).where(SharePin.account_id == anna.id)) is None
    # The owner keeps all, Lena still has it.
    assert titles(all_notes(client, family)) == ["Zeugnis"]
    assert as_lena.get(f"/api/notes/{inside['id']}").status_code == 200
    assert [person["name"] for person in client.get(f"/api/shares/folder/{family}").json()["people"]] == ["Lena"]
    # Leaving twice, or what was never shared: not found.
    assert as_anna.delete(f"/api/shares/with-me/folder/{family}").status_code == 404


# --- AC-7: the shared mark ------------------------------------------------------------------------------------------


def test_notes13_ac7_the_mark_says_with_whom_for_the_owner_and_from_whom_for_the_member(
        client, operator, anna, lena, as_lena):
    family = make_folder(client, "Familie")
    through_folder = new_note(client, title="Im Ordner", folder_id=family)
    alone = new_note(client, title="Allein")
    private = new_note(client, title="Privat")
    share(client, "folder", family, lena, "read")
    share(client, "note", through_folder["id"], anna, "write")
    share(client, "note", alone["id"], anna, "read")
    items = {item["title"]: item for item in all_notes(client)["items"]}
    assert items["Im Ordner"]["shared"] == {"names": ["Anna", "Lena"]}
    assert items["Allein"]["shared"] == {"names": ["Anna"]}
    assert "shared" not in items["Privat"]
    head = client.get(f"/api/notes/{through_folder['id']}").json()
    assert head["shared_with"] == ["Anna", "Lena"] and head["can_share"] is True
    assert client.get(f"/api/notes/{private['id']}").json()["shared_with"] == []
    # The member sees whose it is.
    theirs = {item["title"]: item for item in all_notes(as_lena)["items"]}
    assert theirs["Im Ordner"]["owner"]["name"] == "Tester"
    assert as_lena.get(f"/api/notes/{through_folder['id']}").json()["owner"]["name"] == "Tester"


# --- AC-8: a writer deletes ---------------------------------------------------------------------------------------------


def test_notes13_ac8_a_writer_deletes_into_the_owners_trash_with_their_name(client, operator, anna, as_anna):
    note = new_note(client, title="Grillabend")
    share(client, "note", note["id"], anna, "write")
    assert as_anna.delete(f"/api/notes/{note['id']}").status_code == 204
    items = client.get("/api/trash").json()["items"]
    assert [(item["title"], item["deleted_by"]["name"]) for item in items] == [("Grillabend", "Anna")]
    assert as_anna.get("/api/trash").json()["items"] == []
    # "Rückgängig" right after works for the one who deleted it.
    assert as_anna.post(f"/api/notes/{note['id']}/restore").status_code == 200
    assert stored(note["id"]).deleted_at is None and stored(note["id"]).deleted_by_id is None
    # The owner deleting it names nobody.
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert client.get("/api/trash").json()["items"][0]["deleted_by"] is None


# --- AC-11: no passing on ---------------------------------------------------------------------------------------------


def test_notes13_ac11_a_member_cannot_pass_on_what_was_shared_not_even_to_write(client, operator, anna, lena, as_anna):
    note = new_note(client, title="Gemeinsam")
    family = make_folder(client, "Familie")
    share(client, "note", note["id"], anna, "write")
    share(client, "folder", family, anna, "write")
    assert as_anna.get(f"/api/notes/{note['id']}").json()["can_share"] is False
    assert as_anna.get(f"/api/shares/note/{note['id']}").status_code == 404
    assert as_anna.put(f"/api/shares/note/{note['id']}/people/{lena.id}", json={"level": "read"}).status_code == 404
    assert as_anna.put(f"/api/shares/folder/{family}/people/{lena.id}", json={"level": "read"}).status_code == 404
    assert as_anna.delete(f"/api/shares/note/{note['id']}/people/{anna.id}").status_code == 404
    tomorrow = "2099-01-01"
    assert as_anna.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": tomorrow}).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(Share).where(Share.account_id == lena.id)) is None


# --- EC-2: moving out of a shared folder asks ------------------------------------------------------------------------


def test_notes13_ec2_moving_a_note_out_of_a_shared_folder_is_asked_about(client, operator, anna, lena):
    family = make_folder(client, "Familie")
    also = make_folder(client, "Auch geteilt")
    note = new_note(client, title="Einkauf", folder_id=family)
    alone = new_note(client, title="Allein")
    share(client, "folder", family, anna, "write")
    share(client, "folder", family, lena, "read")
    share(client, "folder", also, anna, "read")
    asked = client.post("/api/shares/move-check", json={"note_ids": [note["id"], alone["id"]], "target_id": None})
    assert asked.json()["notes"] == [{"id": note["id"], "title": "Einkauf", "people": ["Anna", "Lena"]}]
    # Into a folder shared with Anna only: Lena would lose it.
    partly = client.post("/api/shares/move-check", json={"note_ids": [note["id"]], "target_id": also}).json()
    assert partly["notes"][0]["people"] == ["Lena"]
    # Within the shared folder: nothing to ask.
    deeper = make_folder(client, "Tiefer", family)
    assert client.post("/api/shares/move-check",
                       json={"note_ids": [note["id"]], "target_id": deeper}).json()["notes"] == []


# --- EC-3: locked notes -----------------------------------------------------------------------------------------------


def test_notes13_ec3_a_locked_note_is_not_shared_and_a_shared_note_is_not_locked(client, operator, anna, as_anna):
    """With the real vault (NOTES-16): the device locks, encrypts and the server refuses what EC-3 refuses."""
    from .test_notes16 import VAULT_PASSWORD
    from .vault_client import Device

    device = Device(client, operator.id)
    device.setup(VAULT_PASSWORD)
    secret = new_note(client, title="Geheim")
    device.lock(secret["id"])
    refused = client.put(f"/api/shares/note/{secret['id']}/people/{anna.id}", json={"level": "read"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "share_locked"
    link = client.post(f"/api/notes/{secret['id']}/read-link", json={"expires_on": "2099-01-01"})
    assert link.status_code == 409 and link.json()["detail"]["code"] == "share_locked"
    shared = new_note(client, title="Geteilt")
    share(client, "note", shared["id"], anna, "read")
    family = make_folder(client, "Familie")
    in_folder = new_note(client, title="Im Ordner", folder_id=family)
    share(client, "folder", family, anna, "read")
    with SessionLocal() as db:
        # What the vault asks before locking: sharing has to end first.
        assert shares.lock_refused(db, shared["id"]) is True
        assert shares.lock_refused(db, in_folder["id"]) is True
        assert shares.lock_refused(db, secret["id"]) is False
    for note_id in (shared["id"], in_folder["id"]):
        answer = client.post(f"/api/vault/notes/{note_id}/lock/start")
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "note_shared"
        assert stored(note_id).locked is False
    # Locked anyway and moved into a shared folder afterwards: nothing of it reaches the member.
    alone = new_note(client, title="Allein gesperrt")
    device.lock(alone["id"])
    assert client.post("/api/folders/move", json={"target_id": family, "note_ids": [alone["id"]]}).status_code == 200
    assert as_anna.get(f"/api/notes/{alone['id']}").status_code == 404
    assert as_anna.get(f"/api/vault/notes/{alone['id']}").status_code == 404
    assert "Allein gesperrt" not in titles(all_notes(as_anna))
    assert "Geheim" not in titles(all_notes(as_anna))


# --- EC-4, EC-10: the owner deleted or blocked ------------------------------------------------------------------------


def test_notes13_ec4_the_owner_deleted_takes_the_shared_away_from_everyone_with_a_notice(client, operator, anna, lena,
                                                                                        as_lena):
    with new_client(anna) as as_anna:
        note = new_note(as_anna, title="Annas Liste")
        share(as_anna, "note", note["id"], lena, "write")
    assert as_lena.get(f"/api/notes/{note['id']}").status_code == 200
    with SessionLocal() as db:
        accounts.delete_account(db, db.get(Account, anna.id))
    assert as_lena.get(f"/api/notes/{note['id']}").status_code == 404
    assert titles(all_notes(as_lena)) == []
    listing = with_me(as_lena)
    assert listing["groups"] == []
    assert [(notice["title"], notice["owner"], notice["reason"]) for notice in listing["notices"]] == [
        ("Annas Liste", "Anna", "owner_gone")]
    # Brought back by the operator: the sharing is back.
    with SessionLocal() as db:
        accounts.restore_account(db, db.get(Account, anna.id))
    assert as_lena.get(f"/api/notes/{note['id']}").status_code == 200


def test_notes13_ec10_what_a_blocked_account_shared_stays_visible_as_it_was(client, operator, anna, lena, as_lena):
    with new_client(anna) as as_anna:
        note = new_note(as_anna, title="Annas Rezept", markdown="Mehl")
        share(as_anna, "note", note["id"], lena, "read")
    with SessionLocal() as db:
        accounts.block(db, db.get(Account, anna.id))
    head = as_lena.get(f"/api/notes/{note['id']}")
    assert head.status_code == 200 and head.json()["title"] == "Annas Rezept"
    assert titles(all_notes(as_lena)) == ["Annas Rezept"]
    assert [group["owner"]["name"] for group in with_me(as_lena)["groups"]] == ["Anna"]


# --- EC-8, EC-9 -----------------------------------------------------------------------------------------------------


def test_notes13_ec8_shared_alone_and_through_its_folder_the_higher_right_counts(client, operator, anna, as_anna):
    family = make_folder(client, "Familie")
    note = new_note(client, title="Beides", folder_id=family)
    share(client, "note", note["id"], anna, "read")
    share(client, "folder", family, anna, "write")
    assert can_write(as_anna, note["id"])
    share(client, "note", note["id"], anna, "write")
    share(client, "folder", family, anna, "read")
    assert can_write(as_anna, note["id"])
    share(client, "note", note["id"], anna, "read")
    assert not can_write(as_anna, note["id"])
    assert as_anna.get(f"/api/notes/{note['id']}").json()["level"] == "read"


def test_notes13_ec9_sharing_with_oneself_fails_and_twice_only_changes_the_right(client, operator, anna):
    note = new_note(client, title="Einmal")
    refused = client.put(f"/api/shares/note/{note['id']}/people/{operator.id}", json={"level": "write"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "share_self"
    share(client, "note", note["id"], anna, "read")
    dialog = share(client, "note", note["id"], anna, "write")
    assert [(person["name"], person["level"]) for person in dialog["people"]] == [("Anna", "write")]
    with SessionLocal() as db:
        assert len(list(db.scalars(select(Share).where(Share.account_id == anna.id)))) == 1
    # Nobody that is not a member.
    assert client.put(f"/api/shares/note/{note['id']}/people/99999", json={"level": "read"}).status_code == 404


# --- The rules agree everywhere (NOTES-6 report, finding 5) ----------------------------------------------------------


def test_notes13_every_hook_answers_the_same_for_every_note(client, operator, anna, lena, as_anna):
    """Opening, "Alle Notizen", tags and search hold the same notes: the three hooks are filled from one rule."""
    family = make_folder(client, "Familie")
    deeper = make_folder(client, "Tiefer", family)
    made = {
        "alone": new_note(client, title="Allein #x", markdown="wort #x"),
        "folder": new_note(client, title="Im Ordner", markdown="wort #x", folder_id=family),
        "deep": new_note(client, title="Tief", markdown="wort #x", folder_id=deeper),
        "other": new_note(client, title="Privat", markdown="wort #x"),
        "lena": new_note(client, title="Nur Lena", markdown="wort #x"),
    }
    share(client, "note", made["alone"]["id"], anna, "read")
    share(client, "folder", family, anna, "write")
    share(client, "note", made["lena"]["id"], lena, "read")
    expected = {made[key]["id"] for key in ("alone", "folder", "deep")}
    opened = {note["id"] for note in made.values() if as_anna.get(f"/api/notes/{note['id']}").status_code == 200}
    listed = {item["id"] for item in all_notes(as_anna)["items"]}
    found = {hit["id"] for hit in as_anna.get("/api/search", params={"q": "wort"}).json()["items"]}
    with SessionLocal() as db:
        selected = set(db.scalars(shares.shared_select(anna.id)))
    assert opened == listed == found == selected == expected
    tag = as_anna.get("/api/tags").json()["tags"]
    assert [(item["label"], item["count"]) for item in tag] == [("x", 3)]
    with SessionLocal() as db:
        for note in made.values():
            row = db.get(Note, note["id"])
            assert (shares.note_right(db, anna.id, row).value != "none") == (note["id"] in selected)


# --- The hole of NOTES-10: no attachment of the owner through a note one may write -------------------------------------


def _image_block(attachment_id: str) -> dict:
    return {"type": "image", "attrs": {"id": attachment_id, "size": "medium", "name": "x.png"}}


def test_notes13_a_writer_cannot_reach_another_attachment_of_the_owner_by_writing_its_id(
        client, operator, anna, lena, as_anna, as_lena):
    private = new_note(client, title="Privat")
    uploaded = client.post("/api/attachments", params={"note_id": private["id"], "id": attachments.new_id(),
                                                         "name": "secret.png"}, content=png())
    assert uploaded.status_code == 201, uploaded.text
    secret = uploaded.json()["id"]
    shared = new_note(client, title="Gemeinsam", markdown="Text")
    share(client, "note", shared["id"], anna, "write")
    share(client, "note", shared["id"], lena, "read")
    # Anna knows the id (it was shared with her once) and writes it into the note she may write.
    writer = Live(as_anna, shared["id"], token_for(anna))
    assert writer.pump(lambda: writer.synced)
    edit.append_blocks(writer.doc, [_image_block(secret)])
    writer.settle(0.3)
    writer.close()
    assert wait_for(lambda: secret in [ref for ref in _refs(shared["id"])])
    for member in (as_anna, as_lena):
        assert member.get(f"/api/attachments/{secret}").status_code == 404
        assert member.get(f"/api/attachments/{secret}/view").status_code == 404
        assert secret not in {item["id"] for item in member.get(f"/api/notes/{shared['id']}/attachments").json()["items"]}
    assert client.get(f"/api/attachments/{secret}").status_code == 200
    # The owner puts a picture of another note into the shared note himself: the members see it.
    other = new_note(client, title="Fotos")
    shown = client.post("/api/attachments", params={"note_id": other["id"], "id": attachments.new_id(),
                                                      "name": "shown.png"}, content=png()).json()["id"]
    owner = Live(client, shared["id"], token_for(operator))
    assert owner.pump(lambda: owner.synced)
    edit.append_blocks(owner.doc, [_image_block(shown)])
    owner.settle(0.3)
    owner.close()
    assert wait_for(lambda: shown in _refs(shared["id"]))
    assert as_lena.get(f"/api/attachments/{shown}").status_code == 200
    assert shown in {item["id"] for item in as_lena.get(f"/api/notes/{shared['id']}/attachments").json()["items"]}


def _refs(note_id: str) -> list[str]:
    from app.models_attachments import AttachmentRef

    with SessionLocal() as db:
        return list(db.scalars(select(AttachmentRef.attachment_id).where(AttachmentRef.note_id == note_id)))


def test_notes13_the_owner_writing_at_the_same_time_vouches_only_for_what_his_update_carries(client, operator, anna):
    note = new_note(client, title="Gemeinsam")
    share(client, "note", note["id"], anna, "write")
    with SessionLocal() as db:
        from app.models import NoteUpdate

        db.add(NoteUpdate(note_id=note["id"], update=b"...owned-id-1234567890...", account_id=operator.id))
        db.add(NoteUpdate(note_id=note["id"], update=b"...anna-typed...", account_id=anna.id))
        db.commit()
        row = db.get(Note, note["id"])
        assert attachments.vouched_ids(db, row, {"owned-id-1234567890", "foreign-id-0987654321"}) == {
            "owned-id-1234567890"}
    other = new_note(client, title="Allein")
    with SessionLocal() as db:
        db.add(NoteUpdate(note_id=other["id"], update=b"x", account_id=operator.id))
        db.commit()
        assert attachments.vouched_ids(db, db.get(Note, other["id"]), {"any-id-12345678901"}) == {"any-id-12345678901"}
