"""What the API under ``/api/v1/`` gives out (NOTES-25 AC-8 to AC-13): notes, pages of them, folders, tags, smart
folders, shares, attachments, the trash. Who may see what is ``services/apiaccess.py``; every list here starts from
``apiaccess.visible_notes`` or the token's folders.

Lists come newest change first, a page at a time: ``next_cursor`` is opaque (a base64 offset), ``null`` on the last
page. A locked note shows its title and ``locked: true`` and nothing of its content (EC-7). Times are ISO 8601 in UTC.
"""

from __future__ import annotations

import base64
import binascii
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ..models import Account, Note
from ..models_shares import SharePin
from ..models_tags import NoteTag
from ..notedoc.room import Access
from . import apiaccess, attachments, folders, notes, notes_list, search, shares, smart_folders, tags, trash
from .apiaccess import Caller, Refused, scope_clause, visible_notes

#: A page of notes: 50 from the start as the card had it, at most 500.
PAGE = 50
PAGE_MAX = 500
#: A page of search hits.
SEARCH_PAGE = 20
SEARCH_PAGE_MAX = 100
#: The longest Markdown one answer holds, in bytes of UTF-8; a longer one is cut and says ``truncated`` (EC-1).
MAX_MARKDOWN = 1_000_000
#: The cursor's offset never goes past this.
MAX_OFFSET = 10_000_000


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def cut_markdown(markdown: str) -> tuple[str, bool]:
    """The Markdown an answer holds and whether it was cut (EC-1): at most ``MAX_MARKDOWN`` bytes of UTF-8, cut
    before a character that would not fit whole."""
    data = markdown.encode("utf-8")
    if len(data) <= MAX_MARKDOWN:
        return markdown, False
    return data[:MAX_MARKDOWN].decode("utf-8", errors="ignore"), True


def cursor_out(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def cursor_in(cursor: str | None) -> int:
    """The offset a cursor stands for; a cursor that is not one of ours is ``invalid_input``."""
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        if raw.startswith("o:"):
            offset = int(raw[2:])
            if 0 <= offset <= MAX_OFFSET:
                return offset
    except (ValueError, binascii.Error, UnicodeDecodeError):
        pass
    raise BadInput("cursor")


class BadInput(Exception):
    """A query parameter the API cannot read: 422 ``invalid_input`` with ``fields``."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


# --- Notes ----------------------------------------------------------------------------------------------------------


def _owners(db: Session, account: Account, owner_ids: set[int]) -> dict[int, str]:
    strangers = {owner for owner in owner_ids if owner != account.id}
    if not strangers:
        return {}
    return {row.id: row.display_name or row.name
            for row in db.execute(select(Account.id, Account.display_name, Account.name)
                                  .where(Account.id.in_(strangers)))}


def _labels(db: Session, note_ids: list[str]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    if not note_ids:
        return found
    for note_id, label in db.execute(select(NoteTag.note_id, NoteTag.label).where(NoteTag.note_id.in_(note_ids))):
        found.setdefault(note_id, []).append(label)
    return {note_id: sorted(set(labels), key=str.casefold) for note_id, labels in found.items()}


def _pins(db: Session, account: Account, note_ids: list[str]) -> set[str]:
    """Notes of others the account pinned for itself (NOTES-13: pinning is each person's own)."""
    if not note_ids:
        return set()
    return set(db.scalars(select(SharePin.note_id).where(SharePin.account_id == account.id,
                                                         SharePin.note_id.in_(note_ids))))


def _right(db: Session, account: Account, note: Note) -> str:
    if note.owner_id == account.id:
        return "owner"
    return "write" if notes.right_to(db, account, note) == Access.WRITE else "read"


def notes_out(db: Session, account: Account, rows: list[Note]) -> list[dict[str, Any]]:
    """Notes as every list of the API gives them (AC-8)."""
    labels = _labels(db, [note.id for note in rows if not note.locked])
    pins = _pins(db, account, [note.id for note in rows if note.owner_id != account.id])
    owners = _owners(db, account, {note.owner_id for note in rows})
    out = []
    for note in rows:
        locked = bool(note.locked)
        pinned = note.pinned_at is not None if note.owner_id == account.id else note.id in pins
        item: dict[str, Any] = {
            "id": note.id,
            "title": note.title,
            "icon": note.icon or "",
            "color": note.color or "",
            "paper": note.paper or "blank",
            "folder_id": note.folder_id,
            "tags": [] if locked else labels.get(note.id, []),
            "pinned": pinned,
            "tasks": None if locked else notes_list.tasks_out(note),
            "locked": locked,
            "access": _right(db, account, note),
            "created_at": iso(note.created_at),
            "updated_at": iso(note.updated_at),
        }
        if note.owner_id != account.id:
            item["owner"] = owners.get(note.owner_id, "")
        out.append(item)
    return out


def page_of(db: Session, account: Account, where: list[ColumnElement[bool]], offset: int,
            limit: int) -> dict[str, Any]:
    """One page of the notes ``where`` holds for, newest change first."""
    rows = list(db.scalars(select(Note).where(*where).order_by(Note.updated_at.desc(), Note.id.desc())
                           .offset(offset).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    return {"notes": notes_out(db, account, rows), "next_cursor": cursor_out(offset + limit) if more else None}


def note_filters(db: Session, caller: Caller, *, q: str = "", folder_id: str | None = None, tag: str = "",
                 pinned: bool | None = None, changed_since: datetime | None = None,
                 with_locked: bool = False) -> list[ColumnElement[bool]]:
    """The conditions of ``GET /notes``: what the token sees, then the filters asked for. The route is the card's
    too, and the card's routes leave locked notes out (NOTES-25 EC-7): a program asks for them with ``with_locked``
    (an older card key never gets them)."""
    account = caller.account
    where: list[ColumnElement[bool]] = [visible_notes(db, caller)]
    if caller.card_only or not with_locked:
        where.append(Note.locked.is_not(True))
    if folder_id:
        where.append(Note.folder_id == apiaccess.folder(db, caller, folder_id).id)
    if tag.strip():
        key = search.tag_key(tag)
        if not key:
            raise BadInput("tag")
        where.extend([search.tag_clause(key), Note.locked.is_not(True)])
    if pinned is not None:
        clause = search.pinned_by(account)
        where.append(clause if pinned else ~clause)
    if changed_since is not None:
        since = changed_since if changed_since.tzinfo else changed_since.replace(tzinfo=UTC)
        where.append(Note.updated_at > since.astimezone(UTC))
    wanted = " ".join(q.split()).casefold()
    if wanted:
        # The title only, as the card's choice had it; the full text is ``/search``.
        where.append(func.instr(func.nx_fold(Note.title), search.fold(wanted)) > 0)
    return where


def note_head(db: Session, account: Account, note: Note) -> dict[str, Any]:
    """The fields of ``GET /notes/{id}`` besides the card's (AC-9)."""
    item = notes_out(db, account, [note])[0]
    item.pop("tasks", None)
    item.pop("title", None)
    item.pop("updated_at", None)
    item.pop("id", None)
    return item


# --- Search (AC-10) -------------------------------------------------------------------------------------------------


def _snippet(segments: list[dict[str, Any]]) -> str:
    return "".join(f"«{part['text']}»" if part.get("hit") else str(part.get("text", "")) for part in segments)


def search_page(db: Session, caller: Caller, q: str, *, folder_id: str | None, tag: str, offset: int,
                limit: int) -> dict[str, Any]:
    account = caller.account
    folder_ids: list[str] | None = None
    if folder_id:
        found = apiaccess.folder(db, caller, folder_id)
        if found.owner_id != account.id:
            # Search looks into own folders with their subfolders (NOTES-9 AC-4); a shared one names its notes.
            raise Refused("not_found")
        folder_ids = search.folder_tree(db, account, found.id)
    scope = caller.scope(db)
    if scope is not None:
        folder_ids = sorted(scope if folder_ids is None else scope.intersection(folder_ids))
    tag_key = ""
    if tag.strip():
        tag_key = search.tag_key(tag)
        if not tag_key:
            raise BadInput("tag")
    result = search.search(db, account, q, search.Filters(folder_ids=folder_ids, tag=tag_key), offset=offset,
                           limit=limit)
    locked = set(db.scalars(select(Note.id).where(Note.id.in_([item["id"] for item in result.items]),
                                                  Note.locked.is_(True)))) if result.items else set()
    owners = _owners(db, account, {item["owner_id"] for item in result.items})
    out = []
    for item in result.items:
        hit: dict[str, Any] = {
            "id": item["id"], "title": item["title"], "icon": item["icon"], "color": item["color"],
            "folder": item["folder"], "where": item["where"], "excerpt": item["excerpt"],
            "snippet": _snippet(item["excerpt"]), "attachment": item["attachment"],
            "locked": item["id"] in locked, "created_at": item["created_at"], "updated_at": item["updated_at"],
        }
        if hit["locked"]:
            hit.update(excerpt=[], snippet="", attachment=None)
        if item["owner_id"] != account.id:
            hit["owner"] = owners.get(item["owner_id"], "")
        out.append(hit)
    more = offset + len(result.items) < result.total
    return {"total": result.total, "notes": out, "next_cursor": cursor_out(offset + limit) if more else None}


# --- Folders, tags, smart folders, shares (AC-11) -------------------------------------------------------------------


def folder_tree(db: Session, caller: Caller) -> dict[str, Any]:
    """The inbox, the account's own folders as a tree (symbol, color, number of notes) and the folders others share
    with it, with the right. A token limited to folders sees those only."""
    account = caller.account
    tree = folders.tree(db, account.id)
    scope = caller.scope(db)
    entries = [dict(entry) for entry in tree["folders"] if scope is None or entry["id"] in scope]
    by_id = {entry["id"]: entry for entry in entries}
    roots: list[dict[str, Any]] = []
    for entry in entries:
        entry["children"] = []
    for entry in entries:
        parent = by_id.get(entry["parent_id"]) if entry["parent_id"] else None
        shown = {"id": entry["id"], "name": entry["name"], "icon": entry["icon"], "color": entry["color"],
                 "count": entry["count"], "children": entry["children"]}
        if parent is None:
            roots.append(shown)
        else:
            parent["children"].append(shown)
    inbox = tree["inbox"]
    shared: list[dict[str, Any]] = []
    if scope is None:
        for group in shares.with_me(db, account)["groups"]:
            for item in group["items"]:
                if item["kind"] == "folder":
                    shared.append({"id": item["id"], "name": item["title"], "icon": item["icon"],
                                   "color": item["color"], "count": item.get("notes", 0), "access": item["level"],
                                   "owner": group["owner"]["name"]})
    return {
        "inbox": {"id": inbox["id"], "count": inbox["count"]} if scope is None or inbox["id"] in scope else None,
        "folders": roots,
        "shared_with_me": shared,
    }


def tag_list(db: Session, caller: Caller) -> list[dict[str, Any]]:
    within = None if caller.scope(db) is None else scope_clause(db, caller)
    return [{"name": tag["label"], "count": tag["count"]} for tag in tags.list_tags(db, caller.account, within)]


def _smart_where(db: Session, caller: Caller, folder: Any) -> ColumnElement[bool]:
    asked = search.Asked(account=caller.account, tz=search.zone(None), now=smart_folders.now())
    return search.matching(db, asked, folder.conditions or [], folder.match)


def smart_list(db: Session, caller: Caller) -> list[dict[str, Any]]:
    out = []
    within = scope_clause(db, caller)
    for folder in smart_folders.list_for(db, caller.account):
        count = int(db.scalar(select(func.count()).select_from(Note)
                              .where(_smart_where(db, caller, folder), within)) or 0)
        # The two every account gets have no name of their own until renamed: their English name here (as MCP).
        name = folder.name or smart_folders.PRESET_NAMES.get(folder.preset or "", ("", ""))[1]
        out.append({"id": folder.id, "name": name, "preset": folder.preset or None, "match": folder.match,
                    "icon": folder.icon, "color": folder.color, "conditions": folder.conditions or [],
                    "count": count})
    return out


def smart_page(db: Session, caller: Caller, smart_id: str, offset: int, limit: int) -> dict[str, Any]:
    try:
        folder = smart_folders.own(db, caller.account, smart_id)
    except HTTPException as exc:
        # The feature's own "not found" code, said the API's way.
        raise Refused("not_found") from exc
    return page_of(db, caller.account, [_smart_where(db, caller, folder), scope_clause(db, caller)], offset, limit)


def shared_with_me(db: Session, caller: Caller) -> dict[str, Any]:
    """What others share with the account (F7: read only). A token limited to folders sees none of it."""
    if caller.limited:
        return {"groups": []}
    groups = []
    for group in shares.with_me(db, caller.account)["groups"]:
        items = []
        for item in group["items"]:
            entry = {"kind": item["kind"], "id": item["id"], "title": item["title"], "access": item["level"],
                     "icon": item["icon"], "color": item["color"], "updated_at": item["updated_at"]}
            if item["kind"] == "folder":
                entry["count"] = item.get("notes", 0)
            items.append(entry)
        groups.append({"owner": {"id": group["owner"]["id"], "name": group["owner"]["name"]}, "items": items})
    return {"groups": groups}


# --- Attachments (AC-12), trash (AC-13) -----------------------------------------------------------------------------


def attachments_of(db: Session, caller: Caller, note_id: str) -> list[dict[str, Any]]:
    out = []
    for item in attachments.of_note(db, caller.account, note_id):
        out.append({"id": item["id"], "name": item["name"], "kind": item["kind"], "mime": item["mime"],
                    "size": item["size"], "created_at": item["created_at"],
                    "file": f"/api/v1/attachments/{item['id']}/file"})
    return out


def trash_of(db: Session, caller: Caller) -> dict[str, Any]:
    """The account's own notes and folders in the trash, each with the day it goes for good."""
    listing = trash.listing(db, caller.account)
    scope = caller.scope(db, with_trash=True)
    items = []
    for item in listing["items"]:
        if scope is not None:
            if item["kind"] == "folder" and item["id"] not in scope:
                continue
            origin = item.get("origin") or {}
            if item["kind"] == "note" and origin.get("id") not in scope:
                continue
        items.append({"kind": item["kind"], "id": item["id"], "title": item["title"], "icon": item["icon"],
                      "color": item["color"], "deleted_at": item["deleted_at"], "expires_at": item["expires_at"],
                      "days_left": item["days_left"],
                      "origin_folder_id": (item.get("origin") or {}).get("id"),
                      "notes": item["notes"], "folders": item["folders"]})
    return {"trash_days": listing["trash_days"], "items": items}

