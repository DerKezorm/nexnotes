"""The history of a note (NOTES-15): versions to look at, to bring back, to copy.

**When a version is taken.** Every stored update of an account leaves a mark in ``note_edits`` (``record_edit``, hooked
into the note store). An editing session ends when the note has been quiet for ``QUIET`` (five minutes), or at the
latest after ``SESSION_MAX`` (an hour) of writing without a pause; then ``take_due`` keeps the whole Yjs state as a
version, named after everybody who wrote in the session. A ticker runs it every ``TICK_SECONDS`` (the history router's
lifespan). The state is read from the database, not from the live room: every update is stored before anybody sees
it, so the folded state and the updates after it are the note as it is. Nothing here holds a pycrdt object beyond the
function that made it.

**Thinning** (AC-2), in the cleanup round and by the server's clock: within ``KEEP_ALL`` (7 days) every version, up
to ``KEEP_DAILY`` (30 days) the last one of each day, up to the operator's ``history_days`` the last one of each ISO
week, older ones go. A shorter deadline counts from the next round on, never at once (EC-6); the log says how many
went.

**Restoring** (AC-4) is a new change through ``Rooms.change``: under the room's lock the note as it is now is read
(it becomes a version and stays in the history), then the title's changed part and the blocks that differ are
replaced; blocks the two have in common, in order, stay untouched. Whoever has the note open follows live; text typed
at the same moment into a replaced paragraph comes back through the room's rescue (``notedoc/rescue.py``). Right
after, the restored note is a version of its own that says which one it came from.

**Who wrote:** an account, or an account through a program. NOTES-20 (MCP keys) wraps its change in
``with acting_via("mcp:<key name>")``; the label travels with the context into the store's thread.

**Hooks for attachments (NOTES-10):** ``VERSIONS_PURGED_HOOKS`` get the ids of versions about to go (thinning), so that
attachments only an old version names can go with them.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Any

from pycrdt import Doc, XmlElement
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..errors import error
from ..models import Account, Note, NoteUpdate, utcnow
from ..models_history import NoteEdit, NoteVersion
from ..notedoc import doc as notedoc
from ..notedoc.doc import _read_element, body_of, write_blocks
from ..notedoc.rescue import Rescuer, _words
from ..notedoc.schema import PARAGRAPH
from ..notedoc.yupdate import IdRanges, decode_update
from ..notedoc.markdown import to_plain
from . import content, notes, settings_service

logger = logging.getLogger("nexnotes.history")

#: A session ends after this long without a change.
QUIET = timedelta(minutes=5)
#: ... or after this long of writing without such a pause.
SESSION_MAX = timedelta(minutes=60)
#: How often the ticker looks for sessions that ended.
TICK_SECONDS = 30
#: Every version stays this long; after that one per day, after ``KEEP_DAILY`` one per week.
KEEP_ALL = timedelta(days=7)
KEEP_DAILY = timedelta(days=30)
#: Versions per page of the list (EC-5), and the most a page may ask for.
PAGE = 50
PAGE_MAX = 200
#: What a copy's title ends with, by the account's language (AC-5).
VERSION_SUFFIX = {"de": "(Fassung vom {when})", "en": "(Version of {when})"}
#: The longest date label a page may send for the copy's title.
WHEN_MAX = 40


# --- The clock ----------------------------------------------------------------------------------------------------


class Clock:
    """The server's clock, set by hand in tests (a year of versions, 90 days of trash)."""

    def __init__(self) -> None:
        self.fixed: datetime | None = None

    def now(self) -> datetime:
        return self.fixed if self.fixed is not None else utcnow()

    def set(self, when: datetime) -> None:
        self.fixed = when

    def advance(self, **delta: float) -> datetime:
        self.fixed = self.now() + timedelta(**delta)
        return self.fixed

    def reset(self) -> None:
        self.fixed = None


clock = Clock()


# --- Who writes ---------------------------------------------------------------------------------------------------

_via: ContextVar[str] = ContextVar("nexnotes_history_via", default="")


@contextmanager
def acting_via(label: str) -> Iterator[None]:
    """Changes made inside count as made through a program (``mcp:<key name>``), not by the person directly."""
    token = _via.set((label or "")[:140])
    try:
        yield
    finally:
        _via.reset(token)


def record_edit(db: Session, note_id: str, account_id: int | None) -> None:
    """An update of ``account_id`` was stored (the note store's hook). The server's own changes name nobody."""
    if account_id is None:
        return
    via = _via.get()
    now = clock.now()
    statement = insert(NoteEdit).values(note_id=note_id, writer=f"{account_id}|{via}", account_id=account_id, via=via,
                                        first_at=now, last_at=now)
    db.execute(statement.on_conflict_do_update(index_elements=[NoteEdit.note_id, NoteEdit.writer],
                                               set_={"last_at": statement.excluded.last_at}))


# --- Taking versions ----------------------------------------------------------------------------------------------


def _write_lock(db: Session) -> None:
    """The write lock before the first read: the state, the marks and the new version agree, no update slips between
    reading the state and removing the marks."""
    connection = db.connection()
    raw = connection.connection.driver_connection
    if raw is not None and not raw.in_transaction:
        connection.exec_driver_sql("BEGIN IMMEDIATE")


def _current_state(db: Session, note_id: str) -> bytes | None:
    """The note as it is now, as one Yjs update; ``None`` when there is no such note. Call inside the lock."""
    found = db.execute(select(Note.ydoc).where(Note.id == note_id)).first()
    if found is None:
        return None
    updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id).order_by(NoteUpdate.id)))
    return notedoc.load(found.ydoc or None, updates).get_update()


def _take(db: Session, note_id: str, *, restored_from: datetime | None = None, force: bool = False,
          author: int | None = None, state: bytes | None = None, until: datetime | None = None,
          skip_same: bool = False) -> NoteVersion | None:
    """A version of the note as it is now (or ``state``, the note as it was at ``until``), named after who wrote since
    the last one. Nothing when it would be the same as the last version (unless ``force``; with ``skip_same`` not
    even then)."""
    query = select(NoteEdit).where(NoteEdit.note_id == note_id)
    if until is not None:
        query = query.where(NoteEdit.first_at <= until)
    edits = list(db.scalars(query.order_by(NoteEdit.first_at)))
    if state is None:
        state = _current_state(db, note_id)
    gone = delete(NoteEdit).where(NoteEdit.note_id == note_id)
    db.execute(gone if until is None else gone.where(NoteEdit.last_at <= until))
    if state is None:
        return None
    last = db.execute(select(NoteVersion.state).where(NoteVersion.note_id == note_id)
                      .order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc()).limit(1)).first()
    if (not force or skip_same) and last is not None and last.state == state:
        return None
    if last is None and not edits and not force:
        return None
    authors: list[dict[str, Any]] = []
    for edit in edits:
        entry = {"account_id": edit.account_id, "via": edit.via}
        if entry not in authors:
            authors.append(entry)
    if author is not None and {"account_id": author, "via": ""} not in authors:
        authors.insert(0, {"account_id": author, "via": ""})
    now = until or clock.now()
    ended = max((min(edit.last_at, now) for edit in edits), default=now) if restored_from is None else now
    started = min((edit.first_at for edit in edits), default=ended)
    title = notedoc.title_of(notedoc.load(state))
    version = NoteVersion(note_id=note_id, created_at=ended, started_at=min(started, ended), state=state, title=title,
                          size=len(state), authors=authors, restored_from=restored_from)
    db.add(version)
    return version


def take_now(note_id: str, *, restored_from: datetime | None = None, force: bool = False,
             author: int | None = None, state: bytes | None = None, until: datetime | None = None,
             skip_same: bool = False) -> int | None:
    """A version of the note right now (after a restore), or of ``state`` as it was at ``until`` (right before one);
    returns its id, or ``None`` when nothing was new."""
    with SessionLocal() as db:
        _write_lock(db)
        version = _take(db, note_id, restored_from=restored_from, force=force, author=author, state=state,
                        until=until, skip_same=skip_same)
        db.commit()
        return version.id if version is not None else None


def take_due() -> int:
    """Versions of every note whose editing session ended (quiet for ``QUIET`` or longer than ``SESSION_MAX``).
    Returns how many were taken."""
    now = clock.now()
    with SessionLocal() as db:
        rows = db.execute(select(NoteEdit.note_id, func.min(NoteEdit.first_at).label("first"),
                                 func.max(NoteEdit.last_at).label("last")).group_by(NoteEdit.note_id)).all()
    due = [row.note_id for row in rows if row.last <= now - QUIET or row.first <= now - SESSION_MAX]
    taken = 0
    for note_id in due:
        try:
            if take_now(note_id) is not None:
                taken += 1
        except Exception:
            logger.exception("Taking a version failed note=%s", note_id)
    return taken


async def run_forever(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.to_thread(take_due)
        except Exception:
            logger.exception("Taking versions failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_SECONDS)
            return
        except TimeoutError:
            pass


# --- Thinning -----------------------------------------------------------------------------------------------------

#: Called with the session and the ids of versions about to be removed by thinning (attachments, NOTES-10).
VERSIONS_PURGED_HOOKS: list[Callable[[Session, list[int]], None]] = []


def to_thin(rows: list[Any], now: datetime, days: int) -> list[int]:
    """The ids that go: rows of (id, note_id, created_at), any order. Within ``KEEP_ALL`` all stay; then the newest of
    each UTC day, after ``KEEP_DAILY`` the newest of each ISO week; older than ``days`` none."""
    ordered = sorted(rows, key=lambda row: (row.note_id, row.created_at, row.id), reverse=True)
    seen: set[tuple[Any, ...]] = set()
    drop: list[int] = []
    for row in ordered:
        age = now - row.created_at
        if age <= KEEP_ALL:
            continue
        if age > timedelta(days=days):
            drop.append(row.id)
            continue
        if age > KEEP_DAILY:
            week = row.created_at.isocalendar()
            key: tuple[Any, ...] = (row.note_id, "week", week.year, week.week)
        else:
            key = (row.note_id, "day", row.created_at.date())
        if key in seen:
            drop.append(row.id)
        else:
            seen.add(key)
    return drop


def thin() -> int:
    """Thins every history and drops what is older than the operator's deadline. Returns how many went."""
    now = clock.now()
    with SessionLocal() as db:
        days = settings_service.history_days(db)
        rows = db.execute(select(NoteVersion.id, NoteVersion.note_id, NoteVersion.created_at)
                          .where(NoteVersion.created_at < now - KEEP_ALL)).all()
        drop = to_thin(rows, now, days)
        for start in range(0, len(drop), 500):
            chunk = drop[start: start + 500]
            for hook in VERSIONS_PURGED_HOOKS:
                hook(db, chunk)
            db.execute(delete(NoteVersion).where(NoteVersion.id.in_(chunk)))
        db.commit()
    if drop:
        logger.info("History thinned removed=%s days=%s", len(drop), days)
    return len(drop)


# --- Reading ------------------------------------------------------------------------------------------------------


def _names(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(select(Account.id, Account.display_name, Account.name).where(Account.id.in_(ids))).all()
    return {row.id: row.display_name or row.name for row in rows}


def _authors_out(authors: Any, names: dict[int, str]) -> list[dict[str, Any]]:
    out = []
    for entry in authors or []:
        account_id = entry.get("account_id")
        out.append({"id": account_id, "name": names.get(account_id, "") if account_id is not None else "",
                    "via": entry.get("via") or ""})
    return out


def _account_ids(rows: Any) -> set[int]:
    return {entry["account_id"] for row in rows for entry in (row.authors or []) if entry.get("account_id") is not None}


def can_restore(db: Session, account: Account, note: Note) -> bool:
    return notes.access_to(db, account, note).value == "write"


def listing(db: Session, account: Account, note_id: str, before: int | None = None,
            limit: int = PAGE) -> dict[str, Any]:
    """The versions of a note, newest first, a page at a time (EC-5): ``before`` is the id the last page ended with."""
    note = notes.note_for(db, account, note_id)
    limit = max(1, min(limit, PAGE_MAX))
    query = (select(NoteVersion.id, NoteVersion.created_at, NoteVersion.started_at, NoteVersion.title,
                    NoteVersion.authors, NoteVersion.restored_from)
             .where(NoteVersion.note_id == note.id)
             .order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc()))
    if before is not None:
        cursor = db.execute(select(NoteVersion.created_at).where(NoteVersion.id == before,
                                                                  NoteVersion.note_id == note.id)).first()
        if cursor is None:
            raise error("not_found", "Not found.", 404)
        query = query.where(or_(NoteVersion.created_at < cursor.created_at,
                                (NoteVersion.created_at == cursor.created_at) & (NoteVersion.id < before)))
    rows = db.execute(query.limit(limit + 1)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    pending = db.scalar(select(func.count()).select_from(NoteEdit).where(NoteEdit.note_id == note.id)) or 0
    names = _names(db, _account_ids(rows) | ({note.updated_by_id} if note.updated_by_id else set()))
    versions = [
        {
            "id": row.id,
            "created_at": row.created_at.isoformat(),
            "started_at": row.started_at.isoformat(),
            "title": row.title,
            "authors": _authors_out(row.authors, names),
            "restored_from": row.restored_from.isoformat() if row.restored_from else None,
            "current": before is None and index == 0 and not pending,
        }
        for index, row in enumerate(rows)
    ]
    return {
        "versions": versions,
        "next": rows[-1].id if more and rows else None,
        "pending": bool(pending),
        "updated_at": note.updated_at.isoformat(),
        "updated_by": notes.person(db, note.updated_by_id),
        "can_restore": can_restore(db, account, note),
        "history_days": settings_service.history_days(db),
        # The note's symbol and colour for the head of its history (NOTES-3 AC-18); not part of a version.
        "icon": note.icon or "",
        "color": note.color or "",
    }


def _version(db: Session, note_id: str, version_id: int) -> NoteVersion:
    version = db.scalars(select(NoteVersion).where(NoteVersion.id == version_id,
                                                   NoteVersion.note_id == note_id)).first()
    if version is None:
        raise error("not_found", "Not found.", 404)
    return version


def content_of(state: bytes) -> tuple[str, list[dict[str, Any]]]:
    """Title and blocks (cleaned ProseMirror JSON) of a stored state."""
    doc = notedoc.load(state)
    return notedoc.title_of(doc), notedoc.clean_doc(notedoc.to_json(doc))["content"]


def read(db: Session, account: Account, note_id: str, version_id: int) -> dict[str, Any]:
    """One version whole (AC-3): its title and text, when, who."""
    note = notes.note_for(db, account, note_id)
    version = _version(db, note.id, version_id)
    title, blocks = content_of(version.state)
    names = _names(db, _account_ids([version]))
    return {
        "id": version.id,
        "note_id": note.id,
        "created_at": version.created_at.isoformat(),
        "started_at": version.started_at.isoformat(),
        "title": title,
        "content": {"type": "doc", "content": blocks},
        "text": to_plain(notedoc.load(version.state)),
        "authors": _authors_out(version.authors, names),
        "restored_from": version.restored_from.isoformat() if version.restored_from else None,
        "can_restore": can_restore(db, account, note),
    }


def last_restore(db: Session, account: Account, note_id: str) -> dict[str, Any] | None:
    """The newest restore of the note (EC-2): an open editor tells its person when somebody else did it."""
    note = notes.note_for(db, account, note_id)
    row = db.execute(select(NoteVersion.id, NoteVersion.created_at, NoteVersion.authors, NoteVersion.restored_from)
                     .where(NoteVersion.note_id == note.id, NoteVersion.restored_from.is_not(None))
                     .order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc()).limit(1)).first()
    if row is None:
        return None
    names = _names(db, _account_ids([row]))
    return {"id": row.id, "at": row.created_at.isoformat(), "version_at": row.restored_from.isoformat(),
            "authors": _authors_out(row.authors, names)}


# --- Restoring ----------------------------------------------------------------------------------------------------


def _key(block: dict[str, Any]) -> str:
    return json.dumps(block, sort_keys=True, ensure_ascii=False)


def _block_key(child: Any) -> str | None:
    """A block of the live document as the cleaned JSON it reads as; ``None`` for anything that is not one block."""
    if not isinstance(child, XmlElement):
        return None
    cleaned = notedoc.clean_doc({"type": "doc", "content": [_read_element(child)]})["content"]
    return _key(cleaned[0]) if len(cleaned) == 1 else None


#: What a restore replaced: the ids it deleted, where, and the words of the paragraph that took their place.
Replaced = tuple[IdRanges, int, str | None]


def _deleted_now(doc: Doc) -> IdRanges:
    return decode_update(doc.get_update()).deleted


def replace_content(doc: Doc, title: str, blocks: list[dict[str, Any]]) -> list[Replaced]:
    """The note becomes ``title`` and ``blocks``, changing only what differs: the title's changed part, and of the text
    only the blocks that are not in both, in order (the longest common run of equal blocks stays untouched, so
    whoever types in one of them at the same moment keeps their place).

    Returns, for each stretch of blocks it replaced, what it deleted and the paragraph that took its place, so that
    text typed into a replaced block at the same moment joins that paragraph (``Rescuer.remember``)."""
    notedoc.set_title(doc, title)
    wanted = notedoc.clean_doc({"type": "doc", "content": blocks})["content"]
    body = body_of(doc)
    replaced: list[Replaced] = []
    with doc.transaction():
        have = [_block_key(child) for child in body.children]
        matcher = SequenceMatcher(a=have, b=[_key(block) for block in wanted], autojunk=False)
        # From the end backwards, so that the positions of the changes still to come stay right.
        for tag, a_start, a_end, b_start, b_end in reversed(matcher.get_opcodes()):
            if tag == "equal":
                continue
            new = wanted[b_start:b_end]
            if a_start == a_end == 0 and have and b_end < len(wanted):
                # Before the first block. The Yjs engine places a block put at the very start of a list it got from
                # another client by client number, often at the end; so the first block is written again after the
                # new ones and the old one goes (what somebody types into it meanwhile joins the copy).
                new, a_end = new + [wanted[b_end]], 1
            # The new blocks go after the ones they replace (each right behind a block, never at the very start), then
            # the old ones go.
            made = write_blocks(body, a_end, new)
            if a_end > a_start:
                before = _deleted_now(doc)
                del body.children[a_start:a_end]
                gone = _deleted_now(doc).minus(before)
                home = next((block for block in reversed(made) if block.tag == PARAGRAPH), None)
                replaced.append((gone, a_start, _words(home) if home is not None else None))
    return replaced


async def restore(account: Account, note_id: str, version_id: int) -> dict[str, Any]:
    """The version becomes the note (AC-4) as a new change everyone who has it open sees at once (EC-2). The note as
    it was stays in the history."""
    with SessionLocal() as db:
        note = notes.note_for(db, account, note_id, write=True)
        version = _version(db, note.id, version_id)
        state, at = version.state, version.created_at
    title, blocks = await asyncio.to_thread(content_of, state)

    def edit(doc: Doc) -> tuple[bytes, list[Replaced]]:
        # The note exactly as the restore found it, read under the room's lock: what anybody's update brought in
        # until this moment is in it, and it stays in the history.
        before = doc.get_update()
        return before, replace_content(doc, title, blocks)

    def remember(rescuer: Rescuer, done: tuple[bytes, list[Replaced]]) -> None:
        for ids, at, home in done[1]:
            rescuer.remember(ids, at, home)

    started = clock.now()
    before, _ = await notes.change(note_id, edit, account_id=account.id, rescue=remember)
    await asyncio.to_thread(take_now, note_id, state=before, until=started)
    # A restore that changes nothing (the note is the version already) makes no version of its own: each one is the
    # whole note and counts towards the account's storage.
    made = await asyncio.to_thread(take_now, note_id, restored_from=at, force=True, author=account.id, skip_same=True)
    if made is None:
        with SessionLocal() as db:
            made = db.scalar(select(NoteVersion.id).where(NoteVersion.note_id == note_id)
                             .order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc()).limit(1))
    logger.info("Version restored note=%s version=%s", note_id, version_id)
    return {"id": made, "restored_from": at.isoformat()}


def _suffix(account: Account, when: str) -> str:
    language = (account.language or account.browser_language or "en").split("-")[0].lower()
    return VERSION_SUFFIX.get(language, VERSION_SUFFIX["en"]).format(when=when)


def _when_label(account: Account, at: datetime) -> str:
    language = (account.language or account.browser_language or "en").split("-")[0].lower()
    if language == "de":
        return f"{at.day}.{at.month}.{at.year}"
    return f"{at:%b} {at.day}, {at.year}"


def copy(db: Session, account: Account, note_id: str, version_id: int, when: str | None = None) -> Note:
    """A new note with the version's content in the same folder, its title with "(Fassung vom …)" (AC-5). ``when`` is
    the date as the person's device shows it; without it the server's date."""
    source = notes.note_for(db, account, note_id, write=True)
    version = _version(db, source.id, version_id)
    title, blocks = content_of(version.state)
    label = notedoc.clean_title(when)[:WHEN_MAX] if when else ""
    label = label or _when_label(account, version.created_at)
    new_title = notes.copy_title(title, _suffix(account, label))
    document = notedoc.new_doc(new_title, {"type": "doc", "content": blocks})
    now = utcnow()
    note = Note(owner_id=source.owner_id, folder_id=source.folder_id, title=new_title, origin=source.origin,
                ydoc=document.get_update(), text=to_plain(document), created_at=now, updated_at=now,
                updated_by_id=account.id)
    db.add(note)
    db.flush()
    # The copy is found by the search like any note made by hand (NOTES-9).
    notes._written(db, note)
    db.commit()
    logger.info("Version copied note=%s version=%s copy=%s", note_id, version_id, note.id)
    return note


# --- Hooks into the frame -----------------------------------------------------------------------------------------


def _count(db: Session, account_id: int) -> content.Counts:
    size = db.scalar(select(func.coalesce(func.sum(NoteVersion.size), 0))
                     .join(Note, Note.id == NoteVersion.note_id).where(Note.owner_id == account_id))
    return content.Counts(bytes=int(size or 0))


def register() -> None:
    """Once per start, each hook once: who wrote, the thinning in the cleanup round, the bytes the versions take."""
    from . import cleanup

    if record_edit not in notes.UPDATE_HOOKS:
        notes.UPDATE_HOOKS.append(record_edit)
    if all(job is not thin for _, job in cleanup._jobs):
        cleanup.register("history", thin)
    if _count not in content._counters:
        content.register_counter(_count)
