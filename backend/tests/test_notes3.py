"""NOTES-3 Notizen schreiben: the server's part (making, listing, titles, copies, deleting, empty notes)."""

from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict

import pytest
from fastapi.testclient import TestClient
from pycrdt import XmlFragment

from app.db import BUSY_SECONDS, SessionLocal
from app.models import FOLDER_NORMAL, Account, Folder, Note, NoteUpdate
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.notedoc.room import Access
from app.security import start_session
from app.services import content, notes
from app.services.inbox import inbox_for

from .conftest import make_account, new_client
from .notes_live import Live, refused


@pytest.fixture(autouse=True)
def close_connections(client):
    """Connections left open by a failing test are closed before the test client goes."""
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rooms answer in test time: a short grace after the last one left."""
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


def token_for(account: Account) -> str:
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        return start_session(db, row, "127.0.0.1", "tests")


def new_note(client: TestClient, **body: object) -> dict:
    answer = client.post("/api/notes", json=body)
    assert answer.status_code == 201, answer.text
    return answer.json()


def stored(note_id: str) -> Note:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        db.expunge(note)
        return note


def stored_doc(note_id: str):
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        updates = [row.update for row in db.query(NoteUpdate).filter_by(note_id=note_id).order_by(NoteUpdate.id)]
        return notedoc.load(note.ydoc, updates)


def wait_for(check, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return check()


def folder(owner: Account, name: str, parent: str | None = None) -> str:
    with SessionLocal() as db:
        row = Folder(owner_id=owner.id, name=name, kind=FOLDER_NORMAL, parent_id=parent)
        db.add(row)
        db.commit()
        return row.id


# --- AC-1, EC-9 ---------------------------------------------------------------------------------------------------


def test_notes3_ac1_new_note_is_empty_and_lands_in_the_inbox(client, operator):
    note = new_note(client)
    assert note["title"] == "" and note["preview"] == "" and note["title_check"] is False
    with SessionLocal() as db:
        assert note["folder_id"] == inbox_for(db, operator.id).id
    assert [item["id"] for item in client.get("/api/notes").json()] == [note["id"]]
    assert note["path"] == [{"id": note["folder_id"], "name": "", "kind": "inbox", "inbox": True}]
    document = stored_doc(note["id"])
    assert notedoc.title_of(document) == "" and to_plain(document) == ""


def test_notes3_ac1_new_note_goes_into_the_folder_it_is_made_in(client, operator):
    kitchen = folder(operator, "Kitchen")
    note = new_note(client, folder_id=kitchen)
    assert note["folder_id"] == kitchen
    assert [item["id"] for item in client.get("/api/notes", params={"folder_id": kitchen}).json()] == [note["id"]]
    other = make_account("other")
    foreign = folder(other, "Theirs")
    refused_answer = client.post("/api/notes", json={"folder_id": foreign})
    assert refused_answer.status_code == 404
    assert refused_answer.json()["detail"]["code"] == "folder_not_found"


def test_notes3_ec9_a_double_click_makes_one_note(client, operator):
    wanted = str(uuid.uuid4())
    first = client.post("/api/notes", json={"id": wanted})
    second = client.post("/api/notes", json={"id": wanted})
    assert (first.status_code, second.status_code) == (201, 200)
    assert first.json()["id"] == second.json()["id"] == wanted
    assert len(client.get("/api/notes").json()) == 1
    # Somebody else's id is not theirs to take.
    other = make_account("other")
    taken = new_client(other).post("/api/notes", json={"id": wanted})
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "note_id_taken"
    assert client.post("/api/notes", json={"id": "not-a-uuid"}).status_code == 422


# --- AC-2 ---------------------------------------------------------------------------------------------------------


def test_notes3_ac2_typing_is_kept_without_a_save_button(client, operator):
    note = new_note(client)
    before = stored(note["id"]).updated_at
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    edit.append_paragraph(live.doc, "Milk and bread")
    # Every update is stored before anybody else sees it; the text column follows within 2 seconds.
    assert wait_for(lambda: stored(note["id"]).text == "Milk and bread", timeout=3.0)
    with SessionLocal() as db:
        assert db.query(NoteUpdate).filter_by(note_id=note["id"]).count() >= 1
    assert stored(note["id"]).updated_at > before
    assert client.get("/api/notes").json()[0]["preview"] == "Milk and bread"
    live.close()


# --- AC-6 ---------------------------------------------------------------------------------------------------------


def test_notes3_ac6_delete_moves_to_the_trash_and_undo_brings_it_back(client, operator):
    note = new_note(client, markdown="Keep me")
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert client.get("/api/notes").json() == []
    head = client.get(f"/api/notes/{note['id']}").json()
    assert head["deleted_at"] is not None
    assert stored(note["id"]).text == "Keep me"  # in the trash, not gone
    restored = client.post(f"/api/notes/{note['id']}/restore")
    assert restored.status_code == 200 and restored.json()["deleted_at"] is None
    assert [item["id"] for item in client.get("/api/notes").json()] == [note["id"]]


# --- AC-7 ---------------------------------------------------------------------------------------------------------


def test_notes3_ac7_duplicate_copies_into_the_same_folder_with_kopie(client, operator):
    with SessionLocal() as db:
        db.get(Account, operator.id).language = "de"
        db.commit()
    kitchen = folder(operator, "Kitchen")
    note = new_note(client, folder_id=kitchen, title="Shopping", markdown="- [ ] Milk\n- [x] Bread")
    copy = client.post(f"/api/notes/{note['id']}/duplicate")
    assert copy.status_code == 201
    made = copy.json()
    assert made["id"] != note["id"] and made["folder_id"] == kitchen
    assert made["title"] == "Shopping (Kopie)"
    assert notedoc.to_json(stored_doc(made["id"])) == notedoc.to_json(stored_doc(note["id"]))
    assert notedoc.title_of(stored_doc(made["id"])) == "Shopping (Kopie)"
    with SessionLocal() as db:
        db.get(Account, operator.id).language = "en"
        db.commit()
    assert client.post(f"/api/notes/{note['id']}/duplicate").json()["title"] == "Shopping (Copy)"


def test_notes3_ac7_the_copy_title_stays_within_120_characters(client, operator):
    note = new_note(client, title="x" * 120)
    with SessionLocal() as db:
        db.get(Account, operator.id).language = "de"
        db.commit()
    title = client.post(f"/api/notes/{note['id']}/duplicate").json()["title"]
    assert len(title) <= 120 and title.endswith(" (Kopie)")


def test_notes3_ac7_a_copy_of_somebody_else_s_note_goes_into_the_own_inbox(client, operator, monkeypatch):
    """Ready for sharing (NOTES-13): the copy belongs to who made it, never into a folder of the note's owner."""
    kitchen = folder(operator, "Kitchen")
    note = new_note(client, folder_id=kitchen, title="Shared shopping", markdown="- [ ] Milk")
    other = make_account("other")
    monkeypatch.setattr(notes, "ACCESS_RULES", [lambda _db, account, _note: Access.READ if account.id == other.id
                                                else None])
    theirs = new_client(other)
    answer = theirs.post(f"/api/notes/{note['id']}/duplicate")
    assert answer.status_code == 201
    made = answer.json()
    with SessionLocal() as db:
        assert made["folder_id"] == inbox_for(db, other.id).id
        copy = db.get(Note, made["id"])
        assert copy.owner_id == other.id
        assert db.get(Folder, copy.folder_id).owner_id == other.id
    assert notedoc.to_json(stored_doc(made["id"])) == notedoc.to_json(stored_doc(note["id"]))
    # The owner's own copy stays beside the note.
    assert client.post(f"/api/notes/{note['id']}/duplicate").json()["folder_id"] == kitchen


# --- AC-8 ---------------------------------------------------------------------------------------------------------


def test_notes3_ac8_the_head_names_folder_path_created_and_changed(client, operator):
    home = folder(operator, "Home")
    workers = folder(operator, "Workers", home)
    note = new_note(client, folder_id=workers, title="Bathroom")
    head = client.get(f"/api/notes/{note['id']}").json()
    assert [step["name"] for step in head["path"]] == ["Home", "Workers"]
    assert head["created_at"] and head["updated_at"]
    assert head["updated_by"] == {"id": operator.id, "name": operator.display_name}


# --- AC-9, AC-10, EC-4, EC-5, EC-12 -------------------------------------------------------------------------------


@pytest.fixture
def after_leave(monkeypatch: pytest.MonkeyPatch) -> dict[str, threading.Event]:
    """Set per note once the work after the last one left (``notes.after_last_left``) is over: a test waits for that
    event, not for a guessed time. Its bound is ``AFTER_LEAVE_BOUND``."""
    done: dict[str, threading.Event] = defaultdict(threading.Event)
    real = notes.after_last_left

    async def watched(note_id: str, grace: float | None = None) -> None:
        try:
            await real(note_id, grace)
        finally:
            done[note_id].set()

    monkeypatch.setattr(notes, "after_last_left", watched)
    return done


#: How long the work after leaving may take: it writes to SQLite, and a write waits up to ``BUSY_SECONDS`` for another
#: writer's lock (the app's own margin); a check giving up sooner (it was 8 s) fails on a wait the app takes as normal.
AFTER_LEAVE_BOUND = BUSY_SECONDS + 5


def test_notes3_ac10_a_tab_closed_without_a_title_gets_the_suggestion(client, operator, after_leave):
    note = new_note(client)
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    edit.append_paragraph(live.doc, "Dentist Tuesday 15:30 confirm, bring the booklet.")
    live.settle(0.2)
    live.close()
    assert after_leave[note["id"]].wait(AFTER_LEAVE_BOUND), "the work after leaving never ended"
    assert stored(note["id"]).title == "Dentist Tuesday 15:30 confirm"
    assert stored(note["id"]).title_check is True
    assert notedoc.title_of(stored_doc(note["id"])) == "Dentist Tuesday 15:30 confirm"
    item = client.get("/api/notes").json()[0]
    assert item["title_check"] is True


def test_notes3_ac10_another_app_stopping_meanwhile_does_not_cancel_the_suggestion(client, operator, monkeypatch,
                                                                                 after_leave):
    """The wait after the last one left belongs to its own loop: another app in the same process stopping (a second
    test client, a real server in a thread) does not cancel it."""
    monkeypatch.setattr(notes, "LEAVE_GRACE", 2.0)  # still waiting while the other app starts and stops
    note = new_note(client)
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    edit.append_paragraph(live.doc, "Return the drill to the neighbour")
    live.settle(0.2)
    live.close()
    with new_client(operator):  # starts and stops an app of its own while the suggestion waits
        pass
    assert after_leave[note["id"]].wait(AFTER_LEAVE_BOUND), "the work after leaving never ended"
    assert stored(note["id"]).title == "Return the drill to the neighbour"


def test_notes3_ac9_taking_the_suggestion_marks_it_for_checking(client, operator):
    note = new_note(client)
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    edit.append_paragraph(live.doc, "Call the plumber about the tap")
    live.settle(0.2)
    taken = client.post(f"/api/notes/{note['id']}/title/suggestion", json={}).json()
    assert taken["title"] == "Call the plumber about the tap" and taken["title_check"] is True
    # The open editor gets the title at once; the summary after the change keeps the mark.
    assert live.pump(lambda: live.title == "Call the plumber about the tap")
    time.sleep(2.3)
    assert stored(note["id"]).title_check is True
    live.close()


def test_notes3_ac10_notes_made_without_typing_get_a_suggested_title(client, operator):
    shared = new_note(client, markdown="Compost works best in layers. Brown, green, brown.", origin="share:Safari")
    assert shared["title"] == "Compost works best in layers" and shared["title_check"] is True
    assert shared["origin"] == "share:Safari"
    page = new_note(client, title="Article about compost", title_suggested=True, markdown="Text")
    assert page["title"] == "Article about compost" and page["title_check"] is True
    typed = new_note(client, title="Typed by me", markdown="Text")
    assert typed["title_check"] is False


def test_notes3_ac10_title_ok_takes_the_mark_away(client, operator):
    note = new_note(client, markdown="From the share menu")
    assert note["title_check"] is True
    answer = client.post(f"/api/notes/{note['id']}/title/ok")
    assert answer.status_code == 200 and answer.json()["title_check"] is False


def test_notes3_ec12_a_title_given_on_another_device_takes_the_mark_away(client, operator):
    note = new_note(client, markdown="Dictated on the way home")
    assert note["title_check"] is True
    phone = Live(client, note["id"], token_for(operator))
    assert phone.pump(lambda: phone.synced)
    phone.set_title("Way home")
    assert wait_for(lambda: stored(note["id"]).title == "Way home", timeout=3.0)
    assert stored(note["id"]).title_check is False
    assert client.get(f"/api/notes/{note['id']}").json()["title_check"] is False
    phone.close()
    # A title typed through the API counts the same.
    other = new_note(client, markdown="Another dictation")
    assert client.put(f"/api/notes/{other['id']}/title", json={"title": "Given"}).json()["title_check"] is False


def test_notes3_ec4_an_empty_note_left_behind_leaves_nothing(client, operator):
    note = new_note(client)
    live = Live(client, note["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    live.close()
    assert wait_for(lambda: client.get(f"/api/notes/{note['id']}").status_code == 404)
    # Leaving in the browser: discarded at once, only when it is empty.
    empty = new_note(client)
    assert client.post(f"/api/notes/{empty['id']}/discard").json() == {"discarded": True}
    assert client.get(f"/api/notes/{empty['id']}").status_code == 404
    written = new_note(client, title="Not empty")
    assert client.post(f"/api/notes/{written['id']}/discard").json() == {"discarded": False}
    assert client.get(f"/api/notes/{written['id']}").status_code == 200


def test_notes3_ec5_a_title_of_spaces_counts_as_empty(client, operator):
    note = new_note(client, title="Something")
    assert client.put(f"/api/notes/{note['id']}/title", json={"title": "   \t "}).json()["title"] == ""
    assert notedoc.title_of(stored_doc(note["id"])) == ""
    # Typed live: spaces only and some text, the tab closes: the suggestion comes as for no title.
    blank = new_note(client)
    live = Live(client, blank["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    live.set_title("    ")
    edit.append_paragraph(live.doc, "Only spaces above")
    live.settle(0.2)
    live.close()
    assert wait_for(lambda: stored(blank["id"]).title == "Only spaces above")
    # A note of spaces only is empty and goes.
    spaces = new_note(client)
    live = Live(client, spaces["id"], token_for(operator))
    assert live.pump(lambda: live.synced)
    live.set_title("   ")
    live.settle(0.2)
    live.close()
    assert wait_for(lambda: client.get(f"/api/notes/{spaces['id']}").status_code == 404)


def test_notes3_ec6_two_notes_may_share_a_title_in_one_folder(client, operator):
    first = new_note(client, title="Same")
    second = new_note(client, title="Same")
    assert first["folder_id"] == second["folder_id"] and first["id"] != second["id"]


def test_notes3_ec7_a_title_takes_at_most_120_characters(client, operator):
    note = new_note(client)
    title = client.put(f"/api/notes/{note['id']}/title", json={"title": "a" * 200}).json()["title"]
    assert title == "a" * 120
    long_first_line = " ".join(["word"] * 3) + "x" * 300
    suggested = new_note(client, markdown=long_first_line)
    assert len(suggested["title"]) == 120 and suggested["title_check"] is True
    assert notes.suggest_title("y" * 500) == "y" * 120


def test_notes3_ec10_umlauts_emoji_and_right_to_left_stay(client, operator):
    title = "Grüße 👋🏽 مرحبا بالعالم"
    body = "Straße, Ärger, 🙂 und שלום עולם"
    note = new_note(client, title=title, markdown=body)
    head = client.get(f"/api/notes/{note['id']}").json()
    assert head["title"] == title and head["preview"] == body
    assert notedoc.title_of(stored_doc(note["id"])) == title
    assert client.put(f"/api/notes/{note['id']}/title", json={"title": "ß 🧡 עברית"}).json()["title"] == "ß 🧡 עברית"


def test_notes3_the_suggestion_takes_the_first_words():
    assert notes.suggest_title("Dentist Tuesday 15:30, bring the booklet") == "Dentist Tuesday 15:30"
    assert notes.suggest_title("\n\n  Hello world. And more") == "Hello world"
    assert notes.suggest_title("one two three four five six seven eight nine ten") == \
        "one two three four five six seven eight"
    assert notes.suggest_title("   ") == ""


# --- Rights, counts -----------------------------------------------------------------------------------------------


def test_notes3_a_note_is_its_owner_s_alone(client, operator):
    note = new_note(client, title="Mine")
    other = make_account("other")
    theirs = new_client(other)
    if True:
        assert theirs.get(f"/api/notes/{note['id']}").status_code == 404
        assert theirs.get("/api/notes").json() == []
        assert theirs.delete(f"/api/notes/{note['id']}").status_code == 404
        assert theirs.post(f"/api/notes/{note['id']}/duplicate").status_code == 404
        assert theirs.put(f"/api/notes/{note['id']}/title", json={"title": "x"}).status_code == 404
    assert refused(client, note["id"], token_for(other)) == 4403
    assert refused(client, note["id"], None) == 4403


def test_notes3_the_accounts_side_counts_the_notes(client, operator):
    new_note(client, title="One")
    gone = new_note(client, title="Two")
    client.delete(f"/api/notes/{gone['id']}")
    with SessionLocal() as db:
        counts = content.counts(db, operator.id)
    assert counts.notes == 1 and counts.bytes > 0


def test_notes3_live_connections_from_another_site_are_refused(client, operator):
    note = new_note(client)
    for origin in ("https://evil.example", "null", "http://testserver.evil.example"):
        assert refused(client, note["id"], token_for(operator), origin=origin) == 4403
    assert refused(client, note["id"], token_for(operator), origin="http://testserver") == 0


def test_notes3_the_body_of_a_new_note_is_one_empty_paragraph(client, operator):
    note = new_note(client)
    body = stored_doc(note["id"]).get("body", type=XmlFragment)
    assert [child.tag for child in body.children] == ["paragraph"]


def test_notes3_ac6_a_note_deleted_alone_stays_in_the_trash_when_its_folder_comes_back(client, operator):
    kitchen = folder(operator, "Kitchen")
    alone = new_note(client, folder_id=kitchen, title="Deleted alone")
    stays = new_note(client, folder_id=kitchen, title="Goes with the folder")
    client.delete(f"/api/notes/{alone['id']}")
    assert stored(alone["id"]).deleted_batch is not None
    assert client.delete(f"/api/folders/{kitchen}").status_code in (200, 204)
    assert client.post(f"/api/folders/{kitchen}/restore").status_code == 200
    assert {item["id"] for item in client.get("/api/notes").json()} == {stays["id"]}
    # Brought back alone while its folder is in the trash: into the inbox.
    client.delete(f"/api/folders/{kitchen}")
    back = client.post(f"/api/notes/{alone['id']}/restore").json()
    with SessionLocal() as db:
        assert back["folder_id"] == inbox_for(db, operator.id).id
    assert stored(alone["id"]).deleted_batch is None
