"""Sharing (NOTES-13): notes and folders shared with members to read or to write, "Mit mir geteilt", and links to read
one note without an account.

**One rule, every list.** Whether a member may read a note somebody else owns is decided in one place: a share of the
note itself, or of its folder or any folder above it (AC-2, EC-1), by an owner whose account is not deleted (EC-4; a
blocked owner's shares stay, EC-10), and never a locked note (NOTES-16, ``tags.HIDDEN_NOTES``). The higher of two
rights counts (EC-8). The rule exists twice, once for one note (``note_right``, asked by ``notes.access_to``) and once
as a query of note ids (``shared_select``, for lists, search, tags and the export); ``register`` puts both into every
hook that asks, so no list ever shows what opening refuses or the other way round:

- ``notes.ACCESS_RULES`` and ``notes.FOLDER_RULES`` (opening, writing, the live room, attachments, history, export),
- ``notes_list.SHARED_NOTES`` ("Alle Notizen" and its count), ``tags.SHARED_NOTES`` (tags, search, the export),
- ``notes_list.ITEM_EXTRAS`` and ``notes.HEAD_EXTRAS`` (the shared mark: with whom, or from whom; AC-7),
- ``avatars.SEE_RULES`` (who sees whose picture), the counts of ``content`` and its notice when an owner goes (EC-4).

A right taken or lowered counts at once: every open live connection is checked again (``notes.nudge_all``) and closes
with 4403 or 4409 (AC-5). Only the owner shares; whoever a thing is shared with cannot pass it on (AC-11).

**Read links** (AC-9 to AC-13, EC-5 to EC-7, EC-11): a token of 32 random bytes, kept only as its SHA-256. Opening one
that is not there counts as a miss for the sender's address (``LINK_BRAKE``); after ``LINK_FREE_MISSES`` the page
answers 429 to unknown tokens for a while; a link that exists always gets its page. A link ends with its day in the member's time zone, when it is revoked,
when the note goes to the trash or is locked, when its owner's account goes, and while the operator has switched
read links off (``share_links``). The page itself is ``services/share_page.py``.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, not_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql import Select

from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note
from ..models_shares import LEVELS, READ, WRITE, ReadLink, Share, ShareNotice, SharePin
from ..notedoc.room import Access
from ..security import Brake, account_out
from . import avatars, content, notes, notes_list, settings_service, tags
from .history import clock

logger = logging.getLogger("nexnotes.shares")

#: What a new read link is valid for, in days (AC-9: "ab Werk in 7 Tagen").
LINK_DAYS = 7
#: The latest day a link may run to, in days from today: far, but a date nobody types by mistake.
LINK_MAX_DAYS = 3650
#: Random bytes of a link's token: 256 bits, nothing to guess (EC-7).
TOKEN_BYTES = 32
#: Misses a sender may have before the link page slows it down (EC-7).
LINK_FREE_MISSES = 20
#: Expired links stay in "Mein Konto" for this long, then the cleanup round takes them.
LINK_KEEP_EXPIRED = timedelta(days=30)
#: Kinds of things that are shared.
KINDS = ("note", "folder")


class LinkBrake(Brake):
    """Wrong link addresses per sender (EC-7): a few pass, then each waits longer, as after wrong passwords."""

    FREE = LINK_FREE_MISSES


LINK_BRAKE = LinkBrake()


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


# --- Who may do what ----------------------------------------------------------------------------------------------


def _above(db: Session, folder_id: str | None) -> list[str]:
    """The folder and every folder above it, whatever their state (the same as ``shared_select`` walks down)."""
    found: list[str] = []
    current = folder_id
    while current and current not in found and len(found) < 256:
        found.append(current)
        current = db.scalar(select(Folder.parent_id).where(Folder.id == current))
    return found


def _alive_owners() -> Select[Any]:
    return select(Account.id).where(Account.deleted_at.is_(None))


def _strongest(levels: Iterable[str]) -> Access:
    found = set(levels)
    if WRITE in found:
        return Access.WRITE
    if READ in found:
        return Access.READ
    return Access.NONE


def _hidden(db: Session, note_id: str) -> bool:
    """A locked note (NOTES-16): never shared, whatever was shared before (EC-3)."""
    if not tags.HIDDEN_NOTES:
        return False
    return db.scalar(select(Note.id).where(Note.id == note_id, or_(*(hidden() for hidden in tags.HIDDEN_NOTES)))) \
        is not None


def note_right(db: Session, account_id: int, note: Note) -> Access:
    """What sharing gives ``account_id`` on ``note`` of somebody else: the higher right of a share of the note and of
    its folders (EC-8), NONE for a locked note or one of a deleted owner."""
    if note.owner_id == account_id:
        return Access.NONE
    levels = db.scalars(select(Share.level).where(
        Share.account_id == account_id, Share.owner_id == note.owner_id, Share.owner_id.in_(_alive_owners()),
        or_(Share.note_id == note.id, Share.folder_id.in_(_above(db, note.folder_id)))))
    found = _strongest(levels)
    if found != Access.NONE and _hidden(db, note.id):
        return Access.NONE
    return found


def folder_right(db: Session, account_id: int, folder: Folder) -> Access:
    """What sharing gives ``account_id`` in ``folder`` of somebody else: a share of it or of a folder above it."""
    if folder.owner_id == account_id:
        return Access.NONE
    return _strongest(db.scalars(select(Share.level).where(
        Share.account_id == account_id, Share.owner_id == folder.owner_id, Share.owner_id.in_(_alive_owners()),
        Share.folder_id.in_(_above(db, folder.id)))))


def _access_rule(db: Session, account: Account, note: Note) -> Access | None:
    found = note_right(db, account.id, note)
    return found if found != Access.NONE else None


def _folder_rule(db: Session, account: Account, folder: Folder) -> Access | None:
    found = folder_right(db, account.id, folder)
    return found if found != Access.NONE else None


def shared_folders(account_id: int) -> Any:
    """The folders shared with the account and every folder below them (a recursive query; ``id``, ``owner_id``)."""
    top = (select(Folder.id.label("id"), Folder.owner_id.label("owner_id"))
           .join(Share, Share.folder_id == Folder.id)
           .where(Share.account_id == account_id, Share.owner_id == Folder.owner_id,
                  Share.owner_id.in_(_alive_owners()))
           .cte("shared_tree", recursive=True, nesting=True))
    return top.union(select(Folder.id, Folder.owner_id).join(top, and_(Folder.parent_id == top.c.id,
                                                                       Folder.owner_id == top.c.owner_id)))


def shared_select(account_id: int) -> Select[Any]:
    """The ids of the notes of others shared with the account, as a query (``tags.SHARED_NOTES``): the same rule as
    ``note_right``, in the trash or not (who asks leaves those out)."""
    tree = shared_folders(account_id)
    direct = select(Share.note_id).where(Share.account_id == account_id, Share.note_id.is_not(None),
                                         Share.owner_id == Note.owner_id, Share.owner_id.in_(_alive_owners()))
    in_tree = select(tree.c.id).where(tree.c.owner_id == Note.owner_id)
    return select(Note.id).where(Note.owner_id != account_id, or_(Note.id.in_(direct), Note.folder_id.in_(in_tree)),
                                 *(not_(hidden()) for hidden in tags.HIDDEN_NOTES))


def shared_ids(db: Session, account: Account) -> list[str]:
    """The same as ``shared_select``, as ids (``notes_list.SHARED_NOTES``)."""
    if account_out(account):
        return []
    return list(db.scalars(shared_select(account.id)))


# --- What a list and a head show (AC-7) ----------------------------------------------------------------------------


def _names(db: Session, ids: Iterable[int]) -> dict[int, str]:
    wanted = set(ids)
    if not wanted:
        return {}
    return {row.id: row.display_name or row.name
            for row in db.execute(select(Account.id, Account.display_name, Account.name).where(Account.id.in_(wanted)))}


def _owned_shares(db: Session, owner_id: int) -> list[Share]:
    return list(db.scalars(select(Share).join(Account, Account.id == Share.account_id)
                           .where(Share.owner_id == owner_id, Account.deleted_at.is_(None))))


def _below(db: Session, owner_id: int) -> dict[str | None, list[str]]:
    children: dict[str | None, list[str]] = {}
    for folder_id, parent_id in db.execute(select(Folder.id, Folder.parent_id).where(Folder.owner_id == owner_id)):
        children.setdefault(parent_id, []).append(folder_id)
    return children


def _tree_of(children: dict[str | None, list[str]], root: str) -> set[str]:
    found: set[str] = set()
    todo = [root]
    while todo:
        current = todo.pop()
        if current in found:
            continue
        found.add(current)
        todo.extend(children.get(current, []))
    return found


def people_by_note(db: Session, owner_id: int, rows: Iterable[Any]) -> dict[str, set[int]]:
    """For notes of ``owner_id``: whom each is shared with, directly or through its folders."""
    shares = _owned_shares(db, owner_id)
    if not shares:
        return {}
    by_note: dict[str, set[int]] = {}
    by_folder: dict[str, set[int]] = {}
    children: dict[str | None, list[str]] | None = None
    for share in shares:
        if share.note_id is not None:
            by_note.setdefault(share.note_id, set()).add(share.account_id)
        elif share.folder_id is not None:
            if children is None:
                children = _below(db, owner_id)
            for folder_id in _tree_of(children, share.folder_id):
                by_folder.setdefault(folder_id, set()).add(share.account_id)
    found: dict[str, set[int]] = {}
    for row in rows:
        people = by_note.get(row.id, set()) | by_folder.get(row.folder_id, set())
        if people:
            found[row.id] = people
    return found


def item_extras(db: Session, account: Account, rows: list[Any]) -> dict[str, dict[str, Any]]:
    """``notes_list.ITEM_EXTRAS``: an own note shared carries whom with (``shared``); a note of somebody else the pin
    of this member (each pins for itself)."""
    own = [row for row in rows if row.owner_id == account.id]
    theirs = [row.id for row in rows if row.owner_id != account.id]
    found: dict[str, dict[str, Any]] = {}
    people = people_by_note(db, account.id, own) if own else {}
    names = _names(db, {person for group in people.values() for person in group})
    for note_id, group in people.items():
        found[note_id] = {"shared": {"names": sorted((names.get(person, "") for person in group), key=str.casefold)}}
    if theirs:
        pinned = set(db.scalars(select(SharePin.note_id).where(SharePin.account_id == account.id,
                                                               SharePin.note_id.in_(theirs))))
        for note_id in theirs:
            found.setdefault(note_id, {})["pinned"] = note_id in pinned
    return found


def head_extras(db: Session, account: Account, note: Note) -> dict[str, Any]:
    """``notes.HEAD_EXTRAS``: the owner sees whom the note is shared with; whoever it is shared with sees its right
    and its own pin. ``can_share``: only the owner (AC-11)."""
    if note.owner_id == account.id:
        people = people_by_note(db, account.id, [note]).get(note.id, set())
        names = _names(db, people)
        return {"shared_with": sorted(names.values(), key=str.casefold), "can_share": True}
    pinned = db.get(SharePin, (account.id, note.id)) is not None
    level = note_right(db, account.id, note)
    return {"shared_with": [], "can_share": False, "pinned": pinned,
            "level": WRITE if level == Access.WRITE else READ}


def _pin(db: Session, account: Account, note: Note, pinned: bool | None = None) -> bool:
    """``notes_list.PERSONAL_PIN``: reads (``pinned`` None) or sets the member's own pin of a note of somebody else."""
    row = db.get(SharePin, (account.id, note.id))
    if pinned is None:
        return row is not None
    if pinned and row is None:
        db.add(SharePin(account_id=account.id, note_id=note.id))
    elif not pinned and row is not None:
        db.delete(row)
    return pinned


# --- Sharing with members (AC-1, AC-2, AC-5, AC-6, AC-11, EC-3, EC-9) ------------------------------------------------


def _own(db: Session, account: Account, kind: str, item_id: str) -> Note | Folder:
    """The account's own note or folder, alive; ``not_found`` for anything else: only the owner shares (AC-11)."""
    if kind not in KINDS or len(item_id) > 36:
        raise _not_found()
    model = Note if kind == "note" else Folder
    found = db.get(model, item_id)
    if found is None or found.owner_id != account.id or found.deleted_at is not None or account_out(account):
        raise _not_found()
    return found


def _where(kind: str, item_id: str) -> Any:
    return Share.note_id == item_id if kind == "note" else Share.folder_id == item_id


def person_out(db: Session, row: Account) -> dict[str, Any]:
    return {"id": row.id, "name": row.display_name or row.name, "email": row.email or "",
            "avatar": row.avatar_at.isoformat() if row.avatar_at else None}


def find_people(db: Session, account: Account, query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Members of the server by name or address (AC-1), never the account itself, nobody blocked or deleted. At
    least two characters: the list of members is not handed out whole."""
    text = (query or "").strip().casefold()
    if len(text) < 2:
        return []
    plain = text.replace("\\", "").replace("%", "").replace("_", "")
    like = f"%{plain}%"
    rows = db.scalars(select(Account).where(
        Account.id != account.id, Account.blocked_at.is_(None), Account.deleted_at.is_(None),
        or_(func.nx_fold(Account.display_name).like(like), func.nx_fold(Account.name).like(like),
            func.nx_fold(Account.email).like(like))).order_by(Account.display_name, Account.name).limit(limit))
    return [person_out(db, row) for row in rows]


def _title_of(item: Note | Folder) -> str:
    return item.title if isinstance(item, Note) else item.name


def sharing_of(db: Session, account: Account, kind: str, item_id: str) -> dict[str, Any]:
    """What the dialog shows: the people with their rights, who has it through a folder above, and the read link."""
    item = _own(db, account, kind, item_id)
    rows = list(db.execute(select(Share, Account).join(Account, Account.id == Share.account_id)
                           .where(Share.owner_id == account.id, _where(kind, item.id), Account.deleted_at.is_(None))
                           .order_by(Share.created_at, Share.id)))
    people = [{**person_out(db, person), "level": share.level} for share, person in rows]
    folder_id = item.folder_id if isinstance(item, Note) else item.parent_id
    through: list[dict[str, Any]] = []
    if folder_id:
        above = _above(db, folder_id)
        for share, person, folder in db.execute(
                select(Share, Account, Folder).join(Account, Account.id == Share.account_id)
                .join(Folder, Folder.id == Share.folder_id)
                .where(Share.owner_id == account.id, Share.folder_id.in_(above), Account.deleted_at.is_(None))):
            through.append({**person_out(db, person), "level": share.level, "folder": folder.name})
    out: dict[str, Any] = {"kind": kind, "id": item.id, "title": _title_of(item), "people": people,
                           "through_folder": through,
                           "links": bool(settings_service.get(db, "share_links")) and kind == "note"}
    if kind == "note":
        link = db.scalar(select(ReadLink).where(ReadLink.note_id == item.id))
        out["link"] = link_out(link, item) if link is not None else None
    return out


def _check_shareable(db: Session, item: Note | Folder) -> None:
    if isinstance(item, Folder) and item.kind == FOLDER_INBOX:
        raise error("share_inbox", "The inbox cannot be shared.", 422)
    if isinstance(item, Note) and _hidden(db, item.id):
        raise error("share_locked", "A locked note cannot be shared.", 409)


def set_person(db: Session, account: Account, kind: str, item_id: str, person_id: int, level: str) -> dict[str, Any]:
    """Shares with a member, or changes the right (EC-9: twice is a change, never a second share; never oneself)."""
    item = _own(db, account, kind, item_id)
    if level not in LEVELS:
        raise error("invalid_input", "The input is not valid.", 422, fields=["level"])
    if person_id == account.id:
        raise error("share_self", "You cannot share with yourself.", 422)
    person = db.get(Account, person_id)
    if person is None or account_out(person):
        raise error("person_not_found", "This person is not a member of this server.", 404)
    _check_shareable(db, item)
    row = db.scalar(select(Share).where(Share.account_id == person.id, _where(kind, item.id)))
    lowered = False
    if row is None:
        row = Share(owner_id=account.id, account_id=person.id, level=level,
                    note_id=item.id if kind == "note" else None, folder_id=item.id if kind == "folder" else None)
        db.add(row)
    else:
        lowered = row.level == WRITE and level == READ
        row.level = level
    db.commit()
    if lowered:
        # Writing became reading: open editors start again with the right they have now (AC-5).
        notes.nudge_all()
    logger.info("Shared kind=%s id=%s with=%s level=%s", kind, item.id, person.id, level)
    return sharing_of(db, account, kind, item.id)


def _notice(db: Session, account_id: int, reason: str, kind: str, title: str, owner: Account | None) -> None:
    db.add(ShareNotice(account_id=account_id, reason=reason, kind=kind, title=(title or "")[:120],
                       owner_name=((owner.display_name or owner.name) if owner is not None else "")[:80]))


def _drop_pins(db: Session, account_id: int) -> None:
    """The member's pins of notes no longer shared with it go: none waits for a sharing that may come back."""
    db.execute(delete(SharePin).where(SharePin.account_id == account_id,
                                      SharePin.note_id.not_in(shared_select(account_id))))


def remove_person(db: Session, account: Account, kind: str, item_id: str, person_id: int) -> dict[str, Any]:
    """Ends sharing with a member at once (AC-5): its open editors close, "Mit mir geteilt" says so, its pins of what
    it no longer sees go."""
    item = _own(db, account, kind, item_id)
    row = db.scalar(select(Share).where(Share.account_id == person_id, _where(kind, item.id)))
    if row is not None:
        db.delete(row)
        _notice(db, person_id, "ended", kind, _title_of(item), account)
        db.commit()
        _drop_pins(db, person_id)
        db.commit()
        notes.nudge_all()
        logger.info("Sharing ended kind=%s id=%s with=%s", kind, item.id, person_id)
    return sharing_of(db, account, kind, item.id)


def leave(db: Session, account: Account, kind: str, item_id: str) -> None:
    """The member leaves what was shared with it (AC-6): gone for it, nothing changes for the owner."""
    if kind not in KINDS or len(item_id) > 36:
        raise _not_found()
    row = db.scalar(select(Share).where(Share.account_id == account.id, _where(kind, item_id)))
    if row is None:
        raise _not_found()
    db.delete(row)
    db.commit()
    _drop_pins(db, account.id)
    db.commit()
    notes.nudge_all()
    logger.info("Share left kind=%s id=%s", kind, item_id)


def with_me(db: Session, account: Account) -> dict[str, Any]:
    """"Mit mir geteilt" (AC-3): per owner what each shared, with the right; and the notices of what went (AC-5,
    EC-4). Nothing in the trash, nothing locked, nothing of a deleted owner."""
    rows = list(db.execute(select(Share, Account).join(Account, Account.id == Share.owner_id)
                           .where(Share.account_id == account.id, Account.deleted_at.is_(None))))
    owners: dict[int, dict[str, Any]] = {}
    for share, owner in rows:
        if share.note_id is not None:
            note = db.get(Note, share.note_id)
            if note is None or note.deleted_at is not None or _hidden(db, note.id):
                continue
            item = {"kind": "note", "id": note.id, "title": note.title, "level": share.level,
                    "updated_at": note.updated_at.isoformat() if note.updated_at else None, "icon": note.icon or "",
                    "color": note.color or ""}
        else:
            folder = db.get(Folder, share.folder_id)
            if folder is None or folder.deleted_at is not None:
                continue
            children = _below(db, folder.owner_id)
            inside = _tree_of(children, folder.id)
            count, newest = db.execute(select(func.count(), func.max(Note.updated_at)).where(
                Note.folder_id.in_(inside), Note.deleted_at.is_(None), Note.owner_id == folder.owner_id,
                *(not_(hidden()) for hidden in tags.HIDDEN_NOTES))).one()
            item = {"kind": "folder", "id": folder.id, "title": folder.name, "level": share.level,
                    "notes": int(count or 0), "updated_at": newest.replace(tzinfo=UTC).isoformat() if newest else None,
                    "icon": folder.icon or "", "color": folder.color or ""}
        group = owners.setdefault(owner.id, {"owner": {"id": owner.id, "name": owner.display_name or owner.name,
                                                       "avatar": owner.avatar_at.isoformat()
                                                       if owner.avatar_at else None},
                                             "items": []})
        group["items"].append(item)
    groups = sorted(owners.values(), key=lambda group: group["owner"]["name"].casefold())
    for group in groups:
        group["items"].sort(key=lambda item: (item["kind"] != "folder", item["title"].casefold()))
    notices = [{"id": row.id, "reason": row.reason, "kind": row.kind, "title": row.title, "owner": row.owner_name,
                "at": row.created_at.isoformat()}
               for row in db.scalars(select(ShareNotice).where(ShareNotice.account_id == account.id)
                                     .order_by(ShareNotice.created_at.desc(), ShareNotice.id.desc()).limit(50))]
    return {"groups": groups, "count": sum(len(group["items"]) for group in groups), "notices": notices}


def drop_notice(db: Session, account: Account, notice_id: int) -> None:
    db.execute(delete(ShareNotice).where(ShareNotice.id == notice_id, ShareNotice.account_id == account.id))
    db.commit()


def shared_folder(db: Session, account: Account, folder_id: str) -> dict[str, Any]:
    """A folder shared with the account (or one below it): its name, owner, the right, and the folders in it."""
    folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
    if folder is None or folder.owner_id == account.id:
        raise _not_found()
    level = notes.folder_right(db, account, folder)
    if level not in (Access.WRITE, Access.READ):
        raise _not_found()
    owner = db.get(Account, folder.owner_id)
    subfolders = [{"id": row.id, "name": row.name, "icon": row.icon or "", "color": row.color or ""}
                  for row in db.scalars(select(Folder).where(Folder.parent_id == folder.id,
                                                             Folder.deleted_at.is_(None)).order_by(Folder.name))]
    return {"id": folder.id, "name": folder.name, "icon": folder.icon or "", "color": folder.color or "",
            "level": WRITE if level == Access.WRITE else READ,
            "owner": {"id": folder.owner_id, "name": (owner.display_name or owner.name) if owner else ""},
            "folders": subfolders}


def move_check(db: Session, account: Account, note_ids: list[str], target_id: str | None) -> list[dict[str, Any]]:
    """EC-2: the account's notes that would stop being shared with somebody when moved into ``target_id`` (its inbox
    when empty), because they are shared through their folder now and the target is not shared with that person."""
    from .inbox import inbox_for

    target = target_id or inbox_for(db, account.id).id
    rows = list(db.scalars(select(Note).where(Note.id.in_(note_ids[:500]), Note.owner_id == account.id,
                                              Note.deleted_at.is_(None))))
    if not rows:
        return []
    shares = [share for share in _owned_shares(db, account.id) if share.folder_id is not None]
    if not shares:
        return []
    children = _below(db, account.id)
    by_folder: dict[str, set[int]] = {}
    for share in shares:
        for folder_id in _tree_of(children, share.folder_id):
            by_folder.setdefault(folder_id, set()).add(share.account_id)
    keeps = by_folder.get(target, set())
    found = []
    for note in rows:
        losing = by_folder.get(note.folder_id, set()) - keeps
        if losing:
            found.append({"id": note.id, "title": note.title,
                          "people": sorted(_names(db, losing).values(), key=str.casefold)})
    return found


def moves_change_rights(db: Session, account_id: int) -> bool:
    """Whether moving the account's folders and notes may change who reaches them (AC-5): a folder shared by it or
    with it. Moving into or out of such a folder gives or takes rights; without one nothing changes for anybody."""
    return db.scalar(select(Share.id).where(Share.folder_id.is_not(None),
                                            or_(Share.owner_id == account_id, Share.account_id == account_id))
                     .limit(1)) is not None


def lock_refused(db: Session, note_id: str) -> bool:
    """EC-3, for locking a note (NOTES-16): a note shared with somebody (itself or through a folder) or with a read link
    cannot be locked; sharing has to end first."""
    note = db.get(Note, note_id)
    if note is None:
        return False
    if db.scalar(select(ReadLink.id).where(ReadLink.note_id == note.id)) is not None:
        return True
    above = _above(db, note.folder_id)
    return db.scalar(select(Share.id).where(Share.owner_id == note.owner_id,
                                            or_(Share.note_id == note.id, Share.folder_id.in_(above))).limit(1)) \
        is not None


# --- Read links (AC-9, AC-10, AC-12, AC-13, EC-5, EC-6, EC-7) ---------------------------------------------------------


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


#: How far a clock on earth is off UTC at most.
_MAX_OFFSET = timedelta(hours=14)


def _end_of(day: date, ends_at: datetime | None) -> tuple[datetime, timedelta]:
    """When the link stops: the first moment after ``day`` where the member is. The browser sends that moment
    (``ends_at``, its own midnight; no list of time zones needed on the server); without it, midnight in UTC. Returns
    it in UTC with the member's offset from UTC."""
    midnight = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=UTC)
    if ends_at is None:
        return midnight, timedelta(0)
    if ends_at.tzinfo is None:
        raise error("invalid_input", "The input is not valid.", 422, fields=["ends_at"])
    end = ends_at.astimezone(UTC)
    offset = midnight - end
    if abs(offset) > _MAX_OFFSET:
        raise error("invalid_input", "The input is not valid.", 422, fields=["ends_at"])
    return end, offset


def _check_day(day: date, offset: timedelta) -> None:
    today = (clock.now().astimezone(UTC) + offset).date()
    if day <= today:
        raise error("link_expiry_too_soon", "A link runs at least until tomorrow.", 422)
    if day > today + timedelta(days=LINK_MAX_DAYS):
        raise error("link_expiry_too_late", "Choose an earlier date.", 422)


def _links_on(db: Session) -> bool:
    return bool(settings_service.get(db, "share_links"))


def link_out(link: ReadLink, note: Note | None = None, token: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": link.id, "note_id": link.note_id, "expires_on": link.expires_on,
                           "expires_at": link.expires_at.isoformat(), "created_at": link.created_at.isoformat(),
                           "expired": link.expires_at <= clock.now()}
    if note is not None:
        out["title"] = note.title
    if token is not None:
        # Shown once: only its hash is kept.
        out["path"] = f"/l/{token}"
    return out


def make_link(db: Session, account: Account, note_id: str, day: date, ends_at: datetime | None = None
              ) -> dict[str, Any]:
    """A new link to read the note (AC-9), replacing the one before (which stops working). Only the owner, only
    while the operator allows links (AC-10), never for a locked note."""
    if not _links_on(db):
        raise error("share_links_off", "Read links are switched off on this server.", 403)
    note = _own(db, account, "note", note_id)
    assert isinstance(note, Note)
    _check_shareable(db, note)
    end, offset = _end_of(day, ends_at)
    _check_day(day, offset)
    token = secrets.token_urlsafe(TOKEN_BYTES)
    link = db.scalar(select(ReadLink).where(ReadLink.note_id == note.id))
    if link is None:
        link = ReadLink(note_id=note.id, owner_id=account.id, token_hash=hash_token(token), expires_on=day.isoformat(),
                        expires_at=end, created_at=clock.now())
        db.add(link)
    else:
        link.token_hash = hash_token(token)
        link.expires_on = day.isoformat()
        link.expires_at = end
        link.created_at = clock.now()
    db.commit()
    logger.info("Read link made note=%s until=%s", note.id, day.isoformat())
    return link_out(link, note, token)


def _own_link(db: Session, account: Account, link_id: int) -> ReadLink:
    link = db.get(ReadLink, link_id)
    if link is None or link.owner_id != account.id:
        raise _not_found()
    return link


def change_link(db: Session, account: Account, link_id: int, day: date, ends_at: datetime | None = None
                ) -> dict[str, Any]:
    """Another last day for a link (AC-9); the address stays."""
    link = _own_link(db, account, link_id)
    end, offset = _end_of(day, ends_at)
    _check_day(day, offset)
    link.expires_on = day.isoformat()
    link.expires_at = end
    db.commit()
    return link_out(link, db.get(Note, link.note_id))


def revoke_link(db: Session, account: Account, link_id: int) -> None:
    """The link stops working at once (AC-9, AC-13, EC-5)."""
    link = _own_link(db, account, link_id)
    db.delete(link)
    db.commit()
    logger.info("Read link revoked note=%s", link.note_id)


def my_links(db: Session, account: Account) -> list[dict[str, Any]]:
    """"Mein Konto": every read link of the account with its note and its last day (AC-13)."""
    rows = db.execute(select(ReadLink, Note).join(Note, Note.id == ReadLink.note_id)
                      .where(ReadLink.owner_id == account.id).order_by(ReadLink.expires_at))
    return [{**link_out(link, note), "note_gone": note.deleted_at is not None} for link, note in rows]


def resolve(db: Session, token: str) -> tuple[ReadLink | None, Note | None, bool]:
    """The link of a token and its note when it works now; and whether the token was known at all (an unknown one is
    a miss for the brake, EC-7). Nothing of a link that ended: expired or revoked (EC-5), switched off (AC-10), its
    note in the trash or locked (EC-6), its owner deleted (EC-4)."""
    link = db.scalar(select(ReadLink).where(ReadLink.token_hash == hash_token(token)))
    if link is None:
        return None, None, False
    if not _links_on(db) or link.expires_at <= clock.now():
        return None, None, True
    note = db.get(Note, link.note_id)
    owner = db.get(Account, link.owner_id)
    if note is None or note.deleted_at is not None or owner is None or owner.deleted_at is not None \
            or note.owner_id != link.owner_id or _hidden(db, note.id):
        return None, None, True
    return link, note, True


def _drop_old_links() -> None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        gone = db.execute(delete(ReadLink).where(ReadLink.expires_at < clock.now() - LINK_KEEP_EXPIRED))
        db.commit()
        if getattr(gone, "rowcount", 0):
            logger.info("Expired read links removed count=%s", gone.rowcount)


# --- The accounts side -----------------------------------------------------------------------------------------------


def _count(db: Session, account_id: int) -> content.Counts:
    """How many notes and folders the account shares (the question before deleting it)."""
    shared = db.scalar(select(func.count(func.distinct(func.coalesce(Share.note_id, Share.folder_id))))
                       .where(Share.owner_id == account_id)) or 0
    return content.Counts(shared=int(shared))


def _owner_went(db: Session, account_id: int) -> None:
    """EC-4: what the deleted account shared disappears for everyone, each hears so in "Mit mir geteilt". The shares
    stay while the operator can bring the account back; with it they come back."""
    owner = db.get(Account, account_id)
    for share in db.scalars(select(Share).where(Share.owner_id == account_id)):
        item = db.get(Note, share.note_id) if share.note_id else db.get(Folder, share.folder_id)
        if item is None:
            continue
        _notice(db, share.account_id, "owner_gone", "note" if share.note_id else "folder", _title_of(item), owner)
    db.commit()
    notes.nudge_all()


def sees(db: Session, viewer: Account, other_id: int) -> bool:
    """``avatars.SEE_RULES``: the people of a share see each other's picture: owner and member, and the members of
    the same owner's shares (they meet in the same notes, NOTES-12 AC-5)."""
    between = select(Share.id).where(or_(and_(Share.owner_id == viewer.id, Share.account_id == other_id),
                                         and_(Share.owner_id == other_id, Share.account_id == viewer.id)))
    if db.scalar(between.limit(1)) is not None:
        return True
    mine = select(Share.owner_id).where(Share.account_id == viewer.id)
    return db.scalar(select(Share.id).where(Share.account_id == other_id, Share.owner_id.in_(mine)).limit(1)) \
        is not None


def register() -> None:
    """At every start, each hook once, looked up rather than remembered (a test may have emptied a list)."""
    from . import cleanup

    if _access_rule not in notes.ACCESS_RULES:
        notes.ACCESS_RULES.append(_access_rule)
    if _folder_rule not in notes.FOLDER_RULES:
        notes.FOLDER_RULES.append(_folder_rule)
    if head_extras not in notes.HEAD_EXTRAS:
        notes.HEAD_EXTRAS.append(head_extras)
    if shared_ids not in notes_list.SHARED_NOTES:
        notes_list.SHARED_NOTES.append(shared_ids)
    if item_extras not in notes_list.ITEM_EXTRAS:
        notes_list.ITEM_EXTRAS.append(item_extras)
    if _pin not in notes_list.PERSONAL_PIN:
        notes_list.PERSONAL_PIN.append(_pin)
    if shared_select not in tags.SHARED_NOTES:
        tags.SHARED_NOTES.append(shared_select)
    if sees not in avatars.SEE_RULES:
        avatars.SEE_RULES.append(sees)
    if _count not in content._counters:
        content.register_counter(_count)
    if _owner_went not in content._deleted:
        content.on_deleted(_owner_went)
    if all(job is not _drop_old_links for _, job in cleanup._jobs):
        cleanup.register("read links", _drop_old_links)


register()
