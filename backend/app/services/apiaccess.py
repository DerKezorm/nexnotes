"""Who a program is and what it may touch under ``/api/v1/`` (NOTES-25): the one place every route asks.

A token acts as its account and never sees more (AC-6): the account's own notes and those shared with it, by the same
rules as the interface (``notes.right_to``, ``search.readable``). On top of that a token may be limited to folders of
its account (AC-7): then it sees the notes in those folders and in every folder below them, also folders made later,
and nothing else; a note shared with the account lies in none of its folders and stays out of sight.

What a program may not see answers like what is not there (``not_found``, EC-2). A note in the trash answers
``note_trashed`` (EC-3), a locked one ``note_locked`` to its owner and ``not_found`` to everybody else (EC-7,
NOTES-16). Writing needs a token that may write (``token_reads_only``) and a right to write the note
(``not_allowed``, EC-8).

The same limits hold at ``/api/mcp`` for API tokens that may be used there (``services/mcp.py`` asks ``scope`` and
``in_scope``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, false, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ..models import FOLDER_INBOX, TOKEN_API, TOKEN_DASHBOARD, Account, ApiToken, Folder, Note
from ..models_attachments import Attachment
from ..notedoc.room import Access
from . import apitokens, attachments, notes, search, settings_service, totp
from .inbox import inbox_for

LEVELS = ("read", "write")

#: The answers of the walls, with their status and text.
REFUSALS: dict[str, tuple[int, str]] = {
    "origin_refused": (403, "This API is for programs, not web pages."),
    "api_off": (403, "The operator has switched the API off."),
    "token_invalid": (401, "No valid token."),
    "too_many_attempts": (429, "Too many wrong tokens. Try again later."),
    "slow_down": (429, "Too many requests with this token. Wait a minute."),
    "token_card_only": (403, "This older token is for the nexdeck card only. Make an API token."),
    "token_reads_only": (403, "This token may only read."),
    "not_allowed": (403, "This is shared with you to read only."),
    "not_found": (404, "Not found."),
    "note_trashed": (410, "This note is in the trash."),
    "note_locked": (409, "This note is locked."),
    "note_format": (409, "This note is in a format this server cannot read."),
    "not_owner": (403, "Only the owner of the note may do this."),
    "note_changed": (412, "The note changed since it was read. Read it again."),
    "precondition_required": (428, "Name the state the change is based on: If-Match or base."),
    "too_large": (413, "The request is too large."),
    "invalid_input": (422, "The input is not valid."),
}


class Refused(Exception):
    """A request the API turns away: ``{"detail": {"code", "message"}}`` with the status of its code."""

    def __init__(self, code: str, message: str | None = None, headers: dict[str, str] | None = None,
                 **values: Any) -> None:
        super().__init__(code)
        status, text = REFUSALS[code]
        self.code = code
        self.status = status
        self.message = message or text
        self.headers = headers
        self.values = values


def enabled(db: Session) -> bool:
    """The operator's switch "Programmschnittstelle (API) für Mitglieder" (AC-5), on from the start."""
    return bool(settings_service.get(db, "api_enabled"))


@dataclass
class Caller:
    """The account behind a token, detached from the database, and what the token may."""

    account: Account
    token_id: int
    token_name: str
    kind: str
    level: str
    allow_mcp: bool = False
    folder_ids: list[str] | None = None
    expires_at: datetime | None = None
    _scope: dict[bool, set[str] | None] = field(default_factory=dict, repr=False)

    @property
    def label(self) -> str:
        """How the history and the inbox name the token (``api:<name>``; an older card key ``nexdeck:<name>``)."""
        return f"nexdeck:{self.token_name}" if self.kind == TOKEN_DASHBOARD else f"api:{self.token_name}"

    @property
    def writes(self) -> bool:
        return self.level == "write"

    @property
    def card_only(self) -> bool:
        """An older card key: the five routes of the card, nothing else (AC-3)."""
        return self.kind == TOKEN_DASHBOARD

    @property
    def limited(self) -> bool:
        return self.folder_ids is not None

    def access(self) -> list[str]:
        if self.kind == TOKEN_DASHBOARD:
            return ["card"]
        return ["api", "mcp"] if self.allow_mcp else ["api"]

    def scope(self, db: Session, *, with_trash: bool = False) -> set[str] | None:
        """The folders the token may look into, every one below a chosen one included; ``None`` for all. With
        ``with_trash`` folders in the trash count too (the trash of a limited token)."""
        if self.folder_ids is None:
            return None
        if with_trash not in self._scope:
            self._scope[with_trash] = folder_scope(db, self.account.id, self.folder_ids, with_trash=with_trash)
        return self._scope[with_trash]


def caller_of(account: Account, row: ApiToken) -> Caller:
    folders = row.folder_ids if row.kind == TOKEN_API and row.folder_ids else None
    return Caller(account=account, token_id=row.id, token_name=row.name, kind=row.kind,
                  level=row.level if row.level in LEVELS else "read", allow_mcp=bool(row.allow_mcp),
                  folder_ids=[str(found) for found in folders] if folders is not None else None,
                  expires_at=row.expires_at)


def authenticate(db: Session, token: str | None, kinds: tuple[str, ...]) -> Caller | None:
    """The caller behind a token of one of ``kinds``, or None: unknown, run out, revoked, blocked by the operator,
    the account blocked or deleted, or it still owes the second factor the operator requires (EC-5, EC-9)."""
    found = apitokens.authenticate(db, token, kinds)
    if found is None:
        return None
    account, row = found
    if totp.setup_required(db, account):
        return None
    caller = caller_of(account, row)
    db.expunge(account)
    return caller


# --- The limit to folders (AC-7) ------------------------------------------------------------------------------------


def folder_scope(db: Session, account_id: int, chosen: list[str], *, with_trash: bool = False) -> set[str]:
    """The chosen folders of the account and every folder below them. A chosen folder that is gone (or not the
    account's) counts for nothing."""
    query = select(Folder.id, Folder.parent_id).where(Folder.owner_id == account_id)
    if not with_trash:
        query = query.where(Folder.deleted_at.is_(None))
    rows = db.execute(query).all()
    known = {row.id for row in rows}
    children: dict[str | None, list[str]] = {}
    for row in rows:
        children.setdefault(row.parent_id, []).append(row.id)
    found: set[str] = set()
    todo = [folder_id for folder_id in chosen if folder_id in known]
    while todo:
        current = todo.pop()
        if current in found:
            continue
        found.add(current)
        todo.extend(children.get(current, []))
    return found


def valid_folders(db: Session, account: Account, wanted: list[str]) -> list[str] | None:
    """The folders a new token is limited to, checked: the account's own and alive (``inbox`` for its inbox), each
    once, in the order chosen; None when one is not."""
    out: list[str] = []
    for raw in wanted:
        folder_id = raw.strip()
        if folder_id.lower() == "inbox":
            folder_id = inbox_for(db, account.id).id
            db.commit()
        folder = db.get(Folder, folder_id) if 0 < len(folder_id) <= 36 else None
        if folder is None or folder.owner_id != account.id or folder.deleted_at is not None:
            return None
        if folder.id not in out:
            out.append(folder.id)
    return out


def scope_clause(db: Session, caller: Caller) -> ColumnElement[bool]:
    """Notes in the token's folders, or every note for a token without a limit."""
    found = caller.scope(db)
    if found is None:
        return true()
    return Note.folder_id.in_(sorted(found)) if found else false()


def in_scope(db: Session, caller: Caller, folder_id: str | None) -> bool:
    found = caller.scope(db)
    return found is None or (folder_id is not None and folder_id in found)


def visible_notes(db: Session, caller: Caller) -> ColumnElement[bool]:
    """Every note the token may see, alive: the account's own and those shared with it, within its folders."""
    return and_(search.readable(caller.account), scope_clause(db, caller))


# --- One note, one folder, one attachment ---------------------------------------------------------------------------


def note(db: Session, caller: Caller, note_id: str, *, write: bool = False) -> tuple[Note, Access]:
    """The note when the token may read it (and write it, with ``write``), with the account's right; ``Refused``
    otherwise, and nothing of the note goes out with it."""
    found = db.get(Note, note_id) if isinstance(note_id, str) and 0 < len(note_id) <= 36 else None
    if found is None or not in_scope(db, caller, found.folder_id):
        raise Refused("not_found")
    if found.locked or notes.busy(db, found.id):
        # Locked notes are the owner's alone; anybody else does not even learn that it is locked.
        raise Refused("note_locked" if found.owner_id == caller.account.id else "not_found")
    access = notes.access_to(db, caller.account, found)
    if access == Access.GONE:
        raise Refused("note_trashed")
    if access not in (Access.READ, Access.WRITE):
        raise Refused("not_found")
    if write:
        if not caller.writes:
            raise Refused("token_reads_only")
        if access != Access.WRITE:
            raise Refused("not_allowed")
    return found, access


def folder(db: Session, caller: Caller, folder_id: str, *, write: bool = False, own: bool = False) -> Folder:
    """A folder the token may look into (``inbox`` names the account's inbox): the account's own or one shared with
    it, within the token's folders. ``own``: the account's own only (making, renaming, moving, deleting folders and
    moving notes are the owner's, NOTES-4); one shared with it answers like one that is not there."""
    wanted = folder_id.strip()
    if wanted.lower() == "inbox":
        wanted = inbox_for(db, caller.account.id).id
        db.commit()
    found = db.get(Folder, wanted) if 0 < len(wanted) <= 36 else None
    right = notes.folder_right(db, caller.account, found)
    if found is None or right not in (Access.READ, Access.WRITE) or not in_scope(db, caller, found.id):
        raise Refused("not_found")
    if own and found.owner_id != caller.account.id:
        raise Refused("not_found")
    if write:
        if not caller.writes:
            raise Refused("token_reads_only")
        if right != Access.WRITE:
            raise Refused("not_allowed")
    return found


def trashed_note(db: Session, caller: Caller, note_id: str) -> Note:
    """A note to bring back from the trash: one the account may write, within the token's folders as they were."""
    if not caller.writes:
        raise Refused("token_reads_only")
    found = db.get(Note, note_id) if isinstance(note_id, str) and 0 < len(note_id) <= 36 else None
    scope = caller.scope(db, with_trash=True)
    if found is None or (scope is not None and found.folder_id not in scope):
        raise Refused("not_found")
    if notes.right_to(db, caller.account, found) != Access.WRITE:
        raise Refused("not_found")
    return found


def trashed_folder(db: Session, caller: Caller, folder_id: str) -> Folder:
    if not caller.writes:
        raise Refused("token_reads_only")
    found = db.get(Folder, folder_id) if 0 < len(folder_id) <= 36 else None
    scope = caller.scope(db, with_trash=True)
    if found is None or found.owner_id != caller.account.id or (scope is not None and found.id not in scope):
        raise Refused("not_found")
    return found


def first_folder(db: Session, caller: Caller) -> str | None:
    """Where a new note of a token limited to folders goes when it names none: the first chosen one still there
    (AC-7)."""
    found = caller.scope(db)
    if found is None:
        return None
    for chosen in caller.folder_ids or []:
        if chosen in found:
            return chosen
    raise Refused("not_found")


def attachment(db: Session, caller: Caller, attachment_id: str) -> Attachment:
    """An attachment the token may load: the account may open it (``attachments.readable``), and the note it belongs
    to is one the token may read (in its folders, not locked, not in the trash)."""
    try:
        found = attachments.get_for(db, caller.account, attachment_id)
    except HTTPException as exc:
        raise Refused("not_found") from exc
    note(db, caller, found.note_id)
    return found


def is_inbox(folder_row: Folder | None) -> bool:
    return folder_row is not None and folder_row.kind == FOLDER_INBOX
