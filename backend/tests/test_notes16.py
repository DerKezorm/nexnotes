"""NOTES-16: the vault. Locked notes are encrypted on the device; the server never reads them.

The device is played by ``tests/vault_client.py`` with the same derivation and encryption the browser does. Also here:
the cases of earlier features that waited for a real vault (NOTES-5 EC-6, NOTES-6 AC-9/EC-3, NOTES-9 EC-2,
NOTES-11 EC-7, NOTES-17 EC-1), now against real locked notes instead of a stand-in.
"""

from __future__ import annotations

import asyncio
import io
import os
import sqlite3
import uuid
import zipfile
from datetime import timedelta
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Account, Note, NoteUpdate, utcnow
from app.models_attachments import Attachment
from app.models_history import NoteVersion
from app.models_ocr import AttachmentText
from app.models_tags import NoteTag
from app.models_vault import SealedNote, Vault
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.notedoc.room import CLOSE_LOCKED, Access
from app.services import accounts, attachments, backups, export, history, notes, vault, workqueue

from .conftest import DATA_DIR, MEDIA, make_account, new_client
from .notes_live import Live, refused
from .test_notes3 import token_for
from .vault_client import Device, attachment_aad, b64, note_aad, seal, unb64, unpack, unseal

VAULT_PASSWORD = "Tresor-Passwort 2026"


@pytest.fixture(autouse=True)
def close_connections(client, monkeypatch):
    # Exports and the recognition run when the test says, not in threads of their own.
    monkeypatch.setattr(export, "AUTO", False)
    monkeypatch.setattr(workqueue, "AUTO", False)
    yield
    Live.close_all()


@pytest.fixture
def device(client: TestClient, operator: Account) -> Device:
    return Device(client, operator.id)


def marker() -> str:
    """A word that stands nowhere else: lower case ASCII, so that the search index folds it to itself."""
    return "geheimnis" + uuid.uuid4().hex[:12]


def new_note(client: TestClient, title: str, markdown: str = "") -> str:
    answer = client.post("/api/notes", json={"title": title, "markdown": markdown})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def write(note_id: str, account_id: int, text: str) -> None:
    """Typed in the editor: an update through the live room, stored as such (``note_updates``)."""
    asyncio.run(notes.change(note_id, lambda doc: edit.append_paragraph(doc, text), account_id=account_id))


def add_blocks(note_id: str, account_id: int, *blocks: dict) -> None:
    def change(doc):
        body = notedoc.body_of(doc)
        notedoc.write_blocks(body, len(body.children), notedoc.clean_doc({"type": "doc", "content": list(blocks)})
                             ["content"])

    asyncio.run(notes.change(note_id, change, account_id=account_id))


def png(colour: str = "red") -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), colour).save(out, "PNG")
    return out.getvalue()


def upload(client: TestClient, note_id: str, data: bytes, name: str, **params: str) -> dict:
    answer = client.post("/api/attachments", params={"note_id": note_id, "id": attachments.new_id(), "name": name,
                                                     **params}, content=data)
    assert answer.status_code == 201, answer.text
    return answer.json()


def stored_note(note_id: str) -> Note:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        note.ydoc  # noqa: B018 - loaded before the session goes
        db.expunge(note)
        return note


def take_version(note_id: str) -> None:
    """The editing session ends: a version is taken (NOTES-15)."""
    history.clock.advance(minutes=10)
    history.take_due()


def files_holding(needles: list[bytes], root: Path) -> list[str]:
    """Every file below ``root`` that holds one of the needles."""
    found = []
    for path in root.rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            if any(needle in data for needle in needles):
                found.append(str(path.relative_to(root)))
    return found


def rich_note(client: TestClient, account: Account, secret: str) -> tuple[str, dict, dict]:
    """A note with everything that may carry its content: text with a tag, a live update, a version, a picture with
    recognised text, a file, an export made before."""
    note_id = new_note(client, "Versicherungen", f"Police {secret} #{secret}")
    write(note_id, account.id, f"Nummer {secret}-1")
    take_version(note_id)
    write(note_id, account.id, f"Ansprechpartner {secret}-2")
    picture = upload(client, note_id, png(), "Ausweis.png", text="device")
    assert client.put(f"/api/attachments/{picture['id']}/text",
                      json={"pages": [{"text": f"Ausweis {secret}-ocr", "language": "de"}]}).status_code == 200
    document = upload(client, note_id, f"Vertrag {secret}-datei".encode(), "Vertrag-geheim.txt")
    add_blocks(note_id, account.id, {"type": "image", "attrs": {"id": picture["id"], "name": "Ausweis.png"}},
               {"type": "attachment", "attrs": {"id": document["id"], "name": "Vertrag-geheim.txt"}})
    client.post("/api/export/jobs", json={})
    export.run_pending()
    return note_id, picture, document


# --- AC-1, AC-8: setting up, opening ------------------------------------------------------------------------------


def test_notes16_ac1_the_vault_is_set_up_once_and_only_with_the_box_ticked(client, operator, device):
    assert client.get("/api/vault").json() == {"set_up": False, "locked_notes": 0, "locked_all": 0}
    body = {**device.wrap(VAULT_PASSWORD, os.urandom(32)), "understood": False}
    answer = client.post("/api/vault/setup", json=body)
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "vault_not_understood"
    device.setup(VAULT_PASSWORD)
    status = client.get("/api/vault").json()
    assert status["set_up"] is True and status["epoch"] == 1 and status["kdf"]["iterations"] >= 600_000
    again = client.post("/api/vault/setup", json={**device.wrap("anderes", os.urandom(32)), "understood": True})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "vault_exists"
    # The server keeps only the hash of the check value and the wrapped key, never the password or the key.
    with SessionLocal() as db:
        row = db.get(Vault, operator.id)
        assert VAULT_PASSWORD.encode() not in row.wrapped_key and device.key not in row.wrapped_key
        assert len(row.auth_hash) == 64


def test_notes16_ac1_weak_derivations_are_refused(client, operator, device):
    body = {**device.wrap(VAULT_PASSWORD, os.urandom(32)), "understood": True}
    body["kdf"] = {**body["kdf"], "iterations": 1000}
    assert client.post("/api/vault/setup", json=body).status_code == 422
    body["kdf"] = {**body["kdf"], "iterations": 600_000, "hash": "SHA-1"}
    assert client.post("/api/vault/setup", json=body).status_code == 422


def test_notes16_ac8_with_a_vault_locking_asks_only_the_password(client, operator, device):
    device.setup(VAULT_PASSWORD)
    device.forget()
    device.open(VAULT_PASSWORD)
    note_id = new_note(client, "Zweite", "Inhalt")
    assert device.lock(note_id)["locked"] is True


# --- AC-2, EC-3, EC-4: nothing plain anywhere ---------------------------------------------------------------------


def test_notes16_ac2_ec3_ec4_after_locking_no_plain_text_is_left_in_the_data_folder(client, operator, device):
    secret = marker()
    note_id, picture, document = rich_note(client, operator, secret)
    needles = [secret.encode(), secret.encode("utf-16-le"), b"Vertrag-geheim", b"Ausweis.png"]
    # Before: the content is in the database, the files, the search, the export.
    assert files_holding(needles, Path(DATA_DIR))
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NoteUpdate).where(NoteUpdate.note_id == note_id))
        assert db.scalar(select(func.count()).select_from(NoteVersion).where(NoteVersion.note_id == note_id))
        assert db.scalar(select(func.count()).select_from(AttachmentText)
                         .where(AttachmentText.attachment_id == picture["id"]))
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    # After: not in the database, its log, the versions, the index, the recognised text, the files, the export ZIPs.
    assert files_holding(needles, Path(DATA_DIR)) == []
    note = stored_note(note_id)
    assert note.locked and note.ydoc == b"" and note.text == "" and note.title == "Versicherungen"
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NoteUpdate).where(NoteUpdate.note_id == note_id)) == 0
        assert db.scalar(select(func.count()).select_from(NoteTag).where(NoteTag.note_id == note_id)) == 0
        assert db.scalar(select(func.count()).select_from(AttachmentText)
                         .where(AttachmentText.attachment_id.in_([picture["id"], document["id"]]))) == 0
        versions = list(db.scalars(select(NoteVersion).where(NoteVersion.note_id == note_id)))
        assert versions and all(version.sealed for version in versions)
        rows = list(db.scalars(select(Attachment).where(Attachment.note_id == note_id)))
        assert {row.kind for row in rows} == {"sealed"} and {row.name for row in rows} == {""}
    for attachment_id in (picture["id"], document["id"]):
        assert not attachments.path_of(attachment_id, attachments.VIEW).exists()
        assert not attachments.path_of(attachment_id, attachments.THUMB).exists()
        # The file is the device's ciphertext: it opens with the note's key and nothing else.
        sealed_file = attachments.path_of(attachment_id).read_bytes()
        header, _data = unpack(unseal(device.nkey(note_id), sealed_file, attachment_aad(note_id, attachment_id)))
        assert header["name"] in ("Ausweis.png", "Vertrag-geheim.txt")


def test_notes16_ec3_every_interface_gives_title_and_locked_only(client, operator, device):
    secret = marker()
    note_id, picture, _document = rich_note(client, operator, secret)
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    answers = [
        client.get(f"/api/notes/{note_id}"), client.get("/api/notes"), client.get("/api/note-list"),
        client.get("/api/search", params={"q": "versicherungen"}), client.get("/api/tags"),
        client.get(f"/api/notes/{note_id}/history"), client.get(f"/api/notes/{note_id}/attachments"),
        client.get(f"/api/export/notes/{note_id}/markdown"), client.get(f"/api/attachments/{picture['id']}/text"),
        client.get("/api/attachments"), client.get(f"/api/vault/notes/{note_id}"),
    ]
    for answer in answers:
        assert secret not in answer.text and "Vertrag-geheim" not in answer.text, answer.request.url
    head = client.get(f"/api/notes/{note_id}").json()
    assert head["locked"] is True and head["title"] == "Versicherungen" and head["preview"] == ""
    assert client.get("/api/search", params={"q": secret}).json()["total"] == 0
    assert client.get("/api/search", params={"q": "Versicherungen"}).json()["total"] == 1
    markdown = client.get(f"/api/export/notes/{note_id}/markdown").text
    assert "Versicherungen" in markdown and "locked, not exported" in markdown
    # Recognition (NOTES-11): nothing to read, and nothing to bring either.
    assert client.put(f"/api/attachments/{picture['id']}/text",
                      json={"pages": [{"text": "x"}]}).status_code in (409, 422)
    # A version opens only on the device.
    version_id = client.get(f"/api/notes/{note_id}/history").json()["versions"][0]["id"]
    version = client.get(f"/api/notes/{note_id}/history/{version_id}").json()
    assert version["sealed"] is True and "content" not in version
    plain = unseal(device.nkey(note_id), unb64(version["content_sealed"]), note_aad(note_id))
    assert secret in to_plain(notedoc.load(plain))


def test_notes16_ec3_the_server_changes_nothing_in_a_locked_note(client, operator, device):
    note_id = new_note(client, "Gesperrt", "Text")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    with pytest.raises(HTTPException) as caught:
        write(note_id, operator.id, "vom Server")
    assert "note_locked" in str(caught.value.detail)
    assert client.post(f"/api/notes/{note_id}/duplicate").status_code == 409
    assert client.post(f"/api/notes/{note_id}/discard").json() == {"discarded": False}
    assert client.post(f"/api/notes/{note_id}/link-preview",
                       json={"url": "https://example.com/geheim"}).json()["reason"] == "locked"
    plain_upload = client.post("/api/attachments", params={"note_id": note_id, "id": attachments.new_id(),
                                                           "name": "x.txt"}, content=b"plain")
    assert plain_upload.status_code == 409 and plain_upload.json()["detail"]["code"] == "note_locked"
    # The title stays the member's to change (AC-6): the column only.
    assert client.put(f"/api/notes/{note_id}/title", json={"title": "Neuer Titel"}).json()["title"] == "Neuer Titel"
    assert asyncio.run(notes.after_last_left(note_id, grace=0)) is None
    assert stored_note(note_id).locked


def test_notes16_ec4_a_backup_holds_the_locked_note_encrypted_and_brings_it_back_so(client, operator, device,
                                                                                    tmp_path):
    secret = marker()
    note_id, _picture, _document = rich_note(client, operator, secret)
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    sealed_before = device.read(note_id)
    archive = backups.create(note="after locking")
    with zipfile.ZipFile(archive) as opened:
        for name in opened.namelist():
            data = opened.read(name)
            assert secret.encode() not in data and b"Vertrag-geheim" not in data, name
        database = tmp_path / "backup.db"
        database.write_bytes(opened.read(backups.DATABASE_ENTRY))
    # The copy brings the note back as it was: locked, with the same ciphertext the device opens.
    with sqlite3.connect(database) as copy:
        locked, = copy.execute("SELECT locked FROM notes WHERE id = ?", (note_id,)).fetchone()
        content, rev = copy.execute("SELECT content, rev FROM sealed_notes WHERE note_id = ?", (note_id,)).fetchone()
    assert locked == 1 and rev == sealed_before[1]
    assert unseal(device.nkey(note_id), content, note_aad(note_id)) == sealed_before[0]


# --- AC-3, AC-7, EC-6: opening, editing, saving -------------------------------------------------------------------


def test_notes16_ac3_ac7_the_device_opens_edits_and_saves_and_the_server_sees_only_ciphertext(client, operator,
                                                                                            device):
    secret = marker()
    note_id = new_note(client, "Haushalt", f"WLAN {secret}")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    device.forget()
    with pytest.raises(AssertionError):
        device.read(note_id)
    device.open(VAULT_PASSWORD)
    state, rev = device.read(note_id)
    document = notedoc.load(state)
    assert secret in to_plain(document) and notedoc.title_of(document) == "Haushalt"
    edit.append_paragraph(document, f"Gast {secret}-neu")
    answer = device.save(note_id, document.get_update(), rev, title="Haushalt und Codes")
    assert answer.status_code == 200 and answer.json() == {"rev": rev + 1, "conflict": False}
    again, now = device.read(note_id)
    assert f"{secret}-neu" in to_plain(notedoc.load(again)) and now == rev + 1
    head = client.get(f"/api/notes/{note_id}").json()
    assert head["title"] == "Haushalt und Codes" and head["locked"] is True
    with SessionLocal() as db:
        stored = db.get(SealedNote, note_id).content
    assert secret.encode() not in stored
    assert files_holding([secret.encode()], Path(DATA_DIR)) == []


def test_notes16_ac3_ec6_a_wrong_key_opens_nothing(client, operator, device):
    note_id = new_note(client, "Haushalt", "geheim")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    sealed = unb64(client.get(f"/api/vault/notes/{note_id}").json()["content"])
    with pytest.raises(InvalidTag):
        unseal(os.urandom(32), sealed, note_aad(note_id))
    # Bound to its note: the same ciphertext under another note's name does not open.
    with pytest.raises(InvalidTag):
        unseal(device.nkey(note_id), sealed, note_aad(str(uuid.uuid4())))


def test_notes16_ac7_a_locked_note_has_no_live_room(client, operator, device):
    note_id = new_note(client, "Offen", "Text")
    device.setup(VAULT_PASSWORD)
    token = token_for(operator)
    open_tab = Live(client, note_id, token)
    open_tab.settle()
    assert open_tab.synced
    device.lock(note_id)
    open_tab.pump(lambda: open_tab.closed is not None)
    assert open_tab.closed == CLOSE_LOCKED
    assert refused(client, note_id, token) == CLOSE_LOCKED


def test_notes16_new_attachments_of_an_open_locked_note_arrive_encrypted(client, operator, device):
    note_id = new_note(client, "Mit Bild", "Text")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    attachment_id = attachments.new_id()
    sealed = seal(device.nkey(note_id), b"\x00\x00\x00\x02{}" + png(), attachment_aad(note_id, attachment_id))
    answer = client.put("/api/vault/attachments", params={"note": note_id, "id": attachment_id}, content=sealed)
    assert answer.status_code == 201, answer.text
    assert answer.json()["sealed"] is True and answer.json()["name"] == ""
    assert client.get(f"/api/attachments/{attachment_id}/file").content == sealed
    assert client.get(f"/api/attachments/{attachment_id}/thumb").status_code == 404
    # Counted towards the storage; a full one takes nothing more.
    with SessionLocal() as db:
        db.get(Account, operator.id).storage_limit = attachments.used(db, operator.id) + 10
        db.commit()
    full = client.put("/api/vault/attachments", params={"note": note_id, "id": attachments.new_id()},
                      content=os.urandom(4000))
    assert full.status_code == 507
    # Not in the gallery, never read by the recognition.
    assert client.get("/api/attachments").json()["total"] == 0


# --- AC-4: "Sperre aufheben" ----------------------------------------------------------------------------------------


def test_notes16_ac4_unlocking_makes_a_normal_note_again(client, operator, device):
    secret = marker()
    note_id, picture, document = rich_note(client, operator, secret)
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    versions_locked = len(client.get(f"/api/notes/{note_id}/history").json()["versions"])
    device.unlock(note_id)
    note = stored_note(note_id)
    assert not note.locked and secret in note.text
    with SessionLocal() as db:
        assert db.get(SealedNote, note_id) is None
        assert db.scalar(select(func.count()).select_from(NoteTag).where(NoteTag.note_id == note_id)) == 1
        rows = {row.id: row for row in db.scalars(select(Attachment).where(Attachment.note_id == note_id))}
    assert rows[picture["id"]].kind == "image" and rows[picture["id"]].name == "Ausweis.png"
    assert rows[picture["id"]].has_thumb and rows[document["id"]].name == "Vertrag-geheim.txt"
    assert client.get(f"/api/attachments/{document['id']}/file").content == f"Vertrag {secret}-datei".encode()
    assert client.get("/api/search", params={"q": secret}).json()["total"] == 1
    history_now = client.get(f"/api/notes/{note_id}/history").json()["versions"]
    assert len(history_now) == versions_locked and not any(version["sealed"] for version in history_now)
    version = client.get(f"/api/notes/{note_id}/history/{history_now[-1]['id']}").json()
    assert secret in version["text"]
    # The live room takes it again.
    write(note_id, operator.id, "wieder offen")
    assert "wieder offen" in stored_note(note_id).text or "wieder offen" in to_plain(notedoc.load(
        stored_note(note_id).ydoc, [row for row in _updates(note_id)]))


def _updates(note_id: str) -> list[bytes]:
    with SessionLocal() as db:
        return list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id)
                               .order_by(NoteUpdate.id)))


def test_notes16_ac4_an_unlock_with_garbage_for_content_is_refused(client, operator, device):
    note_id = new_note(client, "Gesperrt", "Text")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    start = client.post(f"/api/vault/notes/{note_id}/unlock/start").json()
    for part in ["content", *(f"version:{v['id']}" for v in start["versions"])]:
        client.put("/api/vault/stage", params={"note": note_id, "step": "unlock", "part": part},
                   content=b"no yjs state")
    answer = client.post(f"/api/vault/notes/{note_id}/unlock", json={"names": {}})
    assert answer.status_code == 422
    assert stored_note(note_id).locked


# --- The steps: incomplete, broken off, someone else's ------------------------------------------------------------


def test_notes16_ac2_a_lock_without_all_parts_changes_nothing_and_can_be_broken_off(client, operator, device):
    note_id = new_note(client, "Halb", "Text")
    picture = upload(client, note_id, png(), "Bild.png")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id, keep={f"attachment:{picture['id']}"})
    answer = client.post(f"/api/vault/notes/{note_id}/lock")
    assert answer.status_code == 409 and answer.json()["detail"]["missing"] == [f"attachment:{picture['id']}"]
    assert not stored_note(note_id).locked
    # Meanwhile no change comes in, not even the server's.
    with pytest.raises(HTTPException):
        write(note_id, operator.id, "dazwischen")
    assert client.post(f"/api/vault/notes/{note_id}/lock/cancel").status_code == 204
    write(note_id, operator.id, "danach")
    assert attachments.path_of(picture["id"]).read_bytes().startswith(b"\x89PNG")


def test_notes16_others_never_reach_a_locked_note(client, operator, device, monkeypatch):
    note_id = new_note(client, "Meins", "Text")
    device.setup(VAULT_PASSWORD)
    anna = make_account("anna")
    # A share that would let Anna read the note (NOTES-13): a locked note stays its owner's alone.
    monkeypatch.setattr(notes, "ACCESS_RULES", [lambda _db, account, _note: Access.READ
                                                 if account.id == anna.id else None])
    with new_client(anna) as theirs:
        assert theirs.get(f"/api/notes/{note_id}").status_code == 200
        device.lock(note_id)
        assert theirs.get(f"/api/notes/{note_id}").status_code == 404
        assert theirs.get(f"/api/vault/notes/{note_id}").status_code in (404, 409)
        assert theirs.post(f"/api/vault/notes/{note_id}/unlock/start").status_code == 404


def test_notes16_a_shared_note_cannot_be_locked(client, operator, device, monkeypatch):
    """NOTES-13 EC-3: sharing fills ``vault.SHARE_CHECKS``; until then a stand-in."""
    note_id = new_note(client, "Geteilt", "Text")
    device.setup(VAULT_PASSWORD)
    monkeypatch.setattr(vault, "SHARE_CHECKS", [lambda _db, note: note.id == note_id])
    answer = client.post(f"/api/vault/notes/{note_id}/lock/start")
    assert answer.status_code == 409 and answer.json()["detail"]["code"] == "note_shared"


# --- AC-5, EC-7: a new password -----------------------------------------------------------------------------------


def test_notes16_ac5_ec7_a_new_password_counts_everywhere_and_the_old_session_must_open_again(client, operator,
                                                                                            device):
    note_id = new_note(client, "Haushalt", "Text")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    tablet = Device(new_client(operator), operator.id)
    tablet.open(VAULT_PASSWORD)
    state, rev = tablet.read(note_id)
    vault_key = device.key
    answer = client.post("/api/vault/password", json={"auth_old": device.auth_of(VAULT_PASSWORD),
                                                      **device.wrap("neues Passwort", vault_key)})
    assert answer.status_code == 200 and answer.json()["epoch"] == 2
    # The other device still holds the key of before: its save is refused, it locks and asks again (EC-7).
    refused_save = tablet.save(note_id, state, rev)
    assert refused_save.status_code == 409 and refused_save.json()["detail"]["code"] == "vault_changed"
    assert tablet.try_open(VAULT_PASSWORD).status_code == 403
    tablet.open("neues Passwort")
    assert tablet.key == vault_key and tablet.read(note_id)[0] == state
    assert tablet.save(note_id, state, rev).status_code == 200
    tablet.client.close()


def test_notes16_ac5_the_old_password_is_checked_and_counted(client, operator, device):
    device.setup(VAULT_PASSWORD)
    answer = client.post("/api/vault/password", json={"auth_old": device.auth_of("falsch"),
                                                      **device.wrap("neu", os.urandom(32))})
    assert answer.status_code == 403
    with SessionLocal() as db:
        assert db.get(Vault, operator.id).failures == 1 and db.get(Vault, operator.id).epoch == 1


# --- EC-1: wrong passwords ----------------------------------------------------------------------------------------


def test_notes16_ec1_three_wrong_passwords_wait_thirty_seconds_then_twice_as_long(client, operator, device,
                                                                                monkeypatch):
    device.setup(VAULT_PASSWORD)
    now = [utcnow()]
    monkeypatch.setattr(vault, "utcnow", lambda: now[0])
    first = device.try_open("falsch 1")
    assert first.status_code == 403 and first.json()["detail"]["left"] == 2
    device.try_open("falsch 2")
    third = device.try_open("falsch 3")
    assert third.status_code == 403 and third.json()["detail"]["wait"] == 30
    # During the wait even the right password is not taken; the page shows the seconds left.
    waiting = device.try_open(VAULT_PASSWORD)
    assert waiting.status_code == 429 and 0 < waiting.json()["detail"]["wait"] <= 30
    assert client.get("/api/vault").json()["wait"] == 30
    now[0] += timedelta(seconds=31)
    for _ in range(2):
        assert device.try_open("wieder falsch").json()["detail"]["wait"] == 0
    assert device.try_open("wieder falsch").json()["detail"]["wait"] == 60
    now[0] += timedelta(seconds=61)
    for _ in range(3):
        last = device.try_open("noch falsch")
    assert last.json()["detail"]["wait"] == 120
    now[0] += timedelta(seconds=121)
    assert device.try_open(VAULT_PASSWORD).status_code == 200
    with SessionLocal() as db:
        row = db.get(Vault, operator.id)
        assert (row.failures, row.rounds, row.wait_until) == (0, 0, None)


# --- EC-2: forgotten password -------------------------------------------------------------------------------------


def test_notes16_ec2_a_new_vault_takes_every_locked_note_but_only_with_the_number_seen(client, operator, device):
    kept = new_note(client, "Offen", "bleibt")
    first = new_note(client, "Gesperrt 1", "weg")
    second = new_note(client, "Gesperrt 2", "weg")
    picture = upload(client, second, png(), "Bild.png")
    device.setup(VAULT_PASSWORD)
    device.lock(first)
    device.lock(second)
    assert client.delete(f"/api/notes/{first}").status_code == 204
    status = client.get("/api/vault").json()
    assert status["locked_notes"] == 1 and status["locked_all"] == 2
    fresh = Device(client, operator.id)
    body = {**fresh.wrap("neues Passwort", os.urandom(32)), "understood": True}
    wrong = client.post("/api/vault/reset", json={**body, "count": 1})
    assert wrong.status_code == 409 and wrong.json()["detail"] == {
        "code": "vault_count", "message": "The number of locked notes changed.", "count": 2}
    answer = client.post("/api/vault/reset", json={**body, "count": 2})
    assert answer.status_code == 200 and answer.json()["removed"] == 2 and answer.json()["epoch"] == 2
    with SessionLocal() as db:
        assert db.get(Note, first) is None and db.get(Note, second) is None and db.get(Note, kept) is not None
        assert db.get(Attachment, picture["id"]) is None
    assert not attachments.path_of(picture["id"]).exists()
    assert fresh.try_open(VAULT_PASSWORD).status_code == 403
    assert fresh.try_open("neues Passwort").status_code == 200


# --- EC-5: two devices --------------------------------------------------------------------------------------------


def test_notes16_ec5_two_devices_the_later_save_wins_and_the_other_stays_in_the_history(client, operator, device):
    note_id = new_note(client, "Liste", "Anfang")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    tablet = Device(new_client(operator), operator.id)
    tablet.open(VAULT_PASSWORD)
    state, rev = device.read(note_id)
    mine, theirs = notedoc.load(state), notedoc.load(state)
    edit.append_paragraph(mine, "vom Laptop")
    edit.append_paragraph(theirs, "vom Tablet")
    assert device.save(note_id, mine.get_update(), rev).json() == {"rev": rev + 1, "conflict": False}
    # Written on the revision before: it still becomes the current one, nothing is merged silently ...
    assert tablet.save(note_id, theirs.get_update(), rev).json() == {"rev": rev + 2, "conflict": True}
    now, _ = device.read(note_id)
    assert "vom Tablet" in to_plain(notedoc.load(now)) and "vom Laptop" not in to_plain(notedoc.load(now))
    # ... and the laptop's text is in the history.
    found = []
    for entry in client.get(f"/api/notes/{note_id}/history").json()["versions"]:
        version = client.get(f"/api/notes/{note_id}/history/{entry['id']}").json()
        found.append(to_plain(notedoc.load(unseal(device.nkey(note_id), unb64(version["content_sealed"]),
                                                  note_aad(note_id)))))
    assert any("vom Laptop" in text for text in found)
    tablet.client.close()


def test_notes16_ec5_restoring_a_version_of_a_locked_note_keeps_the_one_before(client, operator, device):
    note_id = new_note(client, "Liste", "erste Fassung")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    state, rev = device.read(note_id)
    later = notedoc.load(state)
    edit.append_paragraph(later, "zweite Fassung")
    device.save(note_id, later.get_update(), rev)
    take_version(note_id)
    old_id = client.get(f"/api/notes/{note_id}/history").json()["versions"][-1]["id"]
    assert client.post(f"/api/notes/{note_id}/history/{old_id}/restore").status_code == 409
    old = client.get(f"/api/notes/{note_id}/history/{old_id}").json()
    plain = unseal(device.nkey(note_id), unb64(old["content_sealed"]), note_aad(note_id))
    _now, rev_now = device.read(note_id)
    answer = device.save(note_id, plain, rev_now, restored_from=old_id)
    assert answer.status_code == 200
    listing = client.get(f"/api/notes/{note_id}/history").json()["versions"]
    assert listing[0]["restored_from"] is not None


# --- EC-8: the account goes ---------------------------------------------------------------------------------------


def test_notes16_ec8_a_deleted_account_s_locked_notes_stay_encrypted_and_go_with_it(client, operator):
    secret = marker()
    anna = make_account("anna")
    with new_client(anna) as theirs:
        phone = Device(theirs, anna.id)
        note_id = new_note(theirs, "Annas Tresor", f"Inhalt {secret}")
        picture = upload(theirs, note_id, png(), "Bild.png")
        phone.setup(VAULT_PASSWORD)
        phone.lock(note_id)
    with SessionLocal() as db:
        accounts.delete_account(db, db.get(Account, anna.id))
    # In the 30 days the operator reaches nothing of it, and the data folder holds it only encrypted.
    assert client.get(f"/api/notes/{note_id}").status_code == 404
    assert client.get(f"/api/vault/notes/{note_id}").status_code == 404
    assert files_holding([secret.encode()], Path(DATA_DIR)) == []
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        row.deleted_at = utcnow() - timedelta(days=31)
        db.commit()
        assert accounts.purge_deleted(db) == 1
        assert db.get(Vault, anna.id) is None and db.get(SealedNote, note_id) is None
    attachments.cleanup()
    assert db_free(picture["id"])


def db_free(attachment_id: str) -> bool:
    with SessionLocal() as db:
        return db.get(Attachment, attachment_id) is None


# --- The vault ends nothing it should not ---------------------------------------------------------------------------


def test_notes16_the_storage_counts_the_encrypted_note(client, operator, device):
    from app.services import content

    note_id = new_note(client, "Gross", "x" * 5000)
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    with SessionLocal() as db:
        size = len(db.get(SealedNote, note_id).content)
        total = content.counts(db, operator.id).bytes
    assert size > 5000 and total >= size


def test_notes16_a_wrong_password_is_logged_without_anything_of_it(client, operator, device, caplog):
    device.setup(VAULT_PASSWORD)
    caplog.clear()
    device.try_open("mein falsches Passwort")
    text = caplog.text
    assert "Wrong vault password" in text and "falsches" not in text and VAULT_PASSWORD not in text


def test_notes16_catch_up_puts_files_in_place_after_a_stop(client, operator, device):
    note_id = new_note(client, "Bild", "x")
    picture = upload(client, note_id, png(), "Bild.png")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    sealed = attachments.path_of(picture["id"]).read_bytes()
    # As if the server stopped right after the commit: the plain file still there, the staged one waiting.
    staged = vault.stage_path(note_id, vault.LOCK, f"attachment:{picture['id']}")
    staged.write_bytes(sealed)
    attachments.path_of(picture["id"]).write_bytes(png())
    assert vault.catch_up() == 1
    assert attachments.path_of(picture["id"]).read_bytes() == sealed and not staged.exists()


# --- Earlier features that waited for the vault -------------------------------------------------------------------


def test_notes5_ec6_with_the_vault_a_locked_note_s_tags_count_nowhere(client, operator, device):
    open_note = new_note(client, "Offen", "#urlaub am Meer")
    locked = new_note(client, "Tresor", "#urlaub #geheimprojekt")
    device.setup(VAULT_PASSWORD)
    device.lock(locked)
    tags = {tag["key"]: tag["count"] for tag in client.get("/api/tags").json()["tags"]}
    assert tags == {"urlaub": 1}
    listed = {item["id"]: item for item in client.get("/api/notes").json()}
    assert listed[locked]["tags"] == [] and listed[open_note]["tags"] == ["urlaub"]
    assert client.get("/api/tags/geheimprojekt").json()["notes"] == []


def test_notes6_ac9_ec3_with_the_vault_a_locked_note_shows_title_and_lock_only(client, operator, device):
    secret = marker()
    locked = new_note(client, "WLAN-Gäste und Codes", f"- [ ] Passwort {secret}")
    upload(client, locked, png(), "Bild.png")
    device.setup(VAULT_PASSWORD)
    device.lock(locked)
    answer = client.get("/api/note-list")
    item = next(entry for entry in answer.json()["items"] if entry["id"] == locked)
    assert item["locked"] is True and item["title"] == "WLAN-Gäste und Codes"
    assert item["preview"] == "" and item["tasks"] is None and "media" not in item and "tags" not in item
    assert secret not in answer.text


def test_notes9_ec2_with_the_vault_a_locked_note_is_found_by_its_title_only(client, operator, device):
    secret = marker()
    locked = new_note(client, "Steuer Tresor", f"Steuernummer {secret}")
    device.setup(VAULT_PASSWORD)
    device.lock(locked)
    assert client.get("/api/search", params={"q": secret}).json()["total"] == 0
    hits = client.get("/api/search", params={"q": "steuer tresor"}).json()
    assert hits["total"] == 1 and secret not in str(hits)


def test_notes11_ec7_with_the_vault_nothing_is_read_in_a_locked_note(client, operator, device):
    from app.models_ocr import AttachmentOcr

    note_id = new_note(client, "Scan", "x")
    picture = upload(client, note_id, png(), "Scan.png", text="device")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    with SessionLocal() as db:
        state = db.get(AttachmentOcr, picture["id"])
        assert state is None or state.state == "locked"
    answer = client.get(f"/api/attachments/{picture['id']}/text")
    assert answer.status_code in (200, 409)
    if answer.status_code == 200:
        assert answer.json()["state"] in ("locked", "none") and answer.json()["items"] == []
    # A sealed attachment added later is never queued.
    attachment_id = attachments.new_id()
    client.put("/api/vault/attachments", params={"note": note_id, "id": attachment_id},
               content=seal(device.nkey(note_id), b"x", attachment_aad(note_id, attachment_id)))
    with SessionLocal() as db:
        assert db.get(AttachmentOcr, attachment_id) is None


def test_notes17_ec1_with_the_vault_a_locked_note_is_exported_with_title_and_hint_only(client, operator, device):
    secret = marker()
    locked = new_note(client, "Tresor", f"Geheim {secret}")
    upload(client, locked, png(), "pass.png")
    new_note(client, "Offen", "lesbar")
    device.setup(VAULT_PASSWORD)
    device.lock(locked)
    single = client.get(f"/api/export/notes/{locked}/markdown")
    assert secret not in single.text and "locked, not exported" in single.text
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/export/jobs/{job['id']}/download").content))
    names = archive.namelist()
    assert not any("pass.png" in name for name in names)
    for name in names:
        assert secret.encode() not in archive.read(name)
    pdf = client.get(f"/api/export/notes/{locked}/pdf")
    assert pdf.status_code == 200 and secret.encode() not in pdf.content


def test_notes16_the_media_folder_holds_no_stray_plain_parts_after_locking(client, operator, device):
    note_id = new_note(client, "Bild", "x")
    upload(client, note_id, png(), "Bild.png")
    device.setup(VAULT_PASSWORD)
    device.lock(note_id)
    leftovers = [path.name for path in MEDIA.iterdir() if path.name.startswith(attachments.WORK_PREFIX)]
    assert leftovers == []


def test_notes16_ac2_the_password_and_keys_never_reach_the_server(client, operator, device, caplog):
    device.setup(VAULT_PASSWORD)
    note_id = new_note(client, "x", "y")
    device.lock(note_id)
    needles = [VAULT_PASSWORD.encode(), device.key]
    assert files_holding(needles, Path(DATA_DIR)) == []
    assert VAULT_PASSWORD not in caplog.text and b64(device.key) not in caplog.text



def test_notes16_the_vectors_of_the_browser():
    """The same bytes as ``frontend/src/vault/vault.test.tsx`` (fixed vectors): the browser, these tests and the iOS
    app derive, wrap and encrypt alike."""
    from .vault_client import derive, note_key

    kek, auth = derive("Tresor-Passwort 2026", bytes(range(16)))
    assert b64(auth) == "JRORMaItQVOTPJoW3Ef0nnb552SFJt/mi6gbKi//jvs="
    wrapped = unb64("AQcHBwcHBwcHBwcHB2uYq195Bav/93xmWPh2D1sdf63zmmkp/DB/aqvEQP1JrYoN/h4af0uJNWt59v9R3w==")
    vault_key = unseal(kek, wrapped, "nexnotes vault key v1|7")
    assert vault_key == bytes(range(32))
    blob = unb64("AQcHBwcHBwcHBwcHB9lc9TGo2OAv4aqCNDH2RELAytw2r1xmmE2BhlUl")
    assert unseal(note_key(vault_key, "note-1"), blob, note_aad("note-1")).decode() == "Geheim äöü"
