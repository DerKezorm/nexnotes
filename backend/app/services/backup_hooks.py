"""What goes into a backup of nexnotes and how it comes back: the hooks of the shared module ``sicherung``
(``app/vendor/nexsicherung``, bauplaene/sicherung 1.0.0). The module runs everything around them (names, list,
schedule, keeping, upload, download, the copy before a restore, staging and the start).

The archive keeps nexnotes' format, so every backup made before the module stays readable and restorable:

* ``nexnotes-backup.json`` (the manifest, written last), ``database/nexnotes.db`` (through SQLite's backup API, never
  as a file: it runs in WAL mode), ``secret.key``, and every attachment under ``attachments/``;
* the manifest lists every attachment with its size and sha256, so the check before a restore tells a damaged archive
  from a good one and says what a restore would change, in the attachments and in the notes;
* a restore swaps the attachments folder as a whole, then the database and the key, ends every session and builds a
  damaged search index anew.

The archive is not encrypted: it lies in the data folder next to the database it copies. Downloading it asks for the
operator's password once more (the module).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import time
import zipfile
import zlib
from pathlib import Path
from typing import Any

from .. import private
from ..config import get_settings
from ..vendor import nexsicherung
from ..vendor.nexsicherung import Checked, Described, Schedule, tools
from ..vendor.nexsicherung.errors import BackupError
from . import settings_service, storage

logger = logging.getLogger("nexnotes.backups")

MANIFEST = "nexnotes-backup.json"
DATABASE_ENTRY = "database/nexnotes.db"
MEDIA_PREFIX = "attachments/"
#: The server's key: without it the sealed secrets of the database (providers, the mail password, second factors) are
#: lost after a restore on a new server.
SECRET_ENTRY = "secret.key"
#: A media file's name: the attachment's id and its ending. Nothing else is packed or unpacked.
MEDIA_NAME = re.compile(r"^[A-Za-z0-9_-]{8,64}(\.[a-z0-9]{1,8})?$")
ATTACHMENTS = "attachments"
#: Limits of what a check or a restore unpacks: the database and each attachment (the size in an archive may lie).
DATABASE_MAX = 64 * 1024**3
MEMBER_MAX = 64 * 1024**3

#: The schedule as nexnotes kept it before the module (``backup_schedule``, ``backup_keep``; their defaults in
#: ``settings_service.DEFAULTS``), with the time of day the module adds (``backup_time``): the night's hour nexnotes
#: used before (3 to 6) is 03:00.
DEFAULT_EVERY = "daily"
DEFAULT_TIME = "03:00"
DEFAULT_KEEP = 7

#: What ``PRAGMA integrity_check`` says of the search index alone (``services/search.py``): FTS5 "secure-delete", which
#: versions before set, left it malformed in some databases. The index is built from the notes, so a backup holding
#: such a one is whole all the same; ``apply`` builds it anew. SQLite up to 3.50 names the table as
#: ``FTS5 table main.search_index_v3``, later versions as ``fts5: checksum mismatch for table "search_index_v3"``.
SEARCH_INDEX_PROBLEM = re.compile(r'FTS5 table main\.search_index_v\d+|^fts5: .*\btable "search_index_v\d+"')

#: What a damaged member raises while it unpacks: the module's list, and zlib's own error (a flipped byte in a
#: deflated member), which the module's ``tools.DAMAGE`` does not name.
DAMAGE = (*tools.DAMAGE, zlib.error)

#: How often the check reads the archive's database when the system does not let it for a moment (a virus scanner
#: holding the fresh copy, a busy disk), and the pause between: no damage, a new copy after a pause.
DATABASE_TRIES = 3
DATABASE_PAUSE_SECONDS = 0.25

#: How many titles of each kind the check names.
TITLES_SHOWN = 5
#: A note as both databases store it: owner, title, last change (as stored text), in the trash.
_NoteRow = tuple[int, str, str, bool]


def media_root() -> Path:
    return get_settings().data_dir / ATTACHMENTS


def media_files(root: Path) -> list[tuple[str, Path]]:
    """Every media file, by name; nothing else that may lie there (temporary files of an upload, links)."""
    if not root.is_dir():
        return []
    return sorted(
        (entry.name, entry) for entry in root.iterdir()
        if MEDIA_NAME.match(entry.name) and entry.is_file() and not entry.is_symlink()
    )


def _manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = json.loads(tools.read_small(archive, MANIFEST, limit=64 * 1024 * 1024).decode("utf-8"))
    except (KeyError, ValueError, *DAMAGE) as exc:
        raise BackupError("backup_invalid", "the archive has no readable manifest") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("media", {}), dict):
        raise BackupError("backup_invalid", "the manifest has the wrong shape")
    return raw


def write_archive(target: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """The archive as nexnotes made it before the module and as ``pack`` makes it now: the database through the backup
    API, the key, every attachment with its size and hash, the manifest last (an archive without it is recognisably
    incomplete). Returns the manifest written."""
    settings = get_settings()
    database = target.with_name(target.name + ".db")
    try:
        private.new_file(database)
        tools.copy_database(settings.database_path, database)
        connection = sqlite3.connect(database)
        try:
            notes = int(connection.execute("SELECT count(*) FROM notes WHERE deleted_at IS NULL").fetchone()[0])
        except sqlite3.DatabaseError:
            notes = 0
        finally:
            connection.close()
        manifest = {**manifest, "notes": notes, "files": 0, "bytes": 0, "media": {}}
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(database, DATABASE_ENTRY)
            key = settings.data_dir / "secret.key"
            if key.is_file():
                archive.write(key, SECRET_ENTRY)
            for rel, full in media_files(media_root()):
                try:
                    size = full.stat().st_size
                    # Photos and PDFs are packed already; deflating them again only costs time.
                    archive.write(full, MEDIA_PREFIX + rel, compress_type=zipfile.ZIP_STORED)
                    manifest["media"][rel] = [size, tools.sha256_file(full)]
                except OSError as exc:
                    logger.warning("A file could not be backed up and was left out: %s", exc.strerror)
                    continue
                manifest["files"] += 1
                manifest["bytes"] += size
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False))
    finally:
        database.unlink(missing_ok=True)
        # The settings show what nexnotes takes; a new archive should be in it at once, not a minute later.
        storage.forget_footprint()
    logger.info("Backup written kind=%s notes=%s files=%s bytes=%s", manifest.get("kind"), manifest["notes"],
                manifest["files"], manifest["bytes"])
    return manifest


# --- The notes a restore changes ------------------------------------------------------------------------------------


def _notes_in(connection: sqlite3.Connection) -> dict[str, _NoteRow]:
    """The notes of a database file, read with plain SQL: an archive from an older version may lack the table or the
    trash column; then it has no notes, or none in the trash."""
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "notes" not in tables:
        return {}
    columns = {row[1] for row in connection.execute("PRAGMA table_info(notes)")}
    trashed = "deleted_at IS NOT NULL" if "deleted_at" in columns else "0"
    return {
        str(row[0]): (int(row[1]), str(row[2] or ""), str(row[3] or ""), bool(row[4]))
        for row in connection.execute(f"SELECT id, owner_id, title, updated_at, {trashed} FROM notes")  # noqa: S608
    }


def _live_notes() -> dict[str, _NoteRow]:
    """The notes of the running database, through the app's own connection (never a second one from outside)."""
    from ..db import engine

    raw = engine.raw_connection()
    try:
        return _notes_in(raw.driver_connection)  # type: ignore[arg-type]
    finally:
        raw.close()


def _compare_notes(archived: dict[str, _NoteRow], current: dict[str, _NoteRow],
                   viewer_id: int | None) -> dict[str, Any]:
    """Alive in the archive but not here: comes back. Alive here but not in the archive: goes. Alive in both with
    another last change: changes. Titles newest first, only the viewer's own (an operator never reads titles of other
    accounts, NOTES-2 AC-7)."""
    alive_then = {key: row for key, row in archived.items() if not row[3]}
    alive_now = {key: row for key, row in current.items() if not row[3]}
    add = [row for key, row in alive_then.items() if key not in alive_now]
    remove = [row for key, row in alive_now.items() if key not in alive_then]
    change = [row for key, row in alive_now.items() if key in alive_then and alive_then[key][2] != row[2]]

    def titles(rows: list[_NoteRow]) -> list[str]:
        own = sorted((row for row in rows if viewer_id is not None and row[0] == viewer_id), key=lambda row: row[2],
                     reverse=True)
        return [row[1] for row in own[:TITLES_SHOWN]]

    return {
        "notes_add": len(add), "notes_change": len(change), "notes_remove": len(remove),
        "notes_add_titles": titles(add), "notes_change_titles": titles(change), "notes_remove_titles": titles(remove),
    }


def _archived_notes(scratch: Path) -> dict[str, _NoteRow]:
    connection = sqlite3.connect(f"file:{scratch.as_posix()}?mode=ro", uri=True)
    try:
        return _notes_in(connection)
    except sqlite3.DatabaseError:
        return {}
    finally:
        connection.close()


def _end_restored_sessions(database: Path) -> None:
    """Sign-ins stored in the backup would come back to life, even ones ended since: everybody signs in anew. A search
    index the check let pass although damaged (``SEARCH_INDEX_PROBLEM``) is built anew from the notes' texts."""
    connection = sqlite3.connect(database)
    try:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").fetchone():
            connection.execute("DELETE FROM auth_sessions")
            connection.commit()
        for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
            if not re.fullmatch(r"search_index_v\d+", name):
                continue
            try:
                connection.execute(f"INSERT INTO \"{name}\"(\"{name}\", rank) VALUES('integrity-check', 0)")
            except sqlite3.DatabaseError:
                logger.warning("The search index of the restored database was damaged and is built anew")
                connection.execute(f"INSERT INTO \"{name}\"(\"{name}\") VALUES('rebuild')")
                connection.commit()
    finally:
        connection.close()


class NexnotesHooks(nexsicherung.AppHooks):
    # --- What goes in

    def pack(self, target: Path, *, kind: str, note: str, created: str) -> None:
        from .. import __version__

        write_archive(target, {"version": __version__, "created": created, "kind": kind, "note": note})

    def describe(self, path: Path) -> Described:
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                if DATABASE_ENTRY not in archive.namelist():
                    raise BackupError("backup_invalid", "the archive holds no database")
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        return Described(
            created=str(manifest.get("created") or "") or None, kind=str(manifest.get("kind") or "manual"),
            note=str(manifest.get("note") or ""), version=str(manifest.get("version") or ""),
            facts={"notes": int(manifest.get("notes") or 0), "files": int(manifest.get("files") or 0)},
        )

    def check(self, path: Path, *, viewer: Any = None, archive_password: str | None = None) -> Checked:
        """The trial run: is the archive whole, and what would a restore change, in the notes and in the attachments?
        ``viewer``: the id of the account asking, whose own notes are named by title."""
        scratch = nexsicherung.archives.scratch("check")
        archived: dict[str, _NoteRow] = {}
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                media: dict[str, list[Any]] = manifest.get("media", {})
                members = {info.filename: info for info in archive.infolist()}
                try:
                    database_ok = DATABASE_ENTRY in members and tools.read_database(
                        archive, DATABASE_ENTRY, scratch, limit=DATABASE_MAX, ignore=SEARCH_INDEX_PROBLEM,
                        tries=DATABASE_TRIES, pause=DATABASE_PAUSE_SECONDS)
                except (BackupError, zlib.error):
                    database_ok = False
                if database_ok:
                    archived = _archived_notes(scratch)
                else:
                    logger.warning("The database in the backup is damaged or could not be read name=%s", path.name)
                damaged: list[str] = []
                for rel, value in media.items():
                    member = members.get(MEDIA_PREFIX + rel)
                    if member is None or tools.safe_member(member.filename, MEDIA_PREFIX, MEDIA_NAME) != rel \
                            or member.file_size != value[0]:
                        damaged.append(rel)
                        continue
                    try:
                        if tools.sha256_member(archive, member, limit=MEMBER_MAX) != (value[0], value[1]):
                            damaged.append(rel)
                    except (BackupError, *DAMAGE):
                        damaged.append(rel)
                damaged += [name for name, info in members.items() if not info.is_dir()
                            and name not in (MANIFEST, DATABASE_ENTRY, SECRET_ENTRY)
                            and tools.safe_member(name, MEDIA_PREFIX, MEDIA_NAME) not in media]
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        finally:
            try:
                scratch.unlink(missing_ok=True)
            except OSError:
                # Still held for a moment: a hidden name the module tidies away later.
                pass
        current = dict(media_files(media_root()))
        details = {
            "would_add": sum(1 for rel in media if rel not in current),
            "would_remove": sum(1 for rel in current if rel not in media),
            "would_change": sum(1 for rel, full in current.items() if rel in media
                                and (full.stat().st_size != media[rel][0]
                                     or tools.sha256_file(full) != media[rel][1])),
            **_compare_notes(archived, _live_notes(), viewer if isinstance(viewer, int) else None),
        }
        return Checked(database_ok=database_ok, files_ok=not damaged, damaged=sorted(damaged), details=details)

    # --- How it comes back, at the next start

    def unpack(self, path: Path, pending: Path, *, archive_password: str | None = None) -> None:
        with zipfile.ZipFile(path) as archive:
            manifest = _manifest(archive)
            tools.extract(archive, DATABASE_ENTRY, pending / "nexnotes.db", limit=DATABASE_MAX)
            if SECRET_ENTRY in archive.namelist():
                (pending / "secret.key").write_bytes(tools.read_small(archive, SECRET_ENTRY, limit=4096))
            (pending / ATTACHMENTS).mkdir()
            for rel in manifest.get("media", {}):
                if not MEDIA_NAME.fullmatch(rel):
                    raise BackupError("backup_damaged", "a file name leaves its folder")
                tools.extract(archive, MEDIA_PREFIX + rel, pending / ATTACHMENTS / rel, limit=MEMBER_MAX)

    def tidy(self) -> None:
        """At every start: what an earlier restore set aside, and an empty archive a stopped process left. The module
        names an archive before ``pack`` writes it; a process stopped in between (the container stopped mid-backup)
        leaves that name empty, listed as unreadable for good. Before the module nothing was left (only a hidden
        part)."""
        folder = nexsicherung.archives.folder()
        if folder.is_dir():
            for path in folder.glob("nexnotes-*.zip"):
                try:
                    if path.is_file() and path.stat().st_size == 0 and nexsicherung.archives.known_name(path.name):
                        path.unlink()
                        logger.warning("An empty backup left by a stopped process was removed name=%s", path.name)
                except OSError:
                    continue
        root = media_root()
        if not root.parent.is_dir():
            return
        for leftover in root.parent.glob(f"{root.name}.replaced-*"):
            if leftover.is_dir() and not leftover.is_symlink() and not tools.remove_tree(leftover):
                logger.warning("A folder set aside by a restore could not be removed yet name=%s", leftover.name)

    def apply(self, pending: Path) -> None:
        """The attachments folder belongs to nexnotes alone: it is swapped as a whole, the old one set aside until the
        end; then the database (its WAL left behind would be read into the restored one) and the key. All or nothing:
        on a failure the attachments, the database and the key from before are put back."""
        settings = get_settings()
        root = media_root()
        target = settings.database_path
        key = settings.data_dir / "secret.key"
        stamp = time.time_ns()
        aside = root.with_name(f"{root.name}.replaced-{stamp}")
        database_aside = target.with_name(f"{target.name}.replaced-{stamp}")
        key_aside = key.with_name(f"{key.name}.replaced-{stamp}")
        moved = database_moved = key_moved = False
        try:
            if root.exists():
                os.rename(root, aside)
                moved = True
            incoming = pending / ATTACHMENTS
            if incoming.is_dir():
                shutil.move(str(incoming), str(root))
            else:
                root.mkdir(parents=True)
            for suffix in ("-wal", "-shm", "-journal"):
                target.with_name(target.name + suffix).unlink(missing_ok=True)
            if target.exists():
                os.replace(target, database_aside)
                database_moved = True
            shutil.copyfile(pending / "nexnotes.db", target)
            _end_restored_sessions(target)
            if (pending / "secret.key").is_file():
                if key.exists():
                    os.replace(key, key_aside)
                    key_moved = True
                shutil.copyfile(pending / "secret.key", key)
                private.tighten(key)
        except Exception:
            logger.exception("Restoring the backup failed, the previous state is put back")
            if moved:
                if root.exists():
                    tools.remove_tree(root)
                os.rename(aside, root)
            if database_moved:
                os.replace(database_aside, target)
            if key_moved:
                os.replace(key_aside, key)
            raise
        if database_moved:
            database_aside.unlink(missing_ok=True)
        if key_moved:
            key_aside.unlink(missing_ok=True)
        if moved:
            tools.remove_tree(aside)
        logger.info("Backup restored")

    # --- The schedule, under nexnotes' own keys

    def load_schedule(self) -> Schedule:
        from ..db import SessionLocal

        with SessionLocal() as db:
            every = settings_service.get(db, "backup_schedule")
            at = settings_service.get(db, "backup_time")
            keep = settings_service.get(db, "backup_keep")
        return Schedule(
            every=every if every in nexsicherung.EVERY else DEFAULT_EVERY,
            time=at if isinstance(at, str) and nexsicherung.model.TIME.match(at) else DEFAULT_TIME,
            keep=keep if isinstance(keep, int) and nexsicherung.model.KEEP_MIN <= keep <= nexsicherung.model.KEEP_MAX
            else DEFAULT_KEEP,
        )

    def save_schedule(self, schedule: Schedule) -> None:
        from ..db import SessionLocal

        with SessionLocal() as db:
            settings_service.save(db, {"backup_schedule": schedule.every, "backup_time": schedule.time,
                                       "backup_keep": schedule.keep})


def configure() -> NexnotesHooks:
    """The module set up for nexnotes: its folders, version and hooks. At the start, before ``apply_pending``; done on
    import too, so the tests find it configured."""
    from .. import __version__

    settings = get_settings()
    hooks = NexnotesHooks()
    nexsicherung.configure(nexsicherung.AppConfig(
        app_name="nexnotes", data_dir=settings.data_dir, version=__version__, hooks=hooks,
        database_path=settings.database_path,
        parts={"attachments": (ATTACHMENTS,), "exports": ("exports",)},
    ))
    return hooks
