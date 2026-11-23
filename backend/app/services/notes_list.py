"""Lists of notes (NOTES-6): the notes of a folder or all of them at once, the way each account looks at them, pinning
and colors.

The server hands a list over whole, in one query without the documents; sorting and grouping by date happen in the
browser, which alone knows the device's time zone (EC-7). How a folder is sorted and grouped is kept per account and
folder, so that every device shows it the same way (AC-4, AC-5). How the notes look (rows, cards, compact rows, tiles)
and whether rows carry their hints is the account's, the same for every list (``list_look``).

A list that is open asks for ``stamp`` every few seconds and loads again only when it changed (EC-6). ``listed_at`` is
set by an ORM event whenever something a list shows changes, whichever way the change comes (the editor, a move, the
trash).

What other features bring dock on here, so that lists show it as soon as they exist:

- ``SHARED_NOTES``: the ids of notes shared with an account (sharing), for "All notes" and its count (AC-7).
- ``ITEM_EXTRAS``: more fields per item, for many notes at once, e.g. ``tags``, ``shared`` (who a note is shared with)
  or ``media`` (the first picture, scan or sketch and how many) and ``attachments`` (how many of every kind).
- ``LOCK_CHECKS``: the ids of locked notes; of those a list gets the title and the lock, nothing else (EC-3).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import String, cast, event, func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import error
from ..models import LIST_STYLES, Account, Folder, Note, NoteListView, NoteUpdate, utcnow
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from ..notedoc.room import Access
from . import notes
from .folders import FOLDER_COLORS

logger = logging.getLogger("nexnotes.lists")

#: The key of "All notes" among the views; a folder's view is keyed by its id.
ALL = "all"
#: How a list looks until the account chose otherwise (AC-5: grouped by date from the start).
DEFAULT_VIEW: dict[str, Any] = {"mode": "list", "sort": "updated", "direction": "desc", "grouped": True}

SharedSource = Callable[[Session, Account], Iterable[str]]
#: Hooks get the notes as rows with the columns a list reads (``_COLUMNS``: ``id``, ``owner_id``, ``folder_id``, ...).
Extras = Callable[[Session, Account, list[Any]], dict[str, dict[str, Any]]]
LockCheck = Callable[[Session, list[Any]], Iterable[str]]

#: Ways a note shared with an account reaches its "All notes": each gives the ids of such notes.
SHARED_NOTES: list[SharedSource] = []
#: Further fields of the items, asked once per list with all of its notes: ``{note_id: {field: value}}``.
ITEM_EXTRAS: list[Extras] = []
#: Which of the notes are locked: a list shows their title and the lock only.
LOCK_CHECKS: list[LockCheck] = []

#: What a locked note's item never carries.
_HIDDEN_WHEN_LOCKED = ("preview", "tasks", "media", "attachments", "tags")


# --- Checklists ---------------------------------------------------------------------------------------------------


def count_tasks(document: dict[str, Any]) -> tuple[int, int]:
    """Checked and all items of every checklist in a document (ProseMirror JSON), nested ones included."""
    done = total = 0
    stack = list(document.get("content") or [])
    while stack:
        node = stack.pop()
        if node.get("type") == s.TASK_ITEM:
            total += 1
            if (node.get("attrs") or {}).get("checked"):
                done += 1
        stack.extend(node.get("content") or [])
    return done, total


def _tasks_of(state: bytes | None, updates: Iterable[bytes] = ()) -> tuple[int, int] | None:
    try:
        return count_tasks(notedoc.to_json(notedoc.load(state, updates)))
    except Exception:  # noqa: BLE001 - a document that cannot be read keeps what was counted before
        logger.warning("Counting the checklists of a note failed")
        return None


def recount(db: Session, note: Note) -> None:
    """The checklists counted anew from what is stored: the folded state and the updates after it. Never raises (a
    hook on the text, ``notes.TEXT_WRITTEN``)."""
    try:
        updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note.id)
                                  .order_by(NoteUpdate.id))) if note.id else []
    except Exception:  # the count waits for the next change rather than failing the write
        logger.exception("Reading the updates of a note failed note=%s", note.id)
        return
    found = _tasks_of(note.ydoc, updates)
    if found is not None:
        note.tasks_done, note.tasks_total = found


def count_missing(db: Session, batch: int = 200) -> int:
    """Notes from before the lists counted (``tasks_total`` empty) are counted once, at the start."""
    counted = 0
    while True:
        ids = list(db.scalars(select(Note.id).where(Note.tasks_total.is_(None)).limit(batch)))
        if not ids:
            return counted
        for note in db.scalars(select(Note).where(Note.id.in_(ids))):
            recount(db, note)
            if note.tasks_total is None:
                note.tasks_done, note.tasks_total = 0, 0
            counted += 1
        db.commit()


# --- What a list shows changed ------------------------------------------------------------------------------------

#: The columns a list shows: a change to any of them sets ``listed_at``.
_LISTED = ("title", "title_check", "text", "folder_id", "owner_id", "deleted_at", "pinned_at", "color", "icon",
           "tasks_done", "tasks_total", "locked")


def _changed(target: Note) -> bool:
    state = inspect(target)
    for name in _LISTED:
        history = state.attrs[name].history
        if history.added and list(history.added) != list(history.deleted):
            return True
    return False


@event.listens_for(Note, "before_insert")
def _note_made(_mapper: Any, _connection: Any, target: Note) -> None:
    if target.tasks_total is None:
        found = _tasks_of(target.ydoc) if target.ydoc else (0, 0)
        if found is not None:
            target.tasks_done, target.tasks_total = found
    target.listed_at = utcnow()


@event.listens_for(Note, "before_update")
def _note_changed(_mapper: Any, _connection: Any, target: Note) -> None:
    if _changed(target):
        target.listed_at = utcnow()


# --- Reading a list -----------------------------------------------------------------------------------------------


def folder_key(db: Session, account: Account, folder_id: str | None) -> str:
    """The key of a list: ``all``, or the id of one of the account's own folders or of a folder shared with it
    (NOTES-13; else ``folder_not_found``)."""
    if not folder_id or folder_id == ALL:
        return ALL
    folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
    if notes.folder_right(db, account, folder) not in (Access.WRITE, Access.READ):
        raise error("folder_not_found", "The folder does not exist.", 404)
    assert folder is not None
    return folder.id


def _own_folder(db: Session, account: Account, key: str) -> bool:
    if key == ALL:
        return True
    folder = db.get(Folder, key)
    return folder is not None and folder.owner_id == account.id


def shared_ids(db: Session, account: Account) -> set[str]:
    """The notes shared with the account, as the sharing feature says; never its own."""
    found: set[str] = set()
    for source in SHARED_NOTES:
        found.update(source(db, account))
    if not found:
        return found
    own = set(db.scalars(select(Note.id).where(Note.id.in_(found), Note.owner_id == account.id)))
    return found - own


def places(db: Session, account: Account, inbox_id: str) -> dict[str, int]:
    """The numbers of the tiles at the top of the sidebar (NOTES-4 AC-16), counted as the iOS app counts them: the
    notes of "Alle Notizen" (own and shared, alive), those shared with the account ("Mit mir geteilt"), and those in the
    inbox marked "Titel prüfen" (a locked note shows no mark, so it is not counted)."""
    alive = Note.deleted_at.is_(None)
    own = db.scalar(select(func.count()).select_from(Note).where(Note.owner_id == account.id, alive)) or 0
    others = shared_ids(db, account)
    shared = (db.scalar(select(func.count()).select_from(Note).where(Note.id.in_(others), alive)) or 0) if others else 0
    check = db.scalar(select(func.count()).select_from(Note).where(
        Note.owner_id == account.id, Note.folder_id == inbox_id, alive, Note.title_check.is_(True),
        Note.locked.is_not(True))) or 0
    return {"all": int(own) + int(shared), "shared": int(shared), "inbox_title_check": int(check)}


#: The columns a list needs, read without the ORM (EC-2: 10,000 notes in well under a second). The text only as far as
#: a preview reaches.
_PREVIEW_SOURCE = 2 * notes.PREVIEW_CHARS
#: Times as SQLite keeps them (UTC, ``YYYY-MM-DD HH:MM:SS.ffffff``): turned into ISO text without making datetimes.
_CREATED = cast(Note.created_at, String).label("created_at")
_UPDATED = cast(Note.updated_at, String).label("updated_at")
_COLUMNS = (Note.id, Note.owner_id, Note.folder_id, Note.title, Note.title_check, Note.origin,
            func.substr(Note.text, 1, _PREVIEW_SOURCE).label("text"), _CREATED, _UPDATED,
            Note.pinned_at.is_not(None).label("pinned"), Note.color, Note.tasks_done, Note.tasks_total,
            Note.icon)
_NEWEST_FIRST = (Note.updated_at.desc(), Note.id.desc())
#: For other lists of notes built the same way (a smart folder, NOTES-7).
LIST_COLUMNS = _COLUMNS
NEWEST_FIRST = _NEWEST_FIRST


def _notes(db: Session, account: Account, key: str) -> tuple[list[Any], list[Any]]:
    """Own and shared notes of a list, alive, as rows of ``_COLUMNS``."""
    own_query = (select(*_COLUMNS).where(Note.owner_id == account.id, Note.deleted_at.is_(None))
                 .order_by(*_NEWEST_FIRST))
    if key != ALL and not _own_folder(db, account, key):
        # A folder somebody shared (NOTES-13 AC-2): its notes the sharing feature lets the account read.
        others = shared_ids(db, account)
        return [], list(db.execute(select(*_COLUMNS).where(Note.folder_id == key, Note.id.in_(others),
                                                           Note.deleted_at.is_(None)).order_by(*_NEWEST_FIRST)))
    if key != ALL:
        return list(db.execute(own_query.where(Note.folder_id == key))), []
    own = list(db.execute(own_query))
    others = shared_ids(db, account)
    shared: list[Any] = []
    if others:
        shared = list(db.execute(select(*_COLUMNS).where(Note.id.in_(others), Note.deleted_at.is_(None))
                                 .order_by(*_NEWEST_FIRST)))
    return own, shared


def tasks_out(note: Any) -> dict[str, int] | None:
    if not note.tasks_total:
        return None
    return {"done": int(note.tasks_done or 0), "total": int(note.tasks_total)}


def item_of(note: Any) -> dict[str, Any]:
    """A note in a list: the same fields as ``GET /api/notes`` gives (``routers/notes.item_out``; a test holds both
    the same)."""
    return {
        "id": note.id,
        "folder_id": note.folder_id,
        "title": note.title,
        "title_check": bool(note.title_check),
        "origin": note.origin,
        "preview": notes.preview(note.text),
        "created_at": _stored_iso(note.created_at),
        "updated_at": _stored_iso(note.updated_at),
        "pinned": bool(note.pinned),
        "color": note.color or "",
        "icon": note.icon or "",
        "tasks": tasks_out(note),
    }


def items(db: Session, account: Account, rows: list[Any]) -> list[dict[str, Any]]:
    """The items of a list with the owner of notes of others, the lock and the extras of the other features. The
    hooks get the rows (``id``, ``owner_id``, ``folder_id``, ``title`` ... as in ``_COLUMNS``)."""
    owners: dict[int, str] = {}
    strangers = {note.owner_id for note in rows if note.owner_id != account.id}
    if strangers:
        for row in db.execute(select(Account.id, Account.display_name, Account.name).where(Account.id.in_(strangers))):
            owners[row.id] = row.display_name or row.name
    locked: set[str] = set()
    for check in LOCK_CHECKS:
        locked.update(check(db, rows))
    extras: dict[str, dict[str, Any]] = {}
    for extra in ITEM_EXTRAS:
        for note_id, fields in extra(db, account, rows).items():
            extras.setdefault(note_id, {}).update(fields)
    out: list[dict[str, Any]] = []
    for note in rows:
        item = item_of(note)
        if extras:
            item.update(extras.get(note.id, {}))
        if note.owner_id != account.id:
            item["owner"] = {"id": note.owner_id, "name": owners.get(note.owner_id, "")}
        if note.id in locked:
            item["locked"] = True
            for field in _HIDDEN_WHEN_LOCKED:
                item.pop(field, None)
            item["preview"] = ""
            item["tasks"] = None
        out.append(item)
    return out


def read(db: Session, account: Account, folder_id: str | None) -> dict[str, Any]:
    """A list: its key, the account's view of it, how many own and shared notes it holds, and the items (newest
    change first; the browser orders them as the view says)."""
    key = folder_key(db, account, folder_id)
    own, shared = _notes(db, account, key)
    rows = own if not shared else sorted(own + shared, key=lambda note: (note.updated_at, note.id), reverse=True)
    return {
        "key": key,
        "view": view_of(db, account, key),
        "counts": {"own": len(own), "shared": len(shared)},
        "items": items(db, account, rows),
    }


def _stored_iso(value: str | None) -> str | None:
    """``2026-11-21 08:05:00.000000`` as SQLite keeps a UTC time, in ISO form with its zone."""
    return value.replace(" ", "T", 1) + "+00:00" if value else None


def _iso(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def stamp(db: Session, account: Account, folder_id: str | None) -> str:
    """Changes whenever the list would show something else: how many, the newest change, the newest listed change."""
    key = folder_key(db, account, folder_id)
    query = select(func.count(), func.max(Note.updated_at), func.max(Note.listed_at)).where(Note.deleted_at.is_(None))
    if not _own_folder(db, account, key):
        theirs = db.execute(query.where(Note.folder_id == key, Note.id.in_(shared_ids(db, account)))).one()
        return "|".join([str(theirs[0]), _iso(theirs[1]), _iso(theirs[2])])
    own = db.execute(query.where(Note.owner_id == account.id,
                                 *(() if key == ALL else (Note.folder_id == key,)))).one()
    parts = [str(own[0]), _iso(own[1]), _iso(own[2])]
    if key == ALL:
        others = shared_ids(db, account)
        if others:
            theirs = db.execute(query.where(Note.id.in_(others))).one()
            parts += [str(theirs[0]), _iso(theirs[1]), _iso(theirs[2])]
    return "|".join(parts)


# --- Views --------------------------------------------------------------------------------------------------------


def view_of(db: Session, account: Account, key: str) -> dict[str, Any]:
    """The sort and grouping of a list; ``mode`` is ``gallery`` for a smart folder showing its attachments, else
    ``list`` (tiles from before count as the list: how notes look is the account's, ``list_look``)."""
    row = db.scalar(select(NoteListView).where(NoteListView.account_id == account.id, NoteListView.key == key))
    if row is None:
        return dict(DEFAULT_VIEW)
    mode = "gallery" if row.mode == "gallery" else "list"
    return {"mode": mode, "sort": row.sort, "direction": row.direction, "grouped": row.grouped}


def save_view(db: Session, account: Account, folder_id: str | None, wanted: dict[str, Any]) -> dict[str, Any]:
    """Keeps how the account looks at a folder (or "All notes"); only what is given changes."""
    return save_view_of(db, account, folder_key(db, account, folder_id), wanted)


def save_view_of(db: Session, account: Account, key: str, wanted: dict[str, Any]) -> dict[str, Any]:
    """Keeps how the account looks at the list ``key`` (a folder, "All notes", a smart folder); only what is given
    changes."""
    for attempt in range(2):
        row = db.scalar(select(NoteListView).where(NoteListView.account_id == account.id, NoteListView.key == key))
        if row is None:
            row = NoteListView(account_id=account.id, key=key, **DEFAULT_VIEW)
            db.add(row)
        for field in ("mode", "sort", "direction", "grouped"):
            if wanted.get(field) is not None:
                setattr(row, field, wanted[field])
        try:
            db.commit()
            break
        except IntegrityError:
            # The same folder's first view saved from a second device at the same moment: take that row.
            db.rollback()
            if attempt:
                raise
    return view_of(db, account, key)


def forget_tile_modes(db: Session) -> int:
    """Lists kept as tiles per folder from before the account's look (``list_look``) become lists: tiles are chosen for
    all lists at once now. Runs at every start; a database without such rows is left alone."""
    changed = db.query(NoteListView).filter(NoteListView.mode == "tiles").update({NoteListView.mode: "list"},
                                                                                synchronize_session=False)
    if changed:
        db.commit()
    return int(changed or 0)


# --- The account's look -------------------------------------------------------------------------------------------

#: How lists look until the account chose: rows with their hints (checklists, attachments, tags).
DEFAULT_LOOK: dict[str, Any] = {"style": LIST_STYLES[0], "hints": True}


def list_look(account: Account) -> dict[str, Any]:
    """How every list of the account looks, on every device: ``style`` (one of ``LIST_STYLES``) and ``hints``."""
    chosen = account.preferences if isinstance(account.preferences, dict) else {}
    style = chosen.get("list_style")
    hints = chosen.get("list_hints")
    return {"style": style if style in LIST_STYLES else DEFAULT_LOOK["style"],
            "hints": hints if isinstance(hints, bool) else DEFAULT_LOOK["hints"]}


def check_style(style: str) -> str:
    if style not in LIST_STYLES:
        raise error("list_style_unknown", "Choose list, cards, compact or tiles.", 422)
    return style


def set_list_look(db: Session, account: Account, style: str | None, hints: bool | None) -> dict[str, Any]:
    """Keeps how the account's lists look; only what is given changes."""
    preferences = dict(account.preferences) if isinstance(account.preferences, dict) else {}
    if style is not None:
        preferences["list_style"] = check_style(style)
    if hints is not None:
        preferences["list_hints"] = bool(hints)
    account.preferences = preferences
    db.commit()
    return list_look(account)


# --- Pins and colors ----------------------------------------------------------------------------------------------


#: Pins of notes others shared: each member pins them for itself (NOTES-13), the owner's pin stays the note's own.
#: ``(db, account, note, pinned)`` stores it, ``(db, account, note)`` reads it.
PERSONAL_PIN: list[Callable[..., Any]] = []


def pinned_for(db: Session, account: Account, note: Note) -> bool:
    if note.owner_id != account.id and PERSONAL_PIN:
        return bool(PERSONAL_PIN[0](db, account, note))
    return note.pinned_at is not None


def set_pinned(db: Session, account: Account, note_id: str, pinned: bool) -> Note:
    """Pinning is the member's own look at its list: whoever may read a note may pin it. A note of somebody else is
    pinned for this member only (NOTES-13); the owner's pin is the note's."""
    note = notes.note_for(db, account, note_id)
    if note.owner_id != account.id:
        if not PERSONAL_PIN:
            raise error("not_found", "Not found.", 404)
        PERSONAL_PIN[0](db, account, note, pinned)
        db.commit()
        return note
    if pinned and note.pinned_at is None:
        note.pinned_at = utcnow()
    elif not pinned:
        note.pinned_at = None
    db.commit()
    return note


def set_color(db: Session, account: Account, note_id: str, color: str) -> Note:
    if color not in ("", *FOLDER_COLORS):
        raise error("note_color_unknown", "Choose a color from the list.")
    note = notes.note_for(db, account, note_id, write=True)
    note.color = color
    db.commit()
    return note


# --- Hooks --------------------------------------------------------------------------------------------------------


def tags_of(db: Session, _account: Account, rows: list[Any]) -> dict[str, dict[str, Any]]:
    """The tags of the notes (NOTES-5), the way ``GET /api/notes`` gives them, for the whole list at once."""
    from . import tags

    found = tags.with_tags(db, [{"id": row.id} for row in rows])
    return {item["id"]: {"tags": item["tags"]} for item in found}


def register() -> None:
    """The checklists are counted wherever a note's title or text is written (``notes.on_text_written``: made, copied,
    the text written anew from the document 2 s after a change, folded); the items carry their tags."""
    notes.on_text_written(recount)
    if tags_of not in ITEM_EXTRAS:
        ITEM_EXTRAS.append(tags_of)


register()
