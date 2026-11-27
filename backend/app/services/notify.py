"""Notifications (NOTES-14): somebody changed a shared note, and the members who asked for it hear so, bundled.

**The switch** (AC-1) is per account at a note or a folder, off from the start (no row). A folder's switch holds for
every note and folder below it; the nearest switch counts, so one note can be off inside a folder that is on. It can
be set only for what is shared (a note or folder of one's own that is shared, or one shared with one).

**What is a change** (AC-2, AC-4): every update stored for a note with an account (``notes.UPDATE_HOOKS``, the same
place the history learns who wrote) and a note put in the trash (``notes.TRASHED_HOOKS``, EC-7). Changes of the server
itself (a suggested title) name nobody and tell nobody. A person never hears of their own changes, whichever device or
MCP key made them: they are all the same account.

**Bundling** (AC-3): the first change of a quiet note keeps the note's lines as they were (``notify_baselines``);
every change widens the writer's row in ``notify_edits``. Once nobody wrote for ``QUIET`` (two minutes), the ticker
compares the lines then and now: lines that came (``+ Eier``) and checklist items that were ticked (``✓ Milch``), and
sends one notification per member, naming everybody else who wrote (EC-6) and cutting the list short. A note written
without a pause is bundled at the latest after ``LONGEST``.

**Who hears it**, decided when the bundle goes, not before: a member whose nearest switch is on, who did not write
alone, whose account is neither blocked nor deleted, and who may still read the note (``notes.right_to``, so a share
that ended counts at once, EC-5, and a locked note of somebody else is out). A locked note (``tags.HIDDEN_NOTES``,
NOTES-16) tells nothing of its content, only that it was changed (EC-1). A browser that has the note open and in view
right now gets nothing (AC-9, ``viewing``). Before every try to send, the first and each after a failure, the right
and the lock are asked again (``_still_for``): a message for somebody who lost the right meanwhile, or one with
content of a note locked meanwhile, is dropped. Locking a note (``lock_changed``) removes what waits of it at once.

**Where it goes**: every browser of the member that allowed notifications (Web Push, ``services/webpush.py``) and every
iOS device signed up for them (the push relay, ``services/apppush.py``). Each message is a row of ``notify_outbox``,
sent at once and tried again after a failure for a while (EC-2); a browser or ticket its service calls gone is
dropped (EC-4). Both ways carry the text only encrypted for the receiver: the push service and the relay see that
something goes, never what (AC-6), and of the note only a keyed hash of its id (``opaque``), never the id.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..errors import error
from ..models import Account, AuthSession, Folder, Note, NoteUpdate
from ..models_notify import NotifyBaseline, NotifyEdit, NotifyOutbox, NotifyWatch, PushDevice, WebPushSubscription
from ..models_shares import Share
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from ..notedoc.room import Access
from ..security import account_out, server_key
from . import apppush, notes, tags, webpush
from .history import clock

logger = logging.getLogger("nexnotes.notify")

#: Hex characters of the mark the relay and the push services get instead of a note's id (AC-6): 96 bits.
OPAQUE_CHARS = 24


class _Refused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


#: A bundle goes once nobody wrote for this long (AC-3) ...
QUIET = timedelta(minutes=2)
#: ... or at the latest after this long of writing without such a pause.
LONGEST = timedelta(minutes=30)
#: How often the ticker looks.
TICK_SECONDS = 15
#: Minutes to wait after the 1st, 2nd, ... failure; after the last one the message is given up (EC-2).
RETRY_MINUTES = (1, 5, 15, 60)
#: Sent and given-up messages stay this long (without their text), then go.
KEEP = timedelta(days=7)
#: Messages one round sends at most; the rest follow in the next.
BATCH = 100
#: How long a browser's word "I show this note" holds; the page repeats it while it shows the note (AC-9).
VIEWING_FOR = timedelta(seconds=75)
#: What a notification names at most: items of the list, characters of one item, characters of the whole text.
MAX_ITEMS = 4
ITEM_CHARS = 40
TEXT_CHARS = 160

#: The texts of a notification, by the receiver's language; any other language gets the English ones.
TEXTS: dict[str, dict[str, str]] = {
    "de": {
        "title": "{names} in „{note}“",
        "untitled": "Ohne Titel",
        "changed": "hat etwas geändert",
        "changed_many": "haben etwas geändert",
        "locked": "wurde geändert",
        "more": "und {count} weitere",
        "trashed": "{names} hat „{note}“ in den Papierkorb gelegt",
        "and": " und ",
        "probe_title": "Probemeldung von nexnotes",
        "probe_text": "So kommen Mitteilungen in diesem Browser an.",
    },
    "en": {
        "title": "{names} in “{note}”",
        "untitled": "Untitled",
        "changed": "made changes",
        "changed_many": "made changes",
        "locked": "was changed",
        "more": "and {count} more",
        "trashed": "{names} moved “{note}” to the trash",
        "and": " and ",
        "probe_title": "Test notification from nexnotes",
        "probe_text": "This is how notifications arrive in this browser.",
    },
}

#: Blocks with text the browser's editor counts one by one (ProseMirror's text blocks): the place a notification opens
#: at is the index among them (AC-5).
TEXT_BLOCKS = frozenset({s.PARAGRAPH, s.HEADING, s.CODE_BLOCK})


# --- Lines and what changed -----------------------------------------------------------------------------------------


def lines_of(document: Any) -> list[list[Any]]:
    """``[[text, checked], ...]`` of a note's body, one per text block in the order of the text; ``checked`` is
    ``True``/``False`` for the first line of a checklist item, ``None`` elsewhere."""
    source = notedoc.to_json(document) if not isinstance(document, dict) else document
    out: list[list[Any]] = []

    def walk(nodes: list[dict[str, Any]], checked: bool | None) -> None:
        for node in nodes:
            kind = node.get("type")
            if kind in TEXT_BLOCKS:
                text = "".join(" " if child.get("type") == s.HARD_BREAK else str(child.get("text") or "")
                               for child in node.get("content") or [])
                out.append([" ".join(text.split()), checked])
                checked = None
            elif kind == s.TASK_ITEM:
                walk(node.get("content") or [], bool((node.get("attrs") or {}).get("checked")))
            else:
                walk(node.get("content") or [], None)

    walk(source.get("content") or [], None)
    return out


def changes(before: list[list[Any]], after: list[list[Any]]) -> tuple[list[tuple[str, str]], int | None]:
    """What came (``+``) and what was ticked (``✓``) between two states, in the order of the text, and the index of
    the first such line in ``after`` (where the note opens, AC-5)."""
    left = Counter(text for text, _checked in before if text)
    ticked_before = Counter(text for text, checked in before if text and checked is True)
    open_before = Counter(text for text, checked in before if text and checked is False)
    ticked_after: Counter[str] = Counter()
    found: list[tuple[str, str]] = []
    first: int | None = None
    for index, (text, checked) in enumerate(after):
        if not text:
            continue
        if left[text] > 0:
            left[text] -= 1
            if checked is True:
                ticked_after[text] += 1
                if ticked_after[text] > ticked_before[text] and open_before[text] > 0:
                    open_before[text] -= 1
                    found.append(("✓", text))
                    first = index if first is None else first
            continue
        found.append(("+", text))
        first = index if first is None else first
    return found, first


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def summary(items: list[tuple[str, str]], language: str) -> str:
    """``+ Eier, + Butter, ✓ Milch``, at most ``MAX_ITEMS`` and ``TEXT_CHARS``, the rest counted (EC-6)."""
    texts = TEXTS.get(language, TEXTS["en"])
    shown: list[str] = []
    length = 0
    for mark, text in items:
        part = f"{mark} {_cut(text, ITEM_CHARS)}"
        if len(shown) >= MAX_ITEMS or length + len(part) + 2 > TEXT_CHARS:
            break
        shown.append(part)
        length += len(part) + 2
    out = ", ".join(shown)
    rest = len(items) - len(shown)
    if rest > 0:
        out = f"{out} {texts['more'].format(count=rest)}" if out else texts["more"].format(count=rest)
    return out


def language_of(account: Account) -> str:
    code = (account.language or account.browser_language or "en").split("-")[0].lower()
    return code if code in TEXTS else "en"


def _names(db: Session, ids: list[int], language: str) -> str:
    rows = {row.id: row.display_name or row.name for row in db.scalars(select(Account).where(Account.id.in_(ids)))}
    names = [rows[account_id] for account_id in ids if account_id in rows]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + TEXTS[language]["and"] + names[-1]


#: Characters of the line a notification names as the place of the change (``anchor``, NOTESIOS-15 AC-3).
ANCHOR_CHARS = 80


def message(db: Session, receiver: Account, note: Note, writers: list[int], items: list[tuple[str, str]],
            at: int | None, *, locked: bool, trashed_by: int | None, line: str = "") -> dict[str, Any]:
    """The notification for one receiver, in their language: title, text, and where a tap leads (AC-2, AC-5). For the
    app also whose it is (``account``; ``server`` comes with ``apppush.plaintext``), who and which note apart
    (``who``, ``note``: the app lock shows only these, NOTESIOS-15 AC-7) and the place (``anchor``: the index of the
    text block and its line, never of a locked note)."""
    language = language_of(receiver)
    texts = TEXTS[language]
    title = note.title or texts["untitled"]
    url = f"/notes/{note.id}"
    if trashed_by is not None:
        names = _names(db, [trashed_by], language)
        return {"title": _cut(title, 100), "text": texts["trashed"].format(names=names, note=_cut(title, 60)),
                "note_id": note.id, "at": None, "url": "/trash", "type": "trashed", "locked": locked,
                "account": receiver.id, "who": names, "note": title, "anchor": None}
    names = _names(db, writers, language)
    if locked:
        text = texts["locked"]
        at = None
    else:
        text = summary(items, language) or texts["changed" if len(writers) == 1 else "changed_many"]
    if at is not None:
        url += f"?change={at}"
    anchor = {"block": at, "text": _cut(line, ANCHOR_CHARS)} if at is not None else None
    return {"title": _cut(texts["title"].format(names=names, note=_cut(title, 60)), 140), "text": text,
            "note_id": note.id, "at": at, "url": url, "type": "changed", "locked": locked,
            "account": receiver.id, "who": names, "note": title, "anchor": anchor}


# --- The switch ---------------------------------------------------------------------------------------------------


def _path_ids(db: Session, folder_id: str | None) -> list[str]:
    """The folder and every folder above it, nearest first."""
    if not folder_id:
        return []
    return [folder.id for folder in reversed(notes.folder_path(db, folder_id))]


def _nearest(db: Session, account_id: int, note_id: str | None, path: list[str]) -> tuple[bool, str | None]:
    """The nearest switch of the account: on or off, and the folder it comes from (``None``: the note's own, or
    none at all)."""
    if note_id is not None:
        own = db.scalar(select(NotifyWatch.on).where(NotifyWatch.account_id == account_id,
                                                     NotifyWatch.note_id == note_id))
        if own is not None:
            return bool(own), None
    if not path:
        return False, None
    rows = dict(db.execute(select(NotifyWatch.folder_id, NotifyWatch.on).where(
        NotifyWatch.account_id == account_id, NotifyWatch.folder_id.in_(path))).all())
    for folder_id in path:
        if folder_id in rows:
            return bool(rows[folder_id]), folder_id
    return False, None


def _owner_shared(db: Session, owner_id: int, note_id: str | None, path: list[str]) -> bool:
    """Something of ``owner_id`` is shared with somebody alive: the note itself or a folder on its path."""
    conditions = []
    if note_id is not None:
        conditions.append(Share.note_id == note_id)
    if path:
        conditions.append(Share.folder_id.in_(path))
    if not conditions:
        return False
    return db.scalar(select(Share.id).join(Account, Account.id == Share.account_id)
                     .where(Share.owner_id == owner_id, Account.deleted_at.is_(None), or_(*conditions))
                     .limit(1)) is not None


def note_shared(db: Session, account: Account, note: Note) -> bool:
    if note.owner_id != account.id:
        return notes.right_to(db, account, note) in (Access.READ, Access.WRITE)
    return _owner_shared(db, account.id, note.id, _path_ids(db, note.folder_id))


def folder_shared(db: Session, account: Account, folder: Folder) -> bool:
    if folder.owner_id != account.id:
        return notes.folder_right(db, account, folder) in (Access.READ, Access.WRITE)
    return _owner_shared(db, account.id, None, _path_ids(db, folder.id))


def _folder_for(db: Session, account: Account, folder_id: str) -> Folder:
    folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
    if notes.folder_right(db, account, folder) not in (Access.READ, Access.WRITE):
        raise error("not_found", "Not found.", 404)
    assert folder is not None
    return folder


def _state(db: Session, account: Account, note_id: str | None, path: list[str], shared: bool) -> dict[str, Any]:
    on, through = _nearest(db, account.id, note_id, path)
    via = None
    if through is not None:
        folder = db.get(Folder, through)
        via = {"id": through, "name": folder.name if folder is not None else ""}
    return {"on": on, "via": via, "shared": shared}


def devices_of(db: Session, account: Account, session_id: int | None) -> dict[str, Any]:
    """Where the account's notifications arrive (AC-8): its iOS devices and its browsers, and whether this browser
    is one of them."""
    apps = _apps_of(db, account)
    browsers = []
    this_browser = False
    for row in webpush.subscriptions(db, account.id):
        browser, system = webpush.describe(row.user_agent)
        mine = session_id is not None and row.session_id == session_id
        this_browser = this_browser or mine
        browsers.append({"id": row.id, "browser": browser, "system": system, "this": mine,
                         "since": row.created_at.isoformat() if row.created_at else None,
                         "last_ok_at": row.last_ok_at.isoformat() if row.last_ok_at else None})
    return {"apps": apps, "browsers": browsers, "this_browser": this_browser}


#: The kinds of the notes' notifications on an iOS device (module geraete): one of them on, the device counts as on.
APP_KINDS = ("changed", "trashed")


def _apps_of(db: Session, account: Account) -> list[dict[str, Any]]:
    """The account's iOS devices signed up for notifications as the sending sees them (``_enqueue_devices``): a
    blocked one is not there, and one with every kind switched off in the app shows as off."""
    from ..vendor.nexgeraete import push
    from .geraete_config import CONFIG
    from .geraete_store import GeraeteStore

    store = GeraeteStore(db)
    holder = store.holder(account.id)
    apps = []
    for _row, token in apppush.devices(db, account.id):
        device = store.device(token.id)
        if device is None:
            continue
        on = holder is not None and not holder.out and device.push is not None and any(
            push.understood(CONFIG, device, kind) and push.wanted(CONFIG, device, holder, kind) for kind in APP_KINDS)
        apps.append({"id": token.id, "name": token.name, "on": on})
    return apps


def probe(db: Session, account: Account, row: WebPushSubscription) -> None:
    """A test notification to one of the account's browsers at once (plan E34, the page Notifications): its title and
    line in the account's language, opening the page it came from. Raises ``webpush.Gone`` or ``webpush.Failed``."""
    import json

    texts = TEXTS[language_of(account)]
    body = {"title": texts["probe_title"], "body": texts["probe_text"], "url": "/settings/notifications",
            "tag": "probe"}
    webpush.deliver(db, row, json.dumps(body, ensure_ascii=False).encode("utf-8"), topic="probe")
    row.last_ok_at = clock.now()
    db.commit()
    logger.info("Test notification sent account_id=%s", account.id)


def preview(db: Session, account: Account, title: str) -> dict[str, str]:
    """How a notification looks (AC-8), in the account's language, with a made-up change."""
    language = language_of(account)
    example = {"de": [("+", "Eier"), ("+", "Butter")], "en": [("+", "Eggs"), ("+", "Butter")]}[language]
    name = {"de": "Anna", "en": "Anna"}[language]
    texts = TEXTS[language]
    return {"title": texts["title"].format(names=name, note=_cut(title or texts["untitled"], 60)),
            "text": summary(example, language)}


def note_settings(db: Session, account: Account, note_id: str, session_id: int | None) -> dict[str, Any]:
    note = notes.note_for(db, account, note_id)
    shared = note_shared(db, account, note)
    return {**_state(db, account, note.id, _path_ids(db, note.folder_id), shared), "kind": "note", "id": note.id,
            "devices": devices_of(db, account, session_id), "preview": preview(db, account, note.title)}


def folder_settings(db: Session, account: Account, folder_id: str, session_id: int | None) -> dict[str, Any]:
    folder = _folder_for(db, account, folder_id)
    shared = folder_shared(db, account, folder)
    path = _path_ids(db, folder.id)
    on, through = _nearest(db, account.id, None, path)
    via = None
    if through is not None and through != folder.id:
        above = db.get(Folder, through)
        via = {"id": through, "name": above.name if above is not None else ""}
    return {"on": on, "via": via, "shared": shared, "kind": "folder", "id": folder.id,
            "devices": devices_of(db, account, session_id), "preview": preview(db, account, folder.name)}


def _put(db: Session, account_id: int, column: Any, item_id: str, on: bool, inherited: bool) -> None:
    """The account's switch at one thing: a row only where it differs from what comes from above (the note inside a
    folder that is on needs no row of its own to be on)."""
    db.execute(delete(NotifyWatch).where(NotifyWatch.account_id == account_id, column == item_id))
    if on != inherited:
        values = {"account_id": account_id, "on": on, "created_at": clock.now(), column.key: item_id}
        db.execute(insert(NotifyWatch).values(**values))
    db.commit()


def set_note(db: Session, account: Account, note_id: str, on: bool, session_id: int | None = None) -> dict[str, Any]:
    note = notes.note_for(db, account, note_id)
    if not note_shared(db, account, note):
        raise error("notify_not_shared", "Notifications are for shared notes and folders.", 409)
    inherited, _ = _nearest(db, account.id, None, _path_ids(db, note.folder_id))
    _put(db, account.id, NotifyWatch.note_id, note.id, on, inherited)
    logger.info("Notifications switched note=%s on=%s", note.id, on)
    return note_settings(db, account, note.id, session_id)


def set_folder(db: Session, account: Account, folder_id: str, on: bool,
               session_id: int | None = None) -> dict[str, Any]:
    folder = _folder_for(db, account, folder_id)
    if not folder_shared(db, account, folder):
        raise error("notify_not_shared", "Notifications are for shared notes and folders.", 409)
    inherited, _ = _nearest(db, account.id, None, _path_ids(db, folder.parent_id))
    _put(db, account.id, NotifyWatch.folder_id, folder.id, on, inherited)
    logger.info("Notifications switched folder=%s on=%s", folder.id, on)
    return folder_settings(db, account, folder.id, session_id)


def head_extras(db: Session, account: Account, note: Note) -> dict[str, Any]:
    """``notes.HEAD_EXTRAS``: whether the bell is on for this note (the head shows it pressed)."""
    on, _ = _nearest(db, account.id, note.id, _path_ids(db, note.folder_id))
    return {"notify": on}


# --- Recording changes --------------------------------------------------------------------------------------------


def _candidates(db: Session, note: Note, path: list[str]) -> list[int]:
    """Accounts with a switch on at the note or a folder above it (whether it is their nearest is asked later)."""
    conditions = [NotifyWatch.note_id == note.id]
    if path:
        conditions.append(NotifyWatch.folder_id.in_(path))
    return list(db.scalars(select(NotifyWatch.account_id).where(NotifyWatch.on.is_(True), or_(*conditions))
                           .distinct()))


def _lines_now(db: Session, note_id: str, *, but_last: bool = False) -> list[list[Any]]:
    """The note's lines as they are stored, or (``but_last``) as they were before its newest stored update, the one
    the hook was called for."""
    found = db.execute(select(Note.ydoc).where(Note.id == note_id)).first()
    if found is None:
        return []
    updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id)
                              .order_by(NoteUpdate.id)))
    try:
        return lines_of(notedoc.load(found.ydoc or None, updates[:-1] if but_last else updates))
    except notedoc.FormatError:
        return []


def _locked(db: Session, note_id: str) -> bool:
    """A locked note (NOTES-16): nothing of its content in a notification (EC-1)."""
    if not tags.HIDDEN_NOTES:
        return False
    return db.scalar(select(Note.id).where(Note.id == note_id, or_(*(hidden() for hidden in tags.HIDDEN_NOTES)))) \
        is not None


def _widen(db: Session, note_id: str, account_id: int) -> None:
    now = clock.now()
    statement = insert(NotifyEdit).values(note_id=note_id, account_id=account_id, first_at=now, last_at=now)
    db.execute(statement.on_conflict_do_update(index_elements=[NotifyEdit.note_id, NotifyEdit.account_id],
                                               set_={"last_at": statement.excluded.last_at}))


def record_change(db: Session, note_id: str, account_id: int | None) -> None:
    """``notes.UPDATE_HOOKS``: an update of ``account_id`` was stored. Only for notes somebody else may want to hear
    of; the first change of a bundle keeps the lines from before it."""
    if account_id is None:
        return
    if db.get(NotifyBaseline, note_id) is None:
        # Nobody anywhere wants notifications: nothing to look up for this keystroke.
        if db.scalar(select(NotifyWatch.id).where(NotifyWatch.on.is_(True)).limit(1)) is None:
            return
        note = db.get(Note, note_id)
        if note is None:
            return
        others = [found for found in _candidates(db, note, _path_ids(db, note.folder_id)) if found != account_id]
        if not others:
            return
        lines = [] if _locked(db, note_id) else _lines_now(db, note_id, but_last=True)
        db.execute(insert(NotifyBaseline).values(note_id=note_id, lines=lines, taken_at=clock.now())
                   .on_conflict_do_nothing(index_elements=[NotifyBaseline.note_id]))
    _widen(db, note_id, account_id)


def record_trash(note_id: str, account_id: int) -> None:
    """``notes.TRASHED_HOOKS``: the note went to the trash (EC-7). It goes out with the next bundle, so "Rückgängig"
    right after takes it back before anybody hears of it."""
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None:
            return
        others = [found for found in _candidates(db, note, _path_ids(db, note.folder_id)) if found != account_id]
        if not others:
            return
        lines = [] if _locked(db, note_id) else _lines_now(db, note_id)
        db.execute(insert(NotifyBaseline).values(note_id=note_id, lines=lines, taken_at=clock.now(),
                                                 trashed_by=account_id)
                   .on_conflict_do_update(index_elements=[NotifyBaseline.note_id],
                                          set_={"trashed_by": account_id}))
        _widen(db, note_id, account_id)
        db.commit()


# --- Bundles going out --------------------------------------------------------------------------------------------

#: Which browser shows which note right now (AC-9): session id -> (note id, until).
_viewing: dict[int, tuple[str, datetime]] = {}


def viewing(session_id: int, note_id: str | None) -> None:
    """A browser says it shows ``note_id`` in view (``None``: none any more). Holds ``VIEWING_FOR``."""
    now = clock.now()
    for key, (_note, until) in list(_viewing.items()):
        if until <= now:
            _viewing.pop(key, None)
    if note_id:
        _viewing[session_id] = (note_id, now + VIEWING_FOR)
    else:
        _viewing.pop(session_id, None)


def _shows(session_id: int, note_id: str) -> bool:
    found = _viewing.get(session_id)
    return found is not None and found[0] == note_id and found[1] > clock.now()


#: Which app device shows which note right now (NOTESIOS-15 EC-6): device (token) id -> (note id, until).
_device_viewing: dict[int, tuple[str, datetime]] = {}


def device_viewing(device_id: int, note_id: str | None) -> None:
    """An app device says it shows ``note_id`` in view (``None``: none any more), as a browser does (``viewing``)."""
    now = clock.now()
    for key, (_note, until) in list(_device_viewing.items()):
        if until <= now:
            _device_viewing.pop(key, None)
    if note_id:
        _device_viewing[device_id] = (note_id, now + VIEWING_FOR)
    else:
        _device_viewing.pop(device_id, None)


def _device_shows(device_id: int, note_id: str) -> bool:
    found = _device_viewing.get(device_id)
    return found is not None and found[0] == note_id and found[1] > clock.now()


def forget_viewing() -> None:
    _viewing.clear()
    _device_viewing.clear()


def _enqueue(db: Session, account: Account, note_id: str, payload: dict[str, Any]) -> int:
    """One row per browser and device of the account; none for a browser that shows the note (AC-9)."""
    now = clock.now()
    count = 0
    for row in webpush.subscriptions(db, account.id):
        if _shows(row.session_id, note_id):
            continue
        db.add(NotifyOutbox(account_id=account.id, channel="web", target_id=row.id, payload=payload, created_at=now,
                            next_try_at=now))
        count += 1
    count += _enqueue_devices(db, account, note_id, payload, now)
    return count


def _enqueue_devices(db: Session, account: Account, note_id: str, payload: dict[str, Any], now: datetime) -> int:
    """One row per device of the account that gets this kind (module geraete, G16, G25): signed up for
    notifications, understanding the kind (the published app: ``changed`` and ``trashed``) and with it on; none while
    the operator has the app switched off or there is no relay. Each row is sent and tried again on its own (EC-2)."""
    from ..vendor.nexgeraete import push
    from .geraete_config import CONFIG
    from .geraete_store import GeraeteStore

    store = GeraeteStore(db)
    if not apppush.relay_url() or not store.switch("app"):
        return 0
    holder = store.holder(account.id)
    if holder is None or holder.out:
        return 0
    kind = str(payload.get("type") or "changed")
    count = 0
    for device in store.devices_of(account.id):
        if device.push is None or _device_shows(int(device.id), note_id):
            continue
        if not push.understood(CONFIG, device, kind) or not push.wanted(CONFIG, device, holder, kind):
            continue
        db.add(NotifyOutbox(account_id=account.id, channel="app", target_id=int(device.id), payload=payload,
                            created_at=now, next_try_at=now))
        count += 1
    return count


def _bundle(db: Session, note_id: str) -> int:
    """The bundle of one note: who hears what. Returns how many messages were queued."""
    # The write lock before the first read: no update slips in between reading the marks and removing them.
    connection = db.connection()
    raw = connection.connection.driver_connection
    if raw is not None and not raw.in_transaction:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
    edits = list(db.scalars(select(NotifyEdit).where(NotifyEdit.note_id == note_id).order_by(NotifyEdit.first_at)))
    baseline = db.get(NotifyBaseline, note_id)
    db.execute(delete(NotifyEdit).where(NotifyEdit.note_id == note_id))
    db.execute(delete(NotifyBaseline).where(NotifyBaseline.note_id == note_id))
    note = db.get(Note, note_id)
    if note is None or baseline is None or not edits:
        return 0
    writers = [edit.account_id for edit in edits]
    trashed_by = baseline.trashed_by if note.deleted_at is not None else None
    locked = _locked(db, note_id)
    items: list[tuple[str, str]] = []
    at: int | None = None
    line = ""
    if trashed_by is None and not locked:
        now_lines = _lines_now(db, note_id)
        items, at = changes(baseline.lines or [], now_lines)
        line = str(now_lines[at][0]) if at is not None and at < len(now_lines) else ""
        if baseline.trashed_by is not None and not items:
            # Put in the trash and taken back right after: nothing to tell.
            return 0
    path = _path_ids(db, note.folder_id)
    queued = 0
    for account_id in _candidates(db, note, path):
        others = [writer for writer in writers if writer != account_id]
        if trashed_by is not None:
            others = [] if trashed_by == account_id else [trashed_by]
        if not others:
            continue
        receiver = db.get(Account, account_id)
        if receiver is None or account_out(receiver):
            continue
        on, _ = _nearest(db, account_id, note.id, path)
        if not on or notes.right_to(db, receiver, note) not in (Access.READ, Access.WRITE):
            continue
        payload = message(db, receiver, note, others, items, at, locked=locked, trashed_by=trashed_by, line=line)
        queued += _enqueue(db, receiver, note.id, payload)
    return queued


def flush_due(now: datetime | None = None) -> int:
    """Every bundle whose note was quiet for ``QUIET`` (or written for longer than ``LONGEST``). Returns how many
    messages were queued."""
    now = now or clock.now()
    with SessionLocal() as db:
        rows = db.execute(select(NotifyEdit.note_id, NotifyEdit.first_at, NotifyEdit.last_at)).all()
    first: dict[str, datetime] = {}
    last: dict[str, datetime] = {}
    for row in rows:
        first[row.note_id] = min(first.get(row.note_id, row.first_at), row.first_at)
        last[row.note_id] = max(last.get(row.note_id, row.last_at), row.last_at)
    due = [note_id for note_id in last if last[note_id] <= now - QUIET or first[note_id] <= now - LONGEST]
    queued = 0
    for note_id in due:
        try:
            with SessionLocal() as db:
                queued += _bundle(db, note_id)
                db.commit()
        except Exception:
            logger.exception("Bundling the notifications of a note failed note=%s", note_id)
    if queued:
        logger.info("Notifications queued count=%s", queued)
    return queued


def opaque(note_id: str) -> str:
    """What the relay and the push services see of a note (AC-6): a keyed hash of its id, cut short. The same note
    gives the same mark, so a newer message replaces an older one on the device (``collapse``, ``Topic``); nothing
    leads back to the note without the server's secret."""
    digest = hmac.new(server_key(), b"notify-note:" + note_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return "n" + digest[:OPAQUE_CHARS]


def _deliver(db: Session, row: NotifyOutbox) -> None:
    """Raises ``webpush.Gone``/``apppush.Gone`` or ``…Failed``; ``LookupError`` when the target is not there."""
    import json

    payload = dict(row.payload or {})
    if row.channel == "web":
        target = db.get(WebPushSubscription, row.target_id)
        if target is None or target.account_id != row.account_id:
            raise LookupError
        about = f"mcp-{payload.get('request_id')}" if payload.get("kind") == MCP_REQUEST else str(
            payload.get("note_id") or "")
        body = {"title": payload.get("title"), "body": payload.get("text"), "url": payload.get("url"),
                "tag": f"mcp-{payload.get('request_id')}" if payload.get("kind") == MCP_REQUEST
                else f"note-{payload.get('note_id')}"}
        webpush.deliver(db, target, json.dumps(body, ensure_ascii=False).encode("utf-8"), topic=opaque(about))
        target.last_ok_at = clock.now()
    elif row.channel == "app":
        _deliver_app(db, row, payload)
    else:
        raise LookupError


def _deliver_app(db: Session, row: NotifyOutbox, payload: dict[str, Any]) -> None:
    """One message of the outbox to one device (module geraete, G55): before every try the rules of ``push.tell``,
    as they stand now, not as they stood when the message was queued: the account not shut out (``holder.out``), the
    operator's switch ``app`` on, the device still paired and signed up, understanding the kind and having it on.
    Sealed with the module's ``seal`` and ``push_info``; a 410 drops the ticket (``store.set_push``, ``send_round``)."""
    from ..vendor.nexgeraete import push
    from .geraete_config import CONFIG
    from .geraete_store import GeraeteStore

    store = GeraeteStore(db)
    holder = store.holder(row.account_id)
    if holder is None or holder.out:
        raise LookupError
    if not store.switch("app"):
        raise _Refused("app_off")
    device = store.device(row.target_id)
    if device is None or str(device.account_id) != str(row.account_id) or device.push is None:
        raise LookupError
    kind = str(payload.get("type") or "changed")
    if not push.understood(CONFIG, device, kind) or not push.wanted(CONFIG, device, holder, kind):
        raise _Refused("not_wanted")
    apppush.deliver(device.push, payload, info=CONFIG.push_info,
                    collapse=opaque(str(payload.get("note_id") or "")))
    found = db.get(PushDevice, row.target_id)
    if found is not None:
        found.last_ok_at = clock.now()


#: "Ein Programm wartet auf dein Ja" (module mcp, decision 14): a tool set to "ask" waits for the account's answer.
REQUEST_WORDS = {
    "de": ("Ein Programm wartet auf dein Ja", "{key}: {what}"),
    "en": ("A program is waiting for your yes", "{key}: {what}"),
}
#: The kind of such a message in the outbox.
MCP_REQUEST = "mcp_request"


def mcp_event(event: str, request: Any) -> None:
    """The module mcp tells of a request (decision 14): ``waiting`` goes to the account's browsers (nexnotes has no
    bell); ``decided`` needs nothing, a message not sent yet stops by itself (``_still_for``)."""
    if event == "waiting":
        request_waiting(int(request.account_id), request)


def request_waiting(account_id: int, request: Any) -> int:
    """A request of an AI program waits for the account (module mcp, decision 14): a Web Push to each of its browsers
    with the program and what it asks, leading to the request's page. Only browsers: the iPhone app knows messages of
    notes only. Returns how many were queued."""
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        if account is None or account_out(account):
            return 0
        title, line = REQUEST_WORDS.get(language_of(account), REQUEST_WORDS["en"])
        what = str(getattr(request, "summary", "") or getattr(request, "tool", ""))
        payload = {"kind": MCP_REQUEST, "request_id": int(request.id), "title": title,
                   "text": _cut(line.format(key=str(request.key_name or ""), what=what), 200),
                   "url": f"/mcp/requests/{int(request.id)}"}
        now = clock.now()
        count = 0
        for row in webpush.subscriptions(db, account.id):
            db.add(NotifyOutbox(account_id=account.id, channel="web", target_id=row.id, payload=payload,
                                created_at=now, next_try_at=now))
            count += 1
        db.commit()
    if count:
        logger.info("MCP request told account_id=%s request=%s browsers=%s", account_id, int(request.id), count)
    return count


def _still_for(db: Session, account: Account, payload: dict[str, Any]) -> str:
    """Why a message must not go any more (empty: it may): the receiver lost the right to the note since it was
    bundled (EC-5), or the note was locked meanwhile and the message tells of its content (EC-1). Asked before every
    try, the first and each one after a failure. A request of an AI program goes only while it still waits."""
    if payload.get("kind") == MCP_REQUEST:
        from ..models_mcp import McpRequest

        waiting = db.get(McpRequest, int(payload.get("request_id") or 0))
        return "" if waiting is not None and waiting.account_id == account.id and waiting.status == "waiting" \
            else "decided"
    note = db.get(Note, str(payload.get("note_id") or ""))
    if note is None:
        return "no_note"
    if not payload.get("locked") and _locked(db, note.id):
        return "locked"
    if notes.right_to(db, account, note) not in (Access.READ, Access.WRITE):
        return "no_right"
    return ""


def send_round(now: datetime | None = None) -> int:
    """Sends what is due. Returns how many went out."""
    from .geraete_store import GeraeteStore

    now = now or clock.now()
    sent = 0
    with SessionLocal() as db:
        due = list(db.scalars(select(NotifyOutbox).where(NotifyOutbox.sent_at.is_(None),
                                                         NotifyOutbox.failed_at.is_(None),
                                                         NotifyOutbox.next_try_at <= now)
                              .order_by(NotifyOutbox.id).limit(BATCH)))
        for row in due:
            account = db.get(Account, row.account_id)
            row.attempts += 1
            try:
                if account is None or account_out(account):
                    raise LookupError
                refused = _still_for(db, account, dict(row.payload or {}))
                if refused:
                    raise _Refused(refused)
                _deliver(db, row)
            except _Refused as refused:
                row.failed_at, row.last_error, row.payload = now, refused.reason, {}
                logger.info("Notification dropped before sending account_id=%s reason=%s", row.account_id,
                            refused.reason)
            except LookupError:
                row.failed_at, row.last_error, row.payload = now, "no_target", {}
            except webpush.Gone:
                logger.info("A browser's push subscription is gone; removing it")
                db.execute(delete(WebPushSubscription).where(WebPushSubscription.id == row.target_id))
                row.failed_at, row.last_error, row.payload = now, "gone", {}
            except apppush.Gone:
                logger.info("A push ticket is gone; removing it")
                GeraeteStore(db).set_push(row.target_id, None)
                row.failed_at, row.last_error, row.payload = now, "gone", {}
            except (webpush.Failed, apppush.Failed) as exc:
                row.last_error = exc.code
                if row.attempts > len(RETRY_MINUTES):
                    row.failed_at, row.payload = now, {}
                    logger.warning("Notification given up channel=%s account_id=%s tries=%s reason=%s", row.channel,
                                   row.account_id, row.attempts, exc.code)
                else:
                    row.next_try_at = now + timedelta(minutes=RETRY_MINUTES[row.attempts - 1])
                    logger.warning("Notification not delivered, tried again later channel=%s account_id=%s try=%s "
                                   "reason=%s", row.channel, row.account_id, row.attempts, exc.code)
            else:
                row.sent_at, row.payload = now, {}
                sent += 1
            db.commit()
    if sent:
        logger.info("Notifications delivered count=%s", sent)
    return sent


def tick(now: datetime | None = None) -> tuple[int, int]:
    """One round of the ticker: bundles that are due, then what waits to be sent."""
    return flush_due(now), send_round(now)


def tidy(now: datetime | None = None) -> None:
    now = now or clock.now()
    with SessionLocal() as db:
        db.execute(delete(NotifyOutbox).where(or_(NotifyOutbox.sent_at < now - KEEP,
                                                  NotifyOutbox.failed_at < now - KEEP)))
        db.commit()


async def run_forever(stop: asyncio.Event) -> None:
    rounds = 0
    while not stop.is_set():
        try:
            await asyncio.to_thread(tick)
            if rounds % 240 == 0:
                await asyncio.to_thread(tidy)
        except Exception:
            logger.exception("The round of notifications failed")
        rounds += 1
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_SECONDS)
            return
        except TimeoutError:
            pass


# --- A note locked ----------------------------------------------------------------------------------------------------


def lock_changed(db: Session, note_id: str, locked: bool) -> None:
    """``tags.LOCK_HOOKS``: a note was locked (NOTES-16). What notifications kept of its content goes in the same
    transaction: the lines before the bundle (``notify_baselines``), who wrote (``notify_edits``) and every message
    still waiting to be sent (EC-1 here, NOTES-16 EC-4)."""
    if not locked:
        return
    db.execute(delete(NotifyBaseline).where(NotifyBaseline.note_id == note_id))
    db.execute(delete(NotifyEdit).where(NotifyEdit.note_id == note_id))
    db.execute(update(NotifyOutbox)
               .where(NotifyOutbox.sent_at.is_(None), NotifyOutbox.failed_at.is_(None),
                      func.json_extract(NotifyOutbox.payload, "$.note_id") == note_id)
               .values(failed_at=clock.now(), last_error="locked", payload={}))


# --- Accounts going ------------------------------------------------------------------------------------------------


def _accounts_out() -> None:
    """``security.SESSIONS_ENDED`` (a sign-out, a block, a delete, a new password): the browsers of a blocked or
    deleted account stop at once, and what waits for it goes. A sign-out took its browser along already (the row hangs
    on the session). Its paired devices rest with their push tickets (G26): nothing is queued for them while the
    account is out (``_enqueue_devices``), and they get notifications again once it is back."""
    with SessionLocal() as db:
        out = select(Account.id).where(or_(Account.blocked_at.is_not(None), Account.deleted_at.is_not(None)))
        db.execute(delete(WebPushSubscription).where(WebPushSubscription.account_id.in_(out)))
        db.execute(update(NotifyOutbox).where(NotifyOutbox.account_id.in_(out), NotifyOutbox.sent_at.is_(None),
                                              NotifyOutbox.failed_at.is_(None))
                   .values(failed_at=clock.now(), last_error="account_out", payload={}))
        # A browser whose session is gone (expired and purged) goes as well; the database does it on delete, this
        # catches rows of databases without foreign keys switched on.
        db.execute(delete(WebPushSubscription).where(WebPushSubscription.session_id.not_in(select(AuthSession.id))))
        db.commit()


def register() -> None:
    """Once per start, each hook once; the Web Push key is made now if there is none yet."""
    from ..security import SESSIONS_ENDED

    if record_change not in notes.UPDATE_HOOKS:
        notes.UPDATE_HOOKS.append(record_change)
    if record_trash not in notes.TRASHED_HOOKS:
        notes.TRASHED_HOOKS.append(record_trash)
    if head_extras not in notes.HEAD_EXTRAS:
        notes.HEAD_EXTRAS.append(head_extras)
    if _accounts_out not in SESSIONS_ENDED:
        SESSIONS_ENDED.append(_accounts_out)
    if lock_changed not in tags.LOCK_HOOKS:
        tags.LOCK_HOOKS.append(lock_changed)
    with SessionLocal() as db:
        webpush.server_key(db)
