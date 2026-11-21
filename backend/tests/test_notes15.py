"""NOTES-15 Verlauf und Papierkorb: versions of a note (taken, thinned, read, restored, copied) and the trash (listed,
back, gone for good, after its deadline). Time runs on ``history.clock``, set by hand."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pycrdt import XmlElement, XmlFragment

from app.db import SessionLocal
from app.models import Account, Folder, Note, NoteUpdate
from app.models_history import NoteEdit, NoteVersion
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.notedoc.room import Access
from app.services import cleanup, history, notes, settings_service, trash
from app.services.inbox import inbox_for

from .conftest import make_account, new_client, sign_in
from .notes_live import Live
from .test_notes3 import folder, new_note, stored, stored_doc, token_for, wait_for

#: A Monday morning, the start of the simulated year.
T0 = datetime(2026, 1, 5, 9, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def close_connections(client):
    """Connections left open by a failing test are closed before the test client goes."""
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def setup(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)
    history.register()
    trash.register()
    history.clock.reset()
    yield
    history.clock.reset()


@pytest.fixture
def shared_with(monkeypatch: pytest.MonkeyPatch):
    """Stands in for sharing (NOTES-13): the accounts given here may read or write every note."""
    rights: dict[int, Access] = {}

    def rule(_db, account, _note):
        return rights.get(account.id)

    monkeypatch.setattr(notes, "ACCESS_RULES", [rule])
    return rights


def write(note_id: str, account_id: int | None, text: str, via: str = "") -> None:
    """A change through ``Rooms.change``, as a program or the server makes one: stored with its account."""

    async def run() -> None:
        with history.acting_via(via):
            await notes.change(note_id, lambda doc: edit.append_paragraph(doc, text), account_id=account_id)

    asyncio.run(run())


def session(note_id: str, account_id: int, words: list[str], at: datetime, via: str = "") -> None:
    """One editing session: ``words`` typed a minute apart from ``at``, then the quiet that ends it."""
    for index, word in enumerate(words):
        history.clock.set(at + timedelta(minutes=index))
        write(note_id, account_id, word, via)
    history.clock.set(at + timedelta(minutes=len(words) - 1) + history.QUIET)
    history.take_due()


def versions(note_id: str) -> list[NoteVersion]:
    with SessionLocal() as db:
        rows = list(db.query(NoteVersion).filter_by(note_id=note_id).order_by(NoteVersion.created_at.desc(),
                                                                               NoteVersion.id.desc()))
        for row in rows:
            row.state  # noqa: B018 - load the deferred column before the session goes
            db.expunge(row)
        return rows


def text_of(version: NoteVersion) -> str:
    from app.notedoc import doc as notedoc

    return to_plain(notedoc.load(version.state))


def history_of(client: TestClient, note_id: str, **params: Any) -> dict[str, Any]:
    answer = client.get(f"/api/notes/{note_id}/history", params=params)
    assert answer.status_code == 200, answer.text
    return answer.json()


def trash_of(client: TestClient) -> dict[str, Any]:
    answer = client.get("/api/trash")
    assert answer.status_code == 200, answer.text
    return answer.json()


def deleted_at(note_id: str | None = None, folder_id: str | None = None) -> datetime:
    with SessionLocal() as db:
        row = db.get(Note, note_id) if note_id else db.get(Folder, folder_id)
        assert row is not None and row.deleted_at is not None
        return row.deleted_at


def alive(note_id: str) -> bool:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        return row is not None and row.deleted_at is None


def exists(note_id: str) -> bool:
    with SessionLocal() as db:
        return db.get(Note, note_id) is not None


# --- History: taking versions (AC-1, AC-2) ----------------------------------------------------------------------


def test_notes15_ac1_versions_come_newest_first_with_time_and_who_wrote(client, operator, shared_with):
    anna = make_account("anna")
    shared_with[anna.id] = Access.WRITE
    note = new_note(client, title="Bathroom", markdown="Tiles on Tuesday")
    session(note["id"], operator.id, ["grout"], T0)
    session(note["id"], anna.id, ["silicone"], T0 + timedelta(hours=2))
    # A program with the account's key (MCP, NOTES-20) is named as that key.
    session(note["id"], operator.id, ["from the key"], T0 + timedelta(hours=4), via="mcp:Laptop")
    found = history_of(client, note["id"])
    assert [v["authors"] for v in found["versions"]] == [
        [{"id": operator.id, "name": "Tester", "via": "mcp:Laptop"}],
        [{"id": anna.id, "name": "Anna", "via": ""}],
        [{"id": operator.id, "name": "Tester", "via": ""}],
    ]
    times = [datetime.fromisoformat(v["created_at"]) for v in found["versions"]]
    assert times == sorted(times, reverse=True)
    # The time is the last change of the session, not the moment the quiet ended.
    assert times[-1] == T0
    assert found["versions"][0]["current"] is True and found["pending"] is False
    assert found["versions"][0]["title"] == "Bathroom"
    assert found["history_days"] == 365 and found["can_restore"] is True


def test_notes15_ac1_a_session_ends_after_five_quiet_minutes_or_after_an_hour(client, operator):
    note = new_note(client, title="Draft")
    for minute in range(0, 12, 2):
        history.clock.set(T0 + timedelta(minutes=minute))
        write(note["id"], operator.id, f"line {minute}")
        history.take_due()
    # Ten minutes with a change every two: one session, no version yet.
    assert versions(note["id"]) == []
    # Five quiet minutes after the last change end it.
    history.clock.set(T0 + timedelta(minutes=15) - timedelta(seconds=1))
    assert history.take_due() == 0
    history.clock.set(T0 + timedelta(minutes=15))
    assert history.take_due() == 1
    assert len(versions(note["id"])) == 1
    # Writing without a pause for more than an hour: a version after the hour, the session goes on.
    start = T0 + timedelta(hours=3)
    for minute in range(0, 64, 2):
        history.clock.set(start + timedelta(minutes=minute))
        write(note["id"], operator.id, f"long {minute}")
        history.take_due()
    assert len(versions(note["id"])) == 2
    # Nothing new: no further version, however long it stays quiet.
    history.clock.advance(days=1)
    history.take_due()
    history.take_due()
    assert len(versions(note["id"])) == 3
    history.clock.advance(days=1)
    assert history.take_due() == 0


def test_notes15_ac1_the_server_s_own_changes_name_nobody(client, operator):
    note = new_note(client, markdown="text")
    history.clock.set(T0)
    write(note["id"], None, "the server put this back")
    history.clock.advance(minutes=10)
    history.take_due()
    assert versions(note["id"]) == []


@pytest.mark.timing
def test_notes15_ac2_ec5_a_year_of_daily_work_thins_to_days_then_weeks_and_loads_a_page_at_a_time(
        client, operator):
    note = new_note(client, title="Diary")
    days = 400

    async def year() -> None:
        # Every day of more than a year a session in the afternoon, in the last month one in the morning as well.
        for day in range(days):
            for hour in (9, 15) if day >= days - 31 else (15,):
                history.clock.set(T0.replace(hour=hour) + timedelta(days=day))
                await notes.change(note["id"], lambda doc, d=day, h=hour: notedoc.set_title(doc, f"Diary {d}.{h}"),
                                   account_id=operator.id)
                history.clock.advance(minutes=6)
                await asyncio.to_thread(history.take_due)

    asyncio.run(year())
    made = days + 31
    assert len(versions(note["id"])) == made
    now = T0.replace(hour=9) + timedelta(days=days)
    history.clock.set(now)
    # Until the cleanup round nothing goes.
    assert len(versions(note["id"])) == made
    cleanup.run_once()
    kept = versions(note["id"])
    ages = [now - version.created_at for version in kept]
    recent = [age for age in ages if age <= timedelta(days=7)]
    daily = [version for version, age in zip(kept, ages, strict=True) if timedelta(days=7) < age <= timedelta(days=30)]
    weekly = [version for version, age in zip(kept, ages, strict=True) if age > timedelta(days=30)]
    # Every session of the last 7 days.
    assert len(recent) == 14
    # One a day up to 30 days, the last of the day.
    assert len({version.created_at.date() for version in daily}) == len(daily) == 23
    assert all(version.created_at.hour == 15 for version in daily)
    # One a week until a year, nothing older.
    weeks = {tuple(version.created_at.isocalendar())[:2] for version in weekly}
    assert len(weeks) == len(weekly)
    assert 47 <= len(weekly) <= 49
    assert max(ages) <= timedelta(days=365)
    # EC-5: the list comes a page at a time, quickly, without gaps or doubles.
    seen: list[int] = []
    cursor = None
    while True:
        started = time.perf_counter()
        page = history_of(client, note["id"], **({"before": cursor} if cursor else {}))
        assert time.perf_counter() - started < 0.5
        assert len(page["versions"]) <= history.PAGE
        seen.extend(version["id"] for version in page["versions"])
        cursor = page["next"]
        if cursor is None:
            break
    assert seen == [version.id for version in kept]


def test_notes15_ac2_thinning_keeps_the_last_of_each_day_and_week():
    class Row:
        def __init__(self, id_: int, at: datetime) -> None:
            self.id, self.note_id, self.created_at = id_, "n", at

    now = datetime(2026, 6, 30, 12, tzinfo=UTC)
    rows = [
        Row(1, now - timedelta(days=3, hours=1)), Row(2, now - timedelta(days=3)),  # within 7 days: both
        Row(3, now - timedelta(days=10, hours=5)), Row(4, now - timedelta(days=10, hours=1)),  # one day: the later
        Row(5, datetime(2026, 5, 4, 9, tzinfo=UTC)), Row(6, datetime(2026, 5, 6, 9, tzinfo=UTC)),  # one ISO week
        Row(7, now - timedelta(days=366)),  # past the deadline
    ]
    assert sorted(history.to_thin(rows, now, 365)) == [3, 5, 7]
    assert sorted(history.to_thin(rows, now, 30)) == [3, 5, 6, 7]


def test_notes15_ec6_a_shorter_deadline_counts_from_the_next_round_and_the_log_says_how_many(
        client, operator, caplog):
    note = new_note(client, title="Old")
    for week in range(30):
        session(note["id"], operator.id, [f"w{week}"], T0 + timedelta(weeks=week))
    history.clock.set(T0 + timedelta(weeks=30))
    cleanup.run_once()
    before = len(versions(note["id"]))
    assert before == 30
    with SessionLocal() as db:
        settings_service.save(db, {"history_days": 90})
    # Not at once: the versions are all still there.
    assert len(versions(note["id"])) == before
    with caplog.at_level(logging.INFO, logger="nexnotes.history"):
        cleanup.run_once()
    after = versions(note["id"])
    assert all(history.clock.now() - version.created_at <= timedelta(days=90) for version in after)
    gone = before - len(after)
    assert gone > 0
    assert f"History thinned removed={gone} days=90" in caplog.text
    # The log names numbers, never a title.
    assert "Old" not in caplog.text


def test_notes15_ec9_thinning_goes_by_the_server_s_clock_in_utc_days():
    class Row:
        def __init__(self, id_: int, at: datetime) -> None:
            self.id, self.note_id, self.created_at = id_, "n", at

    now = datetime(2026, 4, 10, 12, tzinfo=UTC)
    # 23:30 and 00:30 UTC: two days for the server, one evening in New York, one night in Berlin.
    rows = [Row(1, datetime(2026, 3, 28, 23, 30, tzinfo=UTC)), Row(2, datetime(2026, 3, 29, 0, 30, tzinfo=UTC))]
    assert history.to_thin(rows, now, 365) == []


# --- History: reading, restoring, copying (AC-3, AC-4, AC-5, AC-8, EC-2) ---------------------------------------


def test_notes15_ac3_an_old_version_opens_whole_as_it_was(client, operator):
    note = new_note(client, title="Bathroom", markdown="# Before\n\n- [ ] order tiles\n- [x] call the plumber")
    session(note["id"], operator.id, ["grout grey"], T0)
    old = history_of(client, note["id"])["versions"][0]
    write(note["id"], operator.id, "much later")
    answer = client.get(f"/api/notes/{note['id']}/history/{old['id']}")
    assert answer.status_code == 200
    version = answer.json()
    assert version["title"] == "Bathroom"
    kinds = [block["type"] for block in version["content"]["content"]]
    assert kinds == ["heading", "taskList", "paragraph"]
    assert "much later" not in version["text"] and "grout grey" in version["text"]
    assert version["content"]["content"][1]["content"][1]["attrs"]["checked"] is True
    assert version["authors"] == [{"id": operator.id, "name": "Tester", "via": ""}]
    # A version of another note is not found under this one.
    other = new_note(client, title="Other")
    assert client.get(f"/api/notes/{other['id']}/history/{old['id']}").status_code == 404


def test_notes15_ac4_restoring_makes_the_version_current_and_keeps_the_one_before(client, operator):
    note = new_note(client, title="Plan", markdown="first idea")
    session(note["id"], operator.id, ["second thought"], T0)
    target = history_of(client, note["id"])["versions"][0]
    history.clock.set(T0 + timedelta(hours=1))
    write(note["id"], operator.id, "a mistake")
    with SessionLocal() as db:
        db.get(Note, note["id"])  # nothing pending is lost: the mistake is in an edit mark still
        assert db.query(NoteEdit).filter_by(note_id=note["id"]).count() == 1
    answer = client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore")
    assert answer.status_code == 200, answer.text
    assert to_plain(stored_doc(note["id"])) == "first idea\nsecond thought"
    listed = history_of(client, note["id"])["versions"]
    # Newest first: the restored one (saying where it came from), the note as it was, the version itself.
    assert listed[0]["restored_from"] == target["created_at"]
    assert listed[0]["current"] is True
    assert listed[0]["authors"][0]["id"] == operator.id
    kept = versions(note["id"])
    assert "a mistake" in text_of(kept[1])
    assert text_of(kept[0]) == "first idea\nsecond thought"
    assert len(kept) == 3
    # The column follows: lists and search see the restored text.
    assert wait_for(lambda: "a mistake" not in stored(note["id"]).text)


def test_notes15_ac4_restoring_while_two_write_live_loses_nothing(client, operator, shared_with):
    anna = make_account("anna")
    shared_with[anna.id] = Access.WRITE
    note = new_note(client, title="Shared", markdown="alpha\n\nbeta\n\ngamma\n\ndelta")
    history.clock.set(T0)
    write(note["id"], operator.id, "epsilon")
    history.clock.advance(minutes=10)
    history.take_due()
    target = history_of(client, note["id"])["versions"][0]
    mine = Live(client, note["id"], token_for(operator))
    theirs = Live(client, note["id"], token_for(anna))
    for live in (mine, theirs):
        assert live.pump(lambda live=live: live.synced)

    def type_into(live: Live, index: int, word: str) -> None:
        paragraphs = [child for child in live.doc.get("body", type=XmlFragment).children
                      if isinstance(child, XmlElement)]
        run = paragraphs[index].children[0]
        run.insert(len(str(run)), f" {word}")

    # Both write before the restore; everything they wrote reaches the room.
    type_into(mine, 0, "before1")
    type_into(theirs, 4, "before2")
    edit.append_paragraph(mine.doc, "zeta")
    for live in (mine, theirs, mine, theirs):
        live.settle(0.2)
    assert {"before1", "before2", "zeta"} <= set(to_plain(stored_doc(note["id"])).split())
    # Anna is on a train: she goes on typing offline, into a paragraph the restore keeps (beta), into one it replaces
    # (alpha), and a new one. Her changes reach the room only after the restore.
    theirs.disconnect()
    type_into(theirs, 1, "during1")
    type_into(theirs, 0, "during2")
    edit.append_paragraph(theirs.doc, "during3")
    assert client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore").status_code == 200
    # The owner types into the paragraph the restore replaced before the restore reached his window.
    type_into(mine, 0, "during4")
    theirs.connect()
    for _ in range(3):
        for live in (mine, theirs):
            live.settle(0.25)
    final = {to_plain(live.doc) for live in (mine, theirs)}
    assert len(final) == 1, final
    text = final.pop()
    words = set(text.split())
    # What both typed while the restore happened is there.
    assert {"during1", "during2", "during3", "during4"} <= words, text
    # What the restored version holds is there; what it replaced is gone from the note.
    assert {"alpha", "beta", "gamma", "delta", "epsilon"} <= words
    assert not {"before1", "before2", "zeta"} & words
    # The paragraph the restore kept is the same paragraph: Anna's word stands in it, not beside it.
    assert "beta during1" in text.splitlines()
    mine.close()
    theirs.close()
    assert to_plain(stored_doc(note["id"])) == text
    # What was there before the restore stays in the history.
    before_restore = text_of(versions(note["id"])[1])
    assert {"before1", "before2", "zeta"} <= set(before_restore.split())


def test_notes15_ec2_a_restore_by_another_reaches_everyone_at_once_and_says_who(client, operator, shared_with):
    anna = make_account("anna")
    shared_with[anna.id] = Access.WRITE
    note = new_note(client, title="Shared", markdown="old text")
    session(note["id"], operator.id, ["kept"], T0)
    target = history_of(client, note["id"])["versions"][0]
    history.clock.set(T0 + timedelta(hours=1))
    write(note["id"], operator.id, "to be undone")
    laptop = Live(client, note["id"], token_for(operator))
    tablet = Live(client, note["id"], token_for(operator))
    for live in (laptop, tablet):
        assert live.pump(lambda live=live: live.synced)
    assert client.get(f"/api/notes/{note['id']}/history/restored").json() == {"last": None}
    # Anna restores through the same server (one event loop, one set of rooms), then the owner looks again.
    sign_in(client, anna)
    assert client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore").status_code == 200
    sign_in(client, operator)
    for live in (laptop, tablet):
        assert live.pump(lambda live=live: "to be undone" not in live.text, timeout=2.0), live.text
        assert live.text == "old text\nkept"
    last = client.get(f"/api/notes/{note['id']}/history/restored").json()["last"]
    assert last["version_at"] == target["created_at"]
    assert last["authors"][0] == {"id": anna.id, "name": "Anna", "via": ""}
    laptop.close()
    tablet.close()


def test_notes15_ac5_a_copy_lands_in_the_same_folder_titled_with_the_version_s_date(client, operator):
    kitchen = folder(operator, "Kitchen")
    note = new_note(client, title="Recipe", markdown="flour", folder_id=kitchen)
    session(note["id"], operator.id, ["sugar"], datetime(2026, 11, 3, 18, 40, tzinfo=UTC))
    version = history_of(client, note["id"])["versions"][0]
    write(note["id"], operator.id, "salt")
    # The device sends its own date; without one the server writes it in the account's language.
    answer = client.post(f"/api/notes/{note['id']}/history/{version['id']}/copy", json={"when": "3. Nov. 2026"})
    assert answer.status_code == 201, answer.text
    copy = answer.json()
    assert copy["folder_id"] == kitchen and copy["id"] != note["id"]
    assert copy["title"] == "Recipe (Version of 3. Nov. 2026)"
    assert to_plain(stored_doc(copy["id"])) == "flour\nsugar"
    with SessionLocal() as db:
        db.get(Account, operator.id).language = "de"
        db.commit()
    german = client.post(f"/api/notes/{note['id']}/history/{version['id']}/copy", json={}).json()
    assert german["title"] == "Recipe (Fassung vom 3.11.2026)"
    # The note itself is unchanged.
    assert "salt" in to_plain(stored_doc(note["id"]))


def test_notes15_ac8_readers_look_writers_restore_strangers_see_nothing(client, operator, shared_with):
    reader, writer, stranger = make_account("reader"), make_account("writer"), make_account("stranger")
    shared_with[reader.id] = Access.READ
    shared_with[writer.id] = Access.WRITE
    note = new_note(client, title="Shared", markdown="v1")
    session(note["id"], operator.id, ["v2"], T0)
    version = history_of(client, note["id"])["versions"][0]
    base = f"/api/notes/{note['id']}/history"
    with new_client(reader) as theirs:
        listed = theirs.get(base)
        assert listed.status_code == 200 and listed.json()["can_restore"] is False
        assert theirs.get(f"{base}/{version['id']}").status_code == 200
        assert theirs.post(f"{base}/{version['id']}/restore").status_code == 404
        assert theirs.post(f"{base}/{version['id']}/copy", json={}).status_code == 404
    with new_client(writer) as theirs:
        assert theirs.get(base).json()["can_restore"] is True
        assert theirs.post(f"{base}/{version['id']}/restore").status_code == 200
    shared_with.pop(stranger.id, None)
    with new_client(stranger) as theirs:
        for answer in (theirs.get(base), theirs.get(f"{base}/{version['id']}"),
                       theirs.post(f"{base}/{version['id']}/restore"), theirs.get(f"{base}/restored")):
            assert answer.status_code == 404


def test_notes15_versions_count_towards_the_account_s_storage_and_go_with_the_note(client, operator):
    from app.services import content

    note = new_note(client, title="Big", markdown="x" * 2000)
    with SessionLocal() as db:
        before = content.counts(db, operator.id).bytes
    session(note["id"], operator.id, ["more"], T0)
    with SessionLocal() as db:
        size = db.query(NoteVersion).filter_by(note_id=note["id"]).one().size
        assert size > 2000
        assert content.counts(db, operator.id).bytes >= before + size


# --- Trash (AC-6, AC-7, EC-1, EC-3, EC-4, EC-7, EC-8) -----------------------------------------------------------


def test_notes15_ac6_the_trash_lists_what_was_deleted_with_date_origin_and_time_left(client, operator):
    household = folder(operator, "Household")
    old_bills = folder(operator, "Old bills", household)
    inner = folder(operator, "2025", old_bills)
    for title, place in (("Gas", old_bills), ("Water", inner)):
        new_note(client, title=title, folder_id=place)
    shopping = new_note(client, title="Shopping last week", folder_id=household)
    assert client.delete(f"/api/notes/{shopping['id']}").status_code == 204
    assert client.delete(f"/api/folders/{old_bills}").status_code == 200
    found = trash_of(client)
    assert found["trash_days"] == 90 and found["totals"] == {"notes": 3, "folders": 2}
    by_kind = {item["kind"]: item for item in found["items"]}
    # Only the roots: the folder with what went with it, the note deleted alone; not the subfolder, not its notes.
    assert len(found["items"]) == 2
    assert by_kind["folder"]["id"] == old_bills and by_kind["folder"]["title"] == "Old bills"
    assert (by_kind["folder"]["notes"], by_kind["folder"]["folders"]) == (2, 1)
    assert by_kind["folder"]["origin"]["name"] == "Household" and by_kind["folder"]["lands"] == "origin"
    assert by_kind["note"]["title"] == "Shopping last week"
    assert by_kind["note"]["origin"]["name"] == "Household" and by_kind["note"]["lands"] == "origin"
    for item in found["items"]:
        assert item["days_left"] == 90 and item["warn"] is False
        assert datetime.fromisoformat(item["expires_at"]) - datetime.fromisoformat(item["deleted_at"]) == \
            timedelta(days=90)
        # Who deleted it: only in shared folders (NOTES-13); there are none yet.
        assert item["deleted_by"] is None
    # Newest first.
    assert found["items"][0]["kind"] == "folder"


def test_notes15_ac6_back_from_the_trash_and_gone_for_good(client, operator, monkeypatch):
    kept = new_note(client, title="Keep me")
    gone = new_note(client, title="Throw away", markdown="secret")
    session(gone["id"], operator.id, ["more"], T0)
    for note in (kept, gone):
        client.delete(f"/api/notes/{note['id']}")
    assert client.post(f"/api/trash/notes/{kept['id']}/restore").status_code == 200
    assert alive(kept["id"])
    closed: list[str] = []
    real_close = notes.Rooms.close_note

    async def spy(self, note_id, code=4404):
        closed.append(note_id)
        await real_close(self, note_id, code)

    monkeypatch.setattr(notes.Rooms, "close_note", spy)
    heard: list[list[str]] = []
    monkeypatch.setattr(trash, "PURGE_HOOKS", [lambda _db, ids: heard.append(list(ids))])
    answer = client.delete(f"/api/trash/notes/{gone['id']}")
    assert answer.status_code == 200 and answer.json() == {"notes": 1, "folders": 0}
    assert not exists(gone["id"])
    assert closed == [gone["id"]] and heard == [[gone["id"]]]
    with SessionLocal() as db:
        assert db.query(NoteVersion).filter_by(note_id=gone["id"]).count() == 0
        assert db.query(NoteUpdate).filter_by(note_id=gone["id"]).count() == 0
    # A living note is not in the trash: not removable from there.
    assert client.delete(f"/api/trash/notes/{kept['id']}").status_code == 404
    assert exists(kept["id"])
    assert trash_of(client)["items"] == []


def test_notes15_ac7_after_ninety_days_the_trash_empties_itself_and_the_last_week_is_orange(
        client, operator, caplog):
    note = new_note(client, title="Packing list")
    client.delete(f"/api/notes/{note['id']}")
    when = deleted_at(note["id"])
    for passed, left, warn in ((timedelta(days=82), 8, False), (timedelta(days=83), 7, True),
                               (timedelta(days=89, hours=23), 1, True)):
        history.clock.set(when + passed)
        item = trash_of(client)["items"][0]
        assert (item["days_left"], item["warn"]) == (left, warn), passed
    history.clock.set(when + timedelta(days=90) - timedelta(seconds=1))
    cleanup.run_once()
    assert exists(note["id"])
    history.clock.set(when + timedelta(days=90, seconds=1))
    with caplog.at_level(logging.INFO, logger="nexnotes.trash"):
        cleanup.run_once()
    assert not exists(note["id"])
    assert "Trash emptied after its deadline notes=1 folders=0 days=90" in caplog.text
    assert "Packing list" not in caplog.text


def test_notes15_ec6_a_shorter_trash_deadline_counts_from_the_next_round(client, operator, caplog):
    note = new_note(client, title="Thirty days old")
    client.delete(f"/api/notes/{note['id']}")
    history.clock.set(deleted_at(note["id"]) + timedelta(days=30))
    with SessionLocal() as db:
        settings_service.save(db, {"trash_days": 7})
    assert exists(note["id"])
    assert trash_of(client)["items"][0]["days_left"] == 0
    with caplog.at_level(logging.INFO, logger="nexnotes.trash"):
        cleanup.run_once()
    assert not exists(note["id"])
    assert "notes=1 folders=0 days=7" in caplog.text


def test_notes15_ec1_a_note_whose_folder_is_gone_says_so_and_comes_back_into_the_inbox(client, operator):
    crafts = folder(operator, "Crafts")
    note = new_note(client, title="Advent ideas", folder_id=crafts)
    client.delete(f"/api/notes/{note['id']}")
    client.delete(f"/api/folders/{crafts}")
    items = {item["kind"]: item for item in trash_of(client)["items"]}
    assert items["note"]["origin"]["name"] == "Crafts"
    assert items["note"]["origin_gone"] is True and items["note"]["lands"] == "inbox"
    # The folder goes for good; the note deleted before it stays in the trash and still lands in the inbox.
    assert client.delete(f"/api/trash/folders/{crafts}").json() == {"notes": 0, "folders": 1}
    assert exists(note["id"]) and not alive(note["id"])
    items = trash_of(client)["items"]
    assert [item["lands"] for item in items] == ["inbox"]
    answer = client.post(f"/api/trash/notes/{note['id']}/restore")
    assert answer.status_code == 200
    with SessionLocal() as db:
        assert answer.json()["folder_id"] == inbox_for(db, operator.id).id
    assert alive(note["id"])


def test_notes15_ec1_a_folder_whose_parent_is_gone_comes_back_at_the_top(client, operator):
    parent = folder(operator, "Parent")
    child = folder(operator, "Child", parent)
    client.delete(f"/api/folders/{child}")
    client.delete(f"/api/folders/{parent}")
    items = {item["id"]: item for item in trash_of(client)["items"]}
    assert items[child]["lands"] == "top" and items[child]["origin_gone"] is True
    assert client.post(f"/api/trash/folders/{child}/restore").status_code == 200
    with SessionLocal() as db:
        assert db.get(Folder, child).parent_id is None


def test_notes15_ec3_emptying_names_the_number_and_takes_only_what_was_listed(client, operator):
    trip = folder(operator, "Trip")
    for title in ("a", "b", "c"):
        new_note(client, title=title, folder_id=trip)
    alone = new_note(client, title="alone")
    client.delete(f"/api/folders/{trip}")
    client.delete(f"/api/notes/{alone['id']}")
    listed = trash_of(client)
    assert listed["totals"]["notes"] == 4
    # Something deleted after the question was asked stays.
    late = new_note(client, title="late")
    history.clock.set(datetime.fromisoformat(listed["now"]) + timedelta(minutes=1))
    with SessionLocal() as db:
        row = db.get(Note, late["id"])
        row.deleted_at = history.clock.now()
        row.deleted_batch = "late-batch"
        db.commit()
    answer = client.post("/api/trash/empty", json={"until": listed["now"]})
    assert answer.status_code == 200 and answer.json() == {"notes": 4, "folders": 1}
    remaining = trash_of(client)
    assert [item["id"] for item in remaining["items"]] == [late["id"]]
    assert remaining["totals"] == {"notes": 1, "folders": 0}


def test_notes15_ec4_a_folder_comes_back_with_all_its_notes_and_subfolders(client, operator):
    school = folder(operator, "School")
    inner = folder(operator, "Parents' evening", school)
    deeper = folder(operator, "2026", inner)
    ids = [new_note(client, title=f"n{i}", folder_id=place)["id"]
           for i, place in enumerate((school, inner, deeper, deeper))]
    before = new_note(client, title="deleted before", folder_id=inner)
    client.delete(f"/api/notes/{before['id']}")
    client.delete(f"/api/folders/{school}")
    answer = client.post(f"/api/trash/folders/{school}/restore")
    assert answer.status_code == 200
    assert answer.json()["notes"] == 4 and answer.json()["folders"] == 2
    assert all(alive(note_id) for note_id in ids)
    with SessionLocal() as db:
        assert db.get(Folder, deeper).parent_id == inner and db.get(Folder, inner).parent_id == school
        assert all(db.get(Folder, f).deleted_at is None for f in (school, inner, deeper))
    # The note deleted on its own before stays in the trash.
    assert [item["id"] for item in trash_of(client)["items"]] == [before["id"]]


def test_notes15_ec4_a_folder_gone_for_good_takes_its_notes_and_spares_what_was_deleted_before(client, operator):
    school = folder(operator, "School")
    inner = folder(operator, "Inner", school)
    went_with = new_note(client, title="went with", folder_id=inner)
    alone_inner = folder(operator, "Deleted alone", school)
    before = new_note(client, title="deleted before", folder_id=school)
    client.delete(f"/api/notes/{before['id']}")
    client.delete(f"/api/folders/{alone_inner}")
    client.delete(f"/api/folders/{school}")
    assert client.delete(f"/api/trash/folders/{school}").json() == {"notes": 1, "folders": 2}
    assert not exists(went_with["id"])
    assert exists(before["id"])
    with SessionLocal() as db:
        assert db.get(Folder, alone_inner) is not None and db.get(Folder, alone_inner).parent_id is None
    lands = {item["id"]: item["lands"] for item in trash_of(client)["items"]}
    assert lands == {before["id"]: "inbox", alone_inner: "top"}


def test_notes15_ec7_a_folder_coming_back_to_a_taken_name_gets_2_notes_may_share_a_title(client, operator):
    recipes = folder(operator, "Recipes")
    note = new_note(client, title="Soup")
    client.delete(f"/api/folders/{recipes}")
    client.delete(f"/api/notes/{note['id']}")
    client.post("/api/folders", json={"name": "recipes"})
    twin = new_note(client, title="Soup")
    client.post(f"/api/trash/folders/{recipes}/restore")
    client.post(f"/api/trash/notes/{note['id']}/restore")
    with SessionLocal() as db:
        assert db.get(Folder, recipes).name == "Recipes (2)"
        assert db.get(Note, note["id"]).title == db.get(Note, twin["id"]).title == "Soup"


def test_notes15_ec8_two_restores_at_once_bring_it_back_exactly_once(client, operator):
    trip = folder(operator, "Trip")
    inside = new_note(client, title="Inside", folder_id=trip)
    note = new_note(client, title="Single")
    client.delete(f"/api/folders/{trip}")
    client.delete(f"/api/notes/{note['id']}")
    results: list[int] = []
    barrier = threading.Barrier(4)

    def restore(path: str) -> None:
        with new_client(operator) as device:
            barrier.wait()
            results.append(device.post(path).status_code)

    paths = [f"/api/trash/folders/{trip}/restore", f"/api/trash/folders/{trip}/restore",
             f"/api/trash/notes/{note['id']}/restore", f"/api/trash/notes/{note['id']}/restore"]
    threads = [threading.Thread(target=restore, args=(path,)) for path in paths]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(20)
    assert sorted(results) == [200, 200, 200, 200]
    with SessionLocal() as db:
        names = [f.name for f in db.query(Folder).filter(Folder.owner_id == operator.id, Folder.kind == "normal",
                                                         Folder.deleted_at.is_(None))]
        assert names == ["Trip"]
        assert db.query(Note).filter(Note.owner_id == operator.id, Note.deleted_at.is_(None)).count() == 2
    assert alive(inside["id"]) and alive(note["id"])
    assert trash_of(client)["items"] == []


def test_notes15_gone_for_good_takes_only_what_is_still_in_the_trash(client, operator):
    back = folder(operator, "Back again")
    note = new_note(client, title="Back too", folder_id=back)
    client.delete(f"/api/folders/{back}")
    client.post(f"/api/trash/folders/{back}/restore")
    # Found before it came back (two devices): removing it now leaves it alone.
    with SessionLocal() as db:
        assert trash._purge(db, {note["id"]}, {back}) == (0, 0)
    assert alive(note["id"])
    with SessionLocal() as db:
        assert db.get(Folder, back) is not None


def test_notes15_the_trash_is_its_owner_s_alone(client, operator):
    mine = new_note(client, title="Mine")
    box = folder(operator, "Box")
    client.delete(f"/api/notes/{mine['id']}")
    client.delete(f"/api/folders/{box}")
    other = make_account("other")
    with new_client(other) as theirs:
        assert theirs.get("/api/trash").json()["items"] == []
        for answer in (theirs.post(f"/api/trash/notes/{mine['id']}/restore"),
                       theirs.post(f"/api/trash/folders/{box}/restore"),
                       theirs.delete(f"/api/trash/notes/{mine['id']}"),
                       theirs.delete(f"/api/trash/folders/{box}")):
            assert answer.status_code == 404
        theirs.post("/api/trash/empty", json={"until": datetime.now(UTC).isoformat()})
    assert exists(mine["id"]) and len(trash_of(client)["items"]) == 2


def test_notes15_ac5_a_copy_of_a_version_is_found_by_the_search(client, operator):
    """The copy from an old version is a note like any other: the search finds it (NOTES-9 AC-1)."""
    note = new_note(client, title="Recipe", markdown="Kohlrabi")
    session(note["id"], operator.id, ["parsley"], datetime(2026, 11, 3, 18, 40, tzinfo=UTC))
    version = history_of(client, note["id"])["versions"][0]
    copy = client.post(f"/api/notes/{note['id']}/history/{version['id']}/copy", json={}).json()
    found = client.get("/api/search", params={"q": "Kohlrabi"}).json()
    ids = {hit["id"] for hit in found.get("notes", found.get("results", found.get("items", [])))}
    assert copy["id"] in ids, found


# --- Findings of the review ---------------------------------------------------------------------------------------


def _paragraphs(live: Live) -> list[str]:
    return [str(child.children[0]) if child.children else "" for child in live.doc.get("body", type=XmlFragment).children
            if isinstance(child, XmlElement)]


def test_notes15_ac4_a_word_typed_while_restoring_stays_one_word(client, operator):
    """Somebody types into a paragraph the restore replaces; the keystroke that was on its way when the restore came
    joins the paragraph that took its place, where the cursor lands, so the word is not torn into a paragraph "w" and
    the rest. Nothing is lost."""
    note = new_note(client, title="Plan", markdown="first session\n\nsecond")
    history.clock.set(T0)
    write(note["id"], operator.id, "third")
    history.clock.advance(minutes=10)
    history.take_due()
    target = history_of(client, note["id"])["versions"][0]
    # A second window keeps the note open meanwhile, so the room that restores is the one the keystroke reaches.
    keeper = Live(client, note["id"], token_for(operator))
    live = Live(client, note["id"], token_for(operator))
    for each in (keeper, live):
        assert each.pump(lambda each=each: each.synced)
    run = live.doc.get("body", type=XmlFragment).children[0].children[0]
    for word in (" w6", " w7"):
        run.insert(len(str(run)), word)
    live.settle(0.2)
    # The next word is being typed while the restore happens: its first letters reach the room only after it.
    live.disconnect()
    run.insert(len(str(run)), " w")
    assert client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore").status_code == 200
    live.connect()
    assert live.pump(lambda: _paragraphs(live)[:1] == ["first session w"]), _paragraphs(live)
    # The restore has reached the editor; the cursor stands at the end of the paragraph that took the place of the
    # one typed into, and the word goes on there.
    run = live.doc.get("body", type=XmlFragment).children[0].children[0]
    run.insert(len(str(run)), "8 w9")
    live.settle(0.3)
    keeper.settle(0.3)
    assert _paragraphs(live) == _paragraphs(keeper) == ["first session w8 w9", "second", "third"]
    live.close()
    keeper.close()
    assert to_plain(stored_doc(note["id"])) == "first session w8 w9\nsecond\nthird"
    # What was typed before the restore is in the history.
    assert "first session w6 w7" in text_of(versions(note["id"])[1])


@pytest.mark.parametrize("round_", range(8))
def test_notes15_ac4_a_restored_first_paragraph_stays_first(client, operator, round_):
    """The Yjs engine of the server puts a block written at the very start of a list it got from another client by
    client number, half the time at the end: the restore never writes there."""
    from app.notedoc.doc import body_of

    def change_first(doc) -> None:
        body_of(doc).children[0].children[0].insert(0, "changed ")

    def drop_first(doc) -> None:
        del body_of(doc).children[0:1]

    for edit_first, expected in ((change_first, "alpha\nbeta\ngamma"), (drop_first, "alpha\nbeta\ngamma")):
        note = new_note(client, title="Order", markdown="alpha\n\nbeta")
        history.clock.set(T0)
        write(note["id"], operator.id, "gamma")
        history.clock.advance(minutes=10)
        history.take_due()
        target = history_of(client, note["id"])["versions"][0]
        asyncio.run(notes.change(note["id"], edit_first, account_id=operator.id))
        assert client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore").status_code == 200
        assert to_plain(stored_doc(note["id"])) == expected


def test_notes15_ac4_restoring_what_the_note_is_already_makes_no_new_version(client, operator):
    note = new_note(client, title="Plan", markdown="first idea")
    session(note["id"], operator.id, ["second thought"], T0)
    target = history_of(client, note["id"])["versions"][0]
    history.clock.set(T0 + timedelta(hours=1))
    write(note["id"], operator.id, "a mistake")
    assert client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore").status_code == 200
    count = len(versions(note["id"]))
    for _ in range(5):
        answer = client.post(f"/api/notes/{note['id']}/history/{target['id']}/restore")
        assert answer.status_code == 200
        assert answer.json()["id"] == versions(note["id"])[0].id
    assert len(versions(note["id"])) == count
    assert to_plain(stored_doc(note["id"])) == "first idea\nsecond thought"


def test_notes15_ac6_only_the_top_of_a_deleted_folder_goes_for_good_on_its_own(client, operator):
    top = folder(operator, "Top")
    inner = folder(operator, "Inner", top)
    note = new_note(client, title="Inside", folder_id=inner)
    client.delete(f"/api/folders/{top}")
    assert client.delete(f"/api/trash/folders/{inner}").status_code == 404
    assert exists(note["id"])
    with SessionLocal() as db:
        assert db.get(Folder, top) is not None and db.get(Folder, inner) is not None
    assert client.delete(f"/api/trash/folders/{top}").json() == {"notes": 1, "folders": 2}


def test_notes15_ec3_emptying_never_reaches_past_the_server_s_clock(client, operator):
    first = new_note(client, title="first")
    client.delete(f"/api/notes/{first['id']}")
    listed = trash_of(client)
    # Deleted after the list was shown; the request names a moment far ahead.
    history.clock.set(datetime.fromisoformat(listed["now"]) + timedelta(minutes=1))
    later = new_note(client, title="later")
    with SessionLocal() as db:
        row = db.get(Note, later["id"])
        row.deleted_at = history.clock.now() + timedelta(minutes=5)
        row.deleted_batch = "later-batch"
        db.commit()
    future = (datetime.fromisoformat(listed["now"]) + timedelta(days=365)).isoformat()
    assert client.post("/api/trash/empty", json={"until": future}).json() == {"notes": 1, "folders": 0}
    assert exists(later["id"])


def test_notes15_ec3_what_comes_back_and_goes_again_while_emptying_stays(client, operator, monkeypatch):
    """The trash is looked at again under the write lock: a note brought back and deleted anew between the first look
    and the lock was deleted after the question and stays."""
    note = new_note(client, title="Twice")
    client.delete(f"/api/notes/{note['id']}")
    listed = trash_of(client)
    from app.notedoc.room import Rooms

    original = Rooms.close_note

    async def meanwhile(self, note_id: str) -> None:
        await original(self, note_id)
        history.clock.set(datetime.fromisoformat(listed["now"]) + timedelta(minutes=2))
        with SessionLocal() as db:
            row = db.get(Note, note_id)
            row.deleted_at = history.clock.now()
            row.deleted_batch = "again"
            db.commit()

    monkeypatch.setattr(Rooms, "close_note", meanwhile)
    assert client.post("/api/trash/empty", json={"until": listed["now"]}).json() == {"notes": 0, "folders": 0}
    assert exists(note["id"])


def test_notes15_ec1_a_note_whose_folder_is_in_the_trash_comes_back_into_the_inbox(client, operator):
    crafts = folder(operator, "Crafts")
    note = new_note(client, title="Advent ideas", folder_id=crafts)
    client.delete(f"/api/notes/{note['id']}")
    client.delete(f"/api/folders/{crafts}")
    lands = {item["id"]: item["lands"] for item in trash_of(client)["items"]}
    assert lands[note["id"]] == "inbox"
    answer = client.post(f"/api/trash/notes/{note['id']}/restore")
    assert answer.status_code == 200
    with SessionLocal() as db:
        inbox = inbox_for(db, operator.id).id
        assert answer.json()["folder_id"] == inbox
        assert db.get(Note, note["id"]).folder_id == inbox
        assert db.get(Folder, crafts).deleted_at is not None
