"""The vault (NOTES-16): locked notes, encrypted on the member's device, never readable by the server.

**What the server holds.** Per account a ``Vault``: how the device derives its keys from the password (``kdf``), the
vault key wrapped by the device (``wrapped_key``) and the SHA-256 of a check value the device derives from the password
as well (``auth_hash``). The server hands the wrapped key out only for the right check value and counts wrong ones
(EC-1): after every third one a wait, 30 seconds and twice as long each round after (at most a day). It never sees the
password, the vault key or anything of a locked note but its title.

**Locking** is a step in two parts (``lock_start``, ``lock_finish``): the start shuts the note's live room (close code
``CLOSE_LOCKED``), takes the last version, and names what the device must encrypt (the content, every version, every
attachment of the note); the device lays each part down encrypted (``stage``) and the finish swaps them in one
transaction: the note is ``locked``, its plain text, Yjs updates, tags, versions, recognised text and attachment files
go, the search index keeps the title only. Deleted rows are overwritten (``PRAGMA secure_delete``), the search
index is merged so that nothing deleted stays in it, and the write-ahead log is emptied after. Unlocking
(``unlock_start``, ``unlock_finish``) is the same step backwards; the attachments run through the checks of NOTES-10
again.

**A locked note open in a browser** is saved whole (``save``): the encrypted Yjs state with the revision it started
from. One that arrives on an older revision still becomes the current one, and the content it replaces goes into the
history (EC-5). A save under another vault ``epoch`` (the password changed meanwhile) is refused (EC-7).

**Forgotten password**: ``reset`` makes a new vault; every locked note of the account goes for good, but only when the
device names their number (EC-2).

Other features dock on through ``tags.HIDDEN_NOTES`` (lists, tags, search, export, recognition), ``tags.LOCK_HOOKS``,
``notes_list.LOCK_CHECKS``; sharing (NOTES-13) fills ``SHARE_CHECKS`` so that a shared note cannot be locked.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import logging
import os
import secrets
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import ColumnElement, delete, func, select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal, engine
from ..errors import error
from ..models import Account, Note, NoteUpdate, utcnow
from ..models_attachments import Attachment, AttachmentRef
from ..models_history import NoteVersion
from ..models_vault import SealedNote, Vault, VaultPending
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from ..notedoc.markdown import to_plain
from ..notedoc.room import CLOSE_LOCKED
from . import attachments, content, history, notes, settings_service, shares, tags

logger = logging.getLogger("nexnotes.vault")

#: The only derivation taken today, and its bounds: fewer rounds than OWASP's advice for PBKDF2-HMAC-SHA-256 (2023)
#: are refused, more than ten million would keep a phone busy for minutes.
KDF_NAME = "PBKDF2"
KDF_HASH = "SHA-256"
MIN_ITERATIONS = 600_000
MAX_ITERATIONS = 10_000_000
SALT_BYTES = (16, 64)
#: The wrapped vault key: the format byte, a nonce of 12 bytes, 32 bytes of key and 16 of tag.
WRAPPED_BYTES = (61, 256)
#: The first byte of everything a device seals (``FORMAT``): format 2 binds a note's content to its revision and a
#: version from before the lock to its id (the AAD, see ``frontend/src/vault/crypto.ts``). Format 1 had the same AAD
#: for the content and every version; it never left a test installation and is refused, not read.
FORMAT = 0x02
#: The check value: 32 bytes.
AUTH_BYTES = 32
#: Wrong passwords per round, the first wait and the longest (EC-1).
PER_ROUND = 3
FIRST_WAIT = timedelta(seconds=30)
LONGEST_WAIT = timedelta(hours=24)
#: A lock or unlock started and not finished counts for nothing after this.
PENDING_FOR = timedelta(minutes=10)
#: What an encrypted part may add to its plain size (format byte, nonce, tag, the header of an attachment).
OVERHEAD = 64 * 1024
#: The revision a note's content has when it is locked; every save raises it by one.
FIRST_REV = 1
LOCK = "lock"
UNLOCK = "unlock"
STEPS = (LOCK, UNLOCK)
#: The kind of an attachment of a locked note: the server knows nothing of its content.
SEALED_KIND = "sealed"
#: Further ways a note counts as shared besides ``shares.lock_refused`` (NOTES-13): such a note cannot be locked (EC-3).
SHARE_CHECKS: list[Callable[[Session, Note], bool]] = []


# --- Small helpers ------------------------------------------------------------------------------------------------


def _bytes(value: str | None, field: str, low: int, high: int) -> bytes:
    """Strict base64 (standard or URL-safe), its length between ``low`` and ``high``; else ``invalid_input``."""
    try:
        text = (value or "").strip()
        raw = base64.b64decode(text.replace("-", "+").replace("_", "/") + "=" * (-len(text) % 4), validate=True)
    except (binascii.Error, ValueError):
        raise error("invalid_input", "The input is not valid.", 422, fields=[field]) from None
    if not low <= len(raw) <= high:
        raise error("invalid_input", "The input is not valid.", 422, fields=[field])
    return raw


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _auth_hash(auth: bytes) -> str:
    return hashlib.sha256(auth).hexdigest()


def _format_error() -> Exception:
    return error("vault_format", "The device sealed this in a format the server does not take. Update the app.", 422)


def check_format(data: bytes) -> bytes:
    """Something a device sealed, in today's format (``FORMAT``); anything else is ``vault_format``."""
    if not data or data[0] != FORMAT:
        raise _format_error()
    return data


def _wrapped(value: str) -> bytes:
    return check_format(_bytes(value, "wrapped_key", *WRAPPED_BYTES))


def _write_lock(db: Session) -> None:
    """The write lock before the first read (as ``history._write_lock``): two requests at once read one after the
    other, never the same count of failures."""
    connection = db.connection()
    raw = connection.connection.driver_connection
    if raw is not None and not raw.in_transaction:
        connection.exec_driver_sql("BEGIN IMMEDIATE")


def check_kdf(kdf: Any) -> dict[str, Any]:
    """The derivation as the server keeps it; anything else is ``invalid_input``."""
    if not isinstance(kdf, dict) or kdf.get("name") != KDF_NAME or kdf.get("hash") != KDF_HASH:
        raise error("invalid_input", "The input is not valid.", 422, fields=["kdf"])
    iterations = kdf.get("iterations")
    if not isinstance(iterations, int) or isinstance(iterations, bool) \
            or not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        raise error("invalid_input", "The input is not valid.", 422, fields=["kdf.iterations"])
    salt = _bytes(kdf.get("salt"), "kdf.salt", *SALT_BYTES)
    return {"name": KDF_NAME, "hash": KDF_HASH, "iterations": iterations, "salt": b64(salt)}


def vault_of(db: Session, account_id: int) -> Vault | None:
    return db.get(Vault, account_id)


def _vault(db: Session, account: Account) -> Vault:
    found = vault_of(db, account.id)
    if found is None:
        raise error("vault_missing", "The vault is not set up.", 404)
    return found


def wait_left(found: Vault) -> int:
    """Seconds before the next try is taken (0: now)."""
    if found.wait_until is None:
        return 0
    left = (found.wait_until - utcnow()).total_seconds()
    return max(0, int(left + 0.999))


def locked_condition() -> ColumnElement[bool]:
    """``tags.HIDDEN_NOTES``: a locked note."""
    return Note.locked.is_(True)


def locked_count(db: Session, account_id: int, *, with_trash: bool = True) -> int:
    query = select(func.count()).select_from(Note).where(Note.owner_id == account_id, Note.locked.is_(True))
    if not with_trash:
        query = query.where(Note.deleted_at.is_(None))
    return int(db.scalar(query) or 0)


# --- The vault ----------------------------------------------------------------------------------------------------


def status(db: Session, account: Account) -> dict[str, Any]:
    """What a device needs before the password is typed: whether there is a vault, how to derive the keys, its epoch,
    how many notes are locked, and how long a wait still lasts."""
    found = vault_of(db, account.id)
    if found is None:
        return {"set_up": False, "locked_notes": 0, "locked_all": 0}
    return {
        "set_up": True,
        "kdf": found.kdf,
        "epoch": found.epoch,
        "locked_notes": locked_count(db, account.id, with_trash=False),
        "locked_all": locked_count(db, account.id),
        "wait": wait_left(found),
        "failures": found.failures,
    }


def setup(db: Session, account: Account, kdf: Any, wrapped_key: str, auth: str, understood: bool) -> dict[str, Any]:
    """The first lock (AC-1): the vault of the account, made once. ``understood`` is the box "Ich habe verstanden"."""
    if not understood:
        raise error("vault_not_understood", "Confirm that a forgotten password cannot be recovered.", 422)
    if vault_of(db, account.id) is not None:
        raise error("vault_exists", "The vault is set up already.", 409)
    row = Vault(account_id=account.id, kdf=check_kdf(kdf), wrapped_key=_wrapped(wrapped_key),
                auth_hash=_auth_hash(_bytes(auth, "auth", AUTH_BYTES, AUTH_BYTES)), epoch=1)
    db.add(row)
    db.commit()
    logger.info("Vault set up account=%s", account.id)
    return status(db, account)


def _verify(db: Session, account: Account, auth: str) -> Vault:
    """The right check value, or a counted failure (EC-1): ``vault_wait`` while a wait lasts, ``vault_wrong`` with the
    tries left before the next wait and the wait it started. The count is read and written under the write lock:
    tries at the same moment wait for each other, and none of them is lost (twelve at once still give a wait after
    the third)."""
    given = _bytes(auth, "auth", AUTH_BYTES, AUTH_BYTES)
    _write_lock(db)
    found = db.get(Vault, account.id, populate_existing=True)
    if found is None:
        db.rollback()
        raise error("vault_missing", "The vault is not set up.", 404)
    waiting = wait_left(found)
    if waiting:
        db.rollback()
        raise error("vault_wait", "Too many wrong passwords. Wait a moment.", 429, wait=waiting)
    if hmac.compare_digest(_auth_hash(given), found.auth_hash):
        if found.failures or found.rounds or found.wait_until:
            found.failures, found.rounds, found.wait_until = 0, 0, None
        db.commit()
        return found
    found.failures += 1
    wait = 0
    if found.failures % PER_ROUND == 0:
        found.rounds += 1
        length = min(FIRST_WAIT * (2 ** min(found.rounds - 1, 20)), LONGEST_WAIT)
        found.wait_until = utcnow() + length
        wait = int(length.total_seconds())
    db.commit()
    logger.warning("Wrong vault password account=%s failures=%s", found.account_id, found.failures)
    raise error("vault_wrong", "The vault password is wrong.", 403, left=PER_ROUND - found.failures % PER_ROUND,
                wait=wait)


def unlock(db: Session, account: Account, auth: str) -> dict[str, Any]:
    """The wrapped vault key for the right check value (AC-3, AC-7, AC-8)."""
    found = _verify(db, account, auth)
    return {"wrapped_key": b64(found.wrapped_key), "kdf": found.kdf, "epoch": found.epoch}


def change_password(db: Session, account: Account, auth_old: str, kdf: Any, wrapped_key: str,
                    auth: str) -> dict[str, Any]:
    """A new password (AC-5): the same vault key, wrapped anew. Every locked note is read with the new password on
    every device; a device holding the key of before hears ``vault_changed`` and asks again (EC-7)."""
    _vault(db, account)
    clean_kdf = check_kdf(kdf)
    wrapped = _wrapped(wrapped_key)
    new_auth = _bytes(auth, "auth", AUTH_BYTES, AUTH_BYTES)
    found = _verify(db, account, auth_old)
    found.kdf, found.wrapped_key, found.auth_hash = clean_kdf, wrapped, _auth_hash(new_auth)
    found.epoch += 1
    found.changed_at = utcnow()
    db.commit()
    logger.info("Vault password changed account=%s", account.id)
    return status(db, account)


async def reset(account: Account, count: int, kdf: Any, wrapped_key: str, auth: str,
                understood: bool) -> dict[str, Any]:
    """"Passwort vergessen" (EC-2): a new vault; every locked note of the account goes for good, the trash included.
    Only when ``count`` is the number the device showed: a note locked meanwhile on another device is not lost
    unseen."""
    if not understood:
        raise error("vault_not_understood", "Confirm that a forgotten password cannot be recovered.", 422)
    clean_kdf = check_kdf(kdf)
    wrapped = _wrapped(wrapped_key)
    new_auth = _bytes(auth, "auth", AUTH_BYTES, AUTH_BYTES)
    with SessionLocal() as db:
        _vault(db, account)
        ids = list(db.scalars(select(Note.id).where(Note.owner_id == account.id, Note.locked.is_(True))))
    if count != len(ids):
        raise error("vault_count", "The number of locked notes changed.", 409, count=len(ids))
    rooms = notes.rooms()
    for note_id in ids:
        await rooms.close_note(note_id, CLOSE_LOCKED)

    def run() -> int:
        from . import folders, trash

        with SessionLocal() as db:
            folders._write_lock(db)
            found = _vault(db, account)
            going = list(db.scalars(select(Note.id).where(Note.owner_id == account.id, Note.locked.is_(True))))
            if len(going) != count:
                raise error("vault_count", "The number of locked notes changed.", 409, count=len(going))
            for start in range(0, len(going), 500):
                chunk = going[start:start + 500]
                for hook in trash.PURGE_HOOKS:
                    hook(db, chunk)
                db.execute(delete(Note).where(Note.id.in_(chunk)))
            found.kdf, found.wrapped_key, found.auth_hash = clean_kdf, wrapped, _auth_hash(new_auth)
            found.epoch += 1
            found.failures, found.rounds, found.wait_until = 0, 0, None
            found.changed_at = found.created_at = utcnow()
            db.commit()
            return len(going)

    removed = await asyncio.to_thread(run)
    await asyncio.to_thread(wipe_traces)
    notes.nudge_all()
    logger.warning("Vault made anew, locked notes removed account=%s count=%s", account.id, removed)
    with SessionLocal() as db:
        return {**status(db, account), "removed": removed}


# --- Locking and unlocking: the two steps -------------------------------------------------------------------------


def pending_of(db: Session, note_id: str) -> VaultPending | None:
    """The lock or unlock of the note under way, ``None`` when there is none or it ran out."""
    found = db.get(VaultPending, note_id)
    if found is None or found.started_at < utcnow() - PENDING_FOR:
        return None
    return found


def busy(db: Session, note_id: str) -> bool:
    """The note takes no change from the live room or the server: locked, or being locked or unlocked."""
    row = db.execute(select(Note.locked).where(Note.id == note_id)).first()
    return bool(row is not None and row.locked) or pending_of(db, note_id) is not None


def _own_note(db: Session, account: Account, note_id: str) -> Note:
    note = notes.note_for(db, account, note_id, write=True)
    if note.owner_id != account.id:
        raise error("not_found", "Not found.", 404)
    return note


def stage_path(note_id: str, step: str, part: str) -> Path:
    """Where a part of a lock or unlock waits: a work file of the attachments folder (old ones go in the cleanup)."""
    digest = hashlib.sha256(f"{note_id}|{step}|{part}".encode()).hexdigest()[:40]
    return attachments.root() / f"{attachments.WORK_PREFIX}vault-{digest}"


def _remove_staged(note_id: str, step: str, parts: list[str]) -> None:
    for part in parts:
        stage_path(note_id, step, part).unlink(missing_ok=True)


def _keeper(db: Session, row: Attachment) -> str | None:
    """Another note of the same owner that shows the attachment today (a copied block): it moves there and stays as
    it is, never sealed with this note."""
    return db.scalar(select(AttachmentRef.note_id).join(Note, Note.id == AttachmentRef.note_id)
                     .where(AttachmentRef.attachment_id == row.id, AttachmentRef.note_id != row.note_id,
                            Note.owner_id == row.owner_id, Note.locked.is_(False)).limit(1))


async def _shut_room(note_id: str) -> None:
    """Everybody out of the note's live room (close code 4423), and the room gone, so that nothing it still folds
    lands after the lock."""
    rooms = notes.rooms()
    await rooms.close_note(note_id, CLOSE_LOCKED)
    for _ in range(200):
        if rooms.room_of(note_id) is None:
            return
        await asyncio.sleep(0.025)
    logger.warning("A live room stayed open while locking note=%s", note_id)


async def lock_start(account: Account, note_id: str) -> dict[str, Any]:
    """The first part of locking (AC-2): the note takes no change from now on; the answer is everything the device
    must encrypt: the whole Yjs state, the ids of the versions and of the attachments to seal."""
    with SessionLocal() as db:
        _vault(db, account)
        note = _own_note(db, account, note_id)
        if note.locked:
            raise error("note_locked", "The note is locked.", 409)
        if shares.lock_refused(db, note_id) or any(check(db, note) for check in SHARE_CHECKS):
            # Shared with somebody, itself or through a folder, or with a read link: sharing ends first (NOTES-13 EC-3).
            raise error("note_shared", "Stop sharing the note before locking it.", 409)
        running = pending_of(db, note_id)
        if running is not None and running.step != LOCK:
            raise error("note_busy", "The note is being unlocked.", 409)
        db.execute(delete(VaultPending).where(VaultPending.note_id == note_id))
        db.add(VaultPending(note_id=note_id, account_id=account.id, step=LOCK, parts=[], started_at=utcnow()))
        db.commit()
    await _shut_room(note_id)
    # What was written in the last minutes becomes a version first: from now on nothing is written until the lock.
    await asyncio.to_thread(history.take_now, note_id)

    def read() -> dict[str, Any]:
        with SessionLocal() as db:
            state = history._current_state(db, note_id) or b""
            versions = list(db.execute(select(NoteVersion.id, NoteVersion.state)
                                       .where(NoteVersion.note_id == note_id).order_by(NoteVersion.id)))
            sealing = [row.id for row in db.scalars(select(Attachment).where(Attachment.note_id == note_id)
                                                    .order_by(Attachment.created_at, Attachment.id))
                       if _keeper(db, row) is None]
            parts = ["content", *(f"version:{row.id}" for row in versions),
                     *(f"attachment:{each}" for each in sealing)]
            pending = db.get(VaultPending, note_id)
            if pending is None:
                raise error("lock_not_started", "Start the lock again.", 409)
            pending.parts = parts
            found = vault_of(db, account.id)
            db.commit()
            # The content is sealed for revision ``FIRST_REV``, each version for its id (format 2).
            return {"state": b64(state), "rev": FIRST_REV,
                    "versions": [{"id": row.id, "state": b64(row.state)} for row in versions],
                    "attachments": sealing,
                    "epoch": found.epoch if found else 0}

    answer = await asyncio.to_thread(read)
    logger.info("Lock started note=%s", note_id)
    return answer


def _pending_for(db: Session, account: Account, note_id: str, step: str) -> VaultPending:
    found = pending_of(db, note_id)
    if found is None or found.account_id != account.id or found.step != step:
        raise error("lock_not_started", "Start the lock again.", 409)
    return found


def _part_limit(db: Session, part: str) -> int:
    if part.startswith("attachment:"):
        return settings_service.upload_max_mb(db) * attachments.MB + OVERHEAD
    return s.MAX_DOC + OVERHEAD


async def stage(account: Account, note_id: str, step: str, part: str, chunks: AsyncIterator[bytes]) -> int:
    """One part of a lock or unlock, as the device sends it (encrypted for a lock, plain for an unlock)."""
    if step not in STEPS:
        raise error("invalid_input", "The input is not valid.", 422, fields=["step"])
    with SessionLocal() as db:
        _own_note(db, account, note_id)
        found = _pending_for(db, account, note_id, step)
        if part not in (found.parts or []):
            raise error("invalid_input", "The input is not valid.", 422, fields=["part"])
        limit = _part_limit(db, part)
    root = attachments.root()
    root.mkdir(parents=True, exist_ok=True)
    work = root / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
    received = 0
    try:
        with open(work, "wb") as sink:  # noqa: ASYNC230 - written in a thread below, chunk by chunk
            async for chunk in chunks:
                received += len(chunk)
                if received > limit:
                    raise error("too_large", "The request is too large.", 413, max_mb=max(1, limit // attachments.MB))
                await asyncio.to_thread(sink.write, chunk)
        if received == 0:
            raise error("attachment_empty", "The file is empty.", 400)
        os.replace(work, stage_path(note_id, step, part))
    finally:
        work.unlink(missing_ok=True)
    return received


def _first_byte(path: Path) -> bytes:
    with open(path, "rb") as head:
        return head.read(1)


def _staged(note_id: str, step: str, parts: list[str]) -> dict[str, Path]:
    found = {part: stage_path(note_id, step, part) for part in parts}
    missing = [part for part, path in found.items() if not path.is_file()]
    if missing:
        raise error("lock_incomplete", "Parts of the note are missing.", 409, missing=missing)
    return found


async def lock_cancel(account: Account, note_id: str, step: str) -> None:
    """A lock or unlock broken off on the device: the note is as it was and takes changes again."""
    with SessionLocal() as db:
        _own_note(db, account, note_id)
        found = db.get(VaultPending, note_id)
        if found is None or found.account_id != account.id:
            return
        parts = list(found.parts or [])
        db.delete(found)
        db.commit()
    _remove_staged(note_id, step, parts)


async def lock_finish(account: Account, note_id: str) -> dict[str, Any]:
    """The second part of locking: every part is there, and in one transaction the note becomes its encrypted self.
    Afterwards the encrypted files take the place of the plain ones and every trace is overwritten."""
    with SessionLocal() as db:
        _own_note(db, account, note_id)
        parts = list(_pending_for(db, account, note_id, LOCK).parts or [])
    staged = _staged(note_id, LOCK, parts)
    sealed_content = check_format(staged["content"].read_bytes())
    version_parts = {int(part.split(":", 1)[1]): check_format(staged[part].read_bytes())
                     for part in parts if part.startswith("version:")}
    sealing = [part.split(":", 1)[1] for part in parts if part.startswith("attachment:")]
    for attachment_id in sealing:
        check_format(await asyncio.to_thread(_first_byte, staged[f"attachment:{attachment_id}"]))

    def run() -> list[str]:
        with SessionLocal() as db:
            history._write_lock(db)
            note = _own_note(db, account, note_id)
            pending = _pending_for(db, account, note_id, LOCK)
            if note.locked:
                raise error("note_locked", "The note is locked.", 409)
            now_versions = set(db.scalars(select(NoteVersion.id).where(NoteVersion.note_id == note_id)))
            if now_versions != set(version_parts):
                raise error("lock_incomplete", "Parts of the note are missing.", 409,
                            missing=[f"version:{each}" for each in sorted(now_versions - set(version_parts))])
            rows = {row.id: row for row in db.scalars(select(Attachment).where(Attachment.note_id == note_id))}
            unsealed = [row for key, row in rows.items() if key not in sealing]
            for row in unsealed:
                keeper = _keeper(db, row)
                if keeper is None:
                    raise error("lock_incomplete", "Parts of the note are missing.", 409,
                                missing=[f"attachment:{row.id}"])
                row.note_id = keeper
            # What was recognised in its pictures goes while they still have their kind (NOTES-11 EC-7).
            tags.lock_changed(db, note_id, True)
            note.locked = True
            note.ydoc = b""
            note.text = ""
            note.title_check = False
            db.execute(delete(NoteUpdate).where(NoteUpdate.note_id == note_id))
            db.merge(SealedNote(note_id=note_id, content=sealed_content, rev=FIRST_REV, saved_at=utcnow(),
                                saved_by_id=account.id))
            for version in db.scalars(select(NoteVersion).where(NoteVersion.note_id == note_id)):
                version.state = version_parts[version.id]
                version.size = len(version.state)
                version.sealed = True
                # Sealed by the device for its id; a version the server keeps later is bound to its revision.
                version.sealed_rev = None
                # The titles the note had before go with their text: a title made harmless before locking must not
                # stay readable in the history (AC-2, AC-6). Unlocking reads them back from the versions.
                version.title = note.title
            moved: list[str] = []
            for attachment_id in sealing:
                row = rows.get(attachment_id)
                if row is None:
                    continue
                size = staged[f"attachment:{attachment_id}"].stat().st_size
                row.kind, row.name, row.mime = SEALED_KIND, "", "application/octet-stream"
                row.width = row.height = row.pages = row.duration_ms = None
                row.has_view = row.has_thumb = row.inline = row.preview_failed = False
                row.size = row.stored = size
                moved.append(attachment_id)
            db.execute(delete(AttachmentRef).where(AttachmentRef.note_id == note_id))
            db.flush()
            # The search keeps the title, the tags and the count of the checklists go (the hooks on the text).
            notes._written(db, note)
            db.execute(update(Attachment).where(Attachment.id.in_(moved)).values(unref_at=None))
            db.delete(pending)
            db.commit()
            return moved

    moved = await asyncio.to_thread(run)
    for attachment_id in moved:
        _place_sealed(attachment_id, stage_path(note_id, LOCK, f"attachment:{attachment_id}"))
    _remove_staged(note_id, LOCK, parts)
    await asyncio.to_thread(_drop_exports, account.id)
    await asyncio.to_thread(wipe_traces)
    notes.nudge_all()
    logger.info("Note locked note=%s attachments=%s versions=%s", note_id, len(moved), len(version_parts))
    with SessionLocal() as db:
        return note_state(db, account, note_id)


def _place_sealed(attachment_id: str, staged: Path) -> None:
    """The encrypted file takes the place of the plain one; its pictures for the browser go."""
    if staged.is_file():
        os.replace(staged, attachments.path_of(attachment_id))
    for suffix in (attachments.VIEW, attachments.THUMB):
        attachments.path_of(attachment_id, suffix).unlink(missing_ok=True)


def _drop_exports(account_id: int) -> None:
    """ZIPs of the account made before the lock may hold the note in plain text: they go (NOTES-17, AC-2)."""
    from ..models_export import READY, ExportJob
    from . import export

    with SessionLocal() as db:
        for job in db.scalars(select(ExportJob).where(ExportJob.account_id == account_id, ExportJob.status == READY)):
            export._job_file(job.id).unlink(missing_ok=True)
            job.expires_at = utcnow()
        db.commit()


def wipe_traces() -> None:
    """What deleted rows left behind goes from the database file: the search index merged (which drops its deleted
    entries), the write-ahead log written back and emptied."""
    from . import search

    try:
        search.forget_deleted()
    except Exception:
        logger.exception("Merging the search index after a lock failed")
    try:
        with engine.connect() as connection:
            busy_pages = connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)").first()
            if busy_pages is not None and busy_pages[0]:
                logger.warning("The write-ahead log could not be emptied at once; it is at the next checkpoint")
    except Exception:
        logger.exception("Emptying the write-ahead log failed")


def note_state(db: Session, account: Account, note_id: str) -> dict[str, Any]:
    note = _own_note(db, account, note_id)
    sealed = db.get(SealedNote, note_id)
    return {"id": note.id, "locked": note.locked, "rev": sealed.rev if sealed is not None else 0}


async def unlock_start(account: Account, note_id: str) -> dict[str, Any]:
    """The first part of "Sperre aufheben" (AC-4): everything encrypted the device must open and send back plain."""
    with SessionLocal() as db:
        found = _vault(db, account)
        note = _own_note(db, account, note_id)
        if not note.locked:
            raise error("note_not_locked", "The note is not locked.", 409)
        sealed = db.get(SealedNote, note_id)
        versions = list(db.execute(select(NoteVersion.id, NoteVersion.state, NoteVersion.sealed_rev)
                                   .where(NoteVersion.note_id == note_id).order_by(NoteVersion.id)))
        sealing = list(db.scalars(select(Attachment.id).where(Attachment.note_id == note_id,
                                                              Attachment.kind == SEALED_KIND)
                                  .order_by(Attachment.created_at, Attachment.id)))
        parts = ["content", *(f"version:{row.id}" for row in versions), *(f"attachment:{each}" for each in sealing)]
        db.execute(delete(VaultPending).where(VaultPending.note_id == note_id))
        db.add(VaultPending(note_id=note_id, account_id=account.id, step=UNLOCK, parts=parts, started_at=utcnow()))
        db.commit()
        logger.info("Unlock started note=%s", note_id)
        return {
            "content": b64(sealed.content if sealed is not None else b""),
            "rev": sealed.rev if sealed is not None else 0,
            # ``rev``: the version was the note's content at that revision (sealed for it); ``None``: it was sealed
            # for its id when the note was locked.
            "versions": [{"id": row.id, "content": b64(row.state), "rev": row.sealed_rev} for row in versions],
            "attachments": sealing,
            "epoch": found.epoch,
        }


def _readable_state(data: bytes, field: str) -> Any:
    """A plain Yjs state in the format nexnotes-doc 1, or ``invalid_input``."""
    if len(data) > s.MAX_DOC:
        raise error("too_large", "The request is too large.", 413)
    try:
        return notedoc.load(data)
    except Exception:  # noqa: BLE001 - whatever pycrdt says, it is not a note
        raise error("invalid_input", "The input is not valid.", 422, fields=[field]) from None


async def unlock_finish(account: Account, note_id: str, names: dict[str, str]) -> dict[str, Any]:
    """The second part of "Sperre aufheben": the plain content, versions and attachments take the place of the
    encrypted ones; the attachments are checked and drawn anew like any upload, their text is read again."""
    with SessionLocal() as db:
        _own_note(db, account, note_id)
        parts = list(_pending_for(db, account, note_id, UNLOCK).parts or [])
    staged = _staged(note_id, UNLOCK, parts)
    state = staged["content"].read_bytes()
    document = await asyncio.to_thread(_readable_state, state, "content")
    plain_text = to_plain(document)
    version_states: dict[int, tuple[bytes, str]] = {}
    for part in parts:
        if part.startswith("version:"):
            data = staged[part].read_bytes()
            loaded = await asyncio.to_thread(_readable_state, data, part)
            version_states[int(part.split(":", 1)[1])] = (data, notedoc.title_of(loaded))
    opening = [part.split(":", 1)[1] for part in parts if part.startswith("attachment:")]

    def run() -> None:
        with SessionLocal() as db:
            history._write_lock(db)
            note = _own_note(db, account, note_id)
            pending = _pending_for(db, account, note_id, UNLOCK)
            if not note.locked:
                raise error("note_not_locked", "The note is not locked.", 409)
            now_versions = set(db.scalars(select(NoteVersion.id).where(NoteVersion.note_id == note_id)))
            if not now_versions <= set(version_states):
                raise error("lock_incomplete", "Parts of the note are missing.", 409,
                            missing=[f"version:{each}" for each in sorted(now_versions - set(version_states))])
            note.locked = False
            note.ydoc = state
            note.text = plain_text
            db.execute(delete(SealedNote).where(SealedNote.note_id == note_id))
            for version in db.scalars(select(NoteVersion).where(NoteVersion.note_id == note_id)):
                version.state, version.title = version_states[version.id]
                version.size = len(version.state)
                version.sealed = False
                version.sealed_rev = None
            for row in db.scalars(select(Attachment).where(Attachment.id.in_(opening))):
                # A file to download until it is checked and drawn anew right after this (``_place_plain``).
                row.kind, row.name = "file", attachments.clean_name(names.get(row.id) or "")
            db.flush()
            notes._written(db, note)
            db.delete(pending)
            db.commit()

    await asyncio.to_thread(run)
    for attachment_id in opening:
        await asyncio.to_thread(_place_plain, attachment_id, stage_path(note_id, UNLOCK, f"attachment:{attachment_id}"))

    def follow() -> None:
        with SessionLocal() as db:
            # Their text is read again, the search and the lists follow (NOTES-11, NOTES-9).
            tags.lock_changed(db, note_id, False)
            note = db.get(Note, note_id)
            if note is not None:
                notes._written(db, note)
            db.commit()

    await asyncio.to_thread(follow)
    _remove_staged(note_id, UNLOCK, parts)
    notes.nudge_all()
    logger.info("Note unlocked note=%s attachments=%s versions=%s", note_id, len(opening), len(version_states))
    with SessionLocal() as db:
        return note_state(db, account, note_id)


def _place_plain(attachment_id: str, staged: Path) -> None:
    """A plain file back from the device: checked by its content and drawn anew like any upload (NOTES-10), then in
    place of the encrypted one."""
    from ..models_attachments import Attachment as Row

    if not staged.is_file():
        return
    work = staged.with_name(f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}")
    os.replace(staged, work)
    try:
        prepared = attachments._prepare(work, None)
    except attachments.AttachmentError:
        prepared = None
    try:
        target = attachments.path_of(attachment_id)
        stored = 0
        if prepared is not None and prepared.redrawn is not None:
            attachments._write(target, prepared.redrawn)
        elif prepared is not None and prepared.redrawn_file                 and Path(prepared.redrawn_file).parent == attachments.root():
            os.replace(prepared.redrawn_file, target)
        else:
            os.replace(work, target)
        size = target.stat().st_size
        stored = size
        for suffix, data in ((attachments.VIEW, prepared.view if prepared else None),
                             (attachments.THUMB, prepared.thumb if prepared else None)):
            if data is not None:
                attachments._write(attachments.path_of(attachment_id, suffix), data)
                stored += len(data)
        with SessionLocal() as db:
            row = db.get(Row, attachment_id)
            if row is None:
                return
            if prepared is not None:
                row.kind, row.mime = prepared.kind, prepared.mime
                row.width, row.height = prepared.width, prepared.height
                row.pages, row.duration_ms = prepared.pages, prepared.duration_ms
                row.has_view, row.has_thumb = prepared.view is not None, prepared.thumb is not None
                row.inline, row.preview_failed = prepared.inline, prepared.preview_failed
                if prepared.suffix and not row.name.lower().endswith(prepared.suffix):
                    stem = row.name.rsplit(".", 1)[0] if "." in row.name else row.name
                    row.name = attachments.clean_name((stem or "file") + prepared.suffix)
            row.size, row.stored = size, stored
            db.commit()
    finally:
        work.unlink(missing_ok=True)
        work.with_name(work.name + ".m4a").unlink(missing_ok=True)


# --- A locked note open on a device -------------------------------------------------------------------------------


def sealed_of(db: Session, account: Account, note_id: str) -> dict[str, Any]:
    """The encrypted content with its revision and the vault's epoch (AC-3, AC-7)."""
    found = _vault(db, account)
    note = _own_note(db, account, note_id)
    if not note.locked:
        raise error("note_not_locked", "The note is not locked.", 409)
    sealed = db.get(SealedNote, note_id)
    if sealed is None:
        raise error("not_found", "Not found.", 404)
    return {"id": note.id, "content": b64(sealed.content), "rev": sealed.rev, "epoch": found.epoch,
            "title": note.title, "saved_at": sealed.saved_at.isoformat()}


def save(account: Account, note_id: str, content_b64: str, base_rev: int, epoch: int, title: str,
         restored_from: int | None = None, rev: int | None = None) -> dict[str, Any]:
    """The whole note encrypted, as a device saves it. The latest save is the current content; when it was written on
    an older revision, the content it replaces stays in the history (EC-5). ``restored_from``: the id of the version
    the device brought back (NOTES-15 AC-4 for a locked note).

    ``rev`` is the revision the device sealed the content for (format 2: it is in the AAD): the one after the
    current, nothing else. A device that wrote on an older revision hears ``vault_stale`` with the current one, seals
    again for the next and sends once more, still with its ``base_rev``: the save stays a conflict (EC-5)."""
    data = check_format(_bytes(content_b64, "content", 13, s.MAX_DOC + OVERHEAD))
    with SessionLocal() as db:
        history._write_lock(db)
        found = _vault(db, account)
        if epoch != found.epoch:
            raise error("vault_changed", "The vault password changed. Unlock again.", 409, epoch=found.epoch)
        note = _own_note(db, account, note_id)
        if not note.locked:
            raise error("note_not_locked", "The note is not locked.", 409)
        sealed = db.get(SealedNote, note_id)
        if sealed is None:
            raise error("not_found", "Not found.", 404)
        if rev != sealed.rev + 1:
            raise error("vault_stale", "The note has a newer revision. Seal it for the next one.", 409,
                        rev=sealed.rev)
        restoring: datetime | None = None
        if restored_from is not None:
            version = db.scalars(select(NoteVersion).where(NoteVersion.id == restored_from,
                                                           NoteVersion.note_id == note_id)).first()
            if version is None:
                raise error("not_found", "Not found.", 404)
            restoring = version.created_at
        conflict = base_rev != sealed.rev
        if conflict or restoring is not None:
            # The content as it is now stays in the history: written on another device (EC-5), or before a restore.
            history._take(db, note_id, state=sealed.content, force=True, skip_same=True)
        history.record_edit(db, note_id, account.id)
        sealed.content = data
        sealed.rev += 1
        sealed.saved_at = utcnow()
        sealed.saved_by_id = account.id
        clean = notedoc.clean_title(title)
        if clean != note.title:
            note.title = clean
        note.updated_at = utcnow()
        note.updated_by_id = account.id
        notes._written(db, note)
        if restoring is not None:
            db.flush()
            history._take(db, note_id, restored_from=restoring, force=True, author=account.id)
        db.commit()
        saved_rev = sealed.rev
    if conflict:
        logger.info("A locked note was saved on an older revision; the one before stays in the history note=%s",
                    note_id)
    return {"rev": saved_rev, "conflict": conflict}


async def store_attachment(account: Account, note_id: str, attachment_id: str, chunks: AsyncIterator[bytes],
                           declared: int | None) -> dict[str, Any]:
    """A new attachment in an open locked note, encrypted on the device: the server keeps it as it is, as the kind
    ``sealed`` without name, and counts its bytes (the limit per file, the account's storage)."""
    from ..models import Account as Row

    with SessionLocal() as db:
        note = _own_note(db, account, note_id)
        if not note.locked:
            raise error("note_not_locked", "The note is not locked.", 409)
        if not attachments._ID.match(attachment_id or ""):
            raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
        found = db.get(Attachment, attachment_id)
        if found is not None:
            if found.note_id != note_id:
                raise error("not_found", "Not found.", 404)
            return attachments.out(found)
        max_mb = settings_service.upload_max_mb(db)
        limit = max_mb * attachments.MB + OVERHEAD
        if declared is not None and declared > limit:
            raise error("attachment_too_large", "The file is larger than allowed.", 413, name="", size=declared,
                        max_mb=max_mb)
        owner = db.get(Row, note.owner_id)
        storage = owner.storage_limit if owner is not None else None
        taken = attachments.used(db, note.owner_id)
    root = attachments.root()
    root.mkdir(parents=True, exist_ok=True)
    work = root / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
    received = 0
    try:
        with open(work, "wb") as sink:  # noqa: ASYNC230 - written in a thread below, chunk by chunk
            async for chunk in chunks:
                if received == 0 and chunk:
                    check_format(chunk[:1])
                received += len(chunk)
                if received > limit:
                    raise error("attachment_too_large", "The file is larger than allowed.", 413, name="",
                                size=received, max_mb=max_mb)
                if storage is not None and taken + received > storage:
                    raise error("storage_limit_reached", "The storage of the account is full.", 507, used=taken,
                                limit=storage)
                await asyncio.to_thread(sink.write, chunk)
        if received == 0:
            raise error("attachment_empty", "The file is empty.", 400)
        with SessionLocal() as db:
            if db.get(Attachment, attachment_id) is not None:
                raise error("attachment_id_taken", "This attachment id is taken.", 409)
            os.replace(work, attachments.path_of(attachment_id))
            row = Attachment(id=attachment_id, note_id=note_id, owner_id=account.id, uploaded_by=account.id,
                             kind=SEALED_KIND, name="", mime="application/octet-stream", size=received,
                             stored=received, unref_at=None)
            db.add(row)
            db.commit()
            logger.info("Sealed attachment stored note=%s attachment=%s size=%s", note_id, attachment_id, received)
            return attachments.out(row)
    finally:
        work.unlink(missing_ok=True)


# --- Hooks into the frame -----------------------------------------------------------------------------------------


def _lock_check(db: Session, rows: list[Any]) -> list[str]:
    """``notes_list.LOCK_CHECKS``: which of the listed notes are locked."""
    ids = [row.id for row in rows]
    found: list[str] = []
    for start in range(0, len(ids), 500):
        found.extend(db.scalars(select(Note.id).where(Note.id.in_(ids[start:start + 500]), Note.locked.is_(True))))
    return found


def _count(db: Session, account_id: int) -> content.Counts:
    size = db.scalar(select(func.coalesce(func.sum(func.length(SealedNote.content)), 0))
                     .join(Note, Note.id == SealedNote.note_id).where(Note.owner_id == account_id))
    return content.Counts(bytes=int(size or 0))


def catch_up() -> int:
    """At the start: files of a lock or unlock that was through in the database when the server stopped take their
    place now (the encrypted ones of a locked note, the plain ones of an unlocked note); old pending steps go."""
    done = 0
    with SessionLocal() as db:
        db.execute(delete(VaultPending).where(VaultPending.started_at < utcnow() - PENDING_FOR))
        db.commit()
        waiting = set(db.scalars(select(VaultPending.note_id)))
        # Only what can be half-way: a sealed attachment, or one back from a lock not checked yet (a plain "file").
        rows = list(db.execute(select(Attachment.id, Attachment.note_id, Attachment.kind, Note.locked)
                               .join(Note, Note.id == Attachment.note_id)
                               .where((Attachment.kind == SEALED_KIND)
                                      | ((Attachment.kind == "file")
                                         & (Attachment.mime == "application/octet-stream")))))
    for attachment_id, note_id, kind, locked in rows:
        if note_id in waiting:
            continue
        sealing = stage_path(note_id, LOCK, f"attachment:{attachment_id}")
        opening = stage_path(note_id, UNLOCK, f"attachment:{attachment_id}")
        if locked and kind == SEALED_KIND and sealing.is_file():
            _place_sealed(attachment_id, sealing)
            done += 1
        elif not locked and opening.is_file():
            _place_plain(attachment_id, opening)
            done += 1
    if done:
        logger.info("Vault files put in place after a stop count=%s", done)
    return done


def register() -> None:
    """At every start, each hook once: locked notes are hidden from tags, search, export and recognition
    (``tags.HIDDEN_NOTES``), shown with the lock in lists (``notes_list.LOCK_CHECKS``), and their bytes count."""
    from . import notes_list

    if locked_condition not in tags.HIDDEN_NOTES:
        tags.HIDDEN_NOTES.append(locked_condition)
    if _lock_check not in notes_list.LOCK_CHECKS:
        notes_list.LOCK_CHECKS.append(_lock_check)
    if _count not in content._counters:
        content.register_counter(_count)
