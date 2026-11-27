"""What a program writes through the API (NOTES-25 AC-14 to AC-21): new notes, their head, the trash, folders, tags.
Who may write what is ``services/apiaccess.py``; changes of a note's text go through its live room in the router
(``routers/api_v1_write.py``), so that open editors follow at once and nothing typed meanwhile is lost.

Everything goes through the services the interface uses, with the token's account: the same limits, the same rules
for shared notes and folders, the same inbox. A new note carries where it came from (``api:<token name>``).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Folder, Note
from ..models_api import ApiRef
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from . import apiaccess, folders, notes, notes_list, shares
from .apiaccess import Caller, Refused

logger = logging.getLogger("nexnotes.api")


def invalid(*fields: str) -> Refused:
    return Refused("invalid_input", fields=list(fields))


def checked_markdown(text: str | None) -> str:
    """Markdown at most as long as a note takes at once (EC-1): past that ``too_large``, nothing written."""
    text = text or ""
    if len(text) > s.MAX_MARKDOWN:
        raise Refused("too_large", f"A note takes at most {s.MAX_MARKDOWN // 1024} KB of Markdown at once.")
    return text


def checked_title(title: str | None) -> str:
    """A title as the interface takes it, measured after cleaning (one line, blanks joined): past 120 characters
    ``invalid_input`` instead of a title cut off without a word (EC-1)."""
    if title is None:
        return ""
    if len(" ".join(title.split())) > s.MAX_TITLE:
        raise invalid("title")
    return title


def checked_style(icon: str | None, color: str | None, paper: str | None) -> None:
    from .folders import FOLDER_COLORS
    from .symbols import SYMBOLS

    if icon is not None and icon and icon not in SYMBOLS:
        raise invalid("icon")
    if color is not None and color not in ("", *FOLDER_COLORS):
        raise invalid("color")
    if paper is not None and paper not in notes.PAPERS:
        raise invalid("paper")


#: What the folder and tag services answer to input they cannot take, and the field it lies in: the API says these
#: its own way, 422 ``invalid_input`` with ``fields`` (EC-1). Every other answer of a service keeps its code
#: (``folder_name_taken`` 409, ``inbox_fixed`` 400, ``tag_exists`` 409, ``not_found`` 404; ``docs/api.md``).
_INPUT_CODES = {
    "folder_name_missing": "name",
    "folder_name_too_long": "name",
    "folder_target_not_allowed": "parent_id",
    "folder_into_itself": "parent_id",
    "tag_name_invalid": "name",
}


@contextmanager
def service_errors(target: str = "parent_id") -> Iterator[None]:
    """The input errors of a service as ``invalid_input``; ``target``: the field that names where something goes."""
    try:
        yield
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        field = _INPUT_CODES.get(str(detail.get("code")))
        if field is None:
            raise
        raise invalid(target if field == "parent_id" else field) from None


def checked_folder_name(name: str) -> str:
    """A folder name as the interface takes it (at least one visible character, at most 60), else ``invalid_input``."""
    with service_errors():
        folders.checked_name(name)
    return name


def checked_folder_style(icon: str | None, color: str | None) -> None:
    if icon is not None and icon not in ("", *folders.FOLDER_ICONS):
        raise invalid("icon")
    if color is not None:
        try:
            folders.folder_color(color)
        except HTTPException:
            raise invalid("color") from None


# --- New notes (AC-14, EC-13) ---------------------------------------------------------------------------------------


def _by_ref(db: Session, account_id: int, external_ref: str) -> str | None:
    """The note a program made with this reference before, while it is there."""
    return db.scalar(select(ApiRef.note_id).where(ApiRef.account_id == account_id,
                                                  ApiRef.external_ref == external_ref))


def create(caller: Caller, body: Any) -> tuple[str, bool]:
    """A new note; its id and whether it is new. With ``external_ref`` the same request sent again (also at the same
    moment, EC-13) gives the note made the first time."""
    account = caller.account
    markdown = checked_markdown(body.markdown)
    title = checked_title(body.title)
    checked_style(body.icon, body.color, body.paper)
    if not markdown.strip() and not notedoc.clean_title(title):
        raise invalid("markdown", "title")
    ref = body.external_ref.strip() if body.external_ref else ""
    if ref and caller.partner:
        # A connection's references stand apart: it finds again only the notes it made, never one of a program.
        ref = f"verbinden:{caller.partner}:{ref}"
    with SessionLocal() as db:
        if ref:
            found = _by_ref(db, account.id, ref)
            if found is not None:
                return found, False
        target = apiaccess.folder(db, caller, body.folder_id, write=True).id if body.folder_id else (
            apiaccess.first_folder(db, caller))
        note_id = str(uuid.uuid4())
        if ref:
            # Written with the note in one transaction: of two requests at once, one note stays (EC-13).
            db.add(ApiRef(account_id=account.id, external_ref=ref, note_id=note_id))
        try:
            note, _new = notes.create(db, account, note_id=note_id, folder_id=target, title=title or None,
                                      markdown=markdown or None, origin=caller.label)
        except HTTPException as exc:
            db.rollback()
            if ref and isinstance(exc.detail, dict) and exc.detail.get("code") == "note_id_taken":
                found = _by_ref(db, account.id, ref)
                if found is not None:
                    return found, False
            raise
        if body.icon:
            note.icon = body.icon
        if body.color:
            note.color = body.color
        if body.paper:
            note.paper = body.paper
        db.commit()
        if body.pinned:
            notes_list.set_pinned(db, account, note.id, True)
        logger.info("API note made note=%s token_id=%s", note.id, caller.token_id)
        return note.id, True


# --- The head of a note (AC-15) -------------------------------------------------------------------------------------


def _head_plan(db: Session, caller: Caller, note_id: str, body: Any, fields: set[str]) -> tuple[Note, Folder | None]:
    """The note and the folder it goes to, every check of ``change_head`` done, nothing changed."""
    checked_style(body.icon if "icon" in fields else None, body.color if "color" in fields else None,
                  body.paper if "paper" in fields else None)
    writes = bool(fields - {"pinned"})
    note, _access = apiaccess.note(db, caller, note_id, write=writes)
    if not writes and not caller.writes:
        raise Refused("token_reads_only")
    target = None
    if "folder_id" in fields:
        if note.owner_id != caller.account.id:
            raise Refused("not_owner")
        if not body.folder_id:
            raise invalid("folder_id")
        target = apiaccess.folder(db, caller, body.folder_id, write=True, own=True)
    return note, target


def check_head(caller: Caller, note_id: str, body: Any, fields: set[str]) -> None:
    """Whether ``change_head`` would take these fields, without changing anything."""
    with SessionLocal() as db:
        _head_plan(db, caller, note_id, body, fields)


def change_head(caller: Caller, note_id: str, body: Any, fields: set[str]) -> bool:
    """Symbol, color, paper, pinning and folder of a note, all checked before anything changes. Pinning is each
    person's own and needs only the right to read (EC-8); moving is the owner's (``not_owner``). Returns whether
    rights may have changed (moved into or out of a shared folder)."""
    account = caller.account
    with SessionLocal() as db:
        note, target = _head_plan(db, caller, note_id, body, fields)
        if "icon" in fields and body.icon is not None:
            note.icon = body.icon
        if "color" in fields and body.color is not None:
            note.color = body.color
        if "paper" in fields and body.paper is not None:
            note.paper = body.paper
        db.commit()
        if "pinned" in fields and body.pinned is not None:
            notes_list.set_pinned(db, account, note.id, bool(body.pinned))
        moved = False
        if target is not None and target.id != note.folder_id:
            with service_errors(target="folder_id"):
                folders.move(db, account.id, target_id=target.id, folder_ids=[], note_ids=[note.id])
            moved = shares.moves_change_rights(db, account.id)
        logger.info("API note changed note=%s fields=%s token_id=%s", note.id, ",".join(sorted(fields)),
                    caller.token_id)
        return moved


# --- Folders (AC-19) ------------------------------------------------------------------------------------------------


def make_folder(caller: Caller, body: Any) -> dict[str, Any]:
    checked_folder_name(body.name)
    checked_folder_style(body.icon, body.color)
    with SessionLocal() as db:
        parent = None
        if body.parent_id:
            parent = apiaccess.folder(db, caller, body.parent_id, write=True, own=True).id
        elif caller.limited:
            # At the top it would lie outside the token's folders.
            raise invalid("parent_id")
        with service_errors():
            made = folders.create(db, caller.account.id, name=body.name, parent_id=parent, icon=body.icon or "",
                                  color=body.color or "")
        logger.info("API folder made folder=%s token_id=%s", made["id"], caller.token_id)
        return made


def change_folder(caller: Caller, folder_id: str, body: Any, fields: set[str]) -> tuple[dict[str, Any], bool]:
    if "name" in fields and body.name is not None:
        checked_folder_name(body.name)
    checked_folder_style(body.icon if "icon" in fields else None, body.color if "color" in fields else None)
    with SessionLocal() as db:
        found = apiaccess.folder(db, caller, folder_id, write=True, own=True)
        moved = False
        if "parent_id" in fields:
            if body.parent_id:
                target = apiaccess.folder(db, caller, body.parent_id, write=True, own=True).id
            elif caller.limited:
                raise invalid("parent_id")
            else:
                target = None
            if found.kind == "inbox":
                raise HTTPException(status_code=400, detail={
                    "code": "inbox_fixed", "message": "The inbox cannot be renamed, moved or deleted."})
            with service_errors():
                folders.move(db, caller.account.id, target_id=target, folder_ids=[found.id], note_ids=[])
            moved = shares.moves_change_rights(db, caller.account.id)
        with service_errors():
            out = folders.change(db, caller.account.id, found.id, name=body.name if "name" in fields else None,
                                 icon=body.icon if "icon" in fields else None,
                                 color=body.color if "color" in fields else None)
        logger.info("API folder changed folder=%s fields=%s token_id=%s", found.id, ",".join(sorted(fields)),
                    caller.token_id)
        return out, moved


def trash_folder(caller: Caller, folder_id: str) -> dict[str, Any]:
    with SessionLocal() as db:
        found = apiaccess.folder(db, caller, folder_id, write=True, own=True)
        done = folders.trash(db, caller.account.id, found.id)
        logger.info("API folder to the trash folder=%s token_id=%s", found.id, caller.token_id)
        return done


def restore_folder(caller: Caller, folder_id: str) -> dict[str, Any]:
    with SessionLocal() as db:
        found = apiaccess.trashed_folder(db, caller, folder_id)
        done = folders.restore(db, caller.account.id, found.id)
        logger.info("API folder restored folder=%s token_id=%s", found.id, caller.token_id)
        return done


def restore_note(caller: Caller, note_id: str) -> str:
    with SessionLocal() as db:
        found = apiaccess.trashed_note(db, caller, note_id)
        notes.restore(db, caller.account, found.id)
        logger.info("API note restored note=%s token_id=%s", found.id, caller.token_id)
        return found.id
