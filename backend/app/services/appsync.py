"""What changed since a cursor, for the app (NOTES-24 AC-4, EC-4; ``GET /api/app/1/changes`` and ``/wait``).

**One number per change.** Every change to a note or folder takes the next number of one counter (``app_counter``)
and keeps it in ``sync_seq``: text, title, folder, paper, symbol, color, pin, trash, lock and sharing alike. ORM events
set it, whichever way the change comes (the editor, the browser's routes, MCP, the API, a bulk update of the trash),
so no route has to remember it. A flush takes one number for everything it writes. SQLite has one writer at a time and
the counter row is written first, so numbers are committed in their order: a reader that saw number ``n`` has seen
everything up to ``n``.

**What went** (``removed``): a note or folder deleted for good, or one somebody may no longer see (a share withdrawn,
a note moved out of a shared folder, a note locked), leaves a tombstone with the number of that change. A tombstone
names its account or none; one without an account reaches every account that does not see the thing (any more). Who
still sees it never hears of it. Tombstones stay 400 days (``KEEP_DAYS``); a cursor older than the oldest one kept
gets the full list (``full``), and the app drops what is not in it (EC-4). The cleanup that drops them gives
everything older a new number, so a full list read in pages never falls behind the floor again.

**Waiting** (``wait``): every commit that took a number wakes the waiting requests of this process, which look
whether something their account sees changed. Nothing holds a thread or a database connection while it waits.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Self

from sqlalchemy import and_, event, func, inspect, or_, select, text
from sqlalchemy.orm import ORMExecuteState, Session

from ..db import SessionLocal
from ..models import FOLDER_INBOX, Account, Folder, Note, NoteUpdate, utcnow
from ..models_app import AppCounter, AppTombstone
from ..models_shares import READ, WRITE, Share, SharePin

logger = logging.getLogger("nexnotes.app")

#: Objects per page of ``changes``.
PAGE = 500
#: How long a tombstone is kept; a cursor older than that gets the full list.
KEEP_DAYS = 400

#: Columns of a note whose change the app has to hear of. The text comes as a new row of ``note_updates``.
NOTE_COLUMNS = ("title", "title_check", "folder_id", "paper", "icon", "color", "pinned_at", "deleted_at", "locked",
                "owner_id", "updated_at", "created_at")
FOLDER_COLUMNS = ("name", "parent_id", "icon", "color", "position", "deleted_at", "owner_id", "kind")

_NEXT = text("INSERT INTO app_counter (id, value, floor) VALUES (1, 1, 0) "
             "ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value")
_TOOK = "nexnotes_app_seq"

#: The folder and everything below it, as ids (SQLite's recursive query; folders nest within one owner).
_TREE_IDS = ("WITH RECURSIVE tree(id) AS (SELECT :root UNION SELECT folders.id FROM folders "
             "JOIN tree ON folders.parent_id = tree.id) SELECT id FROM tree")
_TREE_FOLDERS = ("WITH RECURSIVE tree(id) AS (SELECT :root UNION SELECT folders.id FROM folders "
                 "JOIN tree ON folders.parent_id = tree.id) "
                 "UPDATE folders SET sync_seq = :seq WHERE id IN (SELECT id FROM tree)")
_TREE_NOTES = ("WITH RECURSIVE tree(id) AS (SELECT :root UNION SELECT folders.id FROM folders "
               "JOIN tree ON folders.parent_id = tree.id) "
               "UPDATE notes SET sync_seq = :seq WHERE folder_id IN (SELECT id FROM tree)")


# --- The counter --------------------------------------------------------------------------------------------------


def _take(session: Session) -> int:
    session.info[_TOOK] = True
    return int(session.connection().execute(_NEXT).scalar_one())


def current(db: Session) -> tuple[int, int]:
    """The last number handed out and the floor below which tombstones are gone."""
    row = db.execute(select(AppCounter.value, AppCounter.floor).where(AppCounter.id == 1)).first()
    return (int(row.value), int(row.floor)) if row is not None else (0, 0)


def _has_shares(session: Session, owner_id: int | None) -> bool:
    if owner_id is None:
        return False
    return session.connection().execute(
        select(Share.id).where(Share.owner_id == owner_id).limit(1)).first() is not None


def _changed(obj: Any, columns: Iterable[str]) -> list[str]:
    state = inspect(obj)
    return [name for name in columns if state.attrs[name].history.has_changes()]


@dataclass
class _Flush:
    """What one flush asks of the counter, written in one go before the flush itself."""

    session: Session
    seq: int | None = None
    notes: set[str] = field(default_factory=set)
    trees: set[str] = field(default_factory=set)
    #: (kind, id, account or None)
    gone: list[tuple[str, str, int | None]] = field(default_factory=list)
    #: (folder whose tree goes, account or None)
    gone_trees: list[tuple[str, int | None]] = field(default_factory=list)
    #: Whether an owner shares anything at all, asked once per flush.
    owners: dict[int, bool] = field(default_factory=dict)

    def number(self) -> int:
        if self.seq is None:
            self.seq = _take(self.session)
        return self.seq

    def went(self, kind: str, object_id: str | None, owner_id: int | None) -> None:
        """A note or folder deleted for good: its owner's devices hear it, and whoever it was shared with."""
        if object_id is None or owner_id is None:
            return
        self.gone.append((kind, object_id, owner_id))
        if owner_id not in self.owners:
            self.owners[owner_id] = _has_shares(self.session, owner_id)
        if self.owners[owner_id]:
            self.gone.append((kind, object_id, None))


@event.listens_for(Session, "before_flush")
def _number_changes(session: Session, _context: Any, _instances: Any) -> None:
    flush = _Flush(session)
    for obj in session.new:
        if isinstance(obj, (Note, Folder)):
            obj.sync_seq = flush.number()
        elif isinstance(obj, (NoteUpdate, SharePin)):
            flush.notes.add(obj.note_id)
        elif isinstance(obj, Share):
            _shared(flush, obj)
    for obj in session.dirty:
        if isinstance(obj, Note):
            changed = _changed(obj, NOTE_COLUMNS)
            if not changed:
                continue
            obj.sync_seq = flush.number()
            if ("folder_id" in changed or ("locked" in changed and obj.locked)) and _has_shares(session, obj.owner_id):
                flush.gone.append(("note", obj.id, None))
        elif isinstance(obj, Folder):
            changed = _changed(obj, FOLDER_COLUMNS)
            if not changed:
                continue
            obj.sync_seq = flush.number()
            if "parent_id" in changed and _has_shares(session, obj.owner_id):
                # Who sees the folder can change with its parent: the whole tree anew, and gone for who lost it.
                flush.trees.add(obj.id)
                flush.gone_trees.append((obj.id, None))
        elif isinstance(obj, Share) and _changed(obj, ("level", "note_id", "folder_id", "account_id")):
            _shared(flush, obj)
    for obj in session.deleted:
        if isinstance(obj, Note):
            flush.went("note", obj.id, obj.owner_id)
        elif isinstance(obj, Folder):
            flush.went("folder", obj.id, obj.owner_id)
        elif isinstance(obj, SharePin):
            flush.notes.add(obj.note_id)
        elif isinstance(obj, Share):
            _shared(flush, obj)
            if obj.note_id:
                flush.gone.append(("note", obj.note_id, obj.account_id))
            elif obj.folder_id:
                flush.gone_trees.append((obj.folder_id, obj.account_id))
    _write(flush)


def _shared(flush: _Flush, share: Share) -> None:
    """A share made, changed or ended: the note, or the folder with everything in it, gets a new number (its right
    and who sees it changed)."""
    if share.note_id:
        flush.notes.add(share.note_id)
    elif share.folder_id:
        flush.trees.add(share.folder_id)


def _write(flush: _Flush) -> None:
    if not (flush.notes or flush.trees or flush.gone or flush.gone_trees):
        return
    seq = flush.number()
    connection = flush.session.connection()
    if flush.notes:
        connection.execute(text("UPDATE notes SET sync_seq = :seq WHERE id IN (SELECT value FROM json_each(:ids))"),
                           {"seq": seq, "ids": json.dumps(sorted(flush.notes))})
    for root in flush.trees:
        connection.execute(text(_TREE_FOLDERS), {"seq": seq, "root": root})
        connection.execute(text(_TREE_NOTES), {"seq": seq, "root": root})
    now = utcnow()
    rows = [{"seq": seq, "kind": kind, "object_id": object_id, "account_id": account_id, "created_at": now}
            for kind, object_id, account_id in flush.gone]
    for root, account_id in flush.gone_trees:
        tree = list(connection.execute(text(_TREE_IDS), {"root": root}).scalars())
        inside = list(connection.execute(select(Note.id).where(Note.folder_id.in_(tree))).scalars()) if tree else []
        rows += [{"seq": seq, "kind": "folder", "object_id": folder_id, "account_id": account_id, "created_at": now}
                 for folder_id in tree]
        rows += [{"seq": seq, "kind": "note", "object_id": note_id, "account_id": account_id, "created_at": now}
                 for note_id in inside]
    if rows:
        connection.execute(AppTombstone.__table__.insert(), rows)


@event.listens_for(Session, "do_orm_execute")
def _number_bulk(state: ORMExecuteState) -> Any:
    """A bulk ``update(Note)`` or ``update(Folder)`` (the trash, a folder's notes) takes a number too; a bulk delete
    leaves tombstones."""
    if not (state.is_update or state.is_delete):
        return None
    mapper = state.bind_mapper
    model = mapper.class_ if mapper is not None else None
    if model not in (Note, Folder):
        return None
    session = state.session
    if state.is_update:
        seq = _take(session)
        return state.invoke_statement(statement=state.statement.values(sync_seq=seq))
    kind = "note" if model is Note else "folder"
    where = state.statement.whereclause
    query = select(model.id, model.owner_id)
    rows = session.connection().execute(query.where(where) if where is not None else query).all()
    if rows:
        flush = _Flush(session)
        for row in rows:
            flush.went(kind, row.id, row.owner_id)
        _write(flush)
    return None


# --- Waking the waiting ---------------------------------------------------------------------------------------------

_waiting_lock = threading.Lock()
_waiting: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    if session.info.pop(_TOOK, False):
        wake()


@event.listens_for(Session, "after_soft_rollback")
def _rolled_back(session: Session, _previous: Any) -> None:
    session.info.pop(_TOOK, None)


def wake() -> None:
    """Every waiting request of this process looks again (from any thread)."""
    with _waiting_lock:
        waiting = list(_waiting)
    for loop, flag in waiting:
        try:
            loop.call_soon_threadsafe(flag.set)
        except RuntimeError:
            pass  # its loop is closed: the request went with it


class Waiter:
    """One waiting request: ``armed`` before it looks, ``wait`` until something was committed or the time ran out."""

    def __init__(self) -> None:
        self.flag = asyncio.Event()
        self.entry = (asyncio.get_running_loop(), self.flag)

    def __enter__(self) -> Self:
        with _waiting_lock:
            _waiting.add(self.entry)
        return self

    def __exit__(self, *_exc: object) -> None:
        with _waiting_lock:
            _waiting.discard(self.entry)

    def arm(self) -> None:
        self.flag.clear()

    async def wait(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.flag.wait(), timeout=max(0.0, seconds))
        except TimeoutError:
            pass


# --- What an account sees ---------------------------------------------------------------------------------------


def _visible_notes(account_id: int) -> Any:
    from .shares import shared_select

    return or_(Note.owner_id == account_id, Note.id.in_(shared_select(account_id)))


def _visible_folders(account_id: int) -> Any:
    from .shares import shared_folders

    tree = shared_folders(account_id)
    return or_(Folder.owner_id == account_id, Folder.id.in_(select(tree.c.id)))


def _listed_folders(account_id: int) -> Any:
    """The folders the app lists: every one it sees but the inbox (``inbox`` stands for the own inbox)."""
    return and_(_visible_folders(account_id), Folder.kind != FOLDER_INBOX)


@dataclass
class Rights:
    """What sharing gives one account, per note and per folder of others."""

    notes: dict[str, str]
    folders: dict[str, str]

    def note(self, row: Any) -> str:
        return _strongest(self.notes.get(row.id), self.folders.get(row.folder_id))


def _strongest(*levels: str | None) -> str:
    return WRITE if WRITE in levels else READ


def rights_of(db: Session, account_id: int) -> Rights:
    """In one go for a whole page: shares of notes, and shares of folders with everything below them."""
    from .shares import _below, _tree_of

    notes: dict[str, str] = {}
    folders: dict[str, str] = {}
    trees: dict[int, dict[str | None, list[str]]] = {}
    alive = select(Account.id).where(Account.deleted_at.is_(None))
    for share in db.scalars(select(Share).where(Share.account_id == account_id, Share.owner_id.in_(alive))):
        if share.note_id:
            notes[share.note_id] = _strongest(notes.get(share.note_id), share.level)
        elif share.folder_id:
            children = trees.get(share.owner_id)
            if children is None:
                children = trees[share.owner_id] = _below(db, share.owner_id)
            for folder_id in _tree_of(children, share.folder_id):
                folders[folder_id] = _strongest(folders.get(folder_id), share.level)
    return Rights(notes, folders)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


def inbox_id(db: Session, account_id: int) -> str | None:
    return db.scalar(select(Folder.id).where(Folder.owner_id == account_id, Folder.kind == FOLDER_INBOX))


@dataclass
class View:
    """What the account sees, for turning rows into the app's shapes."""

    account_id: int
    inbox: str | None
    rights: Rights
    pins: set[str]

    def folder_ref(self, folder_id: str | None, owner_id: int) -> str | None:
        """``inbox`` for the own inbox; a folder of somebody else only when it is shared too, else none (the note
        alone was shared)."""
        if folder_id is None:
            return None
        if folder_id == self.inbox:
            return "inbox"
        if owner_id == self.account_id or folder_id in self.rights.folders:
            return folder_id
        return None

    def note(self, row: Note) -> dict[str, Any]:
        own = row.owner_id == self.account_id
        return {
            "id": row.id, "title": row.title, "folder_id": self.folder_ref(row.folder_id, row.owner_id),
            "paper": row.paper or "blank", "icon": row.icon or "", "color": row.color or "",
            "pinned": row.pinned_at is not None if own else row.id in self.pins,
            "title_check": bool(row.title_check), "locked": bool(row.locked),
            "right": "owner" if own else self.rights.note(row),
            "created_at": _iso(row.created_at), "updated_at": _iso(row.updated_at), "deleted_at": _iso(row.deleted_at),
            "seq": int(row.sync_seq or 0),
        }

    def folder(self, row: Folder) -> dict[str, Any]:
        own = row.owner_id == self.account_id
        parent = row.parent_id if own or row.parent_id in self.rights.folders else None
        return {
            "id": row.id, "name": row.name, "parent_id": parent, "icon": row.icon or "", "color": row.color or "",
            "position": row.position, "deleted_at": _iso(row.deleted_at), "seq": int(row.sync_seq or 0),
        }


def view_of(db: Session, account_id: int, note_ids: Iterable[str] = ()) -> View:
    wanted = list(note_ids)
    pins = set(db.scalars(select(SharePin.note_id).where(SharePin.account_id == account_id,
                                                         SharePin.note_id.in_(wanted)))) if wanted else set()
    return View(account_id=account_id, inbox=inbox_id(db, account_id), rights=rights_of(db, account_id), pins=pins)


def note_out(db: Session, account_id: int, note: Note) -> dict[str, Any]:
    """One note as ``changes`` gives it."""
    return view_of(db, account_id, [note.id]).note(note)


def visible(db: Session, account_id: int, kind: str, ids: Iterable[str]) -> set[str]:
    """Which of ``ids`` the account sees now."""
    wanted = list(set(ids))
    if not wanted:
        return set()
    if kind == "note":
        return set(db.scalars(select(Note.id).where(Note.id.in_(wanted), _visible_notes(account_id))))
    return set(db.scalars(select(Folder.id).where(Folder.id.in_(wanted), _visible_folders(account_id))))


def _removed(db: Session, account_id: int, stones: list[AppTombstone]) -> list[dict[str, str]]:
    """The tombstones of things the account does not see (any more), each once."""
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for kind in ("note", "folder"):
        ids = [stone.object_id for stone in stones if stone.kind == kind]
        still = visible(db, account_id, kind, ids)
        for object_id in ids:
            if object_id in still or (kind, object_id) in seen:
                continue
            seen.add((kind, object_id))
            out.append({"kind": kind, "id": object_id})
    return out


def _stones(account_id: int) -> Any:
    return or_(AppTombstone.account_id == account_id, AppTombstone.account_id.is_(None))


def _needs_full(cursor: int, value: int, floor: int) -> bool:
    return cursor <= 0 or cursor < floor or cursor > value


def changes(db: Session, account: Account, cursor: int, page: int = PAGE) -> dict[str, Any]:
    """Everything the account sees that changed after ``cursor``, at most ``page`` objects (more when several carry
    the last number of the page: a page never ends in the middle of one change)."""
    value, floor = current(db)
    full = _needs_full(cursor, value, floor)
    start = 0 if full else cursor
    notes_where = and_(_visible_notes(account.id), Note.sync_seq > start, Note.sync_seq <= value)
    folders_where = and_(_listed_folders(account.id), Folder.sync_seq > start, Folder.sync_seq <= value)
    stones_where = and_(_stones(account.id), AppTombstone.seq > start, AppTombstone.seq <= value)
    seqs = sorted([
        *db.scalars(select(Note.sync_seq).where(notes_where).order_by(Note.sync_seq).limit(page + 1)),
        *db.scalars(select(Folder.sync_seq).where(folders_where).order_by(Folder.sync_seq).limit(page + 1)),
        *([] if full else db.scalars(select(AppTombstone.seq).where(stones_where).order_by(AppTombstone.seq)
                                     .limit(page + 1))),
    ])
    bound = seqs[page - 1] if len(seqs) > page else value
    more = bound < value and any(seq > bound for seq in seqs)
    if bound < value and not more:
        # Every source stopped at the page's size: whether something lies beyond the bound, ask.
        more = _beyond(db, account, bound, value, full)
    note_rows = list(db.scalars(select(Note).where(notes_where, Note.sync_seq <= bound).order_by(Note.sync_seq)))
    folder_rows = list(db.scalars(select(Folder).where(folders_where, Folder.sync_seq <= bound)
                                  .order_by(Folder.sync_seq)))
    stones = [] if full else list(db.scalars(select(AppTombstone).where(stones_where, AppTombstone.seq <= bound)
                                             .order_by(AppTombstone.seq)))
    view = view_of(db, account.id, [row.id for row in note_rows])
    return {
        "cursor": bound if more else value,
        "full": full,
        "more": more,
        "notes": [view.note(row) for row in note_rows],
        "folders": [view.folder(row) for row in folder_rows],
        "removed": _removed(db, account.id, stones),
    }


def _beyond(db: Session, account: Account, bound: int, value: int, full: bool) -> bool:
    if db.scalar(select(Note.id).where(_visible_notes(account.id), Note.sync_seq > bound, Note.sync_seq <= value)
                 .limit(1)) is not None:
        return True
    if db.scalar(select(Folder.id).where(_listed_folders(account.id), Folder.sync_seq > bound,
                                         Folder.sync_seq <= value).limit(1)) is not None:
        return True
    return not full and db.scalar(select(AppTombstone.id).where(
        _stones(account.id), AppTombstone.seq > bound, AppTombstone.seq <= value).limit(1)) is not None


def changed_since(db: Session, account: Account, cursor: int) -> int | None:
    """The current number when something the account sees changed after ``cursor``, else None (``wait``)."""
    value, floor = current(db)
    if cursor <= 0 and value <= 0:
        return None
    if _needs_full(cursor, value, floor):
        return value
    if _beyond(db, account, cursor, value, full=True):
        return value
    stones = list(db.scalars(select(AppTombstone).where(_stones(account.id), AppTombstone.seq > cursor,
                                                        AppTombstone.seq <= value).limit(PAGE)))
    if stones and _removed(db, account.id, stones):
        return value
    return None


# --- Keeping it tidy ------------------------------------------------------------------------------------------------


def _renumber(db: Session, table: str, below: int) -> None:
    """Every row of ``table`` numbered at most ``below`` gets a number of its own above everything handed out."""
    value, _ = current(db)
    db.execute(text(f"UPDATE {table} SET sync_seq = :base + rowid WHERE sync_seq <= :below"),  # noqa: S608
               {"base": value, "below": below})
    top = int(db.execute(text(f"SELECT MAX(sync_seq) FROM {table}")).scalar() or 0)  # noqa: S608
    db.execute(text("INSERT INTO app_counter (id, value, floor) VALUES (1, :top, 0) "
                    "ON CONFLICT (id) DO UPDATE SET value = MAX(value, :top)"), {"top": top})
    db.commit()


def stamp_unnumbered() -> None:
    """Notes and folders from before the counter (``sync_seq`` 0) get numbers of their own, once, so that a first
    full list can be read in pages like any other."""
    with SessionLocal() as db:
        # The counter starts at 1: a cursor of 0 always means "everything", never "nothing changed yet".
        db.execute(text("INSERT INTO app_counter (id, value, floor) VALUES (1, 1, 0) ON CONFLICT (id) DO NOTHING"))
        db.commit()
        for table in ("notes", "folders"):
            if db.execute(text(f"SELECT 1 FROM {table} WHERE sync_seq = 0 LIMIT 1")).first() is None:  # noqa: S608
                continue
            _renumber(db, table, 0)
            logger.info("Numbered for the app table=%s", table)
    wake()


def drop_old_tombstones(now: Any = None) -> int:
    """Tombstones older than ``KEEP_DAYS`` go; the floor rises to the highest of them, and everything still numbered
    at or below it gets a number of its own above it (a full list read in pages then starts above the floor)."""
    limit = (now or utcnow()) - timedelta(days=KEEP_DAYS)
    with SessionLocal() as db:
        top = db.scalar(select(func.max(AppTombstone.seq)).where(AppTombstone.created_at < limit))
        if top is None:
            return 0
        gone = db.execute(AppTombstone.__table__.delete().where(AppTombstone.created_at < limit)).rowcount
        db.execute(text("INSERT INTO app_counter (id, value, floor) VALUES (1, :top, :top) "
                        "ON CONFLICT (id) DO UPDATE SET floor = MAX(floor, :top)"), {"top": int(top)})
        db.commit()
        _, floor = current(db)
        for table in ("notes", "folders"):
            _renumber(db, table, floor)
        logger.info("Old tombstones dropped count=%s floor=%s", gone, floor)
    wake()
    return int(gone or 0)


def _owner_went(db: Session, account_id: int) -> None:
    """A deleted account's shares count for nothing (``shares._alive_owners``): who they were shared with hears that
    the things went."""
    flush = _Flush(db)
    for share in db.scalars(select(Share).where(Share.owner_id == account_id)):
        if share.note_id:
            flush.gone.append(("note", share.note_id, share.account_id))
        elif share.folder_id:
            flush.gone_trees.append((share.folder_id, share.account_id))
    _write(flush)
    db.commit()


def _owner_back(db: Session, account_id: int) -> None:
    """The operator brought the account back: what it shares comes back with new numbers."""
    from .devices import forget_blocked

    flush = _Flush(db)
    for share in db.scalars(select(Share).where(Share.owner_id == account_id)):
        _shared(flush, share)
    _write(flush)
    db.commit()
    forget_blocked(db, account_id)


def register() -> None:
    """At every start, each hook once."""
    from . import cleanup, content

    if all(job is not drop_old_tombstones for _, job in cleanup._jobs):
        cleanup.register("app tombstones", drop_old_tombstones)
    if _owner_went not in content._deleted:
        content.on_deleted(_owner_went)
    if _owner_back not in content._restored:
        content.on_restored(_owner_back)
