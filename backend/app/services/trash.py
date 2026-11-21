"""The trash (NOTES-15): what was deleted, how long it stays, back or gone for good.

Deleting lives with notes and folders (``deleted_at`` and the mark ``deleted_batch``, NOTES-3 and NOTES-4). The trash
shows the **roots** of each deletion: per mark the top folder (with how many notes and subfolders went with it), and
notes deleted on their own. What went with a folder is not listed by itself; it comes back with its folder only (EC-4).

Back: ``notes.restore`` (its folder gone or in the trash: the inbox, EC-1) and ``folders.restore`` (its parent gone:
the top; a name taken meanwhile: "(2)", EC-7). Both are safe to run twice at once (EC-8): a note is one row, and
bringing a folder back takes the write lock and does nothing for one that is back already.

Gone for good: the open rooms of the notes are closed first (``close_note``), then the rows go; their updates and
versions follow through ``ON DELETE CASCADE``. A folder's cascade would also take notes and folders deleted alone
before that still point into it; those are moved out first (notes to the inbox, folders to the top), so they stay in
the trash on their own. ``PURGE_HOOKS`` hear of every note about to go (attachments, NOTES-10).

After ``trash_days`` (90 from the start, the operator's setting) the cleanup round removes what ran past it, by the
server's clock (AC-7). A shorter deadline counts from the next round, and the log says how much went (EC-6).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note
from . import folders, notes, settings_service
from .history import clock
from .inbox import inbox_for

logger = logging.getLogger("nexnotes.trash")

#: The last days of the deadline, shown in orange (AC-7).
WARN_DAYS = 7
#: Called with the session and the ids of notes about to go for good (attachments, NOTES-10).
PURGE_HOOKS: list[Callable[[Session, list[str]], None]] = []


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


def days_left(deleted_at: datetime, days: int, now: datetime) -> int:
    """Whole days until the deadline, rounded up: "noch 1 Tag" until the very end, 0 once it passed."""
    left = (deleted_at + timedelta(days=days) - now).total_seconds() / 86400
    return max(0, math.ceil(left))


# --- Listing ------------------------------------------------------------------------------------------------------


def _origin(folder: Folder | None) -> dict[str, Any] | None:
    if folder is None:
        return None
    return {"id": folder.id, "name": folder.name, "inbox": folder.kind == FOLDER_INBOX,
            "gone": folder.deleted_at is not None}


def listing(db: Session, account: Account) -> dict[str, Any]:
    """Every root in the account's trash, newest first, with where it came from, where it lands and how long it
    stays (AC-6, AC-7, EC-1)."""
    now = clock.now()
    days = settings_service.trash_days(db)
    trashed_folders = list(db.scalars(select(Folder).where(Folder.owner_id == account.id,
                                                           Folder.deleted_at.is_not(None))))
    trashed_notes = list(db.scalars(select(Note).where(Note.owner_id == account.id, Note.deleted_at.is_not(None))))
    by_batch: dict[str | None, list[Folder]] = {}
    for folder in trashed_folders:
        by_batch.setdefault(folder.deleted_batch, []).append(folder)
    notes_in: dict[str | None, int] = {}
    for note in trashed_notes:
        notes_in[note.deleted_batch] = notes_in.get(note.deleted_batch, 0) + 1
    known: dict[str, Folder] = {folder.id: folder for folder in trashed_folders}
    parent_ids = {folder.parent_id for folder in trashed_folders if folder.parent_id} | {
        note.folder_id for note in trashed_notes}
    missing = parent_ids - set(known)
    if missing:
        known.update({folder.id: folder for folder in db.scalars(select(Folder).where(Folder.id.in_(missing)))})

    def timing(deleted_at: datetime) -> dict[str, Any]:
        left = days_left(deleted_at, days, now)
        return {"deleted_at": deleted_at.isoformat(), "expires_at": (deleted_at + timedelta(days=days)).isoformat(),
                "days_left": left, "warn": left <= WARN_DAYS}

    items: list[dict[str, Any]] = []
    for batch, group in by_batch.items():
        ids = {folder.id for folder in group}
        for root in (folder for folder in group if folder.parent_id not in ids or batch is None):
            parent = known.get(root.parent_id) if root.parent_id else None
            gone = root.parent_id is not None and (parent is None or parent.deleted_at is not None)
            items.append({
                "kind": "folder", "id": root.id, "title": root.name, **timing(root.deleted_at),
                "origin": _origin(parent), "origin_gone": gone, "lands": "top" if gone or parent is None else "origin",
                "notes": notes_in.get(batch, 0) if batch is not None else 0,
                "folders": len(group) - 1 if batch is not None else 0,
                "deleted_by": None,
            })
    for note in trashed_notes:
        if note.deleted_batch is not None and note.deleted_batch in by_batch:
            continue  # went with its folder and comes back with it
        folder = known.get(note.folder_id)
        gone = folder is None or folder.deleted_at is not None
        items.append({
            "kind": "note", "id": note.id, "title": note.title, **timing(note.deleted_at),
            "origin": _origin(folder), "origin_gone": gone,
            "lands": "inbox" if gone or folder is None or folder.kind == FOLDER_INBOX else "origin",
            "notes": 1, "folders": 0, "deleted_by": None,
        })
    items.sort(key=lambda item: (item["deleted_at"], item["id"]), reverse=True)
    return {
        "now": now.isoformat(),
        "trash_days": days,
        "warn_days": WARN_DAYS,
        "items": items,
        "totals": {"notes": len(trashed_notes), "folders": len(trashed_folders)},
    }


# --- Back -----------------------------------------------------------------------------------------------------------


def restore_note(db: Session, account: Account, note_id: str) -> dict[str, Any]:
    note = notes.restore(db, account, note_id)
    return {"kind": "note", "id": note.id, "folder_id": note.folder_id}


def restore_folder(db: Session, account: Account, folder_id: str) -> dict[str, Any]:
    result = folders.restore(db, account.id, folder_id)
    folder = db.get(Folder, folder_id)
    return {"kind": "folder", **result, "parent_id": folder.parent_id if folder else None,
            "name": folder.name if folder else ""}


# --- Gone for good --------------------------------------------------------------------------------------------------


def _purge(db: Session, note_ids: set[str], folder_ids: set[str]) -> tuple[int, int]:
    """Removes the notes and folders, only those still in the trash. Call with the write lock held; commits.

    What lies in one of the folders without going with it (a note or folder deleted alone before) is moved out first,
    so that the cascade does not take it."""
    if folder_ids:
        folder_ids = set(db.scalars(select(Folder.id).where(Folder.id.in_(folder_ids),
                                                            Folder.deleted_at.is_not(None))))
    if note_ids:
        note_ids = set(db.scalars(select(Note.id).where(Note.id.in_(note_ids), Note.deleted_at.is_not(None))))
    if folder_ids:
        staying = select(Note.owner_id).where(Note.folder_id.in_(folder_ids), Note.id.not_in(note_ids)).distinct()
        for owner_id in list(db.scalars(staying)):
            inbox = inbox_for(db, owner_id).id
            db.execute(update(Note).where(Note.owner_id == owner_id, Note.folder_id.in_(folder_ids),
                                          Note.id.not_in(note_ids)).values(folder_id=inbox))
        db.execute(update(Folder).where(Folder.parent_id.in_(folder_ids), Folder.id.not_in(folder_ids))
                   .values(parent_id=None, position=None))
    ordered = sorted(note_ids)
    for start in range(0, len(ordered), 500):
        chunk = ordered[start: start + 500]
        for hook in PURGE_HOOKS:
            hook(db, chunk)
        db.execute(delete(Note).where(Note.id.in_(chunk)))
    if folder_ids:
        db.execute(delete(Folder).where(Folder.id.in_(folder_ids)))
    db.commit()
    return len(note_ids), len(folder_ids)


def _note_ids_of(db: Session, account: Account, note_id: str) -> set[str]:
    found = db.scalar(select(Note.id).where(Note.id == note_id, Note.owner_id == account.id,
                                            Note.deleted_at.is_not(None)))
    if found is None:
        raise _not_found()
    return {found}


def _batch_of(db: Session, account: Account, folder_id: str) -> tuple[set[str], set[str]]:
    root = db.scalars(select(Folder).where(Folder.id == folder_id, Folder.owner_id == account.id,
                                           Folder.deleted_at.is_not(None))).first()
    if root is None:
        raise _not_found()
    if root.deleted_batch is None:
        return set(), {root.id}
    folder_ids = set(db.scalars(select(Folder.id).where(Folder.owner_id == account.id,
                                                        Folder.deleted_batch == root.deleted_batch)))
    note_ids = set(db.scalars(select(Note.id).where(Note.owner_id == account.id,
                                                    Note.deleted_batch == root.deleted_batch)))
    return note_ids, folder_ids


def _until_ids(db: Session, account: Account, until: datetime) -> tuple[set[str], set[str]]:
    note_ids = set(db.scalars(select(Note.id).where(Note.owner_id == account.id, Note.deleted_at.is_not(None),
                                                    Note.deleted_at <= until)))
    folder_ids = set(db.scalars(select(Folder.id).where(Folder.owner_id == account.id,
                                                        Folder.deleted_at.is_not(None), Folder.deleted_at <= until)))
    return note_ids, folder_ids


async def _remove(account: Account, find: Callable[[Session], tuple[set[str], set[str]]]) -> dict[str, int]:
    """Finds what goes, closes the open rooms of its notes, then removes it under the write lock."""
    import asyncio

    with SessionLocal() as db:
        note_ids, folder_ids = find(db)
    rooms = notes.rooms()
    for note_id in sorted(note_ids):
        await rooms.close_note(note_id)

    def run() -> tuple[int, int]:
        with SessionLocal() as db:
            folders._write_lock(db)
            # Found again inside the lock: what was brought back meanwhile stays.
            again_notes, again_folders = find(db)
            return _purge(db, note_ids & again_notes, folder_ids & again_folders)

    removed_notes, removed_folders = await asyncio.to_thread(run)
    notes.nudge_all()
    return {"notes": removed_notes, "folders": removed_folders}


async def purge_note(account: Account, note_id: str) -> dict[str, int]:
    result = await _remove(account, lambda db: (_note_ids_of(db, account, note_id), set()))
    logger.info("Note removed for good note=%s", note_id)
    return result


async def purge_folder(account: Account, folder_id: str) -> dict[str, int]:
    result = await _remove(account, lambda db: _batch_of(db, account, folder_id))
    logger.info("Folder removed for good folder=%s notes=%s", folder_id, result["notes"])
    return result


async def empty(account: Account, until: datetime) -> dict[str, int]:
    """Everything in the trash that was deleted by ``until`` (the moment the page listed it): what was deleted after
    the question was asked stays (EC-3)."""
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    result = await _remove(account, lambda db: _until_ids(db, account, until))
    logger.info("Trash emptied notes=%s folders=%s", result["notes"], result["folders"])
    return result


# --- After the deadline ---------------------------------------------------------------------------------------------


def purge_expired() -> tuple[int, int]:
    """Everything deleted longer ago than ``trash_days`` goes (AC-7, EC-6). The cleanup round calls it."""
    now = clock.now()
    with SessionLocal() as db:
        folders._write_lock(db)
        days = settings_service.trash_days(db)
        cutoff = now - timedelta(days=days)
        note_ids = set(db.scalars(select(Note.id).where(Note.deleted_at.is_not(None), Note.deleted_at < cutoff)))
        folder_ids = set(db.scalars(select(Folder.id).where(Folder.deleted_at.is_not(None),
                                                            Folder.deleted_at < cutoff)))
        removed = _purge(db, note_ids, folder_ids)
    if any(removed):
        # Rooms of these notes closed when they were deleted; any left behind see the note gone at their next check.
        notes.nudge_all()
        logger.info("Trash emptied after its deadline notes=%s folders=%s days=%s", removed[0], removed[1], days)
    return removed


def register() -> None:
    from . import cleanup

    if all(job is not purge_expired for _, job in cleanup._jobs):
        cleanup.register("trash", purge_expired)
