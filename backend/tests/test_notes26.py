"""NOTES-26: the guide as content every account starts with (``services/guide.py``)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.config import Settings, get_settings
from app.db import SessionLocal
from app.models import Account, Folder, Note, Setting
from app.models_attachments import Attachment
from app.models_history import NoteVersion
from app.models_ocr import AttachmentOcr, WorkJob
from app.services import attachments, guide, notes, workqueue
from app.services.folders import FOLDER_COLORS, FOLDER_ICONS

from .conftest import make_account, new_client

SHOTS_LIMIT = 3 * 1024 * 1024


@pytest.fixture
def guide_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """The switch as it is outside the tests (on)."""
    monkeypatch.setattr(get_settings(), "guide", True)


def _with_language(account: Account, language: str) -> Account:
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        row.language = language
        db.commit()
    return account


def _top(account_id: int) -> list[Folder]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(Folder).where(Folder.owner_id == account_id, Folder.parent_id.is_(None),
                                                    Folder.kind == "normal", Folder.deleted_at.is_(None))
                               .order_by(Folder.created_at, Folder.id)))
        db.expunge_all()
    return rows


def _children(folder_id: str) -> list[Folder]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(Folder).where(Folder.parent_id == folder_id)
                               .order_by(Folder.position, Folder.name)))
        db.expunge_all()
    return rows


def _notes_in(folder_ids: list[str]) -> list[Note]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(Note).where(Note.folder_id.in_(folder_ids))
                               .order_by(Note.updated_at.desc())))
        db.expunge_all()
    return rows


def _guide_jobs() -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(WorkJob).where(WorkJob.kind == guide.JOB)) or 0)


# --- The source ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("language", guide.LANGUAGES)
def test_notes26_ac6_the_guide_reads_and_every_picture_symbol_and_colour_is_there(language: str) -> None:
    source = guide.load(language)
    assert len(source.folders) >= 7
    for topic in source.folders:
        assert topic.icon in FOLDER_ICONS and (topic.color in FOLDER_COLORS or topic.color == "")
        assert topic.notes, topic.name
        for note in topic.notes:
            assert note.title and len(note.title) <= 120
            assert note.icon == "" or note.icon in FOLDER_ICONS, (note.title, note.icon)
            assert note.color == "" or note.color in FOLDER_COLORS
            assert note.paper == "" or note.paper in notes.PAPERS
            for relative, name in note.pictures:
                assert (guide.ROOT / language / relative).is_file(), relative
                assert name


def test_notes26_ac6_both_languages_have_the_same_folders_notes_and_pictures() -> None:
    german, english = guide.load("de"), guide.load("en")
    assert [len(topic.notes) for topic in german.folders] == [len(topic.notes) for topic in english.folders]
    for de_topic, en_topic in zip(german.folders, english.folders, strict=True):
        assert (de_topic.icon, de_topic.color) == (en_topic.icon, en_topic.color)
        for de_note, en_note in zip(de_topic.notes, en_topic.notes, strict=True):
            assert [relative for relative, _ in de_note.pictures] == [relative for relative, _ in en_note.pictures]
            assert (de_note.icon, de_note.paper, de_note.pinned) == (en_note.icon, en_note.paper, en_note.pinned)


def test_notes26_ac6_the_notes_show_a_real_checklist_and_a_real_table() -> None:
    for language in guide.LANGUAGES:
        text = "\n".join(note.markdown for topic in guide.load(language).folders for note in topic.notes)
        assert re.search(r"^- \[ \] ", text, re.MULTILINE) and re.search(r"^- \[x\] ", text, re.MULTILINE)
        assert re.search(r"^\|---\|", text, re.MULTILINE)


def test_notes26_ac7_the_pictures_stay_small() -> None:
    total = sum(path.stat().st_size for path in guide.ROOT.rglob("shots/*") if path.is_file())
    assert 0 < total < SHOTS_LIMIT
    for path in guide.ROOT.rglob("shots/*"):
        assert path.suffix == ".webp"
        assert path.stat().st_size < 400 * 1024, path.name


def test_notes26_ac7_every_picture_file_is_used() -> None:
    for language in guide.LANGUAGES:
        used = {relative for topic in guide.load(language).folders for note in topic.notes
                for relative, _ in note.pictures}
        there = {f"shots/{path.name}" for path in (guide.ROOT / language / "shots").iterdir()}
        assert there == used


# --- A new account ------------------------------------------------------------------------------------------------


def test_notes26_ac1_the_switch_is_on_outside_the_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NEXNOTES_GUIDE", raising=False)
    assert Settings(_env_file=None).guide is True


@pytest.mark.parametrize(("language", "name", "first"), [("de", "Anleitung", "Erste Schritte"),
                                                         ("en", "Guide", "Getting started")])
def test_notes26_ac1_a_new_account_gets_the_guide_in_its_language(guide_on, client, language, name, first) -> None:
    with SessionLocal() as db:
        db.add(Account(name="paula", display_name="Paula", email="paula@example.com", role="member",
                       language=language, password_hash="x"))
        db.commit()
        paula = db.scalar(select(Account).where(Account.name == "paula"))
        db.expunge(paula)
    assert _guide_jobs() == 1
    workqueue.run_pending()
    assert _guide_jobs() == 0
    top = _top(paula.id)
    assert [folder.name for folder in top] == [name]
    assert top[0].icon == "book" and top[0].color == "honey"
    topics = _children(top[0].id)
    source = guide.load(language)
    assert [folder.name for folder in topics] == [topic.name for topic in source.folders]
    assert topics[0].name == first
    assert [folder.icon for folder in topics] == [topic.icon for topic in source.folders]
    made = _notes_in([folder.id for folder in topics])
    assert len(made) == sum(len(topic.notes) for topic in source.folders)
    # In the guide's order: the newest change first, as the lists sort.
    assert [note.title for note in _notes_in([topics[0].id])] == [note.title for note in source.folders[0].notes]
    assert all(note.owner_id == paula.id and note.origin == guide.ORIGIN for note in made)


def test_notes26_ac1_an_invited_account_gets_it_too_and_its_making_does_not_wait(guide_on, client, operator):
    link = client.post("/api/invites", json={}).json()["link"]
    with new_client() as stranger:
        made = stranger.post(f"/api/invite/{link.rsplit('/', 1)[1]}",
                             json={"display_name": "Paula", "password": "correct horse battery"})
        assert made.status_code in (200, 201), made.text
    with SessionLocal() as db:
        paula = db.scalar(select(Account).where(Account.display_name == "Paula"))
        db.expunge(paula)
    # Made by the queue, not while the account was made.
    assert _top(paula.id) == []
    assert _guide_jobs() == 2
    workqueue.run_pending()
    assert len(_top(paula.id)) == 1


def test_notes26_ac1_looking_at_the_folders_makes_a_guide_still_waiting(guide_on, client, operator) -> None:
    assert _guide_jobs() == 1
    tree = client.get("/api/folders")
    assert tree.status_code == 200
    names = [folder["name"] for folder in tree.json()["folders"]]
    assert names.count("Guide") + names.count("Anleitung") == 1
    assert _guide_jobs() == 0
    # Not twice: the queue has nothing left.
    workqueue.run_pending()
    assert len(_top(operator.id)) == 1


def test_notes26_ac1_the_guide_is_not_in_the_inbox(guide_on, client, operator) -> None:
    client.get("/api/folders")
    inbox = client.get("/api/folders/inbox").json()
    assert inbox.get("notes", []) == []


def test_notes26_ac1_the_guide_is_the_accounts_to_change_and_delete(guide_on, client, operator) -> None:
    client.get("/api/folders")
    root = _top(operator.id)[0]
    assert client.patch(f"/api/folders/{root.id}", json={"name": "Hilfe"}).status_code == 200
    assert client.delete(f"/api/folders/{root.id}").status_code == 200
    assert _top(operator.id) == []


# --- What the notes are ------------------------------------------------------------------------------------------


def _picture_rows(account_id: int) -> list[Attachment]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(Attachment).where(Attachment.owner_id == account_id)))
        db.expunge_all()
    return rows


def test_notes26_ac4_the_pictures_are_attachments_to_read_like_uploads(guide_on, client, operator) -> None:
    client.get("/api/folders")
    rows = _picture_rows(operator.id)
    source = guide.load("en")
    assert len(rows) == sum(len(note.pictures) for topic in source.folders for note in topic.notes)
    row = rows[0]
    assert row.kind == "image" and row.inline and row.has_thumb and row.unref_at is None
    file = client.get(f"/api/attachments/{row.id}/file")
    assert file.status_code == 200 and file.headers["content-type"].startswith("image/webp")
    assert len(file.content) == row.size
    assert client.get(f"/api/attachments/{row.id}/thumb").status_code == 200
    # In the note's text as a picture block, named like the picture.
    note = client.get(f"/api/notes/{row.note_id}").json()
    listed = client.get(f"/api/notes/{row.note_id}/attachments").json()
    assert row.id in str(listed)
    assert note["title"]


def test_notes26_ac4_the_pictures_are_not_queued_for_text_recognition(guide_on, client, operator) -> None:
    client.get("/api/folders")
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(WorkJob).where(WorkJob.kind == "ocr")) == 0
        states = set(db.scalars(select(AttachmentOcr.state)))
    assert states == {"done"}


def test_notes26_ac5_the_guide_takes_nothing_of_the_storage(guide_on, client, operator) -> None:
    with SessionLocal() as db:
        before = attachments.used(db, operator.id)
    client.get("/api/folders")
    with SessionLocal() as db:
        after = attachments.used(db, operator.id)
        stored = db.scalar(select(func.sum(Attachment.stored)).where(Attachment.owner_id == operator.id))
        texts = db.scalar(select(func.sum(func.length(Note.ydoc))).where(Note.owner_id == operator.id))
        versions = db.scalar(select(func.sum(NoteVersion.size)))
    assert stored == 0
    # The notes' text and their first versions count as any note's; the pictures do not.
    assert after - before == texts + versions


def test_notes26_ac8_the_guide_comes_from_nexnotes_not_from_the_member(guide_on, client, operator) -> None:
    client.get("/api/folders")
    made = _notes_in([folder.id for folder in _children(_top(operator.id)[0].id)])
    assert all(note.updated_by_id is None and note.origin == "guide" for note in made)
    history = client.get(f"/api/notes/{made[0].id}/history").json()
    assert history["updated_by"] is None
    assert [version["authors"] for version in history["versions"]] == [[{"id": None, "name": "", "via": "guide"}]]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NoteVersion)) == len(made)


def test_notes26_ac1_the_welcome_is_pinned_and_a_note_has_its_paper(guide_on, client, operator) -> None:
    client.get("/api/folders")
    made = _notes_in([folder.id for folder in _children(_top(operator.id)[0].id)])
    pinned = [note.title for note in made if note.pinned_at is not None]
    assert pinned == [guide.load("en").folders[0].notes[0].title]
    assert {note.paper for note in made} >= {"grid"}


# --- Accounts from before -----------------------------------------------------------------------------------------


def test_notes26_ac2_accounts_from_before_get_it_once_and_not_again(guide_on, client, operator) -> None:
    _with_language(operator, "de")
    with SessionLocal() as db:
        db.execute(WorkJob.__table__.delete())
        db.execute(Setting.__table__.delete().where(Setting.key == guide.SEEDED))
        db.commit()
    other = make_account("bruno")
    with SessionLocal() as db:
        db.execute(WorkJob.__table__.delete())
        db.commit()
        assert guide.seed_existing(db) == 2
        assert guide.seed_existing(db) == 0
    workqueue.run_pending()
    assert [folder.name for folder in _top(operator.id)] == ["Anleitung"]
    assert len(_top(other.id)) == 1
    # Deleted: it does not come back by itself.
    client.delete(f"/api/folders/{_top(operator.id)[0].id}")
    with SessionLocal() as db:
        assert guide.seed_existing(db) == 0
    workqueue.run_pending()
    client.get("/api/folders")
    assert _top(operator.id) == []


def test_notes26_ec2_switched_off_no_account_gets_it_by_itself(client, operator) -> None:
    assert _guide_jobs() == 0
    with SessionLocal() as db:
        db.execute(Setting.__table__.delete().where(Setting.key == guide.SEEDED))
        db.commit()
        assert guide.seed_existing(db) == 0
        # Marked all the same: switching it on later does not hand it to everybody from before.
        assert db.get(Setting, guide.SEEDED) is not None
    client.get("/api/folders")
    assert _top(operator.id) == []


# --- Making it again ----------------------------------------------------------------------------------------------


def test_notes26_ac3_make_again_adds_a_fresh_one_and_leaves_the_own_alone(guide_on, client, operator) -> None:
    client.get("/api/folders")
    first = _top(operator.id)[0]
    topics = _children(first.id)
    changed = _notes_in([topics[0].id])[0]
    with SessionLocal() as db:
        db.get(Note, changed.id).title = "Mine now"
        db.commit()
    made = client.post("/api/guide", json={"language": "de"})
    assert made.status_code == 201, made.text
    assert made.json()["name"] == "Anleitung"
    again = client.post("/api/guide", json={"language": "en"})
    assert again.json()["name"] == "Guide (2)"
    assert [folder.name for folder in _top(operator.id)] == ["Guide", "Anleitung", "Guide (2)"]
    with SessionLocal() as db:
        assert db.get(Note, changed.id).title == "Mine now"
        assert db.get(Folder, first.id).deleted_at is None


def test_notes26_ac3_make_again_works_with_the_switch_off_in_the_accounts_language(client, operator) -> None:
    _with_language(operator, "de")
    made = client.post("/api/guide", json={})
    assert made.status_code == 201
    assert made.json()["name"] == "Anleitung"


def test_notes26_ac5_a_guide_asked_for_again_counts_and_needs_room(client, operator) -> None:
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        row.storage_limit = attachments.used(db, operator.id) + 1000
        db.commit()
    refused = client.post("/api/guide", json={"language": "en"})
    assert refused.status_code == 507
    assert refused.json()["detail"]["code"] == "storage_limit_reached"
    assert _top(operator.id) == []
    with SessionLocal() as db:
        db.get(Account, operator.id).storage_limit = None
        db.commit()
    assert client.post("/api/guide", json={"language": "en"}).status_code == 201
    with SessionLocal() as db:
        stored = db.scalar(select(func.sum(Attachment.stored)).where(Attachment.owner_id == operator.id))
    assert stored == guide.size_of("en")


def test_notes26_ac3_make_again_needs_a_sign_in() -> None:
    with new_client() as stranger:
        assert stranger.post("/api/guide", json={}).status_code == 401


# --- When it goes wrong -------------------------------------------------------------------------------------------


def test_notes26_ec1_a_broken_guide_never_stops_an_account_and_leaves_nothing_half(guide_on, client, operator,
                                                                                    monkeypatch) -> None:
    calls = {"count": 0}
    real = guide._make_note

    def broken(*args, **kwargs):
        # Two notes are made, then it breaks: for every account from then on.
        calls["count"] += 1
        if calls["count"] >= 3:
            raise RuntimeError("disk on fire")
        return real(*args, **kwargs)

    monkeypatch.setattr(guide, "_make_note", broken)
    link = client.post("/api/invites", json={}).json()["link"]
    with new_client() as stranger:
        made = stranger.post(f"/api/invite/{link.rsplit('/', 1)[1]}",
                             json={"display_name": "Paula", "password": "correct horse battery"})
        assert made.status_code in (200, 201), made.text
    with SessionLocal() as db:
        paula = db.scalar(select(Account).where(Account.display_name == "Paula"))
        assert paula is not None
        db.expunge(paula)
    workqueue.run_pending()
    assert calls["count"] >= 4
    for account_id in (operator.id, paula.id):
        assert _top(account_id) == []
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(Note).where(Note.owner_id == account_id)) == 0
            assert db.scalar(select(func.count()).select_from(Attachment)
                             .where(Attachment.owner_id == account_id)) == 0
            # The queue tries again later.
            job = db.scalar(select(WorkJob).where(WorkJob.kind == guide.JOB, WorkJob.ref == str(account_id)))
            assert job is not None and job.attempts == 1


def test_notes26_ec1_a_broken_guide_does_not_break_the_folder_list(guide_on, client, operator, monkeypatch) -> None:
    def broken(*_args, **_kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(guide, "_make_note", broken)
    tree = client.get("/api/folders")
    assert tree.status_code == 200
    assert _top(operator.id) == []
    assert _guide_jobs() == 1
    # Not tried again at every look: the queue takes it from here.
    calls = {"count": 0}
    monkeypatch.setattr(guide, "make", lambda *_args, **_kwargs: calls.update(count=calls["count"] + 1))
    assert client.get("/api/folders").status_code == 200
    assert calls["count"] == 0


def test_notes26_ec3_an_account_gone_before_its_turn_is_passed_over(guide_on, client) -> None:
    paula = make_account("paula")
    with SessionLocal() as db:
        db.delete(db.get(Account, paula.id))
        db.commit()
    workqueue.run_pending()
    assert _guide_jobs() == 0
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Folder).where(Folder.owner_id == paula.id)) == 0


def test_notes26_ac6_the_guide_writes_its_files_only_into_the_attachments_folder(guide_on, client, operator) -> None:
    client.get("/api/folders")
    root = attachments.root().resolve()
    for row in _picture_rows(operator.id):
        assert Path(attachments.path_of(row.id)).resolve().parent == root


@pytest.mark.parametrize(("language", "tag"), [("de", "anleitung"), ("en", "guide")])
def test_notes26_ac6_the_guide_brings_one_tag_of_its_own_and_no_other(guide_on, client, operator, language,
                                                                       tag) -> None:
    _with_language(operator, language)
    client.get("/api/folders")
    labels = [entry["label"].lstrip("#").lower() for entry in client.get("/api/tags").json()["tags"]]
    assert labels == [tag]
