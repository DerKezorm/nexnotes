"""Folders of an account (NOTES-4): a tree without a depth limit, the inbox at its side.

The rules live here, the router only translates. Every change that reads the tree before it writes takes the
database's write lock first (``_write_lock``): a folder moved on one device while it is deleted on another must never
end up alive under a parent in the trash, where nobody would find its notes again (EC-4). Whatever the two requests
do, one of them sees the other's result.

Deleting puts a folder, its subfolders and their notes in the trash under one mark (``deleted_batch``); bringing the
folder back brings back exactly what carries that mark, never a note that was in the trash before.

The order among siblings is alphabetical until the member drags one of them; from then on every sibling has a
``position`` and new or moved-in folders join at the end. Both live on the server, so they hold on every device;
which folders are open in the sidebar stays with each browser.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import sort_key
from ..errors import error
from ..models import FOLDER_INBOX, FOLDER_NORMAL, Folder, Note, new_uuid, utcnow
from . import settings_service
from .inbox import inbox_for

#: The longest name a folder may have, in characters (decided in the spec: 60, not 100).
NAME_MAX = 60

#: The twelve colours a folder can carry, by key; the page knows the same keys (``frontend/src/folders/palette.ts``).
#: An empty colour is no colour.
FOLDER_COLORS: dict[str, str] = {
    "honey": "#f2c14e",
    "orange": "#fb923c",
    "red": "#fb7185",
    "berry": "#e36fd8",
    "violet": "#a78bfa",
    "blue": "#60a5fa",
    "sky": "#38bdf8",
    "teal": "#2dd4bf",
    "green": "#4ade80",
    "lime": "#a3e635",
    "gray": "#9a9aa8",
    "silver": "#d4d4d8",
}

#: The fixed row of symbols, in the order the picker shows them. An empty symbol shows the colour as a small square.
FOLDER_ICONS: tuple[str, ...] = (
    "folder", "briefcase", "house", "heart", "star", "chef-hat",
    "book", "receipt", "plane", "car", "music", "camera",
    "gift", "graduation-cap", "leaf", "wrench", "baby", "dumbbell",
    "shopping-cart", "lightbulb", "code", "palette", "paw-print", "calendar",
)

#: Characters that never belong in a name: control characters, line and paragraph separators.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
#: How much of a note's text the inbox shows.
PREVIEW = 200


# --- Names ------------------------------------------------------------------------------------------------------------


def clean_name(raw: str) -> str:
    """The name as stored: one Unicode spelling (NFC), control characters as blanks, no blanks at the edges. Umlauts
    and emoji stay as they are (EC-7)."""
    return unicodedata.normalize("NFC", _CONTROL.sub(" ", raw)).strip()


def checked_name(raw: str) -> str:
    name = clean_name(raw)
    if not name:
        raise error("folder_name_missing", "Enter a name for the folder.")
    if len(name) > NAME_MAX:
        raise error("folder_name_too_long", f"A folder name has at most {NAME_MAX} characters.", maximum=NAME_MAX)
    return name


def same_name_key(name: str) -> str:
    """Two names the member would take for the same: case does not count (EC-2)."""
    return unicodedata.normalize("NFC", name).casefold()


def _check_style(icon: str | None, color: str | None) -> None:
    if icon is not None and icon not in ("", *FOLDER_ICONS):
        raise error("folder_style_unknown", "Choose a symbol from the list.")
    if color is not None and color not in ("", *FOLDER_COLORS):
        raise error("folder_style_unknown", "Choose a color from the list.")


# --- Locks and lookups ------------------------------------------------------------------------------------------------


def _write_lock(db: Session) -> None:
    """The write lock before the first read: another request that changes folders waits until this one is done, and
    this one reads a tree nobody changes under it. SQLite would otherwise start the transaction only at the first
    write, after the reads it depends on."""
    connection = db.connection()
    raw = connection.connection.driver_connection
    if raw is not None and not raw.in_transaction:
        connection.exec_driver_sql("BEGIN IMMEDIATE")


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


def _alive(db: Session, account_id: int, folder_id: str) -> Folder:
    found = db.scalars(
        select(Folder).where(Folder.id == folder_id, Folder.owner_id == account_id, Folder.deleted_at.is_(None))
    ).first()
    if found is None:
        raise _not_found()
    return found


def _alive_parents(db: Session, account_id: int) -> dict[str, str | None]:
    """Every living folder of the account with its parent, in one query."""
    rows = db.execute(
        select(Folder.id, Folder.parent_id).where(Folder.owner_id == account_id, Folder.deleted_at.is_(None))
    ).all()
    return {row.id: row.parent_id for row in rows}


def _ancestors(parents: dict[str, str | None], folder_id: str | None) -> list[str]:
    """The folder itself and everything above it, nearest first. Stops at a loop, should the data ever hold one."""
    chain: list[str] = []
    current = folder_id
    while current is not None and current not in chain:
        chain.append(current)
        current = parents.get(current)
    return chain


def _subtree(db: Session, account_id: int, root_id: str) -> list[str]:
    """The living folder and every living folder below it, at any depth."""
    children: dict[str | None, list[str]] = {}
    for folder_id, parent_id in _alive_parents(db, account_id).items():
        children.setdefault(parent_id, []).append(folder_id)
    found, queue = [], [root_id]
    while queue:
        current = queue.pop()
        if current in found:
            continue
        found.append(current)
        queue.extend(children.get(current, []))
    return found


def _siblings(db: Session, account_id: int, parent_id: str | None, leaving: Iterable[str] = ()) -> list[Folder]:
    """The living normal folders under a parent (``None``: the top), without those in ``leaving``."""
    query = select(Folder).where(
        Folder.owner_id == account_id, Folder.deleted_at.is_(None), Folder.kind == FOLDER_NORMAL,
        Folder.parent_id.is_(None) if parent_id is None else Folder.parent_id == parent_id,
    )
    skip = set(leaving)
    return [folder for folder in db.scalars(query) if folder.id not in skip]


def _name_taken(siblings: Iterable[Folder], name: str) -> bool:
    key = same_name_key(name)
    return any(same_name_key(sibling.name) == key for sibling in siblings)


def _refuse_taken(name: str) -> Exception:
    return error("folder_name_taken", "A folder with this name is already there.", 409, name=name)


def _position_at_end(siblings: list[Folder]) -> int | None:
    """Where a folder joins its new siblings: at the end once the member has ordered them, else alphabetically."""
    placed = [sibling.position for sibling in siblings if sibling.position is not None]
    return max(placed) + 1 if placed else None


def _ordered(folders: Iterable[Any]) -> list[Any]:
    """The order of the sidebar: positions first where the member dragged, otherwise alphabetical."""
    return sorted(folders, key=lambda f: (f.position is None, f.position or 0, sort_key(f.name), f.id))


# --- Reading ----------------------------------------------------------------------------------------------------------


def view(folder: Any, count: int = 0) -> dict[str, Any]:
    return {
        "id": folder.id,
        "parent_id": folder.parent_id,
        "name": folder.name,
        "icon": folder.icon or "",
        "color": folder.color or "",
        "position": folder.position,
        "count": count,
    }


def tree(db: Session, account_id: int) -> dict[str, Any]:
    """The inbox and every living folder, flat and in sidebar order, each with the number of its own notes (without
    those of its subfolders, AC-8). One query for all of them, however many there are (EC-8)."""
    inbox = inbox_for(db, account_id)
    db.commit()
    counts = (
        select(Note.folder_id.label("folder_id"), func.count().label("notes"))
        .where(Note.owner_id == account_id, Note.deleted_at.is_(None))
        .group_by(Note.folder_id)
        .subquery()
    )
    rows = db.execute(
        select(Folder.id, Folder.parent_id, Folder.kind, Folder.name, Folder.icon, Folder.color, Folder.position,
               func.coalesce(counts.c.notes, 0).label("count"))
        .outerjoin(counts, counts.c.folder_id == Folder.id)
        .where(Folder.owner_id == account_id, Folder.deleted_at.is_(None))
    ).all()
    alive = {row.id for row in rows}
    inbox_count = next((row.count for row in rows if row.id == inbox.id), 0)
    folders = []
    for row in _ordered(row for row in rows if row.kind != FOLDER_INBOX):
        entry = view(row, row.count)
        # Never happens while the lock holds; should a folder ever live under a parent in the trash, it shows at the
        # top instead of hiding its notes where nobody looks.
        if entry["parent_id"] is not None and entry["parent_id"] not in alive:
            entry["parent_id"] = None
        folders.append(entry)
    return {"inbox": {"id": inbox.id, "count": inbox_count}, "folders": folders}


def impact(db: Session, account_id: int, folder_id: str) -> dict[str, int]:
    """What goes with a folder (the question before deleting, the line of the move dialog): its notes and subfolders
    at every depth, and how many days the trash keeps them."""
    folder = _alive(db, account_id, folder_id)
    ids = _subtree(db, account_id, folder.id)
    notes = db.scalar(
        select(func.count()).select_from(Note).where(
            Note.owner_id == account_id, Note.deleted_at.is_(None), Note.folder_id.in_(ids)
        )
    )
    return {"notes": int(notes or 0), "folders": len(ids) - 1, "trash_days": settings_service.trash_days(db)}


def inbox_view(db: Session, account_id: int) -> dict[str, Any]:
    """The inbox with its notes, newest first, each with where it came from (AC-7)."""
    inbox = inbox_for(db, account_id)
    db.commit()
    notes = db.scalars(
        select(Note)
        .where(Note.owner_id == account_id, Note.folder_id == inbox.id, Note.deleted_at.is_(None))
        .order_by(Note.updated_at.desc())
    ).all()
    return {
        "id": inbox.id,
        "notes": [
            {
                "id": note.id,
                "title": note.title,
                "preview": " ".join(note.text.split())[:PREVIEW],
                "origin": note.origin,
                "title_check": note.title_check,
                "created_at": note.created_at.isoformat(),
                "updated_at": note.updated_at.isoformat(),
            }
            for note in notes
        ],
    }


# --- Changing ---------------------------------------------------------------------------------------------------------


def create(db: Session, account_id: int, *, name: str, parent_id: str | None = None, icon: str = "",
           color: str = "") -> dict[str, Any]:
    """A new folder at the top or in any other folder, at any depth (AC-1)."""
    clean = checked_name(name)
    _check_style(icon, color)
    _write_lock(db)
    if parent_id is not None:
        parent = _alive(db, account_id, parent_id)
        if parent.kind == FOLDER_INBOX:
            raise error("folder_target_not_allowed", "Folders cannot go into the inbox.")
    siblings = _siblings(db, account_id, parent_id)
    if _name_taken(siblings, clean):
        raise _refuse_taken(clean)
    folder = Folder(owner_id=account_id, parent_id=parent_id, kind=FOLDER_NORMAL, name=clean, icon=icon, color=color,
                    position=_position_at_end(siblings))
    db.add(folder)
    db.commit()
    return view(folder)


def change(db: Session, account_id: int, folder_id: str, *, name: str | None = None, icon: str | None = None,
           color: str | None = None) -> dict[str, Any]:
    """Rename (AC-4), symbol and colour (AC-10). The inbox keeps its name and look (AC-7)."""
    _check_style(icon, color)
    clean = checked_name(name) if name is not None else None
    _write_lock(db)
    folder = _alive(db, account_id, folder_id)
    if folder.kind == FOLDER_INBOX:
        raise error("inbox_fixed", "The inbox cannot be renamed, moved or deleted.")
    if clean is not None and clean != folder.name:
        if _name_taken(_siblings(db, account_id, folder.parent_id, leaving=[folder.id]), clean):
            raise _refuse_taken(clean)
        folder.name = clean
    if icon is not None:
        folder.icon = icon
    if color is not None:
        folder.color = color
    db.commit()
    return view(folder)


def move(db: Session, account_id: int, *, target_id: str | None, folder_ids: list[str],
         note_ids: list[str]) -> dict[str, int]:
    """Folders with everything inside them (AC-2) and notes (AC-3, AC-14) into a folder; folders also to the top
    (``target_id`` ``None``). Never a folder into itself or one of its subfolders (EC-1), never a folder into the
    inbox, never two folders of the same name side by side (EC-2). All or nothing."""
    folder_ids, note_ids = list(dict.fromkeys(folder_ids)), list(dict.fromkeys(note_ids))
    _write_lock(db)
    target = _alive(db, account_id, target_id) if target_id is not None else None
    moved_folders = 0
    if folder_ids:
        if target is not None and target.kind == FOLDER_INBOX:
            raise error("folder_target_not_allowed", "Folders cannot go into the inbox.")
        parents = _alive_parents(db, account_id)
        above_target = set(_ancestors(parents, target_id))
        folders = [_alive(db, account_id, folder_id) for folder_id in folder_ids]
        for folder in folders:
            if folder.kind == FOLDER_INBOX:
                raise error("inbox_fixed", "The inbox cannot be renamed, moved or deleted.")
            if folder.id in above_target:
                raise error("folder_into_itself", "A folder cannot go into itself or one of its subfolders.")
        arriving = [folder for folder in folders if folder.parent_id != target_id]
        staying = _siblings(db, account_id, target_id, leaving=folder_ids)
        seen: list[Folder] = list(staying)
        for folder in arriving:
            if _name_taken(seen, folder.name):
                raise _refuse_taken(folder.name)
            seen.append(folder)
        end = _position_at_end(staying)
        for folder in arriving:
            folder.parent_id = target_id
            folder.position = end
            if end is not None:
                end += 1
        moved_folders = len(arriving)
    moved_notes = 0
    if note_ids:
        if target is None:
            raise error("folder_target_not_allowed", "A note always lies in a folder or in the inbox.")
        notes = db.scalars(
            select(Note).where(Note.id.in_(note_ids), Note.owner_id == account_id, Note.deleted_at.is_(None))
        ).all()
        if len(notes) != len(note_ids):
            raise _not_found()
        for note in notes:
            if note.folder_id != target.id:
                note.folder_id = target.id
                moved_notes += 1
    db.commit()
    return {"folders": moved_folders, "notes": moved_notes}


def reorder(db: Session, account_id: int, *, parent_id: str | None, ids: list[str]) -> list[dict[str, Any]]:
    """The member's order among the folders of one parent (AC-11). Siblings the list leaves out (made on another
    device meanwhile) follow in their order; ids that are not siblings any more are passed over."""
    _write_lock(db)
    if parent_id is not None:
        _alive(db, account_id, parent_id)
    siblings = _ordered(_siblings(db, account_id, parent_id))
    by_id = {folder.id: folder for folder in siblings}
    chosen = [by_id[folder_id] for folder_id in dict.fromkeys(ids) if folder_id in by_id]
    rest = [folder for folder in siblings if folder not in chosen]
    for index, folder in enumerate(chosen + rest):
        folder.position = index
    db.commit()
    return [view(folder) for folder in chosen + rest]


def trash(db: Session, account_id: int, folder_id: str) -> dict[str, Any]:
    """The folder, its subfolders and their notes into the trash under one mark (AC-5)."""
    _write_lock(db)
    folder = _alive(db, account_id, folder_id)
    if folder.kind == FOLDER_INBOX:
        raise error("inbox_fixed", "The inbox cannot be renamed, moved or deleted.")
    ids = _subtree(db, account_id, folder.id)
    batch, now = new_uuid(), utcnow()
    db.execute(
        update(Folder).where(Folder.id.in_(ids), Folder.owner_id == account_id)
        .values(deleted_at=now, deleted_batch=batch)
    )
    notes = db.execute(
        update(Note).where(Note.folder_id.in_(ids), Note.owner_id == account_id, Note.deleted_at.is_(None))
        .values(deleted_at=now, deleted_batch=batch)
    ).rowcount
    db.commit()
    return {"id": folder.id, "batch": batch, "folders": len(ids) - 1, "notes": int(notes or 0)}


def _free_name(siblings: list[Folder], name: str) -> str:
    """The name itself if nobody beside it carries it, else the first free one of "Name (2)", "Name (3)" ..."""
    if not _name_taken(siblings, name):
        return name
    number = 2
    while True:
        suffix = f" ({number})"
        candidate = name[: NAME_MAX - len(suffix)].rstrip() + suffix
        if not _name_taken(siblings, candidate):
            return candidate
        number += 1


def restore(db: Session, account_id: int, folder_id: str) -> dict[str, Any]:
    """Brings a deleted folder back with exactly what went with it: by "Undo" right after, or later from the trash
    (EC-10). A folder whose parent is not there any more comes back at the top; a name taken meanwhile gets a
    number."""
    _write_lock(db)
    root = db.scalars(select(Folder).where(Folder.id == folder_id, Folder.owner_id == account_id)).first()
    if root is None:
        raise _not_found()
    if root.deleted_at is None:
        return {"id": root.id, "folders": 0, "notes": 0}
    batch = root.deleted_batch
    if batch is None:
        raise _not_found()
    returning = db.scalars(select(Folder).where(Folder.owner_id == account_id, Folder.deleted_batch == batch)).all()
    in_batch = {folder.id for folder in returning}
    parents = _alive_parents(db, account_id)
    for folder in returning:
        if folder.parent_id in in_batch:
            continue
        if folder.parent_id is not None and folder.parent_id not in parents:
            folder.parent_id = None
            folder.position = None
        siblings = _siblings(db, account_id, folder.parent_id)
        folder.name = _free_name(siblings, folder.name)
        if folder.position is None:
            folder.position = _position_at_end(siblings)
    for folder in returning:
        folder.deleted_at = None
        folder.deleted_batch = None
    notes = db.execute(
        update(Note).where(Note.owner_id == account_id, Note.deleted_batch == batch)
        .values(deleted_at=None, deleted_batch=None)
    ).rowcount
    db.commit()
    return {"id": root.id, "folders": len(returning) - 1, "notes": int(notes or 0)}

