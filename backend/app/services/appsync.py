"""What changed since a cursor, for the app (NOTES-24 AC-4, EC-4; ``GET /api/app/1/changes`` and ``/wait``).

**One number per change.** Every change to a note or folder takes the next number of one counter (``app_counter``)
and keeps it in ``sync_seq``: text, title, folder, paper, symbol, color, pin, trash, lock and sharing alike. ORM events
set it, whichever way the change comes (the editor, the browser's routes, MCP, the API, a bulk update of the trash),
so no route has to remember it. A flush takes one number for everything it writes. SQLite has one writer at a time and
the counter row is written first, so numbers are committed in their order: a reader that saw number ``n`` has seen
everything up to ``n``.

**What went** (``removed``): a note or folder deleted for good, or one somebody may no longer see (a share withdrawn,
a note moved out of a shared folder, a note locked), leaves a tombstone with the number of that change, one for each
account it can concern: its owner, and whoever the owner shares anything with (never an account that never could have
seen it). Who still sees it never hears of it. Tombstones stay 400 days (``KEEP_DAYS``); a cursor older than the oldest
one kept gets the full list (``full``), and the app drops what none of its pages held (EC-4). The last page of a full
list read in pages brings the tombstones since it started (what went between the pages). The cleanup that drops old
tombstones gives everything older a new number, so a full list read in pages never falls behind the floor again.

**Smart folders** (NOTESIOS-7) are numbered like folders and are only ever their owner's: a deleted one leaves a
tombstone of the kind ``smart`` for its owner alone. **Recognised text** of attachments (NOTESIOS-10): when the text of
an attachment changes (the server read it, or the app brought it), every note that names it gets a new number, and
each note in ``changes`` carries ``texts``, a stamp of that text (``texts_of``), so the app knows whose text to fetch.

**Waiting** (``wait``): every commit that took a number wakes the waiting requests of this process, which look
whether something their account sees changed. Nothing holds a thread or a database connection while it waits.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Self

from sqlalchemy import and_, event, func, inspect, or_, select, text
from sqlalchemy.orm import ORMExecuteState, Session

from ..db import SessionLocal
from ..models import FOLDER_INBOX, Account, Folder, Note, NoteListView, NoteUpdate, utcnow
from ..models_app import AppCounter, AppTombstone
from ..models_attachments import Attachment, AttachmentRef
from ..models_ocr import PAGE_DONE, AttachmentText
from ..models_shares import READ, WRITE, Share, SharePin
from ..models_smart import SmartFolder

logger = logging.getLogger("nexnotes.app")

#: Objects per page of ``changes``.
PAGE = 500
#: How long a tombstone is kept; a cursor older than that gets the full list.
KEEP_DAYS = 400

#: Columns of a note whose change the app has to hear of. The text comes as a new row of ``note_updates``.
NOTE_COLUMNS = ("title", "title_check", "folder_id", "paper", "icon", "color", "pinned_at", "deleted_at", "locked",
                "owner_id", "updated_at", "updated_by_id", "created_at")
FOLDER_COLUMNS = ("name", "parent_id", "icon", "color", "position", "deleted_at", "owner_id", "kind")
SMART_COLUMNS = ("name", "preset", "match", "conditions", "icon", "color", "position", "owner_id")
#: Columns of an attachment's text whose change the notes naming it have to bring (``texts``).
TEXT_COLUMNS = ("text", "state", "page")
#: Columns of an account the app keeps (``account`` in ``changes``).
ACCOUNT_COLUMNS = ("display_name", "avatar_at", "preferences")

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


def take_on(connection: Any) -> int:
    """The next number on a bare connection (rows written without the ORM, like the smart folders every new account
    gets in its own insert)."""
    return int(connection.execute(_NEXT).scalar_one())


def current(db: Session) -> tuple[int, int]:
    """The last number handed out and the floor below which tombstones are gone."""
    row = db.execute(select(AppCounter.value, AppCounter.floor).where(AppCounter.id == 1)).first()
    return (int(row.value), int(row.floor)) if row is not None else (0, 0)


def _recipients(session: Session, owner_id: int | None) -> list[int]:
    """The accounts the owner shares anything with: the only ones besides the owner a tombstone of its things can
    concern."""
    if owner_id is None:
        return []
    return list(session.connection().execute(
        select(Share.account_id).where(Share.owner_id == owner_id).distinct()).scalars())


def _changed(obj: Any, columns: Iterable[str]) -> list[str]:
    state = inspect(obj)
    return [name for name in columns if state.attrs[name].history.has_changes()]


@dataclass
class _Flush:
    """What one flush asks of the counter, written in one go before the flush itself."""

    session: Session
    seq: int | None = None
    notes: set[str] = field(default_factory=set)
    accounts: set[int] = field(default_factory=set)
    trees: set[str] = field(default_factory=set)
    #: Attachments whose recognised text changed: the notes naming them get the number.
    attachments: set[str] = field(default_factory=set)
    #: (kind, id, account)
    gone: list[tuple[str, str, int | None]] = field(default_factory=list)
    #: (folder whose tree goes, account)
    gone_trees: list[tuple[str, int | None]] = field(default_factory=list)
    #: Whether an owner shares anything at all, asked once per flush.
    owners: dict[int, list[int]] = field(default_factory=dict)

    def number(self) -> int:
        if self.seq is None:
            self.seq = _take(self.session)
        return self.seq

    def went(self, kind: str, object_id: str | None, owner_id: int | None) -> None:
        """A note or folder deleted for good: its owner's devices hear it, and whoever it was shared with."""
        if object_id is None or owner_id is None:
            return
        self.gone.append((kind, object_id, owner_id))
        for account_id in self.recipients(owner_id):
            self.gone.append((kind, object_id, account_id))

    def recipients(self, owner_id: int) -> list[int]:
        if owner_id not in self.owners:
            self.owners[owner_id] = _recipients(self.session, owner_id)
        return self.owners[owner_id]


@event.listens_for(Session, "before_flush")
def _number_changes(session: Session, _context: Any, _instances: Any) -> None:
    flush = _Flush(session)
    for obj in session.new:
        if isinstance(obj, (Note, Folder, SmartFolder)):
            obj.sync_seq = flush.number()
        elif isinstance(obj, AttachmentText):
            flush.attachments.add(obj.attachment_id)
        elif isinstance(obj, (NoteUpdate, SharePin)):
            flush.notes.add(obj.note_id)
        elif isinstance(obj, Share):
            _shared(flush, obj)
        elif isinstance(obj, NoteListView):
            flush.accounts.add(obj.account_id)
    for obj in session.dirty:
        if isinstance(obj, Note):
            changed = _changed(obj, NOTE_COLUMNS)
            if not changed:
                continue
            obj.sync_seq = flush.number()
            if "folder_id" in changed or ("locked" in changed and obj.locked):
                # Who it was shared with through its folder, or at all, may not see it any more.
                flush.gone += [("note", obj.id, account_id) for account_id in flush.recipients(obj.owner_id)]
        elif isinstance(obj, Folder):
            changed = _changed(obj, FOLDER_COLUMNS)
            if not changed:
                continue
            obj.sync_seq = flush.number()
            people = flush.recipients(obj.owner_id) if "parent_id" in changed else []
            if people:
                # Who sees the folder can change with its parent: the whole tree anew, and gone for who lost it.
                flush.trees.add(obj.id)
                flush.gone_trees += [(obj.id, account_id) for account_id in people]
        elif isinstance(obj, Share) and _changed(obj, ("level", "note_id", "folder_id", "account_id")):
            _shared(flush, obj)
        elif (isinstance(obj, Account) and _changed(obj, ACCOUNT_COLUMNS)) or (
                isinstance(obj, SmartFolder) and _changed(obj, SMART_COLUMNS)):
            obj.sync_seq = flush.number()
        elif isinstance(obj, AttachmentText) and _changed(obj, TEXT_COLUMNS):
            flush.attachments.add(obj.attachment_id)
        elif isinstance(obj, NoteListView) and _changed(obj, ("sort", "direction", "grouped", "mode", "key")):
            flush.accounts.add(obj.account_id)
    for obj in session.deleted:
        if isinstance(obj, Note):
            flush.went("note", obj.id, obj.owner_id)
        elif isinstance(obj, Folder):
            flush.went("folder", obj.id, obj.owner_id)
        elif isinstance(obj, SmartFolder):
            # Never shared: its owner's devices alone hear of it.
            flush.gone.append(("smart", obj.id, obj.owner_id))
        elif isinstance(obj, AttachmentText):
            flush.attachments.add(obj.attachment_id)
        elif isinstance(obj, SharePin):
            flush.notes.add(obj.note_id)
        elif isinstance(obj, NoteListView):
            flush.accounts.add(obj.account_id)
        elif isinstance(obj, Share):
            _shared(flush, obj)
            if obj.note_id:
                flush.gone.append(("note", obj.note_id, obj.account_id))
            elif obj.folder_id:
                flush.gone_trees.append((obj.folder_id, obj.account_id))
    _write(flush)


def bump_notes(session: Session, note_ids: Iterable[str]) -> None:
    """Notes whose change the ORM does not see (their tags, written straight into ``note_tags``) get a new number."""
    flush = _Flush(session)
    flush.notes.update(note_ids)
    _write(flush)


def _shared(flush: _Flush, share: Share) -> None:
    """A share made, changed or ended: the note, or the folder with everything in it, gets a new number (its right
    and who sees it changed)."""
    if share.note_id:
        flush.notes.add(share.note_id)
    elif share.folder_id:
        flush.trees.add(share.folder_id)


def _write(flush: _Flush) -> None:
    if not (flush.notes or flush.accounts or flush.trees or flush.gone or flush.gone_trees or flush.attachments):
        return
    seq = flush.number()
    connection = flush.session.connection()
    if flush.accounts:
        connection.execute(text("UPDATE accounts SET sync_seq = :seq WHERE id IN (SELECT value FROM json_each(:ids))"),
                           {"seq": seq, "ids": json.dumps(sorted(flush.accounts))})
    if flush.notes:
        connection.execute(text("UPDATE notes SET sync_seq = :seq WHERE id IN (SELECT value FROM json_each(:ids))"),
                           {"seq": seq, "ids": json.dumps(sorted(flush.notes))})
    if flush.attachments:
        connection.execute(text("UPDATE notes SET sync_seq = :seq WHERE id IN (SELECT note_id FROM attachment_refs "
                                "WHERE attachment_id IN (SELECT value FROM json_each(:ids))) OR id IN (SELECT note_id "
                                "FROM attachments WHERE id IN (SELECT value FROM json_each(:ids)))"),
                           {"seq": seq, "ids": json.dumps(sorted(flush.attachments))})
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
    if model is NoteListView:
        # A view gone or changed in bulk (a smart folder deleted): its account gets a new number.
        where = state.statement.whereclause
        query = select(NoteListView.account_id).distinct()
        owners = set(state.session.connection().execute(query.where(where) if where is not None else query)
                     .scalars())
        if owners:
            flush = _Flush(state.session)
            flush.accounts.update(owners)
            _write(flush)
        return None
    if model is AttachmentText:
        # Text replaced or forgotten in bulk (the app's text, a locked note): the notes naming it get a new number.
        where = state.statement.whereclause
        query = select(AttachmentText.attachment_id).distinct()
        ids = set(state.session.connection().execute(query.where(where) if where is not None else query).scalars())
        if ids:
            flush = _Flush(state.session)
            flush.attachments.update(ids)
            _write(flush)
        return None
    if model not in (Note, Folder, SmartFolder):
        return None
    session = state.session
    if state.is_update:
        seq = _take(session)
        return state.invoke_statement(statement=state.statement.values(sync_seq=seq))
    where = state.statement.whereclause
    query = select(model.id, model.owner_id)
    rows = session.connection().execute(query.where(where) if where is not None else query).all()
    if rows:
        flush = _Flush(session)
        for row in rows:
            if model is SmartFolder:
                flush.gone.append(("smart", row.id, row.owner_id))
            else:
                flush.went("note" if model is Note else "folder", row.id, row.owner_id)
        _write(flush)
    return None


# --- Waking the waiting ---------------------------------------------------------------------------------------------

_waiting_lock = threading.Lock()
_waiting: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
#: The waiting request of each device: a device waits once; a second ``wait`` of it ends the first.
_by_device: dict[int, Waiter] = {}
#: Commits closer together than this wake the waiting once: typing in a browser commits many times a second, and each
#: wake costs every waiting device a look into the database.
WAKE_EVERY = 0.2
_wake_lock = threading.Lock()
_last_wake = 0.0
_wake_pending = False


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    if session.info.pop(_TOOK, False):
        wake()


@event.listens_for(Session, "after_soft_rollback")
def _rolled_back(session: Session, _previous: Any) -> None:
    session.info.pop(_TOOK, None)


def wake() -> None:
    """Every waiting request of this process looks again (from any thread), at most every ``WAKE_EVERY`` seconds:
    commits in between are gathered into one wake at the end of that time."""
    global _last_wake, _wake_pending
    with _wake_lock:
        if _wake_pending:
            return
        now = time.monotonic()
        later = _last_wake + WAKE_EVERY - now
        if later > 0:
            _wake_pending = True
            timer = threading.Timer(later, _wake_later)
            timer.daemon = True
            timer.start()
            return
        _last_wake = now
    _wake_now()


def _wake_later() -> None:
    global _last_wake, _wake_pending
    with _wake_lock:
        _wake_pending = False
        _last_wake = time.monotonic()
    _wake_now()


def _wake_now() -> None:
    with _waiting_lock:
        waiting = list(_waiting)
    for loop, flag in waiting:
        try:
            loop.call_soon_threadsafe(flag.set)
        except RuntimeError:
            pass  # its loop is closed: the request went with it


class Waiter:
    """One waiting request of a device: ``armed`` before it looks, ``wait`` until something was committed or the time
    ran out. ``replaced`` once the same device waits anew (its connection broke and the app asked again)."""

    def __init__(self, device_id: int) -> None:
        self.device_id = device_id
        self.flag = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.entry = (self.loop, self.flag)
        self.replaced = False

    def __enter__(self) -> Self:
        with _waiting_lock:
            before = _by_device.get(self.device_id)
            _by_device[self.device_id] = self
            _waiting.add(self.entry)
        if before is not None:
            before.replaced = True
            try:
                before.loop.call_soon_threadsafe(before.flag.set)
            except RuntimeError:
                pass
        return self

    def __exit__(self, *_exc: object) -> None:
        with _waiting_lock:
            _waiting.discard(self.entry)
            if _by_device.get(self.device_id) is self:
                del _by_device[self.device_id]

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
    #: The account's own pins of notes of others (NOTES-13): note id to when it pinned it.
    pins: dict[str, datetime]
    tags: dict[str, list[str]] = field(default_factory=dict)
    texts: dict[str, str] = field(default_factory=dict)
    #: The people a page names (owners of things of others, who wrote last): id to ``{"id", "name", "avatar"}``.
    people: dict[int, dict[str, Any]] = field(default_factory=dict)
    #: Own notes shared with somebody by themselves, and own folders shared themselves or through one above.
    shared_notes: set[str] = field(default_factory=set)
    shared_folders: set[str] = field(default_factory=set)

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

    def person(self, account_id: int | None) -> dict[str, Any] | None:
        return self.people.get(account_id) if account_id is not None else None

    def note(self, row: Note) -> dict[str, Any]:
        own = row.owner_id == self.account_id
        return {
            "id": row.id, "title": row.title, "folder_id": self.folder_ref(row.folder_id, row.owner_id),
            "paper": row.paper or "blank", "icon": row.icon or "", "color": row.color or "",
            "pinned": row.pinned_at is not None if own else row.id in self.pins,
            # When it was pinned (NOTESIOS-21, contract 0.13): the app's Markdown export writes it like the server's.
            "pinned_at": _iso(row.pinned_at if own else self.pins.get(row.id)),
            "title_check": bool(row.title_check), "locked": bool(row.locked),
            # Where a quick note came from (NOTESIOS-5 AC-4, contract 0.12), shown on every device.
            "origin": row.origin or "",
            "right": "owner" if own else self.rights.note(row),
            "tags": [] if row.locked else self.tags.get(row.id, []),
            "texts": "" if row.locked else self.texts.get(row.id, ""),
            # Sharing (NOTESIOS-14): whose a note of somebody else is, whether an own one is shared, who wrote last.
            "owner": None if own else self.person(row.owner_id),
            "shared": own and (row.id in self.shared_notes or row.folder_id in self.shared_folders),
            "updated_by": self.person(row.updated_by_id),
            "created_at": _iso(row.created_at), "updated_at": _iso(row.updated_at), "deleted_at": _iso(row.deleted_at),
            "seq": int(row.sync_seq or 0),
        }

    def smart(self, row: SmartFolder) -> dict[str, Any]:
        return smart_out(row, self.inbox)

    def folder(self, row: Folder) -> dict[str, Any]:
        own = row.owner_id == self.account_id
        parent = row.parent_id if own or row.parent_id in self.rights.folders else None
        return {
            "id": row.id, "name": row.name, "parent_id": parent, "icon": row.icon or "", "color": row.color or "",
            "position": row.position,
            "right": "owner" if own else self.rights.folders.get(row.id, READ),
            "owner": None if own else self.person(row.owner_id),
            "shared": own and row.id in self.shared_folders,
            "deleted_at": _iso(row.deleted_at), "seq": int(row.sync_seq or 0),
        }


def _people(db: Session, ids: set[int]) -> dict[int, dict[str, Any]]:
    """Name and picture of the accounts a page names; an account gone names nobody."""
    wanted = [account_id for account_id in ids if account_id is not None]
    found: dict[int, dict[str, Any]] = {}
    for start in range(0, len(wanted), 500):
        for row in db.execute(select(Account.id, Account.display_name, Account.name, Account.avatar_at)
                              .where(Account.id.in_(wanted[start:start + 500]), Account.deleted_at.is_(None))):
            found[row.id] = {"id": row.id, "name": row.display_name or row.name, "avatar": _iso(row.avatar_at) or ""}
    return found


def _own_shared(db: Session, account_id: int) -> tuple[set[str], set[str]]:
    """The account's own notes shared by themselves, and its folders shared by themselves or through a folder above
    (with somebody whose account is alive), as the lists mark them (NOTES-13 AC-7)."""
    from .shares import _below, _owned_shares, _tree_of

    shares = _owned_shares(db, account_id)
    notes = {share.note_id for share in shares if share.note_id}
    folders: set[str] = set()
    roots = [share.folder_id for share in shares if share.folder_id]
    if roots:
        children = _below(db, account_id)
        for root in roots:
            folders |= _tree_of(children, root)
    return notes, folders


def tags_of(db: Session, note_ids: list[str]) -> dict[str, list[str]]:
    """The tags of the notes as written, without ``#``, each spelling once."""
    from ..models_tags import NoteTag

    found: dict[str, list[str]] = {}
    for start in range(0, len(note_ids), 500):
        for note_id, label in db.execute(select(NoteTag.note_id, NoteTag.label)
                                         .where(NoteTag.note_id.in_(note_ids[start:start + 500]))
                                         .order_by(NoteTag.note_id, NoteTag.label)):
            found.setdefault(note_id, []).append(label)
    return found


def _vouched_pairs(db: Session, account_id: int, owners: dict[str, int]) -> set[tuple[str, str]]:
    """In notes of somebody else: the (note, attachment) pairs its owner put there (NOTES-13). As
    ``attachments._vouched`` in the browser, a pair without a row counts as not vouched."""
    from ..models_attachments import AttachmentMention

    theirs = [note_id for note_id, owner_id in owners.items() if owner_id != account_id]
    vouched: set[tuple[str, str]] = set()
    for start in range(0, len(theirs), 500):
        vouched.update((row.note_id, row.attachment_id) for row in db.execute(
            select(AttachmentMention.note_id, AttachmentMention.attachment_id)
            .where(AttachmentMention.note_id.in_(theirs[start:start + 500]), AttachmentMention.vouched.is_(True))))
    return vouched


def _text_rows(db: Session, account_id: int, notes: dict[str, int], *, words: bool) -> Iterable[Any]:
    """The pages with text of the attachments each note names (``notes``: id to owner), in the order the note names
    them: only attachments of the note's owner; in a note of somebody else only those in their own note or vouched
    for by the owner (``attachments.readable``). ``words``: each page with its text; else one row per attachment with
    how many pages hold text and when the last changed (a stamp, which never reads the text: every write of a page
    sets its ``updated_at``)."""
    vouched = _vouched_pairs(db, account_id, notes)
    ids = list(notes)
    if words:
        columns: tuple[Any, ...] = (AttachmentText.page, AttachmentText.text.label("body"), AttachmentText.language)
        order: tuple[Any, ...] = (AttachmentText.page,)
    else:
        columns = (func.count(AttachmentText.page).label("pages"),
                   func.max(AttachmentText.updated_at).label("changed"))
        order = ()
    for start in range(0, len(ids), 500):
        statement = (
            select(AttachmentRef.note_id, Attachment.id, Attachment.kind, Attachment.name, Attachment.owner_id,
                   Attachment.note_id.label("home"), *columns)
            .join(Attachment, Attachment.id == AttachmentRef.attachment_id)
            .join(AttachmentText, AttachmentText.attachment_id == Attachment.id)
            .where(AttachmentRef.note_id.in_(ids[start:start + 500]), AttachmentText.state == PAGE_DONE)
        )
        if not words:
            statement = statement.group_by(AttachmentRef.note_id, Attachment.id)
        for row in db.execute(statement.order_by(AttachmentRef.note_id, AttachmentRef.position, Attachment.id,
                                                 *order)):
            owner = notes.get(row.note_id)
            if row.owner_id != owner:
                continue
            if row.home != row.note_id and owner != account_id and (row.note_id, row.id) not in vouched:
                continue
            yield row


def attachment_texts(db: Session, account_id: int, notes: dict[str, int]) -> dict[str, list[dict[str, Any]]]:
    """The recognised text of the attachments each note names, the pages that hold text: what the search reads
    (``ocr.texts_of``), for the app's search offline (``_text_rows``)."""
    found: dict[str, dict[str, dict[str, Any]]] = {}
    for row in _text_rows(db, account_id, notes, words=True):
        entry = found.setdefault(row.note_id, {}).setdefault(
            row.id, {"id": row.id, "kind": row.kind, "name": row.name, "pages": []})
        entry["pages"].append({"page": row.page, "text": row.body, "language": row.language or ""})
    return {note_id: list(held.values()) for note_id, held in found.items()}


def _stamp(parts: list[str]) -> str:
    import hashlib

    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16] if parts else ""


def texts_of(db: Session, account_id: int, rows: Iterable[Note]) -> dict[str, str]:
    """``texts`` of each note: a stamp over which attachments hold text on how many pages and since when, without
    reading the text itself; locked notes have none."""
    return text_stamps(db, account_id, {row.id: row.owner_id for row in rows if not row.locked})


def text_stamps(db: Session, account_id: int, notes: dict[str, int]) -> dict[str, str]:
    parts: dict[str, list[str]] = {}
    for row in _text_rows(db, account_id, notes, words=False):
        parts.setdefault(row.note_id, []).append(f"{row.id}|{row.kind}|{row.name}|{row.pages}|{row.changed}")
    return {note_id: _stamp(found) for note_id, found in parts.items()}


def view_of(db: Session, account_id: int, note_ids: Iterable[str] = (), rows: Iterable[Note] = (),
            folders: Iterable[Folder] = ()) -> View:
    wanted = list(note_ids)
    rows = list(rows)
    folders = list(folders)
    pins = {row.note_id: row.pinned_at for row in db.execute(
        select(SharePin.note_id, SharePin.pinned_at).where(SharePin.account_id == account_id,
                                                           SharePin.note_id.in_(wanted)))} if wanted else {}
    named = {row.updated_by_id for row in rows} | {row.owner_id for row in rows if row.owner_id != account_id}
    named |= {row.owner_id for row in folders if row.owner_id != account_id}
    shared_notes, shared_folders = _own_shared(db, account_id) if rows or folders else (set(), set())
    return View(account_id=account_id, inbox=inbox_id(db, account_id), rights=rights_of(db, account_id), pins=pins,
                tags=tags_of(db, wanted) if wanted else {}, texts=texts_of(db, account_id, rows),
                people=_people(db, named), shared_notes=shared_notes, shared_folders=shared_folders)


def account_out(db: Session, account: Account) -> dict[str, Any]:
    """What the app keeps of the account (``account`` in ``changes``): name, picture, default paper, how its lists
    look, and every list's view (all of them, each time)."""
    from . import notes, notes_list

    row = db.get(Account, account.id) or account
    inbox = inbox_id(db, row.id)
    views = []
    for view in db.scalars(select(NoteListView).where(NoteListView.account_id == row.id).order_by(NoteListView.key)):
        entry: dict[str, Any] = {"key": "inbox" if view.key == inbox else view.key, "sort": view.sort,
                                 "direction": view.direction, "grouped": bool(view.grouped)}
        if view.key.startswith("s:"):
            # A smart folder's view says whether it shows its notes or the gallery (NOTESIOS-7 AC-7).
            entry["mode"] = "gallery" if view.mode == "gallery" else "list"
        views.append(entry)
    return {"name": row.display_name or row.name, "avatar": _iso(row.avatar_at) or "",
            "paper": notes.default_paper(row), "list_look": notes_list.list_look(row), "views": views,
            "seq": int(row.sync_seq or 0)}


def note_out(db: Session, account_id: int, note: Note) -> dict[str, Any]:
    """One note as ``changes`` gives it."""
    return view_of(db, account_id, [note.id], [note]).note(note)


def _inbox_condition(conditions: Any, inbox: str | None, *, to_app: bool) -> list[Any]:
    """The condition "Ordner" names the own inbox as ``inbox`` in the app, by its id on the server."""
    out = []
    for condition in conditions or []:
        if isinstance(condition, dict) and condition.get("kind") == "folder" and inbox:
            if to_app and condition.get("id") == inbox:
                condition = {**condition, "id": "inbox"}
            elif not to_app and condition.get("id") == "inbox":
                condition = {**condition, "id": inbox}
        out.append(condition)
    return out


def conditions_in(db: Session, account_id: int, conditions: Any) -> Any:
    """The conditions of a smart folder as the app sends them, for the server."""
    from .inbox import inbox_for

    if not isinstance(conditions, list):
        return conditions
    named = any(isinstance(item, dict) and item.get("kind") == "folder" and item.get("id") == "inbox"
                for item in conditions)
    return _inbox_condition(conditions, inbox_for(db, account_id).id if named else None, to_app=False)


def smart_out(row: SmartFolder, inbox: str | None) -> dict[str, Any]:
    """One smart folder as ``changes`` gives it."""
    return {
        "id": row.id, "name": row.name, "preset": row.preset or "", "match": row.match,
        "conditions": _inbox_condition(row.conditions, inbox, to_app=True), "icon": row.icon or "",
        "color": row.color or "", "position": row.position, "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at), "seq": int(row.sync_seq or 0),
    }


def visible(db: Session, account_id: int, kind: str, ids: Iterable[str]) -> set[str]:
    """Which of ``ids`` the account sees now."""
    wanted = list(set(ids))
    if not wanted:
        return set()
    if kind == "note":
        return set(db.scalars(select(Note.id).where(Note.id.in_(wanted), _visible_notes(account_id))))
    if kind == "smart":
        return set(db.scalars(select(SmartFolder.id).where(SmartFolder.id.in_(wanted),
                                                           SmartFolder.owner_id == account_id)))
    return set(db.scalars(select(Folder.id).where(Folder.id.in_(wanted), _visible_folders(account_id))))


def _removed(db: Session, account_id: int, stones: list[AppTombstone]) -> list[dict[str, str]]:
    """The tombstones of things the account does not see (any more), each once."""
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for kind in ("note", "folder", "smart"):
        ids = [stone.object_id for stone in stones if stone.kind == kind]
        still = visible(db, account_id, kind, ids)
        for object_id in ids:
            if object_id in still or (kind, object_id) in seen:
                continue
            seen.add((kind, object_id))
            out.append({"kind": kind, "id": object_id})
    return out


def _stones(account_id: int) -> Any:
    return AppTombstone.account_id == account_id


def _needs_full(cursor: int, value: int, floor: int) -> bool:
    return cursor <= 0 or cursor < floor or cursor > value


def changes(db: Session, account: Account, cursor: int, page: int = PAGE, *, going_on: bool = False,
            since: int | None = None) -> dict[str, Any]:
    """Everything the account sees that changed after ``cursor``, at most ``page`` objects (more when several carry
    the last number of the page: a page never ends in the middle of one change). ``going_on``: ``cursor`` is the one
    the device got with the last page of a full list; this page belongs to it and says ``full`` too (every page of a
    full list does, and the app drops what none of them held once ``more`` is false). ``since``: the number the full
    list started at; its last page brings what went for good meanwhile, between the pages (the app had it from an
    earlier page)."""
    value, floor = current(db)
    full = going_on and 0 < cursor <= value
    if full:
        start = cursor
    else:
        full = _needs_full(cursor, value, floor)
        start = 0 if full else cursor
    notes_where = and_(_visible_notes(account.id), Note.sync_seq > start, Note.sync_seq <= value)
    folders_where = and_(_listed_folders(account.id), Folder.sync_seq > start, Folder.sync_seq <= value)
    smart_where = and_(SmartFolder.owner_id == account.id, SmartFolder.sync_seq > start, SmartFolder.sync_seq <= value)
    stones_where = and_(_stones(account.id), AppTombstone.seq > start, AppTombstone.seq <= value)
    seqs = sorted([
        *db.scalars(select(Note.sync_seq).where(notes_where).order_by(Note.sync_seq).limit(page + 1)),
        *db.scalars(select(Folder.sync_seq).where(folders_where).order_by(Folder.sync_seq).limit(page + 1)),
        *db.scalars(select(SmartFolder.sync_seq).where(smart_where).order_by(SmartFolder.sync_seq).limit(page + 1)),
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
    smart_rows = list(db.scalars(select(SmartFolder).where(smart_where, SmartFolder.sync_seq <= bound)
                                 .order_by(SmartFolder.sync_seq)))
    stones = [] if full else list(db.scalars(select(AppTombstone).where(stones_where, AppTombstone.seq <= bound)
                                             .order_by(AppTombstone.seq)))
    if full and not more and since is not None:
        stones = list(db.scalars(select(AppTombstone).where(
            _stones(account.id), AppTombstone.seq > since, AppTombstone.seq <= value).order_by(AppTombstone.seq)))
    view = view_of(db, account.id, [row.id for row in note_rows], note_rows, folder_rows)
    out: dict[str, Any] = {
        "cursor": bound if more else value,
        "full": full,
        "more": more,
        "notes": [view.note(row) for row in note_rows],
        "folders": [view.folder(row) for row in folder_rows],
        "smart_folders": [view.smart(row) for row in smart_rows],
        "removed": _removed(db, account.id, stones),
    }
    # The account comes on the page whose range holds its last change (``start`` < its number <= the page's end), on
    # the first page of a full list whatever its number, and on the last page when it changed after the end of the
    # range read: never lost between pages of one run.
    seq = _account_seq(db, account.id)
    if (full and not going_on) or (start < seq and (not more or seq <= bound)):
        out["account"] = account_out(db, account)
    return out


def _account_seq(db: Session, account_id: int) -> int:
    return int(db.scalar(select(Account.sync_seq).where(Account.id == account_id)) or 0)


def _beyond(db: Session, account: Account, bound: int, value: int, full: bool) -> bool:
    if db.scalar(select(Note.id).where(_visible_notes(account.id), Note.sync_seq > bound, Note.sync_seq <= value)
                 .limit(1)) is not None:
        return True
    if db.scalar(select(Folder.id).where(_listed_folders(account.id), Folder.sync_seq > bound,
                                         Folder.sync_seq <= value).limit(1)) is not None:
        return True
    if db.scalar(select(SmartFolder.id).where(SmartFolder.owner_id == account.id, SmartFolder.sync_seq > bound,
                                              SmartFolder.sync_seq <= value).limit(1)) is not None:
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
    if _beyond(db, account, cursor, value, full=True) or _account_seq(db, account.id) > cursor:
        return value
    stones = list(db.scalars(select(AppTombstone).where(_stones(account.id), AppTombstone.seq > cursor,
                                                        AppTombstone.seq <= value).limit(PAGE)))
    if stones and _removed(db, account.id, stones):
        return value
    return None


def seen_stamp(db: Session, account: Account) -> str:
    """Changes whenever anything the account sees changed, whichever way it came (a device over ``/api/app/1``, MCP,
    the API, another browser): the browser's tree, tiles and smart folders ask for it every few seconds and load
    again only when it changed. The newest number of its notes, folders and smart folders, its own, the newest
    tombstone of what it can no longer see, and how many notes and folders it sees (a note shared and withdrawn
    leaves the newest number as it was)."""
    notes_seen = db.execute(select(func.count(), func.max(Note.sync_seq)).where(_visible_notes(account.id))).one()
    folders_seen = db.execute(select(func.count(), func.max(Folder.sync_seq))
                              .where(_visible_folders(account.id))).one()
    smart = db.scalar(select(func.max(SmartFolder.sync_seq)).where(SmartFolder.owner_id == account.id))
    stone = db.scalar(select(func.max(AppTombstone.seq)).where(_stones(account.id)))
    parts = (notes_seen[0], notes_seen[1], folders_seen[0], folders_seen[1], smart, stone,
             _account_seq(db, account.id))
    return "-".join(str(int(part or 0)) for part in parts)


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
        for table in ("notes", "folders", "smart_folders"):
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
        for table in ("notes", "folders", "smart_folders"):
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
    flush = _Flush(db)
    for share in db.scalars(select(Share).where(Share.owner_id == account_id)):
        _shared(flush, share)
    _write(flush)
    db.commit()


def register() -> None:
    """At every start, each hook once."""
    from . import cleanup, content

    if all(job is not drop_old_tombstones for _, job in cleanup._jobs):
        cleanup.register("app tombstones", drop_old_tombstones)
    if _owner_went not in content._deleted:
        content.on_deleted(_owner_went)
    if _owner_back not in content._restored:
        content.on_restored(_owner_back)
