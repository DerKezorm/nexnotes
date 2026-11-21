"""NOTES-1 Installation and operation: every acceptance criterion and edge case whose check is an automatic test.

The names carry the IDs of the spec (``Development/Planung/nexnotes/Features/NOTES-1 ...``).
"""

from __future__ import annotations

import errno
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import threading
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import __version__
from app.config import Settings, StartupError, _explain, get_settings
from app.db import SessionLocal
from app.main import app
from app.models import OPERATOR, Account, utcnow
from app.routers import health
from app.security import brake
from app.services import accounts, backups, content, settings_service, storage

from .conftest import DATA_DIR, MEDIA, PASSWORD, SETUP_CODE, make_account, new_client

GOOD = "a long enough password"
SETUP = {"display_name": "Robin", "email": "robin@example.com", "password": GOOD, "code": SETUP_CODE}


def _code(answer: object) -> str:
    return str(answer.json()["detail"]["code"])  # type: ignore[attr-defined]


def _count() -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(Account)) or 0)


# --- AC-1, AC-2, EC-6, EC-7, EC-8: the setup of the first account -------------------------------------------------


def test_notes1_ac1_a_fresh_data_folder_shows_the_setup_and_the_first_account_is_the_operator(
    client: TestClient,
) -> None:
    state = client.get("/api/setup").json()
    assert state["needs_setup"] is True and state["code_required"] is True
    made = client.post("/api/setup", json=SETUP)
    assert made.status_code == 200, made.text
    assert made.json()["role"] == OPERATOR and made.json()["display_name"] == "Robin"
    assert client.get("/api/auth/me").json()["email"] == "robin@example.com"
    assert client.get("/api/setup").json()["needs_setup"] is False


def test_notes1_ac12_the_setup_names_the_data_folder_it_really_uses_and_nobody_after(client: TestClient) -> None:
    # NEXNOTES_DATA_DIR of the test run is a temporary folder, never ``/data``: the page shows that one.
    assert client.get("/api/setup").json()["data_dir"] == str(get_settings().data_dir) == str(Path(DATA_DIR))
    assert str(Path(DATA_DIR)) != str(Path("/data"))
    assert client.post("/api/setup", json=SETUP).status_code == 200
    # Set up: the sign-in page asks the same route, and nobody learns the folder from it any more.
    with new_client() as stranger:
        assert stranger.get("/api/setup").json()["data_dir"] is None


def test_notes1_ac2_the_setup_code_is_in_the_log_at_every_start_until_set_up(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(get_settings(), "setup_token", "")
    monkeypatch.setattr(accounts, "_generated_code", None)
    with caplog.at_level(logging.WARNING), SessionLocal() as db:
        accounts.announce_setup_code(db)
    code = accounts.setup_code()
    assert code in caplog.text, "the code stands in the log"
    assert client.post("/api/setup", json={**SETUP, "code": ""}).status_code == 403
    assert client.post("/api/setup", json={**SETUP, "code": code.lower()}).status_code == 200
    # Once set up, a start writes no code any more.
    caplog.clear()
    with caplog.at_level(logging.WARNING), SessionLocal() as db:
        accounts.announce_setup_code(db)
    assert code not in caplog.text


def test_notes1_ac2_the_operator_may_give_the_setup_code_in_the_environment(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "setup_token", "my-own-setup-code")
    assert client.post("/api/setup", json={**SETUP, "code": SETUP_CODE}).status_code == 403
    assert client.post("/api/setup", json={**SETUP, "code": "my-own-setup-code"}).status_code == 200


def test_notes1_ec6_a_wrong_setup_code_makes_nothing_and_is_braked(client: TestClient) -> None:
    answers = [client.post("/api/setup", json={**SETUP, "code": f"wrong-{n}"}).status_code for n in range(12)]
    assert set(answers[:5]) == {403} and answers[-1] == 429
    assert _count() == 0
    brake.forget()


def test_notes1_ec7_a_double_click_on_create_account_makes_exactly_one_operator(client: TestClient) -> None:
    results: list[int] = []

    def press() -> None:
        with TestClient(app, base_url="http://testserver", headers={"X-Nexnotes-Client": "tab-double000"}) as tab:
            # Without an address: nothing but the setup itself keeps a second operator out.
            results.append(tab.post("/api/setup", json={**SETUP, "email": ""}).status_code)

    presses = [threading.Thread(target=press) for _ in range(4)]
    for thread in presses:
        thread.start()
    for thread in presses:
        thread.join()
    assert sorted(results) == [200, 409, 409, 409]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Account).where(Account.role == OPERATOR)) == 1


def test_notes1_ec8_once_set_up_the_setup_sends_people_to_the_sign_in(client: TestClient) -> None:
    make_account("boss", OPERATOR)
    stranger = new_client()
    assert stranger.get("/api/setup").json() == {**stranger.get("/api/setup").json(), "needs_setup": False}
    again = stranger.post("/api/setup", json=SETUP)
    assert again.status_code == 409 and _code(again) == "already_set_up"
    assert _count() == 1


# --- AC-4, AC-5, EC-3, EC-9: backups -------------------------------------------------------------------------------


def test_notes1_ac4_backups_run_daily_and_keep_seven_from_the_start(client: TestClient, operator: Account) -> None:
    settings = client.get("/api/settings").json()
    assert (settings["backup_schedule"], settings["backup_keep"]) == ("daily", 7)
    for schedule, keep in (("weekly", 1), ("daily", 365), ("off", 30)):
        saved = client.put("/api/settings", json={"backup_schedule": schedule, "backup_keep": keep}).json()
        assert (saved["backup_schedule"], saved["backup_keep"]) == (schedule, keep)
    for bad in ({"backup_keep": 0}, {"backup_keep": 366}, {"backup_schedule": "hourly"}):
        assert client.put("/api/settings", json=bad).status_code == 422


def test_notes1_ac4_a_backup_holds_the_database_the_attachments_and_the_settings(
    client: TestClient, operator: Account
) -> None:
    (MEDIA / "attachment0001").write_bytes(b"a picture of a receipt")
    client.put("/api/settings", json={"trash_days": 30})
    made = client.post("/api/backups", json={"note": "now"})
    assert made.status_code == 201, made.text
    with zipfile.ZipFile(backups.path_of(made.json()["name"])) as archive:
        names = set(archive.namelist())
        assert {backups.DATABASE_ENTRY, backups.MANIFEST, "attachments/attachment0001"} <= names
        manifest = json.loads(archive.read(backups.MANIFEST))
        assert manifest["version"] == __version__ and manifest["files"] == 1
        database = Path(backups.folder()) / "probe.db"
        database.write_bytes(archive.read(backups.DATABASE_ENTRY))
    connection = sqlite3.connect(database)
    try:
        stored = dict(connection.execute("SELECT key, value FROM settings").fetchall())
        accounts_in_backup = connection.execute("SELECT count(*) FROM accounts").fetchone()[0]
    finally:
        connection.close()
        database.unlink()
    assert json.loads(str(stored["trash_days"])) == 30 and accounts_in_backup == 1


def test_notes1_ac4_the_schedule_makes_one_at_night_and_keeps_only_the_newest(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import datetime

    night = datetime.now().astimezone().replace(hour=3, minute=10)
    assert backups.due("daily", now=night) is True
    assert backups.due("daily", now=night.replace(hour=14)) is False
    for _ in range(3):
        backups.create(kind=backups.SCHEDULED)
    backups.prune(2)
    assert len([entry for entry in backups.entries() if entry.kind == backups.SCHEDULED]) == 2


def test_notes1_ac4_weekly_is_due_after_seven_days_at_night_not_after_six(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import datetime, timedelta
    from types import SimpleNamespace

    # The last scheduled backup on a Sunday night at 03:10.
    made = datetime(2026, 11, 1, 3, 10).astimezone()
    monkeypatch.setattr(backups, "entries", lambda: [SimpleNamespace(kind=backups.SCHEDULED, created=made.isoformat())])
    # Six nights later a weekly backup is not due yet, a daily one is.
    assert backups.due("weekly", now=made + timedelta(days=6)) is False
    assert backups.due("daily", now=made + timedelta(days=6)) is True
    # The seventh night it is; by day only a day late, for a server that sleeps at night.
    assert backups.due("weekly", now=made + timedelta(days=7)) is True
    assert backups.due("weekly", now=made + timedelta(days=7, hours=10)) is False
    assert backups.due("weekly", now=made + timedelta(days=8, hours=10)) is True
    assert backups.due("off", now=made + timedelta(days=30)) is False

def test_notes1_ac5_the_check_says_what_a_restore_adds_changes_and_removes(
    client: TestClient, operator: Account
) -> None:
    (MEDIA / "staysthesame1").write_bytes(b"same")
    (MEDIA / "willbechanged").write_bytes(b"before")
    (MEDIA / "willberemoved").write_bytes(b"gone later")
    name = client.post("/api/backups", json={}).json()["name"]
    (MEDIA / "willbechanged").write_bytes(b"after, longer")
    (MEDIA / "willberemoved").unlink()
    (MEDIA / "comesafterwards").write_bytes(b"new")
    brief = client.post(f"/api/backups/{name}/check").json()
    assert brief["usable"] is True
    assert (brief["would_add"], brief["would_change"], brief["would_remove"]) == (1, 1, 1)


def _note(owner_id: int, title: str) -> str:
    from app.models import Note
    from app.services.inbox import inbox_for

    with SessionLocal() as db:
        row = Note(owner_id=owner_id, folder_id=inbox_for(db, owner_id).id, title=title, text=title)
        db.add(row)
        db.commit()
        return row.id


def test_notes1_ac5_the_check_names_the_notes_a_restore_brings_back_changes_and_takes_away(
    client: TestClient, operator: Account
) -> None:
    from datetime import timedelta

    from app.models import Note

    anna = make_account("anna")
    kept = _note(operator.id, "Kept as it is")
    edited = _note(operator.id, "Shopping list")
    deleted = _note(operator.id, "Recipe for bread")
    trashed = _note(operator.id, "Holiday plans")
    _note(anna.id, "Anna's diary")
    name = client.post("/api/backups", json={}).json()["name"]
    with SessionLocal() as db:
        later = utcnow() + timedelta(minutes=5)
        db.get(Note, edited).updated_at = later
        db.delete(db.get(Note, deleted))
        db.get(Note, trashed).deleted_at = later
        db.commit()
    _note(operator.id, "Written after the backup")
    _note(anna.id, "Anna's new secret")
    brief = client.post(f"/api/backups/{name}/check").json()
    assert brief["usable"] is True
    assert (brief["notes_add"], brief["notes_change"], brief["notes_remove"]) == (2, 1, 2)
    assert sorted(brief["notes_add_titles"]) == ["Holiday plans", "Recipe for bread"]
    assert brief["notes_change_titles"] == ["Shopping list"]
    # Numbers for every account, titles only of the operator's own notes (NOTES-2 AC-7).
    assert brief["notes_remove_titles"] == ["Written after the backup"]
    assert "Anna" not in json.dumps(brief)
    assert kept not in json.dumps(brief)


def test_notes1_ac5_the_check_names_at_most_five_titles_newest_first(client: TestClient, operator: Account) -> None:
    name = client.post("/api/backups", json={}).json()["name"]
    for title in ("Kiwi", "Apple", "Melon", "Banana", "Pear", "Cherry", "Fig"):
        _note(operator.id, title)
        time.sleep(0.002)
    brief = client.post(f"/api/backups/{name}/check").json()
    assert brief["notes_remove"] == 7
    assert brief["notes_remove_titles"] == ["Fig", "Cherry", "Pear", "Banana", "Melon"]

def test_notes1_ac5_a_restore_needs_the_confirmation_of_the_password(client: TestClient, operator: Account,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(backups, "restart_soon", lambda *_args, **_kw: None)
    name = client.post("/api/backups", json={}).json()["name"]
    refused = client.post(f"/api/backups/{name}/restore", json={"password": "not it"})
    assert refused.status_code == 401
    assert not backups.pending_folder().exists()
    done = client.post(f"/api/backups/{name}/restore", json={"password": PASSWORD})
    assert done.status_code == 202 and done.json()["restarting"] is True
    assert (backups.pending_folder() / backups.MANIFEST).is_file()
    backups._remove_tree(backups.pending_folder())


def test_notes1_ec3_a_backup_cut_off_midway_is_no_backup(client: TestClient, operator: Account,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    (MEDIA / "attachment0001").write_bytes(b"x")

    def stopped(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt  # the container stops in the middle

    monkeypatch.setattr(backups, "_hash_file", stopped)
    with pytest.raises(KeyboardInterrupt):
        backups.create()
    assert backups.entries() == []
    assert [path.name for path in backups.folder().iterdir() if path.suffix in (".zip", ".part")] == []


def test_notes1_ec3_a_restore_laid_out_halfway_is_thrown_away_at_the_start(client: TestClient,
                                                                           operator: Account) -> None:
    pending = backups.pending_folder()
    pending.mkdir(parents=True, exist_ok=True)
    (pending / "nexnotes.db").write_bytes(b"half")
    assert backups.apply_pending() is False
    assert not pending.exists()
    assert client.get("/api/auth/me").status_code == 200, "the database was not touched"


def test_notes1_ec3_a_write_stopped_midway_leaves_nothing_half_saved(client: TestClient, operator: Account) -> None:
    with pytest.raises(RuntimeError), SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.display_name = "Half"
        db.flush()
        raise RuntimeError("the server stops")
    with SessionLocal() as db:
        assert db.get(Account, operator.id).display_name == "Tester"  # type: ignore[union-attr]


def _rewrite_manifest(name: str, version: str) -> str:
    path = backups.path_of(name)
    copy = path.with_name(path.name.replace(".zip", "-x.zip"))
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(copy, "w") as target:
        for item in source.infolist():
            data = source.read(item)
            if item.filename == backups.MANIFEST:
                manifest = json.loads(data)
                manifest["version"] = version
                data = json.dumps(manifest).encode()
            target.writestr(item, data)
    return backups.receive(copy)


def test_notes1_ec9_a_backup_of_an_older_version_is_taken_and_one_of_a_newer_is_refused(
    client: TestClient, operator: Account
) -> None:
    name = client.post("/api/backups", json={}).json()["name"]
    older = _rewrite_manifest(name, "0.0.1")
    assert client.post(f"/api/backups/{older}/check").json()["usable"] is True
    newer = _rewrite_manifest(name, "99.0.0")
    refused = client.post(f"/api/backups/{newer}/check")
    assert refused.status_code == 400 and _code(refused) == "backup_too_new"
    with pytest.raises(backups.BackupError):
        backups.stage_restore(newer)
    assert not backups.pending_folder().exists()


def test_notes1_ec9_an_older_database_gets_the_new_columns_at_the_start(tmp_path: Path) -> None:
    """A database of an older version lacks columns this one has: the start adds them, the rows stay."""
    from sqlalchemy import create_engine, inspect, text

    from app import db as database

    old = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with old.begin() as connection:
        connection.execute(text("CREATE TABLE settings (key VARCHAR(64) PRIMARY KEY, value JSON)"))
        connection.execute(text("INSERT INTO settings VALUES ('trash_days', '30')"))
        connection.execute(text("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name VARCHAR(64) UNIQUE, "
                                "created_at DATETIME)"))
        connection.execute(text("INSERT INTO accounts (id, name, created_at) VALUES (1, 'robin', '2026-01-01')"))
    original = database.engine
    database.engine = old
    try:
        database.init_db()
    finally:
        database.engine = original
    columns = {column["name"] for column in inspect(old).get_columns("accounts")}
    assert {"deleted_at", "storage_limit", "role", "email"} <= columns
    with old.connect() as connection:
        assert str(connection.execute(text("SELECT value FROM settings WHERE key='trash_days'")).scalar()) == "30"
        assert connection.execute(text("SELECT name, role FROM accounts")).one() == ("robin", "member")


# --- AC-6, AC-7, AC-8, AC-11: the server settings ------------------------------------------------------------------


def test_notes1_ac6_limits_and_deadlines_have_their_defaults_and_count_at_once(
    client: TestClient, operator: Account
) -> None:
    settings = client.get("/api/settings").json()
    assert (settings["upload_max_mb"], settings["history_days"], settings["trash_days"]) == (100, 365, 90)
    saved = client.put("/api/settings", json={"upload_max_mb": 250, "history_days": 90, "trash_days": 30}).json()
    assert (saved["upload_max_mb"], saved["history_days"], saved["trash_days"]) == (250, 90, 30)
    with SessionLocal() as db:
        assert settings_service.upload_max_mb(db) == 250
        assert settings_service.history_days(db) == 90 and settings_service.trash_days(db) == 30
    assert client.get("/api/auth/me").json()["upload_max_mb"] == 250
    assert client.put("/api/settings", json={"trash_days": 3}).status_code == 422


def test_notes1_ac7_the_account_list_shows_used_storage_and_a_limit_to_set_or_remove(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    content.register_counter(lambda _db, account_id: content.Counts(bytes=4096 if account_id == anna.id else 0))
    try:
        rows = {row["name"]: row for row in client.get("/api/accounts").json()}
        assert (rows["anna"]["storage_used"], rows["anna"]["storage_limit"]) == (4096, None)
        limited = client.put(f"/api/accounts/{anna.id}/storage-limit", json={"limit": 5 * 1024**3}).json()
        assert limited["storage_limit"] == 5 * 1024**3
        removed = client.put(f"/api/accounts/{anna.id}/storage-limit", json={"limit": None}).json()
        assert removed["storage_limit"] is None
    finally:
        content._counters.clear()


def test_notes1_ac8_the_switches_of_the_other_features_stand_in_the_server_settings(
    client: TestClient, operator: Account
) -> None:
    settings = client.get("/api/settings").json()
    assert settings["link_previews"] is True and settings["share_links"] is True and settings["mcp_enabled"] is True
    assert settings["ocr_languages"] == ["de", "en"]
    saved = client.put("/api/settings", json={
        "link_previews": False, "share_links": False, "mcp_enabled": False, "ocr_languages": ["fr", "de", "tr"],
    }).json()
    assert (saved["link_previews"], saved["share_links"], saved["mcp_enabled"]) == (False, False, False)
    assert saved["ocr_languages"] == ["de", "fr", "tr"]
    assert client.put("/api/settings", json={"ocr_languages": ["xx"]}).status_code == 422
    assert client.put("/api/settings", json={"ocr_languages": []}).status_code == 422


def test_notes1_ac11_the_server_settings_show_used_and_free_space_of_the_data_folder(
    client: TestClient, operator: Account
) -> None:
    import shutil

    settings = client.get("/api/settings").json()
    disk = shutil.disk_usage(get_settings().data_dir)
    assert settings["data_total"] == disk.total
    assert abs(settings["data_free"] - disk.free) < 512 * 1024**2
    assert settings["data_used"] + settings["data_free"] <= settings["data_total"]


def test_notes1_ac6_7_8_11_only_the_operator_reaches_the_server_settings(client: TestClient,
                                                                        operator: Account) -> None:
    with new_client(make_account("anna")) as member:
        assert member.get("/api/settings").status_code == 403
        assert member.put("/api/settings", json={"trash_days": 7}).status_code == 403


# --- AC-9: errors in the log ---------------------------------------------------------------------------------------


def test_notes1_ac9_an_error_stands_in_the_log_with_time_and_cause_without_note_content(
    client: TestClient, operator: Account
) -> None:
    secret_text = "Einkaufsliste: Milch, Butter, geheimes Rezept"
    probe = APIRouter()

    @probe.post("/api/probe-failure")
    def fail(body: dict) -> None:
        raise ValueError("the disk said no")

    app.include_router(probe)
    try:
        with TestClient(app, base_url="http://testserver", headers={"X-Nexnotes-Client": "tab-probe0000"},
                        raise_server_exceptions=False) as tab:
            from .conftest import sign_in

            sign_in(tab, operator)
            answer = tab.post("/api/probe-failure", json={"text": secret_text})
        assert answer.status_code == 500 and _code(answer) == "internal_error"
        lines = client.get("/api/logs", params={"level": "ERROR"}).json()
        found = [line for line in lines if "the disk said no" in line["message"] + str(line.get("trace", ""))]
        assert found, lines
        assert found[0]["time"] and found[0]["level"] == "ERROR"
        everything = Path(get_settings().data_dir / "logs").glob("*")
        assert all(secret_text not in path.read_text(encoding="utf-8", errors="replace") for path in everything)
    finally:
        app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", "") !=
                                "/api/probe-failure"]


# --- EC-1, EC-4, EC-5: a full, read-only or missing data folder, a wrong variable ----------------------------------


def test_notes1_ec1_a_full_data_folder_says_so_and_keeps_what_was_there(client: TestClient, operator: Account) -> None:
    probe = APIRouter()

    @probe.put("/api/probe-full")
    def full() -> None:
        with SessionLocal() as db:
            row = db.get(Account, operator.id)
            assert row is not None
            row.display_name = "Never saved"
            db.flush()
            raise OSError(errno.ENOSPC, "No space left on device")

    app.include_router(probe)
    try:
        with TestClient(app, base_url="http://testserver", headers={"X-Nexnotes-Client": "tab-probe0001"},
                        raise_server_exceptions=False) as tab:
            answer = tab.put("/api/probe-full")
        assert answer.status_code == 507 and _code(answer) == "storage_full"
        assert "full" in answer.json()["detail"]["message"]
        with SessionLocal() as db:
            assert db.get(Account, operator.id).display_name == "Tester"  # type: ignore[union-attr]
    finally:
        app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", "") !=
                                "/api/probe-full"]
    assert storage.disk_full(sqlite3.OperationalError("database or disk is full"))
    assert not storage.disk_full(sqlite3.OperationalError("database is locked"))


def test_notes1_ec4_a_named_data_folder_that_is_missing_stops_the_start_with_a_clear_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.CRITICAL), pytest.raises(StartupError):
        storage.check_data_dir(tmp_path / "not-mounted", named=True)
    assert "does not exist" in caplog.text and "not-mounted" in caplog.text
    # The default folder of a development checkout is simply made.
    storage.check_data_dir(tmp_path / "made", named=False)
    assert (tmp_path / "made").is_dir()


def test_notes1_ec4_a_data_folder_without_write_access_stops_the_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    real_open = open

    def refused(path: object, *args: object, **kwargs: object) -> object:
        if ".write-check-" in str(path):
            raise PermissionError(errno.EACCES, "Permission denied")
        return real_open(path, *args, **kwargs)  # type: ignore[call-overload]

    monkeypatch.setattr("builtins.open", refused)
    with caplog.at_level(logging.CRITICAL), pytest.raises(StartupError):
        storage.check_data_dir(tmp_path, named=True)
    assert "may not write" in caplog.text
    a_file = tmp_path / "a-file"
    a_file.write_text("x")
    monkeypatch.setattr("builtins.open", real_open)
    with pytest.raises(StartupError):
        storage.check_data_dir(a_file, named=True)


@pytest.mark.parametrize(("variable", "value", "allowed"), [
    ("NEXNOTES_SESSION_DAYS", "thirty", "a whole number"),
    ("NEXNOTES_SESSION_DAYS", "0", "a whole number from 1 to 3650"),
    ("NEXNOTES_SESSION_DAYS", "-3", "a whole number from 1 to 3650"),
    ("NEXNOTES_SESSION_DAYS", "3651", "a whole number from 1 to 3650"),
    ("NEXNOTES_API_DOCS", "maybe", "true or false"),
    ("NEXNOTES_DISABLE_BACKGROUND", "perhaps", "true or false"),
    ("NEXNOTES_COOKIE_SECURE", "sometimes", "auto"),
    ("NEXNOTES_OPERATOR_NETWORKS", "192.168.1.0/33", "addresses and networks separated by commas"),
    ("NEXNOTES_OPERATOR_NETWORKS", "192.168.1.0/24, home", "addresses and networks separated by commas"),
    ("NEXNOTES_TRUSTED_PROXIES", "10.0.0.300", "addresses and networks separated by commas"),
    ("NEXNOTES_LOG_LEVEL", "verbose", "quiet, normal, detailed, trace"),
    ("NEXNOTES_PUBLIC_URL", "notes.example.com", "http:// or https://"),
    ("NEXNOTES_PUBLIC_URL", "ftp://notes.example.com", "http:// or https://"),
    ("NEXNOTES_PUBLIC_URL", "https://example.com/notes", "without a path"),
    ("NEXNOTES_PUBLIC_URL", "https://notes.example.com:port", "http:// or https://"),
    ("NEXNOTES_UPDATE_URL", "github.com/releases", "http:// or https://"),
    ("NEXNOTES_COOKIE_SUFFIX", "a;b", "letters, digits and _ only"),
    ("NEXNOTES_ARGON2_TIME", "0", "a whole number from 1 to 20"),
    ("NEXNOTES_ARGON2_MEMORY_KIB", "512", "a whole number from 1024 to 4194304"),
    ("NEXNOTES_ARGON2_PARALLELISM", "0", "a whole number from 1 to 16"),
])
def test_notes1_ec5_a_wrong_variable_names_itself_and_what_is_allowed(
    monkeypatch: pytest.MonkeyPatch, variable: str, value: str, allowed: str
) -> None:
    from pydantic import ValidationError

    monkeypatch.setenv(variable, value)
    with pytest.raises(ValidationError) as caught:
        Settings()
    [line] = _explain(caught.value)
    assert line.startswith(f"{variable} has the value {value!r}") and allowed in line


@pytest.mark.parametrize(("variable", "value"), [
    ("NEXNOTES_SESSION_DAYS", "1"),
    ("NEXNOTES_SESSION_DAYS", "3650"),
    ("NEXNOTES_OPERATOR_NETWORKS", "192.168.0.0/16, 10.0.0.5, fd00::/8"),
    ("NEXNOTES_OPERATOR_NETWORKS", ""),
    ("NEXNOTES_TRUSTED_PROXIES", "172.16.0.0/12"),
    ("NEXNOTES_LOG_LEVEL", "DEBUG"),
    ("NEXNOTES_LOG_LEVEL", "trace"),
    ("NEXNOTES_PUBLIC_URL", "https://notes.example.com/"),
    ("NEXNOTES_PUBLIC_URL", "http://192.168.1.5:8570"),
    ("NEXNOTES_COOKIE_SUFFIX", "_second"),
])
def test_notes1_ec5_good_values_still_start(monkeypatch: pytest.MonkeyPatch, variable: str, value: str) -> None:
    monkeypatch.setenv(variable, value)
    Settings()


def test_notes1_ec5_a_wrong_operator_network_stops_the_start_instead_of_opening_the_pages(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # The case the review found: "/33" was skipped and the operator's pages were open from everywhere.
    monkeypatch.setenv("NEXNOTES_OPERATOR_NETWORKS", "192.168.1.0/33")
    get_settings.cache_clear()
    try:
        with caplog.at_level(logging.CRITICAL), pytest.raises(StartupError):
            get_settings()
        assert "NEXNOTES_OPERATOR_NETWORKS has the value '192.168.1.0/33', which is not valid. Allowed:" in caplog.text
    finally:
        monkeypatch.delenv("NEXNOTES_OPERATOR_NETWORKS")
        get_settings.cache_clear()


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")
@pytest.mark.parametrize("port", ["eighty", "0", "70000"])
def test_notes1_ec5_a_wrong_port_stops_the_container_before_anything_starts(port: str) -> None:
    entrypoint = Path(__file__).resolve().parents[2] / "docker" / "entrypoint.sh"
    done = subprocess.run(["sh", str(entrypoint), "uvicorn", "app.main:app"], capture_output=True, text=True,
                          env={**os.environ, "NEXNOTES_PORT": port}, timeout=30, check=False)
    assert done.returncode == 1
    assert f"NEXNOTES_PORT has the value '{port}', which is not valid. Allowed: a whole number from 1 to 65535"         in done.stderr


def test_notes1_ec5_get_settings_stops_the_start_with_those_lines(monkeypatch: pytest.MonkeyPatch,
                                                                  caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("NEXNOTES_SESSION_DAYS", "thirty")
    get_settings.cache_clear()
    try:
        with caplog.at_level(logging.CRITICAL), pytest.raises(StartupError):
            get_settings()
        assert "NEXNOTES_SESSION_DAYS has the value 'thirty'" in caplog.text
    finally:
        monkeypatch.delenv("NEXNOTES_SESSION_DAYS")
        get_settings.cache_clear()


# --- EC-2: a data folder on a network share ------------------------------------------------------------------------


def test_notes1_ec2_a_data_folder_on_a_share_is_warned_about_in_the_log_and_on_the_setup(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from app.routers import auth
    from app.services import mounts

    table = "server:/export /data nfs4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
    assert mounts.in_table("/data", table).network is True
    assert mounts.in_table("/srv/notes", table).network is False
    with caplog.at_level(logging.WARNING):
        monkeypatch.setattr(mounts, "locate", lambda _path, **_kw: mounts.Where("network", "nfs4"))
        mounts.warn_at_start(Path("/data"), Path("/data/nexnotes.db"))
    assert "network share" in caplog.text
    monkeypatch.setattr(auth.mounts, "locate", lambda _path, **_kw: mounts.Where("network", "nfs4"))
    assert client.get("/api/setup").json()["data_on_share"] is True


# --- AC-10: an update keeps the data and makes a backup first -------------------------------------------------------


def test_notes1_ac10_a_new_version_makes_a_backup_before_it_changes_anything(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app import main

    with SessionLocal() as db:
        settings_service.save(db, {"running_version": "0.0.9"})
    main._backup_before_update()
    made = [entry for entry in backups.entries() if entry.kind == backups.UPDATE]
    assert made and made[0].note == f"before {__version__}"
    main._remember_version()
    with SessionLocal() as db:
        assert settings_service.get(db, "running_version") == __version__
    main._backup_before_update()
    assert len([entry for entry in backups.entries() if entry.kind == backups.UPDATE]) == 1


# --- EC-11: the server's clock --------------------------------------------------------------------------------------


def test_notes1_ec11_deadlines_follow_the_servers_clock_and_the_log_warns_when_it_is_far_off(
    client: TestClient, operator: Account, caplog: pytest.LogCaptureFixture
) -> None:
    health.forget()
    now_ms = int(time.time() * 1000)
    with caplog.at_level(logging.WARNING):
        near = client.post("/api/health/clock", json={"now": now_ms + 20_000}).json()
    assert abs(near["drift"]) < 60 and "clock" not in caplog.text
    with caplog.at_level(logging.WARNING):
        far = client.post("/api/health/clock", json={"now": now_ms + 3_600_000}).json()
        client.post("/api/health/clock", json={"now": now_ms + 3_600_000})
    assert far["drift"] < -3000
    assert caplog.text.count("The server's clock differs") == 1
    # A deadline (here: the 30 days of a deleted account) goes by the server's time, not by what a browser says.
    anna = make_account("anna")
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        from datetime import timedelta

        row.deleted_at = utcnow() - timedelta(days=29, hours=23)
        db.commit()
        assert accounts.purge_deleted(db) == 0


def test_notes1_ac9_the_log_comes_as_rows_page_by_page_and_live_connections_stay_out_on_normal(
    client: TestClient, operator: Account
) -> None:
    """The log as a table (time, level, source, request and account, message), page by page; uvicorn's two lines per
    live connection are a detail of the deep modes, not of "normal" (review of 21.11.2026)."""
    import logging as logging_

    from app.services import logs as log_service

    log_service.setup()
    noise = logging_.getLogger("uvicorn.error")
    noise.info("connection open")
    noise.info('127.0.0.1:50000 - "WebSocket /api/notes/abc/live" [accepted]')
    noise.info("connection closed")
    for number in range(5):
        logging_.getLogger("nexnotes.probe").warning("probe line %s", number)
    rows = client.get("/api/logs", params={"search": "probe line", "limit": 2}).json()
    assert [row["message"] for row in rows] == ["probe line 4", "probe line 3"]
    assert set(rows[0]) >= {"time", "level", "logger", "message", "request_id", "user", "at"}
    assert rows[0]["level"] == "WARNING" and rows[0]["logger"] == "nexnotes.probe"
    following = client.get("/api/logs", params={"search": "probe line", "limit": 2, "offset": 2}).json()
    assert [row["message"] for row in following] == ["probe line 2", "probe line 1"]
    everything = " ".join(row["message"] for row in client.get("/api/logs", params={"limit": 1000}).json())
    assert "connection open" not in everything and "connection closed" not in everything and "[accepted]" not in everything
    # A deep mode wants them, as DEBUG.
    assert client.put("/api/logs/level", json={"mode": "detailed", "minutes": 30}).status_code == 200
    try:
        noise.info("connection open")
        found = [row for row in client.get("/api/logs", params={"search": "connection open"}).json()]
        assert found and found[0]["level"] == "DEBUG"
    finally:
        client.put("/api/logs/level", json={"mode": "normal", "minutes": 0})
