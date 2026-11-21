"""Notes: made, listed, titled, copied, deleted, and written together live.

The text of a note is a Yjs document (``app/notedoc``). Everything typed goes through the live room (``Rooms``, one
per process) and its store here (``SqlNoteStore``); the columns ``title`` and ``text`` are copies the server keeps for
lists, search and preview. Changes the server makes itself (a suggested title) go through ``Rooms.change`` as well, so
a browser that has the note open sees them at once.

Rights: ``access_to`` says what an account may do with a note. Today only the owner reads and writes; sharing
(NOTES-13) adds its ways in through ``ACCESS_RULES``.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note, NoteUpdate, utcnow
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from ..notedoc.markdown import from_markdown, to_plain
from ..notedoc.room import Access, Folded, Peer, Rooms
from ..security import account_out
from . import content
from .inbox import inbox_for

logger = logging.getLogger("nexnotes.notes")

#: Characters of the plain text a list shows under the title.
PREVIEW_CHARS = 200
#: Seconds a note waits after the last connection left before an empty one goes and one without a title gets the
#: suggestion (a connection that only broke for a moment comes back long before).
LEAVE_GRACE = 15.0
#: Empty notes nobody touched for this long go in the cleanup round (a tab closed before it ever connected).
EMPTY_NOTE_AGE = timedelta(days=1)
#: What a copy's title ends with, by the account's language (NOTES-3 AC-7).
COPY_SUFFIX = {"de": "(Kopie)", "en": "(Copy)"}
#: Words a suggested title takes at most.
SUGGESTION_WORDS = 8


# --- Rights -------------------------------------------------------------------------------------------------------

AccessRule = Callable[[Session, Account, Note], Access | None]
#: Further ways to a note besides owning it, asked in order: the first that answers WRITE or READ counts. Sharing
#: (NOTES-13) adds its readers and writers here.
ACCESS_RULES: list[AccessRule] = []


def access_to(db: Session, account: Account | None, note: Note | None) -> Access:
    """What ``account`` may do with ``note``: WRITE, READ, NONE, or GONE when it may and the note is in the trash."""
    if account is None or note is None or account_out(account):
        return Access.NONE
    found = Access.WRITE if note.owner_id == account.id else Access.NONE
    if found == Access.NONE and note.locked:
        # A locked note is its owner's alone (NOTES-16), whatever a share of its folder says (NOTES-13 EC-3).
        return Access.NONE
    if found == Access.NONE:
        for rule in ACCESS_RULES:
            answer = rule(db, account, note)
            if answer in (Access.WRITE, Access.READ):
                found = answer
                break
    if found == Access.NONE:
        return Access.NONE
    return Access.GONE if note.deleted_at is not None else found


def note_for(db: Session, account: Account, note_id: str, *, write: bool = False, deleted: bool = False) -> Note:
    """The note when the account may see it (and write, when asked), else ``not_found``: a note nobody may see is
    not there for them."""
    note = db.get(Note, note_id) if len(note_id) <= 36 else None
    access = access_to(db, account, note)
    if access == Access.GONE and deleted:
        access = Access.WRITE if note is not None and note.owner_id == account.id else Access.READ
    if access not in (Access.WRITE, Access.READ) or (write and access != Access.WRITE):
        raise error("not_found", "Not found.", 404)
    assert note is not None
    return note


# --- Locked notes (NOTES-16) --------------------------------------------------------------------------------------


def busy(db: Session, note_id: str) -> bool:
    """The note is locked in the vault, or being locked or unlocked (``services/vault.py``): no live room, no change
    by the server."""
    from ..models_vault import VaultPending
    from .vault import PENDING_FOR

    row = db.execute(select(Note.locked).where(Note.id == note_id)).first()
    if row is not None and row.locked:
        return True
    started = db.scalar(select(VaultPending.started_at).where(VaultPending.note_id == note_id))
    return started is not None and started >= utcnow() - PENDING_FOR


def _refuse_locked(note_id: str) -> None:
    with SessionLocal() as db:
        if busy(db, note_id):
            raise error("note_locked", "The note is locked.", 409)


# --- Hooks on the text --------------------------------------------------------------------------------------------

#: Called wherever the title or the text of a note is written, with the session and the note, before the commit of the
#: same transaction (the search index, NOTES-9). A hook must not raise; it logs its own failures.
TEXT_WRITTEN: list[Callable[[Session, Note], None]] = []


def on_text_written(hook: Callable[[Session, Note], None]) -> None:
    """Adds ``hook`` once; asked again (every start) it stays once."""
    if hook not in TEXT_WRITTEN:
        TEXT_WRITTEN.append(hook)


def _written(db: Session, note: Note) -> None:
    for hook in TEXT_WRITTEN:
        hook(db, note)


# --- Titles -------------------------------------------------------------------------------------------------------

_SENTENCE_END = re.compile(r"[.!?;,]\s|[.!?;,]$|\s[-–—]\s")


def suggest_title(text: str) -> str:
    """A title from the first words of the text: its first line up to the first sentence mark, at most
    ``SUGGESTION_WORDS`` words and ``MAX_TITLE`` characters (NOTES-3 AC-9, AC-10, EC-7). Empty for an empty text."""
    for line in (text or "").splitlines():
        line = notedoc.clean_title(line)
        if not line:
            continue
        end = _SENTENCE_END.search(line)
        if end is not None and end.start() > 0:
            line = line[: end.start()]
        words = line.split(" ")
        return notedoc.clean_title(" ".join(words[:SUGGESTION_WORDS]))
    return ""


def _take_title(note: Note, title: str) -> None:
    """The column follows the document's title; a title that changed is one somebody gave, so "Titel prüfen" goes
    (NOTES-3 AC-10, EC-12)."""
    if title != note.title:
        note.title = title
        if title:
            note.title_check = False


# --- The store of the live room -----------------------------------------------------------------------------------

#: Called after every stored update with the session, the note and the account (``None`` for the server's own
#: changes), once the update is committed: the history (NOTES-15) remembers who wrote. A hook that fails is logged and
#: never costs the update.
UpdateHook = Callable[[Session, str, int | None], None]
UPDATE_HOOKS: list[UpdateHook] = []


def _after_update(db: Session, note_id: str, account_id: int | None) -> None:
    for hook in UPDATE_HOOKS:
        try:
            hook(db, note_id, account_id)
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("A hook after storing an update failed note=%s", note_id)


@dataclass(frozen=True)
class LiveSession:
    """What the check of a live connection looks at again: the browser's session and the note."""

    token: str
    note_id: str


class SqlNoteStore:
    """``NoteStore`` over SQLAlchemy: ``notes.ydoc`` holds the folded state, ``note_updates`` what came since."""

    def __init__(self, sessions: Callable[[], Session] = SessionLocal) -> None:
        self.sessions = sessions

    async def load(self, note_id: str) -> tuple[bytes | None, list[bytes]]:
        return await asyncio.to_thread(self._load, note_id)

    def _load(self, note_id: str) -> tuple[bytes | None, list[bytes]]:
        with self.sessions() as db:
            state = db.scalar(select(Note.ydoc).where(Note.id == note_id))
            updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id)
                                      .order_by(NoteUpdate.id)))
        return (state or None), updates

    async def save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
        return await asyncio.to_thread(self._save_update, note_id, update, account_id)

    def _save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
        with self.sessions() as db:
            if busy(db, note_id):
                # Locked meanwhile (NOTES-16): nothing plain is stored any more; the room closes the sender.
                raise RuntimeError("the note is locked")
            db.add(NoteUpdate(note_id=note_id, update=update, account_id=account_id))
            if account_id is not None:
                note = db.get(Note, note_id)
                if note is not None:
                    note.updated_at = utcnow()
                    note.updated_by_id = account_id
            db.commit()
            _after_update(db, note_id, account_id)
            return int(db.scalar(select(func.count()).select_from(NoteUpdate)
                                 .where(NoteUpdate.note_id == note_id)) or 0)

    async def fold(self, note_id: str, folded: Folded) -> None:
        await asyncio.to_thread(self._fold, note_id, folded)

    def _fold(self, note_id: str, folded: Folded) -> None:
        with self.sessions() as db:
            note = db.get(Note, note_id)
            if note is None or note.locked:
                return
            last = db.scalar(select(func.max(NoteUpdate.id)).where(NoteUpdate.note_id == note_id))
            note.ydoc = folded.state
            note.text = folded.text
            _take_title(note, folded.title)
            _written(db, note)
            if last is not None:
                db.execute(delete(NoteUpdate).where(NoteUpdate.note_id == note_id, NoteUpdate.id <= last))
            db.commit()

    async def summary(self, note_id: str, title: str, text: str) -> None:
        await asyncio.to_thread(self._summary, note_id, title, text)

    def _summary(self, note_id: str, title: str, text: str) -> None:
        with self.sessions() as db:
            note = db.get(Note, note_id)
            if note is None or note.locked:
                return
            note.text = text
            _take_title(note, title)
            _written(db, note)
            db.commit()


def _check_now(peer: Peer) -> Access:
    session: LiveSession = peer.session
    from ..security import session_account

    with SessionLocal() as db:
        account = session_account(db, session.token)
        if account is None or account.id != peer.account_id:
            return Access.NONE
        if busy(db, session.note_id):
            return Access.NONE
        return access_to(db, account, db.get(Note, session.note_id))


async def check_live(peer: Peer) -> Access:
    """The live room asks again: is the session still there, may the account still write or read, is the note
    still there (NOTES-12 EC-2, EC-5)."""
    return await asyncio.to_thread(_check_now, peer)


# --- One Rooms per event loop -------------------------------------------------------------------------------------

_rooms: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, Rooms] = weakref.WeakKeyDictionary()
_leaving: set[asyncio.Task[None]] = set()


def make_rooms() -> Rooms:
    return Rooms(store=SqlNoteStore(), check=check_live)


def rooms() -> Rooms:
    """The rooms of the running process. nexnotes runs one worker with one loop; the tests' clients bring their own
    loops, and a room lives in the loop its connections run in."""
    loop = asyncio.get_running_loop()
    found = _rooms.get(loop)
    if found is None:
        found = _rooms[loop] = make_rooms()
    return found


def nudge_all() -> None:
    """A session ended, an account was blocked or deleted: every live connection is checked again at once."""
    for each in list(_rooms.values()):
        each.nudge()


async def shutdown() -> None:
    """At a stop: every room folded, every connection told to come back (NOTES-12 EC-7). Only this loop's own: the
    tests run several apps at once (a second client, a real server), and one stopping must not cancel what waits in
    another's loop (from another thread, too)."""
    loop = asyncio.get_running_loop()
    for task in list(_leaving):
        if task.get_loop() is loop:
            task.cancel()
    found = _rooms.pop(loop, None)
    if found is not None:
        await found.shutdown()


# --- Changes through the room -------------------------------------------------------------------------------------


async def change(note_id: str, edit: Callable[[Any], Any], account_id: int | None = None,
                 rescue: Callable[[Any, Any], None] | None = None) -> Any:
    """A change by the server. A locked note takes none (``note_locked``, NOTES-16 EC-3): MCP, nexdeck, a suggested
    title, a copy or a restored version never read or write what the device encrypted."""
    await asyncio.to_thread(_refuse_locked, note_id)
    return await rooms().change(note_id, edit, account_id=account_id, rescue=rescue)


async def read_live(note_id: str) -> tuple[str, str]:
    """The title and plain text as they are now: from the open room, or the stored document."""
    return await change(note_id, lambda doc: (notedoc.title_of(doc), to_plain(doc)))


# --- Making notes -------------------------------------------------------------------------------------------------


def _folder_for(db: Session, account: Account, folder_id: str | None) -> Folder:
    if not folder_id:
        return inbox_for(db, account.id)
    folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
    if folder is None or folder.owner_id != account.id or folder.deleted_at is not None:
        raise error("folder_not_found", "The folder does not exist.", 404)
    return folder


def _valid_id(note_id: str | None) -> str:
    if note_id is None:
        return str(uuid.uuid4())
    try:
        return str(uuid.UUID(note_id))
    except (ValueError, AttributeError, TypeError):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"]) from None


def create(db: Session, account: Account, *, note_id: str | None = None, folder_id: str | None = None,
           title: str | None = None, markdown: str | None = None, origin: str = "",
           title_suggested: bool = False) -> tuple[Note, bool]:
    """A new note; returns it and whether it is new. The same ``note_id`` twice gives the same note (a double click,
    a request sent again, NOTES-3 EC-9).

    A note made without typing (``markdown`` without ``title``, or a title that is only a suggestion such as a page's
    title) gets a suggested title and "Titel prüfen" (AC-10)."""
    wanted = _valid_id(note_id)
    existing = db.get(Note, wanted)
    if existing is not None:
        if existing.owner_id != account.id:
            raise error("note_id_taken", "This note id is taken.", 409)
        return existing, False
    folder = _folder_for(db, account, folder_id)
    if markdown is not None and len(markdown) > s.MAX_MARKDOWN:
        raise error("too_large", "The request is too large.", 413)
    body = from_markdown(markdown) if markdown else None
    clean = notedoc.clean_title(title)
    check = False
    if body is not None and not clean:
        clean = suggest_title(to_plain(body))
        check = bool(clean)
    elif clean and title_suggested:
        check = True
    document = notedoc.new_doc(clean, body)
    now = utcnow()
    note = Note(id=wanted, owner_id=account.id, folder_id=folder.id, title=clean, title_check=check,
                origin=(origin or "")[:100], ydoc=document.get_update(), text=to_plain(document), created_at=now,
                updated_at=now, updated_by_id=account.id, paper=default_paper(account))
    db.add(note)
    _written(db, note)
    try:
        db.commit()
    except IntegrityError:
        # The same id at the same moment from a second request: the first one made it.
        db.rollback()
        existing = db.get(Note, wanted)
        if existing is None or existing.owner_id != account.id:
            raise error("note_id_taken", "This note id is taken.", 409) from None
        return existing, False
    logger.info("Note created note=%s", note.id)
    return note, True


#: The papers a note can be written on (NOTES-3 AC-17); the first is the default.
PAPERS: tuple[str, ...] = ("blank", "lined", "grid", "dots")


def check_paper(paper: str) -> str:
    if paper not in PAPERS:
        raise error("paper_unknown", "Choose blank, lined, grid or dots.", 422)
    return paper


def default_paper(account: Account) -> str:
    """The paper new notes of the account start on ("My account", Appearance); blank unless it chose another."""
    chosen = (account.preferences or {}).get("paper") if isinstance(account.preferences, dict) else None
    return chosen if chosen in PAPERS else PAPERS[0]


def set_paper(db: Session, account: Account, note_id: str, paper: str) -> Note:
    """Only who may write the note; every open editor follows within seconds (it reads the head again)."""
    check_paper(paper)
    note = note_for(db, account, note_id, write=True)
    note.paper = paper
    db.commit()
    return note


def set_icon(db: Session, account: Account, note_id: str, icon: str) -> Note:
    """The symbol before the title (NOTES-3 AC-18), from the same list as the folders'; empty takes it away. Only who
    may write the note; open editors follow within seconds (they read the head again)."""
    from .symbols import SYMBOLS

    if icon and icon not in SYMBOLS:
        raise error("note_icon_unknown", "Choose a symbol from the list.", 422)
    note = note_for(db, account, note_id, write=True)
    note.icon = icon
    db.commit()
    return note


def copy_suffix(account: Account) -> str:
    language = (account.language or account.browser_language or "en").split("-")[0].lower()
    return COPY_SUFFIX.get(language, COPY_SUFFIX["en"])


def copy_title(title: str, suffix: str) -> str:
    """``title (Kopie)``, the title shortened so that the whole stays within ``MAX_TITLE``."""
    room = s.MAX_TITLE - len(suffix) - 1
    base = title[:room].rstrip() if len(title) > room else title
    return f"{base} {suffix}".strip()


async def duplicate(account: Account, note_id: str) -> Note:
    """A copy in the same folder with "(Kopie)" after the title (NOTES-3 AC-7): the text as it is now, a new document
    with its own history. The copy is the copier's own: from a folder of somebody else (a note shared with them,
    NOTES-13) it goes into the copier's inbox, never into the other's folder."""

    def read(doc: Any) -> tuple[str, dict[str, Any]]:
        return notedoc.title_of(doc), notedoc.to_json(doc)

    with SessionLocal() as db:
        source = note_for(db, account, note_id)
        if source.locked:
            # The server cannot read a locked note to copy it (NOTES-16).
            raise error("note_locked", "The note is locked.", 409)
        folder_id = source.folder_id
        origin = source.origin
        # The copy keeps the paper and the symbol of its original (NOTES-3 AC-17, AC-18).
        paper = source.paper or PAPERS[0]
        icon = source.icon or ""
    title, body = await change(note_id, read)
    title = copy_title(title, copy_suffix(account))
    document = notedoc.new_doc(title, body)
    with SessionLocal() as db:
        folder = db.get(Folder, folder_id) if folder_id else None
        if folder is None or folder.owner_id != account.id:
            folder_id = inbox_for(db, account.id).id
        now = utcnow()
        note = Note(owner_id=account.id, folder_id=folder_id, title=title, origin=origin,
                    ydoc=document.get_update(), text=to_plain(document), created_at=now, updated_at=now,
                    updated_by_id=account.id, paper=paper, icon=icon)
        db.add(note)
        _written(db, note)
        db.commit()
        logger.info("Note duplicated note=%s copy=%s", note_id, note.id)
        return note


# --- Titles from outside the editor -------------------------------------------------------------------------------


async def set_title(account: Account, note_id: str, title: str) -> Note:
    """A title the member gave (a client without a live connection): the document and the column; "Titel prüfen"
    goes."""
    clean = notedoc.clean_title(title)
    with SessionLocal() as db:
        note = note_for(db, account, note_id, write=True)
        note.title = clean
        if clean:
            note.title_check = False
        _written(db, note)
        db.commit()
        locked = note.locked
    if locked:
        # The title of a locked note stays readable (NOTES-16 AC-6): the column only; the device writes the rest.
        return _fresh(note_id)
    await change(note_id, lambda doc: notedoc.set_title(doc, clean), account_id=account.id)
    return _fresh(note_id)


async def suggest(note_id: str, title: str | None = None, *, confirmed: bool = False) -> str:
    """The suggested title (given, or from the first words) into the column, then into the document as a change of
    the server. With "Titel prüfen" unless the person ``confirmed`` it, having seen it (NOTES-3 AC-9, AC-10). Empty
    when there is nothing to suggest."""
    with SessionLocal() as db:
        if busy(db, note_id):
            return ""
    if title is None:
        _, text = await read_live(note_id)
        title = suggest_title(text)
    clean = notedoc.clean_title(title)
    if not clean:
        return ""
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None:
            return ""
        note.title = clean
        note.title_check = not confirmed
        note.updated_at = utcnow()
        _written(db, note)
        db.commit()
    await change(note_id, lambda doc: notedoc.set_title(doc, clean))
    logger.info("Title suggested note=%s confirmed=%s", note_id, confirmed)
    return clean


def title_ok(db: Session, account: Account, note_id: str) -> Note:
    note = note_for(db, account, note_id, write=True)
    note.title_check = False
    db.commit()
    return note


# --- Deleting -----------------------------------------------------------------------------------------------------


async def delete_note(account: Account, note_id: str) -> None:
    """Into the trash (NOTES-15 brings the trash page): gone from every list, everyone who has it open is told
    (NOTES-12 EC-2)."""
    with SessionLocal() as db:
        note = note_for(db, account, note_id, write=True)
        if note.owner_id != account.id:
            raise error("not_found", "Not found.", 404)
        note.deleted_at = utcnow()
        # A mark of its own: bringing its folder back (NOTES-4) does not bring back a note deleted alone before.
        note.deleted_batch = str(uuid.uuid4())
        db.commit()
    await rooms().close_note(note_id)
    logger.info("Note deleted note=%s", note_id)


def restore(db: Session, account: Account, note_id: str) -> Note:
    """Back from the trash ("Rückgängig", NOTES-3 AC-6)."""
    note = note_for(db, account, note_id, write=True, deleted=True)
    if note.owner_id != account.id:
        raise error("not_found", "Not found.", 404)
    note.deleted_at = None
    note.deleted_batch = None
    folder = db.get(Folder, note.folder_id)
    if folder is None or folder.deleted_at is not None:
        # Its folder went to the trash meanwhile: the note comes back into the inbox.
        note.folder_id = inbox_for(db, account.id).id
    db.commit()
    logger.info("Note restored note=%s", note_id)
    return note


def _remove_for_good(note_id: str) -> None:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is not None:
            db.delete(note)
            db.commit()


async def discard_if_empty(note_id: str) -> bool:
    """A note without title and text goes without a trace (NOTES-3 EC-4); True when it went. A note that holds only
    an attachment (NOTES-10) is not empty. A locked note is never empty: the server cannot know (NOTES-16)."""
    with SessionLocal() as db:
        if busy(db, note_id):
            return False
    title, text, attached = await change(
        note_id, lambda doc: (notedoc.title_of(doc), to_plain(doc), notedoc.attachment_refs(doc)))
    if title or text.strip() or attached:
        return False
    await rooms().close_note(note_id)
    await asyncio.to_thread(_remove_for_good, note_id)
    logger.info("Empty note discarded note=%s", note_id)
    return True


async def after_last_left(note_id: str, grace: float | None = None) -> None:
    """The last connection left a note. If nobody is back after the grace: an empty note goes (EC-4), one with text
    but no title gets the suggestion with "Titel prüfen" (AC-10: a tab closed without a title)."""
    await asyncio.sleep(LEAVE_GRACE if grace is None else grace)
    if rooms().room_of(note_id) is not None:
        return
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None or note.deleted_at is not None or note.title or busy(db, note_id):
            return
    try:
        if not await discard_if_empty(note_id):
            await suggest(note_id)
    except notedoc.FormatError:
        return
    except Exception:
        # A task nobody awaits: without this its failure (a database lock that did not end) would vanish unseen.
        logger.exception("Tidying a note after the last one left failed note=%s", note_id)


def schedule_after_leave(note_id: str) -> None:
    task = asyncio.create_task(after_last_left(note_id))
    _leaving.add(task)
    task.add_done_callback(_leaving.discard)


# --- Reading ------------------------------------------------------------------------------------------------------


def _fresh(note_id: str) -> Note:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        return note


def preview(text: str) -> str:
    return " ".join((text or "").split())[:PREVIEW_CHARS]


def list_notes(db: Session, account: Account, folder_id: str | None = None) -> list[Note]:
    query = select(Note).where(Note.owner_id == account.id, Note.deleted_at.is_(None))
    if folder_id:
        query = query.where(Note.folder_id == folder_id)
    return list(db.scalars(query.order_by(Note.updated_at.desc(), Note.id)))


def folder_path(db: Session, folder_id: str) -> list[Folder]:
    """The folders from the top down to the note's own."""
    path: list[Folder] = []
    seen: set[str] = set()
    current = db.get(Folder, folder_id)
    while current is not None and current.id not in seen and len(path) < 64:
        seen.add(current.id)
        path.append(current)
        current = db.get(Folder, current.parent_id) if current.parent_id else None
    return list(reversed(path))


def folder_out(folder: Folder) -> dict[str, Any]:
    return {"id": folder.id, "name": folder.name, "kind": folder.kind, "inbox": folder.kind == FOLDER_INBOX}


def person(db: Session, account_id: int | None) -> dict[str, Any] | None:
    if account_id is None:
        return None
    row = db.get(Account, account_id)
    if row is None:
        return None
    return {"id": row.id, "name": row.display_name or row.name}


# --- Hooks into the frame -----------------------------------------------------------------------------------------


def _count(db: Session, account_id: int) -> content.Counts:
    notes = db.scalar(select(func.count()).select_from(Note)
                      .where(Note.owner_id == account_id, Note.deleted_at.is_(None))) or 0
    size = db.scalar(select(func.coalesce(func.sum(func.length(Note.ydoc)), 0)).where(Note.owner_id == account_id))
    updates = db.scalar(select(func.coalesce(func.sum(func.length(NoteUpdate.update)), 0))
                        .join(Note, Note.id == NoteUpdate.note_id).where(Note.owner_id == account_id))
    return content.Counts(notes=int(notes), shared=0, bytes=int(size or 0) + int(updates or 0))


def _account_went(_db: Session, _account_id: int) -> None:
    nudge_all()


def _drop_old_empty_notes() -> None:
    limit = utcnow() - EMPTY_NOTE_AGE
    with SessionLocal() as db:
        rows = list(db.scalars(select(Note).where(Note.title == "", Note.text == "", Note.updated_at < limit,
                                                  Note.deleted_at.is_(None), Note.locked.is_(False))))
        gone = 0
        for note in rows:
            if db.scalar(select(func.count()).select_from(NoteUpdate).where(NoteUpdate.note_id == note.id)):
                continue
            db.delete(note)
            gone += 1
        if gone:
            db.commit()
            logger.info("Empty notes removed count=%s", gone)


def register() -> None:
    """At every start, each hook once: the note count for the accounts side, a nudge of every live connection when
    sessions end or an account goes, the cleanup of empty notes left behind. Looked up rather than remembered: a hook
    list emptied meanwhile (a test that put its own in) is filled again."""
    from ..security import SESSIONS_ENDED
    from . import cleanup

    if _count not in content._counters:
        content.register_counter(_count)
    if _account_went not in content._deleted:
        content.on_deleted(_account_went)
    if nudge_all not in SESSIONS_ENDED:
        SESSIONS_ENDED.append(nudge_all)
    if all(job is not _drop_old_empty_notes for _, job in cleanup._jobs):
        cleanup.register("empty notes", _drop_old_empty_notes)


