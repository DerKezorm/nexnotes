"""NOTES-25 Programmschnittstelle (API), every route that writes: new notes (with ``external_ref``, also two at
once), the head of a note, appending while somebody types, the trash, folders, tags, uploads, the history and the
notifications, the limits, Markdown with HTML, and the rights of each of them."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, Folder, Note
from app.models_api import ApiRef
from app.models_history import NoteEdit
from app.models_notify import NotifyEdit
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.services import apibrake, apiwrite, settings_service

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored_doc, token_for
from .test_notes10 import attached, png_with_text
from .test_notes13 import make_folder, share


@pytest.fixture(autouse=True)
def fresh(client) -> Iterator[None]:
    apibrake.forget()
    yield
    Live.close_all()
    apibrake.forget()


def program() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def token_of(client: TestClient, **body) -> str:
    answer = client.post("/api/tokens", json={"name": "n8n", "level": "write", **body})
    assert answer.status_code == 201, answer.text
    return answer.json()["token"]


def call(token: str, method: str, path: str, via: TestClient | None = None, **kwargs):
    """``via``: the test client whose event loop holds the live room a test watches; the request carries nothing but
    the token."""
    headers = {"Authorization": f"Bearer {token}", **kwargs.pop("headers", {})}
    return (via or program()).request(method, path, headers=headers, **kwargs)


def ok(answer, status: int = 200) -> dict:
    assert answer.status_code == status, answer.text
    return answer.json() if answer.content else {}


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def stored(note_id: str) -> Note:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        db.expunge(note)
        return note


def markdown_of(token: str, note_id: str) -> str:
    return ok(call(token, "GET", f"/api/v1/notes/{note_id}"))["markdown"]


# --- AC-14: new notes -----------------------------------------------------------------------------------------------


def test_notes25_ac14_a_new_note_goes_to_the_inbox_says_where_from_and_checks_a_title_nobody_typed(client, operator):
    token = token_of(client, name="Wetterbericht")
    made = call(token, "POST", "/api/v1/notes", json={"markdown": "Regen ab Mittag\n\n- [ ] Schirm"})
    body = ok(made, 201)
    note = stored(body["id"])
    inbox = client.get("/api/folders").json()["inbox"]["id"]
    assert note.folder_id == inbox and note.origin == "api:Wetterbericht"
    assert note.title == "Regen ab Mittag" and note.title_check is True
    assert "- [ ] Schirm" in body["markdown"] and body["etag"]
    # With a title: no "Titel prüfen"; with folder, symbol, color, paper and pinned.
    home = make_folder(client, "Haushalt")
    full = ok(call(token, "POST", "/api/v1/notes", json={
        "title": "Einkauf", "markdown": "- [ ] Milch", "folder_id": home, "icon": "star", "color": "red",
        "paper": "lined", "pinned": True}), 201)
    note = stored(full["id"])
    assert (note.title, note.title_check, note.folder_id, note.color, note.paper) == ("Einkauf", False, home, "red",
                                                                                      "lined")
    assert note.pinned_at is not None and full["pinned"] is True and full["icon"] == note.icon
    # Nothing at all to write.
    empty = call(token, "POST", "/api/v1/notes", json={"markdown": "  "})
    assert empty.status_code == 422 and code(empty) == "invalid_input"
    bad = call(token, "POST", "/api/v1/notes", json={"markdown": "x", "icon": "no-such-symbol"})
    assert bad.status_code == 422 and bad.json()["detail"]["fields"] == ["icon"]


def test_notes25_ac14_external_ref_makes_one_note_however_often_it_is_sent(client, operator):
    token = token_of(client)
    first = call(token, "POST", "/api/v1/notes", json={"markdown": "Tagesplan", "external_ref": "plan-2026-11-22"})
    again = call(token, "POST", "/api/v1/notes", json={"markdown": "Tagesplan", "external_ref": "plan-2026-11-22"})
    assert first.status_code == 201 and again.status_code == 200 and first.json()["id"] == again.json()["id"]
    other = call(token, "POST", "/api/v1/notes", json={"markdown": "x", "external_ref": "plan-2026-11-23"})
    assert other.status_code == 201 and other.json()["id"] != first.json()["id"]
    # Another account's same reference is its own.
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = token_of(as_anna)
    assert call(theirs, "POST", "/api/v1/notes", json={"markdown": "x", "external_ref": "plan-2026-11-22"}
                ).status_code == 201
    # Gone for good: the next request makes a new note.
    with SessionLocal() as db:
        db.delete(db.get(Note, first.json()["id"]))
        db.commit()
        assert db.scalar(select(ApiRef).where(ApiRef.external_ref == "plan-2026-11-22",
                                              ApiRef.account_id == operator.id)) is None
    renewed = call(token, "POST", "/api/v1/notes", json={"markdown": "x", "external_ref": "plan-2026-11-22"})
    assert renewed.status_code == 201 and renewed.json()["id"] != first.json()["id"]


def test_notes25_ec13_two_requests_with_the_same_external_ref_at_once_make_one_note(client, operator, monkeypatch):
    token = token_of(client)
    # Both looked before either wrote: the second finds the reference taken when it writes.
    original = apiwrite._by_ref
    seen: list[int] = []

    def late(db, account_id, ref):
        seen.append(1)
        return None if len(seen) == 1 else original(db, account_id, ref)

    first = ok(call(token, "POST", "/api/v1/notes", json={"markdown": "a", "external_ref": "race"}), 201)
    seen.clear()
    monkeypatch.setattr(apiwrite, "_by_ref", late)
    second = call(token, "POST", "/api/v1/notes", json={"markdown": "a", "external_ref": "race"})
    assert second.status_code == 200 and second.json()["id"] == first["id"]
    monkeypatch.setattr(apiwrite, "_by_ref", original)
    # And for real, from two threads at once.
    answers: list = []
    start = threading.Barrier(4)

    def send() -> None:
        start.wait()
        answers.append(call(token, "POST", "/api/v1/notes", json={"markdown": "b", "external_ref": "together"}))

    threads = [threading.Thread(target=send) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answer.status_code for answer in answers).count(201) == 1
    assert len({answer.json()["id"] for answer in answers}) == 1
    with SessionLocal() as db:
        assert len(db.scalars(select(Note).where(Note.origin == "api:n8n", Note.text == "b")).all()) == 1


def test_notes25_ac14_ac7_ec8_where_a_new_note_may_go(client, operator):
    home = make_folder(client, "Haushalt")
    limited = token_of(client, name="limited", folders=[home])
    note = ok(call(limited, "POST", "/api/v1/notes", json={"markdown": "x"}), 201)
    assert stored(note["id"]).folder_id == home
    work = make_folder(client, "Arbeit")
    assert code(call(limited, "POST", "/api/v1/notes", json={"markdown": "x", "folder_id": work})) == "not_found"
    reads = token_of(client, name="reads", level="read")
    refused = call(reads, "POST", "/api/v1/notes", json={"markdown": "x"})
    assert refused.status_code == 403 and code(refused) == "token_reads_only"
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        writing = make_folder(as_anna, "Gemeinsam")
        reading = make_folder(as_anna, "Nur lesen")
        private = make_folder(as_anna, "Privat")
        share(as_anna, "folder", writing, operator, "write")
        share(as_anna, "folder", reading, operator, "read")
    token = token_of(client)
    made = ok(call(token, "POST", "/api/v1/notes", json={"markdown": "x", "folder_id": writing}), 201)
    with SessionLocal() as db:
        assert db.get(Note, made["id"]).owner_id == anna.id
    assert code(call(token, "POST", "/api/v1/notes", json={"markdown": "x", "folder_id": reading})) == "not_allowed"
    assert code(call(token, "POST", "/api/v1/notes", json={"markdown": "x", "folder_id": private})) == "not_found"


# --- AC-15: the head of a note --------------------------------------------------------------------------------------


def test_notes25_ac15_ec8_title_symbol_color_paper_pinning_and_folder_as_in_the_interface(client, operator):
    token = token_of(client)
    note = new_note(client, title="Alt", markdown="x")
    home = make_folder(client, "Haushalt")
    changed = ok(call(token, "PATCH", f"/api/v1/notes/{note['id']}", json={
        "title": "Neu", "icon": "star", "color": "blue", "paper": "grid", "pinned": True, "folder_id": home}))
    assert changed["title"] == "Neu" and changed["folder_id"] == home and changed["pinned"] is True
    row = stored(note["id"])
    assert (row.title, row.color, row.paper, row.folder_id) == ("Neu", "blue", "grid", home) and row.icon == "star"
    assert ok(call(token, "GET", f"/api/v1/notes/{note['id']}"))["title"] == "Neu"
    assert call(token, "PATCH", f"/api/v1/notes/{note['id']}", json={"title": "x" * 121}).json()["detail"][
        "fields"] == ["title"]
    assert code(call(token, "PATCH", f"/api/v1/notes/{note['id']}", json={"paper": "wavy"})) == "invalid_input"
    # A note of somebody else: only its owner moves it; pinning is each person's own, even when shared to read.
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        writing = new_note(as_anna, title="Gemeinsam", markdown="x")
        reading = new_note(as_anna, title="Zum Lesen", markdown="x")
        share(as_anna, "note", writing["id"], operator, "write")
        share(as_anna, "note", reading["id"], operator, "read")
    moved = call(token, "PATCH", f"/api/v1/notes/{writing['id']}", json={"folder_id": home})
    assert moved.status_code == 403 and code(moved) == "not_owner"
    assert ok(call(token, "PATCH", f"/api/v1/notes/{writing['id']}", json={"title": "Gemeinsam neu"}))
    assert ok(call(token, "PATCH", f"/api/v1/notes/{reading['id']}", json={"pinned": True}))["pinned"] is True
    assert stored(reading["id"]).pinned_at is None
    refused = call(token, "PATCH", f"/api/v1/notes/{reading['id']}", json={"color": "red"})
    assert refused.status_code == 403 and code(refused) == "not_allowed"
    reads = token_of(client, name="reads", level="read")
    assert code(call(reads, "PATCH", f"/api/v1/notes/{note['id']}", json={"pinned": False})) == "token_reads_only"


# --- AC-16: appending and ticking while somebody types --------------------------------------------------------------


def test_notes25_ac16_appending_and_ticking_show_at_once_and_lose_nothing_typed(client, operator):
    token = token_of(client, name="Skript")
    note = new_note(client, markdown="Anfang\n\n- [ ] Milch")
    browser = Live(client, note["id"], token_for(operator))
    assert browser.pump(lambda: browser.synced)
    edit.append_paragraph(browser.doc, "getippt im Browser")
    appended = call(token, "POST", f"/api/v1/notes/{note['id']}/append", via=client,
                    json={"markdown": "vom Programm"})
    assert appended.status_code == 200, appended.text
    assert browser.pump(lambda: "vom Programm" in browser.text and "getippt im Browser" in browser.text)
    ticked = call(token, "POST", f"/api/v1/notes/{note['id']}/items/0", via=client, json={"text": "Milch"})
    assert ticked.status_code == 200 and ticked.json()["tasks"] == {"done": 1, "total": 1}
    edit.append_paragraph(browser.doc, "noch mehr getippt")
    assert browser.pump(lambda: False, timeout=0.3) is False
    browser.close()
    text = markdown_of(token, note["id"])
    assert all(part in text for part in ("Anfang", "getippt im Browser", "vom Programm", "noch mehr getippt",
                                         "- [x] Milch"))
    assert call(token, "POST", f"/api/v1/notes/{note['id']}/append", json={"markdown": " "}).status_code == 422


# --- AC-18, EC-3: the trash -----------------------------------------------------------------------------------------


def test_notes25_ac18_ec3_deleting_puts_into_the_trash_and_restore_brings_back(client, operator):
    token = token_of(client)
    note = new_note(client, title="Weg damit", markdown="x")
    assert call(token, "DELETE", f"/api/v1/notes/{note['id']}").status_code == 204
    assert stored(note["id"]).deleted_at is not None
    for method, path, body in (("GET", "", None), ("PATCH", "", {"title": "y"}), ("POST", "/append", {"markdown": "y"}),
                               ("DELETE", "", None)):
        answer = call(token, method, f"/api/v1/notes/{note['id']}{path}", json=body)
        assert answer.status_code == 410 and code(answer) == "note_trashed", (method, path)
    back = ok(call(token, "POST", f"/api/v1/notes/{note['id']}/restore"))
    assert back["title"] == "Weg damit" and stored(note["id"]).deleted_at is None
    folder = make_folder(client, "Alt")
    inside = new_note(client, markdown="drin", folder_id=folder)
    assert ok(call(token, "DELETE", f"/api/v1/folders/{folder}"))
    assert stored(inside["id"]).deleted_at is not None
    assert ok(call(token, "POST", f"/api/v1/folders/{folder}/restore"))
    assert stored(inside["id"]).deleted_at is None
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, markdown="x")
        as_anna.delete(f"/api/notes/{theirs['id']}")
    assert code(call(token, "POST", f"/api/v1/notes/{theirs['id']}/restore")) == "not_found"


# --- AC-19: folders -------------------------------------------------------------------------------------------------


def test_notes25_ac19_folders_made_renamed_styled_moved_deleted_and_the_inbox_stays(client, operator):
    token = token_of(client)
    home = ok(call(token, "POST", "/api/v1/folders", json={"name": "Haushalt", "icon": "heart", "color": "green"}),
              201)
    child = ok(call(token, "POST", "/api/v1/folders", json={"name": "Einkauf", "parent_id": home["id"]}), 201)
    assert child["parent_id"] == home["id"]
    renamed = ok(call(token, "PATCH", f"/api/v1/folders/{child['id']}", json={"name": "Läden", "color": "blue"}))
    assert renamed["name"] == "Läden" and renamed["color"] == "blue"
    moved = ok(call(token, "PATCH", f"/api/v1/folders/{child['id']}", json={"parent_id": None}))
    assert moved["parent_id"] is None
    with SessionLocal() as db:
        assert db.get(Folder, child["id"]).parent_id is None
    assert call(token, "POST", "/api/v1/folders", json={"name": "x" * 61}).json()["detail"]["fields"] == ["name"]
    for method, body in (("PATCH", {"name": "Posteingang"}), ("PATCH", {"parent_id": home["id"]}), ("DELETE", None)):
        answer = call(token, method, "/api/v1/folders/inbox", json=body)
        assert answer.status_code == 400 and code(answer) == "inbox_fixed", method
    assert call(token, "POST", "/api/v1/folders", json={"name": "x", "parent_id": "inbox"}).json()["detail"][
        "fields"] == ["parent_id"]
    trashed = ok(call(token, "DELETE", f"/api/v1/folders/{home['id']}"))
    assert trashed
    with SessionLocal() as db:
        assert db.get(Folder, home["id"]).deleted_at is not None
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = make_folder(as_anna, "Annas")
        share(as_anna, "folder", theirs, operator, "write")
    # A folder shared with the account is its owner's to rename, move and delete.
    for method, body in (("PATCH", {"name": "Meins"}), ("DELETE", None)):
        assert code(call(token, method, f"/api/v1/folders/{theirs}", json=body)) == "not_found"
    limited = token_of(client, name="limited", folders=[child["id"]])
    assert call(limited, "POST", "/api/v1/folders", json={"name": "Oben"}).json()["detail"]["fields"] == ["parent_id"]
    assert ok(call(limited, "POST", "/api/v1/folders", json={"name": "Drin", "parent_id": child["id"]}), 201)
    reads = token_of(client, name="reads", level="read")
    assert code(call(reads, "POST", "/api/v1/folders", json={"name": "x"})) == "token_reads_only"


# --- AC-20: tags ----------------------------------------------------------------------------------------------------


def test_notes25_ac20_renaming_a_tag_changes_only_own_notes(client, operator):
    token = token_of(client)
    mine = new_note(client, markdown="Kuchen #backen")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, markdown="Brot #backen")
        share(as_anna, "note", theirs["id"], operator, "write")
    done = ok(call(token, "PATCH", "/api/v1/tags/backen", json={"name": "Backstube"}))
    assert done == {"name": "Backstube", "changed": 1, "kept": 1}
    assert "#Backstube" in markdown_of(token, mine["id"]) and "#backen" in markdown_of(token, theirs["id"])
    # Limited to a folder: only the notes in it.
    home = make_folder(client, "Haushalt")
    inside = new_note(client, markdown="drin #liste", folder_id=home)
    outside = new_note(client, markdown="draußen #liste")
    limited = token_of(client, name="limited", folders=[home])
    assert ok(call(limited, "PATCH", "/api/v1/tags/liste", json={"name": "einkauf"}))["changed"] == 1
    assert "#einkauf" in markdown_of(token, inside["id"]) and "#liste" in markdown_of(token, outside["id"])


# --- AC-21: uploads -------------------------------------------------------------------------------------------------


def test_notes25_ac21_a_file_comes_as_a_block_at_the_end_with_the_limits_of_the_interface(client, operator):
    token = token_of(client)
    note = new_note(client, markdown="Rechnung")
    picture = call(token, "POST", f"/api/v1/notes/{note['id']}/attachments", params={"name": "foto.png"},
                   content=png_with_text())
    assert picture.status_code == 201, picture.text
    text = call(token, "POST", f"/api/v1/notes/{note['id']}/attachments", params={"name": "liste.txt"},
                content=b"Milch, Brot")
    assert text.status_code == 201, text.text
    blocks = [block["type"] for block in notedoc.to_json(stored_doc(note["id"]))["content"]]
    assert blocks[-2:] == ["image", "attachment"]
    assert call(token, "GET", text.json()["file"]).content == b"Milch, Brot"
    # The operator's limit per file, and the account's storage.
    with SessionLocal() as db:
        settings_service.save(db, {"upload_max_mb": 1})
    big = call(token, "POST", f"/api/v1/notes/{note['id']}/attachments", params={"name": "gross.bin"},
               content=b"x" * (1024 * 1024 + 10))
    assert big.status_code == 413 and code(big) == "attachment_too_large"
    with SessionLocal() as db:
        db.get(Account, operator.id).storage_limit = 1
        db.commit()
    full = call(token, "POST", f"/api/v1/notes/{note['id']}/attachments", params={"name": "a.txt"}, content=b"abc")
    assert full.status_code == 507 and code(full) == "storage_limit_reached"
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        reading = new_note(as_anna, markdown="x")
        share(as_anna, "note", reading["id"], operator, "read")
    refused = call(token, "POST", f"/api/v1/notes/{reading['id']}/attachments", params={"name": "a.txt"},
                   content=b"abc")
    assert refused.status_code == 403 and code(refused) == "not_allowed"


# --- AC-22, AC-24: history, notifications, log ----------------------------------------------------------------------


def test_notes25_ac22_ac24_the_history_names_the_token_shared_members_hear_and_the_log_says_no_content(
        client, operator, caplog):
    anna = make_account("anna")
    note = new_note(client, title="Gemeinsamer Plan", markdown="Anfang")
    share(client, "note", note["id"], anna, "write")
    with new_client(anna) as as_anna:
        assert as_anna.put(f"/api/notify/note/{note['id']}", json={"on": True}).status_code == 200
    made = client.post("/api/tokens", json={"name": "Hausautomation", "level": "write"}).json()
    token = made["token"]
    caplog.set_level(logging.INFO, logger="nexnotes.api")
    ok(call(token, "POST", f"/api/v1/notes/{note['id']}/append", json={"markdown": "Geheimer Zusatz"}))
    with SessionLocal() as db:
        writers = {(row.account_id, row.via) for row in db.scalars(select(NoteEdit).where(
            NoteEdit.note_id == note["id"]))}
        assert (operator.id, "api:Hausautomation") in writers
        # The account wrote: members the note is shared with hear of it as of any change of the account.
        assert db.scalar(select(NotifyEdit).where(NotifyEdit.note_id == note["id"],
                                                  NotifyEdit.account_id == operator.id)) is not None
    lines = [record.getMessage() for record in caplog.records if record.name == "nexnotes.api"]
    assert any(note["id"] in line and f"token_id={made['made']['id']}" in line for line in lines)
    assert not any(secret in caplog.text for secret in (token, "Geheimer Zusatz", "Gemeinsamer Plan"))


# --- EC-1, EC-12: limits and what Markdown may carry ----------------------------------------------------------------


def test_notes25_ec1_the_limits_of_the_interface_hold_and_nothing_is_written(client, operator):
    token = token_of(client)
    note = new_note(client, markdown="kurz")
    huge = "a" * (512 * 1024 + 1)
    for method, path, body in (("POST", "/api/v1/notes", {"markdown": huge}),
                               ("POST", f"/api/v1/notes/{note['id']}/append", {"markdown": huge})):
        answer = call(token, method, path, json=body)
        assert answer.status_code == 413 and code(answer) == "too_large"
    long_title = call(token, "POST", "/api/v1/notes", json={"markdown": "x", "title": "t" * 121})
    assert long_title.status_code == 422 and long_title.json()["detail"]["fields"] == ["title"]
    with SessionLocal() as db:
        assert len(db.scalars(select(Note)).all()) == 1
    assert markdown_of(token, note["id"]).strip() == "kurz"


def test_notes25_ec12_html_scripts_and_foreign_attachments_open_nothing(client, operator):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, markdown="x")
        foreign = attached(as_anna, theirs["id"], b"not yours", "fremd.txt")
    token = token_of(client)
    made = ok(call(token, "POST", "/api/v1/notes", json={"markdown": (
        "<script>alert(1)</script>\n\n[klick](javascript:alert(1)) und <b>fett</b>\n\n"
        f"[Datei](attachment:{foreign['id']})")}), 201)
    text = made["markdown"]
    assert "javascript:" not in text
    assert "&lt;script&gt;" in text or "\\<script\\>" in text or "<script>" not in text.replace("\\<", "")
    assert code(call(token, "GET", f"/api/v1/attachments/{foreign['id']}/file")) == "not_found"
    assert foreign["id"] not in {item["id"] for item in ok(call(token, "GET", f"/api/v1/notes/{made['id']}/attachments"))[
        "attachments"]}


# --- AC-15, AC-17: PATCH with If-Match, pinning a note shared to read --------------------------------------------


def test_notes25_ac15_ac17_patch_with_if_match_compares_and_writes_the_title_in_one_step(client, operator,
                                                                                       monkeypatch):
    import asyncio

    from app.services import notes

    from .test_notes3 import wait_for

    token = token_of(client)
    note = new_note(client, title="Alt", markdown="Erste Zeile")
    etag = ok(call(token, "GET", f"/api/v1/notes/{note['id']}"))["etag"]
    # An older state: 412 with the state of now, and nothing changes, not even the fields beside the title.
    stale = call(token, "PATCH", f"/api/v1/notes/{note['id']}", json={"title": "Neu", "color": "red"},
                 headers={"If-Match": '"0000"'})
    assert stale.status_code == 412 and code(stale) == "note_changed" and stale.json()["detail"]["etag"] == etag
    assert (stored(note["id"]).title, stored(note["id"]).color) == ("Alt", "")
    # Somebody types the moment the state has been compared: the typing waits for the room and goes in as soon as the
    # room is free, and every later change of the server waits until it is in (``_refuse_locked`` is the first step
    # of each). The title is still written on exactly the state named in If-Match, and what was typed is kept.
    real_state, real_title, real_refuse = notedoc.state_tag, notedoc.set_title, notes._refuse_locked
    armed = [True]
    typed = threading.Event()
    written_on: list[str] = []

    def typing(doc) -> None:
        edit.append_paragraph(doc, "gleichzeitig getippt")
        typed.set()

    def state_tag(doc) -> str:
        tag = real_state(doc)
        if armed[0]:
            armed[0] = False
            asyncio.get_running_loop().create_task(notes.rooms().change(note["id"], typing, account_id=operator.id))
        return tag

    def refuse_locked(note_id: str) -> None:
        if not armed[0]:
            typed.wait(5)
        real_refuse(note_id)

    def set_title(doc, title: str) -> str:
        written_on.append(real_state(doc))
        return real_title(doc, title)

    monkeypatch.setattr(notedoc, "state_tag", state_tag)
    monkeypatch.setattr(notedoc, "set_title", set_title)
    monkeypatch.setattr(notes, "_refuse_locked", refuse_locked)
    answer = call(token, "PATCH", f"/api/v1/notes/{note['id']}", via=client, json={"title": "Neu", "pinned": True},
                  headers={"If-Match": f'"{etag}"'})
    assert answer.status_code == 200, answer.text
    assert written_on == [etag]
    monkeypatch.undo()
    assert wait_for(lambda: "gleichzeitig getippt" in markdown_of(token, note["id"]))
    row = stored(note["id"])
    assert row.title == "Neu" and row.pinned_at is not None
    assert ok(call(token, "GET", f"/api/v1/notes/{note['id']}"))["title"] == "Neu"


def test_notes25_ec8_pinning_a_note_shared_to_read_also_with_if_match(client, operator):
    token = token_of(client)
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        reading = new_note(as_anna, title="Zum Lesen", markdown="x")
        share(as_anna, "note", reading["id"], operator, "read")
    path = f"/api/v1/notes/{reading['id']}"
    etag = ok(call(token, "GET", path))["etag"]
    pinned = call(token, "PATCH", path, json={"pinned": True}, headers={"If-Match": f'"{etag}"'})
    assert pinned.status_code == 200, pinned.text
    assert pinned.json()["pinned"] is True and stored(reading["id"]).pinned_at is None
    # The state is still compared, and anything beyond pinning still needs the right to write.
    assert code(call(token, "PATCH", path, json={"pinned": False}, headers={"If-Match": '"0000"'})) == "note_changed"
    refused = call(token, "PATCH", path, json={"pinned": False, "title": "Meins"}, headers={"If-Match": f'"{etag}"'})
    assert refused.status_code == 403 and code(refused) == "not_allowed"
    assert ok(call(token, "GET", path))["pinned"] is True and stored(reading["id"]).title == "Zum Lesen"


# --- AC-19, EC-1: what the folder service refuses, the API's way ----------------------------------------------------


def test_notes25_ac19_ec1_folder_input_errors_answer_invalid_input_with_fields(client, operator):
    token = token_of(client)

    def fields_of(answer) -> list[str]:
        assert answer.status_code == 422 and code(answer) == "invalid_input", answer.text
        return answer.json()["detail"]["fields"]

    home = ok(call(token, "POST", "/api/v1/folders", json={"name": "Haushalt"}), 201)
    child = ok(call(token, "POST", "/api/v1/folders", json={"name": "Einkauf", "parent_id": home["id"]}), 201)
    for body, field in (({"name": "   "}, "name"), ({"name": ""}, "name"), ({"name": "x" * 61}, "name"),
                        ({"name": "Neu", "icon": "no-such-symbol"}, "icon"), ({"name": "Neu", "color": "red-ish"}, "color"),
                        ({"name": "Neu", "parent_id": "inbox"}, "parent_id")):
        assert fields_of(call(token, "POST", "/api/v1/folders", json=body)) == [field], body
    for body, field in (({"name": " "}, "name"), ({"color": "#fff"}, "color"), ({"icon": "nope"}, "icon"),
                        ({"parent_id": child["id"]}, "parent_id")):
        assert fields_of(call(token, "PATCH", f"/api/v1/folders/{home['id']}", json=body)) == [field], body
    # Other answers keep their code: a name that is there already, the inbox.
    taken = call(token, "POST", "/api/v1/folders", json={"name": "haushalt"})
    assert taken.status_code == 409 and code(taken) == "folder_name_taken"
    assert code(call(token, "DELETE", "/api/v1/folders/inbox")) == "inbox_fixed"
    with SessionLocal() as db:
        assert db.get(Folder, home["id"]).name == "Haushalt" and db.get(Folder, home["id"]).parent_id is None
    assert fields_of(call(token, "PATCH", "/api/v1/tags/backen", json={"name": " "})) == ["name"]


# --- AC-20, AC-7: renaming a tag tells nothing of tags outside the token's folders ---------------------------------


def test_notes25_ac20_ac7_renaming_a_tag_limited_to_folders_tells_nothing_of_tags_outside(client, operator):
    home = make_folder(client, "Haushalt")
    inside = new_note(client, markdown="drin #liste", folder_id=home)
    new_note(client, markdown="draußen #geheimprojekt")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, markdown="Annas #liste")
        share(as_anna, "note", theirs["id"], operator, "write")
    every = token_of(client)
    limited = token_of(client, name="limited", folders=[home])
    # Without a limit the account sees both tags and is asked.
    taken = call(every, "PATCH", "/api/v1/tags/liste", json={"name": "geheimprojekt"})
    assert taken.status_code == 409 and code(taken) == "tag_exists"
    # Within the folders the other tag is not there: renamed, and no note of somebody else counted.
    done = ok(call(limited, "PATCH", "/api/v1/tags/liste", json={"name": "geheimprojekt"}))
    assert done == {"name": "geheimprojekt", "changed": 1, "kept": 0}
    assert "#geheimprojekt" in markdown_of(every, inside["id"]) and "#liste" in markdown_of(every, theirs["id"])


# --- EC-1: an answer past 1 MB is cut in bytes ----------------------------------------------------------------------


def test_notes25_ec1_markdown_past_the_limit_is_cut_in_bytes_and_says_truncated(client, operator, monkeypatch):
    from app.services import apiv1

    # The limit itself: bytes of UTF-8, never half a character.
    text, cut = apiv1.cut_markdown("ä" * 600_000)
    assert cut is True and len(text.encode("utf-8")) == apiv1.MAX_MARKDOWN == 1_000_000 and set(text) == {"ä"}
    assert apiv1.cut_markdown("a" * 1_000_000) == ("a" * 1_000_000, False)
    text, cut = apiv1.cut_markdown("a" * 999_999 + "ä")
    assert cut is True and text == "a" * 999_999
    # Through the API, with a smaller limit: 120 umlauts are 240 bytes.
    token = token_of(client)
    note = new_note(client, title="U", markdown="ü" * 120)
    full = ok(call(token, "GET", f"/api/v1/notes/{note['id']}"))
    assert full["truncated"] is False and "ü" * 120 in full["markdown"]
    monkeypatch.setattr(apiv1, "MAX_MARKDOWN", 200)
    short = ok(call(token, "GET", f"/api/v1/notes/{note['id']}"))
    assert short["truncated"] is True and len(short["markdown"].encode("utf-8")) <= 200
    assert full["markdown"].startswith(short["markdown"]) and len(short["markdown"]) < len(full["markdown"])
