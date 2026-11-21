"""What a nexdeck card reads and ticks (NOTES-21) under ``/api/v1/`` (``routers/api_v1.py``).

The card sees what its member sees (own notes and those shared with the member), never a locked note (NOTES-16:
neither its title nor anything of it, also not among the pinned ones) and never the trash. Ticking goes through the
live room (``notes.change``, NOTES-12): whoever has the note open sees it at once, and an item ticked in nexnotes at
the same moment is ticked too (EC-5). The history names the token (``nexdeck:<name>`` for an older card key,
``api:<name>`` for an API token, NOTES-25).

Who may call, and which note, is ``services/apiaccess.py``; the rate ``services/apibrake.py``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, Note, utcnow
from ..models_shares import SharePin
from ..notedoc import doc as notedoc
from ..notedoc import edit
from ..notedoc.markdown import to_plain
from ..notedoc.room import Access
from . import apibrake, notes_list

#: Pinned notes one answer holds at most.
MAX_PINNED = 50
#: Lines of text a card of a note without a checklist gets, and the most characters of one line. An item is shortened
#: as for MCP (``edit.shown_task_text``), so that ticking with the text shown finds it.
MAX_LINES = 30
MAX_LINE = 500
#: Checklist items one answer holds at most.
MAX_ITEMS = 1000


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


def pinned(db: Session, account: Account, base: str, limit: int, scope: set[str] | None = None) -> dict[str, Any]:
    """The pinned notes (AC-5): the member's own pinned ones and those of others it pinned for itself, newest change
    first, with title, first line and the progress of their checklists. ``scope``: the folders an API token is
    limited to (NOTES-25 AC-7)."""
    own = list(db.scalars(select(Note).where(Note.owner_id == account.id, Note.pinned_at.is_not(None),
                                             Note.deleted_at.is_(None), Note.locked.is_not(True))))
    theirs_ids = set(db.scalars(select(SharePin.note_id).where(SharePin.account_id == account.id)))
    if theirs_ids:
        theirs_ids &= notes_list.shared_ids(db, account)
    theirs = list(db.scalars(select(Note).where(Note.id.in_(theirs_ids), Note.deleted_at.is_(None),
                                                Note.locked.is_not(True)))) if theirs_ids else []
    if scope is not None:
        own = [note for note in own if note.folder_id in scope]
        theirs = [note for note in theirs if note.folder_id in scope]
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


def read_doc(doc: Any) -> tuple[str, list[edit.Task], str]:
    return notedoc.title_of(doc), edit.list_tasks(doc), to_plain(doc)


def card_of(note: Note, access: Access, writes: bool, base: str, read: tuple[str, list[edit.Task], str],
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
        "can_check": writes and access == Access.WRITE,
        "tasks": {"done": done, "total": len(items)} if items else None,
        "items": [{"index": item.index, "text": edit.shown_task_text(item.text), "checked": item.checked,
                   "depth": item.depth}
                  for item in items[:MAX_ITEMS]],
        "more_items": max(0, len(items) - MAX_ITEMS),
        "lines": lines,
        "stamp": stamp,
        "as_of": utcnow().isoformat(),
    }


def forget() -> None:
    """The rate of every token starts afresh (tests)."""
    apibrake.forget()
