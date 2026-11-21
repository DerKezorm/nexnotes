"""Smart folders (NOTES-7): saved conditions with a name, shown as a folder.

What a smart folder shows is asked anew whenever it is opened (AC-4): the conditions are the search's
(``search.matching``), over the account's own notes and those shared with it, never the trash. The list it gives is
built like any other list of notes (``notes_list.items``: tags, pictures, shares, the lock), and the way the account
looks at it (rows or tiles, the sort) is kept per smart folder like a folder's (``note_list_views``, key ``s:<id>``).

Changing, renaming or deleting a smart folder never touches a note (AC-6). Deleting is for good: there is nothing in
it to bring back.

Every account gets two of them when it is made (AC-7), whichever way it comes (password, invitation, a provider):
"Offene Checklisten" and "Zuletzt bearbeitet". They carry a ``preset`` and no name, so the interface names them in its
own language until the member renames them; otherwise they are like any other.
"""

from __future__ import annotations

import logging
import unicodedata
from datetime import datetime
from typing import Any

from sqlalchemy import delete, event, func, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, Note, NoteListView, Setting, new_uuid, utcnow
from ..models_smart import SmartFolder
from . import notes_list, search

logger = logging.getLogger("nexnotes.smart")

NAME_MAX = 60
#: How many notes the preview while making one shows (AC-3); the count is of all.
PREVIEW = 20

OPEN_TASKS = "open_tasks"
RECENT = "recent"
#: The two every account gets (AC-7): "Offene Checklisten" and "Zuletzt bearbeitet" (changed in the last 7 days).
PRESETS: dict[str, dict[str, Any]] = {
    OPEN_TASKS: {"match": "all", "conditions": [{"kind": "tasks", "op": "open"}]},
    RECENT: {"match": "all", "conditions": [{"kind": "date", "field": "updated", "period": "week"}]},
}
#: The names the interface gives them, in every language it has: a folder of one's own may not take one (EC-6).
PRESET_NAMES: dict[str, tuple[str, ...]] = {
    OPEN_TASKS: ("Offene Checklisten", "Open checklists"),
    RECENT: ("Zuletzt bearbeitet", "Recently edited"),
}
#: Marks that the accounts from before smart folders got theirs, once.
SEEDED = "smart_folders_seeded"


def now() -> datetime:
    """The moment the periods count from (a test sets the clock here, EC-3)."""
    return utcnow()


def view_key(folder_id: str) -> str:
    """The key of a smart folder's view in ``note_list_views``."""
    return f"s:{folder_id}"


def name_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).strip().casefold()


def _preset_key(preset: str) -> str:
    return f"preset:{preset}"


# --- Reading and writing ------------------------------------------------------------------------------------------


def out(folder: SmartFolder) -> dict[str, Any]:
    return {
        "id": folder.id,
        "name": folder.name,
        "preset": folder.preset,
        "match": folder.match,
        "conditions": folder.conditions or [],
        "position": folder.position,
        "created_at": folder.created_at.isoformat() if folder.created_at else None,
        "updated_at": folder.updated_at.isoformat() if folder.updated_at else None,
    }


def _not_found() -> Exception:
    return error("smart_folder_not_found", "The smart folder does not exist.", 404)


def list_for(db: Session, account: Account) -> list[SmartFolder]:
    """The account's smart folders in their order (AC-8)."""
    return list(db.scalars(select(SmartFolder).where(SmartFolder.owner_id == account.id)
                           .order_by(SmartFolder.position, SmartFolder.created_at, SmartFolder.id)))


def own(db: Session, account: Account, folder_id: str) -> SmartFolder:
    """One of the account's smart folders; ``smart_folder_not_found`` for anything else, another account's too."""
    folder = db.get(SmartFolder, folder_id) if len(folder_id) <= 36 else None
    if folder is None or folder.owner_id != account.id:
        raise _not_found()
    return folder


def _clean_name(raw: str) -> str:
    name = unicodedata.normalize("NFC", raw or "").strip()
    if not name or len(name) > NAME_MAX or any(unicodedata.category(char) in ("Cc", "Cf") for char in name):
        raise error("smart_folder_name_invalid", f"A smart folder needs a name of at most {NAME_MAX} characters.",
                    422, maximum=NAME_MAX)
    return name


def _taken(db: Session, account: Account, key: str, besides: str | None) -> str | None:
    """The name of another smart folder of the account that ``key`` would repeat (EC-6), or ``None``."""
    for folder in list_for(db, account):
        if folder.id == besides:
            continue
        names = (folder.name,) if folder.name else PRESET_NAMES.get(folder.preset, ())
        for name in names:
            if name_key(name) == key:
                return name
    return None


def _check_free(db: Session, account: Account, name: str, besides: str | None = None) -> None:
    """EC-6: the answer names the smart folder there is already, as it is written."""
    taken = _taken(db, account, name_key(name), besides)
    if taken is not None:
        raise error("smart_folder_exists", f"There is already a smart folder named {taken}.", 409, name=taken)


def create(db: Session, account: Account, name: str, match: str, conditions: Any) -> SmartFolder:
    """A new smart folder at the end of the list (AC-1, AC-2, AC-5)."""
    clean = _clean_name(name)
    checked = search.read_conditions(conditions)
    _check_free(db, account, clean)
    last = db.scalar(select(func.max(SmartFolder.position)).where(SmartFolder.owner_id == account.id))
    folder = SmartFolder(owner_id=account.id, name=clean, name_key=name_key(clean), match=_match(match),
                         conditions=checked, position=(last + 1) if last is not None else 0)
    db.add(folder)
    _commit_named(db, clean)
    return folder


def _match(value: str) -> str:
    if value not in search.MATCHES:
        raise error("smart_condition_invalid", "A condition of the smart folder is not valid.", 422, reason="match")
    return value


def _commit_named(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        # The same name from a second device at the same moment.
        db.rollback()
        raise error("smart_folder_exists", f"There is already a smart folder named {name}.", 409, name=name) from None


def update(db: Session, account: Account, folder_id: str, *, name: str | None = None, match: str | None = None,
           conditions: Any = None) -> SmartFolder:
    """Renames it or changes its conditions; the notes stay as they are (AC-6). A folder that came with the account
    keeps its name in the interface's language as long as it is given no other (``name`` empty)."""
    folder = own(db, account, folder_id)
    if name is not None:
        if not name.strip() and folder.preset:
            folder.name, folder.name_key = "", _preset_key(folder.preset)
        else:
            clean = _clean_name(name)
            _check_free(db, account, clean, besides=folder.id)
            folder.name, folder.name_key = clean, name_key(clean)
    if match is not None:
        folder.match = _match(match)
    if conditions is not None:
        folder.conditions = search.read_conditions(conditions)
    folder.updated_at = utcnow()
    _commit_named(db, folder.name or folder.preset)
    return folder


def remove(db: Session, account: Account, folder_id: str) -> None:
    """Gone for good, with the way the account looked at it; not one note changes (AC-6)."""
    folder = own(db, account, folder_id)
    db.execute(delete(NoteListView).where(NoteListView.account_id == account.id,
                                          NoteListView.key == view_key(folder.id)))
    db.delete(folder)
    db.commit()


def reorder(db: Session, account: Account, ids: list[str]) -> list[SmartFolder]:
    """The order the member dragged them into (AC-8); folders not named keep their order after those named."""
    folders = list_for(db, account)
    by_id = {folder.id: folder for folder in folders}
    if len(set(ids)) != len(ids) or any(folder_id not in by_id for folder_id in ids):
        raise _not_found()
    ordered = [by_id[folder_id] for folder_id in ids] + [folder for folder in folders if folder.id not in ids]
    for position, folder in enumerate(ordered):
        folder.position = position
    db.commit()
    return ordered


# --- What a smart folder shows ------------------------------------------------------------------------------------


def _asked(account: Account, tz: str | None) -> search.Asked:
    return search.Asked(account=account, tz=search.zone(tz), now=now())


def _rows(db: Session, where: Any, limit: int | None = None) -> list[Any]:
    statement = select(*notes_list.LIST_COLUMNS).where(where).order_by(*notes_list.NEWEST_FIRST)
    if limit is not None:
        statement = statement.limit(limit)
    return list(db.execute(statement))


def read(db: Session, account: Account, folder_id: str, tz: str | None) -> dict[str, Any]:
    """The notes that fit now, as a list like a folder's (AC-4): the account's view of it, how many own and shared
    ones, the items newest change first; ``broken`` names the conditions that point nowhere (EC-1)."""
    folder = own(db, account, folder_id)
    asked = _asked(account, tz)
    rows = _rows(db, search.matching(db, asked, folder.conditions or [], folder.match))
    mine = sum(1 for row in rows if row.owner_id == account.id)
    key = view_key(folder.id)
    return {
        "key": key,
        "view": notes_list.view_of(db, account, key),
        "counts": {"own": mine, "shared": len(rows) - mine},
        "items": notes_list.items(db, account, rows),
        "folder": out(folder),
        "broken": asked.broken,
    }


def stamp(db: Session, account: Account, folder_id: str, tz: str | None) -> str:
    """Changes whenever the smart folder would show something else: its notes, its conditions, the day."""
    folder = own(db, account, folder_id)
    asked = _asked(account, tz)
    where = search.matching(db, asked, folder.conditions or [], folder.match)
    found = db.execute(select(func.count(), func.max(Note.updated_at), func.max(Note.listed_at)).where(where)).one()
    today = asked.now.astimezone(asked.tz).date().isoformat()
    parts = [str(found[0]), _iso(found[1]), _iso(found[2]), _iso(folder.updated_at), today, str(len(asked.broken))]
    return "|".join(parts)


def _iso(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def preview(db: Session, account: Account, match: str, conditions: Any, tz: str | None) -> dict[str, Any]:
    """What fits the conditions while they are being made, with how many (AC-3)."""
    checked = search.read_conditions(conditions)
    asked = _asked(account, tz)
    where = search.matching(db, asked, checked, _match(match))
    total = int(db.scalar(select(func.count()).select_from(Note).where(where)) or 0)
    return {"total": total, "items": notes_list.items(db, account, _rows(db, where, PREVIEW)),
            "broken": asked.broken}


def save_view(db: Session, account: Account, folder_id: str, wanted: dict[str, Any]) -> dict[str, Any]:
    folder = own(db, account, folder_id)
    return notes_list.save_view_of(db, account, view_key(folder.id), wanted)


# --- The two every account gets (AC-7) ----------------------------------------------------------------------------


def _preset_rows(account_id: int) -> list[dict[str, Any]]:
    made = utcnow()
    return [{"id": new_uuid(), "owner_id": account_id, "name": "", "name_key": _preset_key(preset), "preset": preset,
             "match": spec["match"], "conditions": spec["conditions"], "position": position, "created_at": made,
             "updated_at": made}
            for position, (preset, spec) in enumerate(PRESETS.items())]


@event.listens_for(Account, "after_insert")
def _account_made(_mapper: Any, connection: Any, target: Account) -> None:
    """A new account, whichever way it came: its two smart folders, in the same transaction."""
    connection.execute(insert(SmartFolder), _preset_rows(target.id))


def seed_existing(db: Session) -> int:
    """Accounts from before smart folders get the two once; whoever deleted them later does not get them again."""
    if db.get(Setting, SEEDED) is not None:
        return 0
    have = select(SmartFolder.owner_id)
    ids = list(db.scalars(select(Account.id).where(Account.id.not_in(have))))
    for account_id in ids:
        db.execute(insert(SmartFolder), _preset_rows(account_id))
    db.add(Setting(key=SEEDED, value=True))
    try:
        db.commit()
    except IntegrityError:
        # A second start at the same moment did it.
        db.rollback()
        return 0
    if ids:
        logger.info("Smart folders given to accounts=%s", len(ids))
    return len(ids)
