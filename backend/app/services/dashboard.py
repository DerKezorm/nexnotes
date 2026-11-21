"""What a nexdeck card reads and ticks (NOTES-21), through a key of a member made for it.

A key is a row of ``api_tokens`` with ``kind = dashboard`` and a level: ``read`` shows the card, ``write`` also ticks
checklist items (AC-1). It counts under ``/api/v1/`` only, and there only for the card's data; the other routes take
paired devices, MCP takes its own keys.

The card sees what its member sees (``notes.access_to``: own notes and those shared with the member), never a locked
note (NOTES-16: neither its title nor anything of it, also not among the pinned ones) and never the trash. Ticking goes
through the live room (``notes.change``, NOTES-12): whoever has the note open sees it at once, and an item ticked in
nexnotes at the same moment is ticked too (EC-5). The history names the key (``nexdeck:<key name>``).
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import TOKEN_DASHBOARD, Account, ApiToken, Note, utcnow
from ..models_shares import SharePin
from ..notedoc import doc as notedoc
from ..notedoc import edit
from ..notedoc.markdown import to_plain
from ..notedoc.room import Access
from . import apitokens, notes, notes_list, totp

LEVELS = ("read", "write")
#: Keys an account may hold.
MAX_KEYS = 20
#: Requests one key may make per minute, as the other apps of the family allow.
PER_MINUTE = 600
#: Pinned notes one answer holds at most.
MAX_PINNED = 50
#: Notes the choice of a card lists at most.
MAX_CHOICE = 200
#: Lines of text a card of a note without a checklist gets, and the most characters of one line or item.
MAX_LINES = 30
MAX_LINE = 500
#: Checklist items one answer holds at most.
MAX_ITEMS = 1000


@dataclass
class Caller:
    account: Account
    key_id: int
    key_name: str
    level: str

    @property
    def label(self) -> str:
        """How the history names the key."""
        return f"nexdeck:{self.key_name}"

    @property
    def writes(self) -> bool:
        return self.level == "write"


def authenticate(db: Session, token: str | None) -> Caller | None:
    """The member behind a card's key, or None: no such key, a token of another kind, the account blocked or deleted,
    or it still owes the second factor the operator requires."""
    found = apitokens.authenticate(db, token, (TOKEN_DASHBOARD,))
    if found is None:
        return None
    account, row = found
    if totp.setup_required(db, account):
        return None
    db.expunge(account)
    return Caller(account=account, key_id=row.id, key_name=row.name, level=row.level if row.level in LEVELS else "read")


_calls_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def brake(key_id: int, now: float | None = None) -> bool:
    """True while the key stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[key_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()


# --- Keys -----------------------------------------------------------------------------------------------------------


def key_out(row: ApiToken) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "level": row.level,
        "prefix": row.prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
    }


def keys_of(db: Session, account_id: int) -> list[ApiToken]:
    return list(db.scalars(select(ApiToken).where(ApiToken.account_id == account_id,
                                                  ApiToken.kind == TOKEN_DASHBOARD).order_by(ApiToken.id)))


def count_keys(db: Session, account_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(ApiToken)
                         .where(ApiToken.account_id == account_id, ApiToken.kind == TOKEN_DASHBOARD)) or 0)


# --- What the card reads --------------------------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def stamp_of(note: Note) -> str:
    """Changes with every change a card shows (title, text, items, pinning): nexdeck draws anew only then."""
    return f"{_iso(note.updated_at) or ''}|{_iso(note.listed_at) or ''}"


def first_line(text: str | None) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return " ".join(line.split())[:MAX_LINE]
    return ""


def _owners(db: Session, account: Account, found: list[Note]) -> dict[int, str]:
    strangers = {note.owner_id for note in found if note.owner_id != account.id}
    if not strangers:
        return {}
    return {row.id: row.display_name or row.name
            for row in db.execute(select(Account.id, Account.display_name, Account.name)
                                  .where(Account.id.in_(strangers)))}


def _visible(db: Session, account: Account) -> Any:
    """Notes the card may show: the member's own and those shared with it, alive, never locked."""
    shared = notes_list.shared_ids(db, account)
    mine = Note.owner_id == account.id
    return ((mine | Note.id.in_(shared)) if shared else mine), Note.deleted_at.is_(None), Note.locked.is_not(True)


def pinned(db: Session, account: Account, base: str, limit: int) -> dict[str, Any]:
    """The pinned notes (AC-5): the member's own pinned ones and those of others it pinned for itself, newest change
    first, with title, first line and the progress of their checklists."""
    own = list(db.scalars(select(Note).where(Note.owner_id == account.id, Note.pinned_at.is_not(None),
                                             Note.deleted_at.is_(None), Note.locked.is_not(True))))
    theirs_ids = set(db.scalars(select(SharePin.note_id).where(SharePin.account_id == account.id)))
    if theirs_ids:
        theirs_ids &= notes_list.shared_ids(db, account)
    theirs = list(db.scalars(select(Note).where(Note.id.in_(theirs_ids), Note.deleted_at.is_(None),
                                                Note.locked.is_not(True)))) if theirs_ids else []
    found = sorted(own + theirs, key=lambda note: (note.updated_at or utcnow(), note.id), reverse=True)
    owners = _owners(db, account, found)
    shown = found[:limit]
    out = []
    for note in shown:
        item: dict[str, Any] = {
            "id": note.id,
            "title": note.title,
            "first_line": first_line(note.text),
            "tasks": notes_list.tasks_out(note),
            "updated_at": _iso(note.updated_at),
            "link": f"{base}/notes/{note.id}",
        }
        if note.owner_id != account.id:
            item["owner"] = owners.get(note.owner_id, "")
        out.append(item)
    stamp = "~".join(f"{note.id}:{stamp_of(note)}" for note in shown)
    return {"pinned": out, "more": max(0, len(found) - len(shown)), "link": base, "stamp": stamp,
            "as_of": utcnow().isoformat()}


def choice(db: Session, account: Account, query: str, limit: int) -> list[dict[str, Any]]:
    """The notes a card may be set to (the setting of the card in nexdeck), newest change first, by title."""
    statement = select(Note.id, Note.title, Note.owner_id, Note.tasks_done, Note.tasks_total, Note.updated_at).where(
        *_visible(db, account))
    wanted = query.strip().casefold()
    rows = list(db.execute(statement.order_by(Note.updated_at.desc(), Note.id.desc())))
    if wanted:
        rows = [row for row in rows if wanted in (row.title or "").casefold()]
    rows = rows[:limit]
    owners = {}
    strangers = {row.owner_id for row in rows if row.owner_id != account.id}
    if strangers:
        owners = {row.id: row.display_name or row.name
                  for row in db.execute(select(Account.id, Account.display_name, Account.name)
                                        .where(Account.id.in_(strangers)))}
    out = []
    for row in rows:
        item: dict[str, Any] = {"id": row.id, "title": row.title, "tasks": notes_list.tasks_out(row),
                                "updated_at": _iso(row.updated_at)}
        if row.owner_id != account.id:
            item["owner"] = owners.get(row.owner_id, "")
        out.append(item)
    return out


class CardRefused(Exception):
    """Why a card of one note shows no content (EC-2): ``not_found``, ``note_trashed``, ``note_locked``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def note_for_card(db: Session, account: Account, note_id: str) -> tuple[Note, Access]:
    """The note a card shows and what the member may do with it; ``CardRefused`` with nothing of its content when it
    is locked, in the trash, gone, or no longer shared (EC-2)."""
    note = db.get(Note, note_id) if 0 < len(note_id) <= 36 else None
    if note is not None and note.locked:
        # Locked notes are the owner's alone; anybody else does not even learn that it is locked.
        raise CardRefused("note_locked" if note.owner_id == account.id else "not_found")
    if note is not None and notes.busy(db, note.id):
        raise CardRefused("note_locked" if note.owner_id == account.id else "not_found")
    access = notes.access_to(db, account, note)
    if access == Access.GONE:
        raise CardRefused("note_trashed")
    if access not in (Access.READ, Access.WRITE) or note is None:
        raise CardRefused("not_found")
    return note, access


def read_doc(doc: Any) -> tuple[str, list[edit.Task], str]:
    return notedoc.title_of(doc), edit.list_tasks(doc), to_plain(doc)


def card_of(note: Note, access: Access, caller: Caller, base: str, read: tuple[str, list[edit.Task], str],
            stamp: str) -> dict[str, Any]:
    title, items, plain = read
    done = sum(1 for item in items if item.checked)
    lines = []
    if not items:
        lines = [" ".join(line.split())[:MAX_LINE] for line in plain.splitlines() if line.strip()][:MAX_LINES]
    return {
        "id": note.id,
        "title": title or note.title,
        "link": f"{base}/notes/{note.id}",
        "updated_at": _iso(note.updated_at),
        "can_check": caller.writes and access == Access.WRITE,
        "tasks": {"done": done, "total": len(items)} if items else None,
        "items": [{"index": item.index, "text": item.text[:MAX_LINE], "checked": item.checked, "depth": item.depth}
                  for item in items[:MAX_ITEMS]],
        "more_items": max(0, len(items) - MAX_ITEMS),
        "lines": lines,
        "stamp": stamp,
        "as_of": utcnow().isoformat(),
    }
