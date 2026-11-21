"""NOTES-11 Texterkennung and NOTES-18, findings of the review: the text of a note locked after its attachments were
read, rounds per account in the work queue, pages of the large view from disk and in line, recordings through the
worker with limits and into a file, foreign text kept out of the search, transcripts nested too deep, and how many
pages the iOS app may bring."""

from __future__ import annotations

import io
import shutil
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Note
from app.models_ocr import AttachmentText, WorkJob
from app.services import attachments, media, ocr, sketches, tags, workqueue

from .conftest import make_account, new_client
from .test_notes3 import new_note
from .test_notes10 import add_blocks, block, pdf_of, upload
from .test_notes11 import (  # noqa: F401 - the fixtures of NOTES-11 apply here too
    attach,
    close_connections,
    empty_index,
    engine,
    find,
    picture,
    setup,
    state_of,
    text_of,
)
from .test_notes18 import m4a_of, send

FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


def texts_in_db(attachment_id: str) -> list[str]:
    with SessionLocal() as db:
        return list(db.scalars(select(AttachmentText.text).where(AttachmentText.attachment_id == attachment_id)))


def lock(note_id: str, locked: bool) -> None:
    """What NOTES-16 will do when a note is locked or unlocked."""
    with SessionLocal() as db:
        tags.lock_changed(db, note_id, locked)
        db.commit()


# --- 1: a note locked after its attachments were read ----------------------------------------------------------------


def test_notes11_ec7_a_note_locked_after_its_text_was_read_loses_that_text(client, operator, engine, monkeypatch):  # noqa: F811 - the fixture of NOTES-11
    note = new_note(client, title="Tresor")
    row = attach(client, note["id"], picture(), "Vertrag.png", operator.id)
    engine.pages[row["id"]] = ["Geheimer Vertragstext"]
    workqueue.run_pending()
    assert state_of(row["id"]).state == "done" and texts_in_db(row["id"]) == ["Geheimer Vertragstext"]
    # Locked: at once nothing is given out, even before the text is gone.
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id == note["id"]])
    assert text_of(client, row["id"]) == {"id": row["id"], "state": "locked", "pages": 1, "items": []}
    lock(note["id"], True)
    assert texts_in_db(row["id"]) == [] and state_of(row["id"]).state == "locked"
    workqueue.run_pending()
    assert len(engine.asked(row["id"])) == 1
    # Unlocked: read again.
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [])
    lock(note["id"], False)
    workqueue.run_pending()
    assert state_of(row["id"]).state == "done" and texts_in_db(row["id"]) == ["Geheimer Vertragstext"]


def test_notes11_ec7_a_lock_no_hook_saw_loses_its_text_at_the_next_start(client, operator, engine, monkeypatch):  # noqa: F811 - the fixture of NOTES-11
    note = new_note(client, title="Tresor")
    row = attach(client, note["id"], picture(), "Brief.png", operator.id)
    engine.pages[row["id"]] = ["Geheimer Brief"]
    workqueue.run_pending()
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id == note["id"]])
    ocr.catch_up()
    assert texts_in_db(row["id"]) == [] and state_of(row["id"]).state == "locked"


# --- 2: rounds per account, and a cap of waiting jobs ----------------------------------------------------------------


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch):
    done: list[str] = []
    monkeypatch.setitem(workqueue.HANDLERS, "probe", workqueue.Kind(run=lambda ref: done.append(ref)))
    return done


def _enqueue(ref: str, account: int) -> bool:
    with SessionLocal() as db:
        put = workqueue.enqueue(db, "probe", ref, account=account)
        db.commit()
    return put


def test_notes11_ec6_the_queue_serves_the_accounts_in_rounds(client, probe):
    for index in range(30):
        _enqueue(f"anna-{index}", 1)
    _enqueue("ben-0", 2)
    _enqueue("ben-1", 2)
    workqueue.run_pending(limit=4)
    # Ben does not wait thirty turns behind Anna.
    assert probe[:4] in (["anna-0", "ben-0", "anna-1", "ben-1"], ["ben-0", "anna-0", "ben-1", "anna-1"])
    workqueue.run_pending()
    assert len(probe) == 32


def test_notes11_ec6_an_account_has_at_most_so_many_jobs_waiting_and_the_rest_comes_later(
        client, operator, engine, monkeypatch, probe):  # noqa: F811 - the fixture of NOTES-11
    monkeypatch.setattr(workqueue, "MAX_WAITING", 3)
    assert [_enqueue(f"anna-{index}", 1) for index in range(5)] == [True, True, True, False, False]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(WorkJob).where(WorkJob.account_id == 1)) == 3
    workqueue.run_pending()
    # The recognition comes back for what was refused: every picture is read in the end.
    monkeypatch.setattr(workqueue, "MAX_WAITING", 2)
    note = new_note(client, title="Viele")
    rows = [attach(client, note["id"], picture(), f"Bon {index}.png", operator.id) for index in range(5)]
    for index, row in enumerate(rows):
        engine.pages[row["id"]] = [f"Kassenbon Nummer {index}"]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(WorkJob).where(WorkJob.kind == ocr.JOB)) == 2
    workqueue.run_pending()
    assert [state_of(row["id"]).state for row in rows] == ["done"] * 5


# --- 3: pages of the large view ---------------------------------------------------------------------------------------


class Drawer:
    """Stands in for the worker's ``render``: a white page of the asked width; busy the first ``busy`` times."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.busy = 0

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        if self.busy:
            self.busy -= 1
            raise ocr.EngineFailed("busy", retry=True)
        Image.new("RGB", (request["width"], request["width"] * 4 // 3), "white").save(request["out"], "WEBP")
        return {"ok": True}


@pytest.fixture
def drawer(monkeypatch: pytest.MonkeyPatch) -> Drawer:
    fake = Drawer()
    monkeypatch.setattr(ocr, "ENGINE_RENDER", fake)
    monkeypatch.setattr(ocr, "PAGE_RETRY_SECONDS", 0.01)
    shutil.rmtree(ocr.page_folder(), ignore_errors=True)
    return fake


def test_notes11_ac3_a_drawn_page_comes_from_disk_the_next_time(client, operator, drawer):
    note = new_note(client, title="PDF")
    # An id with dashes in it, as token_urlsafe makes one now and then.
    answer = upload(client, note["id"], pdf_of(3), "Drei.pdf", "a-b-c-d" + attachments.new_id()[7:])
    assert answer.status_code == 201, answer.text
    row = answer.json()
    for width in (1400, 1300, 1400):
        answer = client.get(f"/api/attachments/{row['id']}/pages/2", params={"width": width})
        assert answer.status_code == 200 and answer.headers["content-type"] == "image/webp"
        assert Image.open(io.BytesIO(answer.content)).size[0] == 1400
    assert len(drawer.calls) == 1
    # The worker busy: the page waits outside the threads and comes once it is free.
    drawer.busy = 2
    assert client.get(f"/api/attachments/{row['id']}/pages/3").status_code == 200
    assert len(drawer.calls) == 4
    # Gone with its attachment in the cleanup round.
    assert ocr.sweep_pages() == 0
    with SessionLocal() as db:
        from app.models_attachments import Attachment

        db.delete(db.get(Attachment, row["id"]))
        db.commit()
    assert ocr.sweep_pages() == 2 and list(ocr.page_folder().iterdir()) == []


def test_notes11_ac3_an_account_has_at_most_two_pages_in_line(client, operator, drawer):
    note = new_note(client, title="PDF")
    row = attach(client, note["id"], pdf_of(3), "Drei.pdf", operator.id)
    assert client.get(f"/api/attachments/{row['id']}/pages/1").status_code == 200
    assert ocr.PAGE_LINE.admit(operator.id) and ocr.PAGE_LINE.admit(operator.id)
    try:
        busy = client.get(f"/api/attachments/{row['id']}/pages/2")
        assert busy.status_code == 503 and busy.json()["detail"]["code"] == "busy"
        # What was drawn before needs no place in line.
        assert client.get(f"/api/attachments/{row['id']}/pages/1").status_code == 200
        # Another account is not held up by this one.
        other = make_account("fremd")
        with new_client(other) as stranger:
            theirs = new_note(stranger, title="Meins")
            mine = attach(stranger, theirs["id"], pdf_of(2), "Zwei.pdf", other.id)
            assert stranger.get(f"/api/attachments/{mine['id']}/pages/2").status_code == 200
    finally:
        ocr.PAGE_LINE.leave(operator.id)
        ocr.PAGE_LINE.leave(operator.id)
    assert len(drawer.calls) == 2


# --- 4: recordings through the worker, into a file ------------------------------------------------------------------


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg and ffprobe are missing")
def test_notes18_ec2_a_recording_is_made_anew_in_the_worker_and_into_a_file_not_into_memory(
        client, operator, tmp_path, monkeypatch):
    work = tmp_path / ".up-probe"
    work.write_bytes(m4a_of(tmp_path))
    prepared = media.prepare(work, "recording")
    assert prepared.kind == "recording" and prepared.redrawn is None
    written = Path(prepared.redrawn_file)
    assert written.parent == work.parent and written.stat().st_size > 0
    written.unlink()

    # Read in the worker: what this process would do with it never runs here.
    def never(_path):
        raise AssertionError("ffmpeg ran in the server's process")

    monkeypatch.setattr(sketches, "_faststart", never)
    note = new_note(client, title="Aufnahme")
    answer = send(client, note["id"], m4a_of(tmp_path), "Aufnahme.m4a", "recording")
    assert answer.status_code == 201, answer.text
    stored = client.get(f"/api/attachments/{answer.json()['id']}/file").content
    assert stored.index(b"moov") < stored.index(b"mdat") and b"Geheimer Titel" not in stored


# --- 5: foreign text through a copied id ------------------------------------------------------------------------------


def test_notes11_text_of_an_attachment_of_another_owner_never_reaches_one_s_search(client, operator, engine):  # noqa: F811 - the fixture of NOTES-11
    note = new_note(client, title="Anna")
    row = attach(client, note["id"], picture(), "Bon.png", operator.id)
    engine.pages[row["id"]] = ["Vertraulicher Kassenbon"]
    workqueue.run_pending()
    other = make_account("fremd")
    with new_client(other) as stranger:
        theirs = new_note(stranger, title="Fremd")
        add_blocks(theirs["id"], other.id, block("image", row))
        with SessionLocal() as db:
            assert ocr.texts_of(db, db.get(Note, theirs["id"])) == []
        assert stranger.get("/api/search", params={"q": "vertraulicher"}).json()["total"] == 0
    assert find(client, "vertraulicher")["total"] == 1


# --- 6: a transcript nested too deep ---------------------------------------------------------------------------------


def test_notes18_a_transcript_nested_too_deep_is_refused_not_an_error(client, operator):
    note = new_note(client, title="Tief")
    answer = send(client, note["id"], b"[" * 200_000 + b"]" * 200_000, "tief.json", "transcript")
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "attachment_wrong_kind"


# --- 8: the pages the iOS app may bring --------------------------------------------------------------------------------


def test_notes11_ac5_a_picture_takes_one_page_of_text_a_pdf_as_many_as_it_has(client, operator, engine):  # noqa: F811 - the fixture of NOTES-11
    note = new_note(client, title="Gerät")
    photo = attach(client, note["id"], picture(), "Scan.png", operator.id)
    pdf = attach(client, note["id"], pdf_of(2), "Zwei.pdf", operator.id)
    two = {"pages": [{"text": "eins"}, {"text": "zwei"}]}
    assert client.put(f"/api/attachments/{photo['id']}/text", json=two).status_code == 422
    assert client.put(f"/api/attachments/{photo['id']}/text", json={"pages": [{"text": "eins"}]}).status_code == 200
    three = {"pages": [{"text": "eins"}, {"text": "zwei"}, {"text": "drei"}]}
    assert client.put(f"/api/attachments/{pdf['id']}/text", json=three).status_code == 422
    assert client.put(f"/api/attachments/{pdf['id']}/text", json=two).status_code == 200

