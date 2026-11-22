"""The guide (NOTES-26): a folder "Anleitung" ("Guide") with a subfolder per subject and notes that explain nexnotes,
with pictures of the real interface.

It ships with the program in both languages (``app/guide/de``, ``app/guide/en``): ``guide.json`` names the folder,
its symbol and colour and the subfolders in their order; each subfolder holds one Markdown file per note (in the order
of their file names). A note's first line ``# Title`` is its title; a block of ``key: value`` lines between ``---``
at its top gives its symbol, colour, paper and whether it is pinned. A picture is a line of its own,
``![Name](shots/<file>)``: it becomes an attachment of the note, exactly like an uploaded picture.

**When it is made:**

* for every new account, whichever way it comes (password, invitation, a provider), in the account's language: the
  account's insert puts a job into the work queue (``_account_made``), so making an account never waits for it and
  never fails because of it. Whoever looks at the folders before the queue got to it gets it right then
  (``catch_up``).
* once for every account that was there before the guide came (``seed_existing``, marked by ``SEEDED``).
* again whenever the member asks for it (Settings > Appearance), next to what is there: "Anleitung (2)" when
  "Anleitung" is taken. Nothing is ever overwritten or updated by itself.

``NEXNOTES_GUIDE=false`` turns off the first two (the tests and the operator who does not want it); asking for it
still works.

**Whose it is:** the account's, like a folder of its own: renamed, changed, deleted at will. Its notes come from
"nexnotes" (``origin`` ``guide``, a first version in the history by ``guide``, nobody as the last writer), not from the
member. Its pictures do not count towards the account's storage (``stored`` 0): nobody chose to keep them, and an
account with a small limit must not start full. They are not read for text (NOTES-11): the guide's words are in the
notes already, and thirty pictures per new account would keep the queue busy for nothing.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

from sqlalchemy import delete, event, insert, select, update
from sqlalchemy.orm import Session, object_session

from ..config import get_settings
from ..db import SessionLocal
from ..models import Account, Folder, Note, Setting, utcnow
from ..models_attachments import Attachment
from ..models_history import NoteVersion
from ..models_ocr import OCR_DONE, RUNNING, AttachmentOcr, WorkJob
from ..notedoc import doc as notedoc
from . import attachments, folders, mailer, media, notes, workqueue

logger = logging.getLogger("nexnotes.guide")

ROOT = Path(__file__).resolve().parent.parent / "guide"
LANGUAGES = ("de", "en")
#: The kind of work in the queue; its ``ref`` is the account's id.
JOB = "guide"
#: Marks that the accounts from before the guide got theirs, once.
SEEDED = "guide_seeded"
#: Where a guide's notes came from (``Note.origin``) and who wrote their first version (``via`` of the history).
ORIGIN = "guide"
#: How long ``catch_up`` waits for the queue's worker that is making the guide right now.
WAIT_SECONDS = 20.0
#: A picture's line: ``![Name](shots/file.webp)``.
_PICTURE = re.compile(r"^!\[([^\]]*)\]\((shots/[A-Za-z0-9_.-]+)\)\s*$")
_ORDER = re.compile(r"^\d+\s+")
#: One guide at a time per account (the queue's worker and a look at the folders, or two clicks).
_making: dict[int, threading.Lock] = {}
_making_lock = threading.Lock()


def language_of(wanted: str | None) -> str:
    """German for German, English for every other language (the guide is written in those two)."""
    return "de" if (wanted or "").lower().startswith("de") else "en"


def account_language(db: Session, account: Account) -> str:
    """The account's language, its browser's at the last sign-in, the instance's, else English."""
    return language_of(mailer.language_for(db, account))


# --- The source ---------------------------------------------------------------------------------------------------


@dataclass
class GuideNote:
    title: str
    markdown: str
    icon: str = ""
    color: str = ""
    paper: str = ""
    pinned: bool = False
    #: Picture files (``shots/<file>``) by their place in the text, with the name the note shows.
    pictures: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class GuideFolder:
    name: str
    icon: str
    color: str
    notes: list[GuideNote]


@dataclass
class Guide:
    language: str
    name: str
    icon: str
    color: str
    folders: list[GuideFolder]


def _front(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text
    values = {}
    for line in text[4:end].splitlines():
        key, _, value = line.partition(":")
        if key.strip():
            values[key.strip()] = value.strip()
    return values, text[end + 5:]


def _note(path: Path) -> GuideNote:
    front, body = _front(path.read_text(encoding="utf-8").replace("\r\n", "\n"))
    lines = body.lstrip("\n").split("\n")
    if not lines or not lines[0].startswith("# "):
        raise ValueError(f"the guide's note {path.name} does not start with '# Title'")
    title = lines[0][2:].strip()
    pictures: list[tuple[str, str]] = []
    for line in lines[1:]:
        found = _PICTURE.match(line)
        if found:
            pictures.append((found.group(2), found.group(1)))
    return GuideNote(title=title, markdown="\n".join(lines[1:]).strip("\n") + "\n", icon=front.get("icon", ""),
                     color=front.get("color", ""), paper=front.get("paper", ""),
                     pinned=front.get("pinned", "").lower() in ("yes", "true"), pictures=pictures)


@lru_cache(maxsize=len(LANGUAGES))
def load(language: str) -> Guide:
    """The guide in ``language`` (``de`` or ``en``) as it ships, read once per process."""
    base = ROOT / language_of(language)
    manifest = json.loads((base / "guide.json").read_text(encoding="utf-8"))
    topics = []
    for entry in manifest["folders"]:
        directory = base / entry["dir"]
        topics.append(GuideFolder(name=_ORDER.sub("", entry["dir"]), icon=entry.get("icon", ""),
                                  color=entry.get("color", ""),
                                  notes=[_note(path) for path in sorted(directory.glob("*.md"))]))
    return Guide(language=language_of(language), name=manifest["name"], icon=manifest.get("icon", ""),
                 color=manifest.get("color", ""), folders=topics)


@dataclass(frozen=True)
class Picture:
    """A picture of the guide as the server keeps an upload of it: the file, and the preview it makes."""

    data: bytes
    mime: str
    width: int
    height: int
    thumb: bytes
    view: bytes | None


@lru_cache(maxsize=256)
def picture(language: str, relative: str) -> Picture:
    """A picture file of the guide with its preview, made once per process (the same for every account). The files
    are the program's own: no worker needed to read them."""
    from PIL import Image

    path = ROOT / language_of(language) / relative
    data = path.read_bytes()
    _kind, form = media.kind_of(data[:4096])
    with Image.open(BytesIO(data)) as image:
        image.load()
        width, height = image.size
        thumb = media._webp(image, media.THUMB_EDGE, 75)
        view = media._webp(image, media.VIEW_EDGE, 82) if max(width, height) > media.VIEW_EDGE else None
    return Picture(data=data, mime=media.IMAGE_TYPES.get(form, "image/webp"), width=width, height=height,
                   thumb=thumb, view=view)


# --- Making it ----------------------------------------------------------------------------------------------------


def _lock_for(account_id: int) -> threading.Lock:
    with _making_lock:
        return _making.setdefault(account_id, threading.Lock())


def _picture_name(name: str, relative: str) -> str:
    suffix = Path(relative).suffix
    base = notedoc.clean_label(name, 120) or Path(relative).stem
    return attachments.clean_name(base + suffix)


def _stored(found: Picture) -> int:
    return len(found.data) + len(found.thumb) + (len(found.view) if found.view is not None else 0)


def _place_pictures(db: Session, note: Note, guide: Guide, source: GuideNote, ids: list[str], counted: bool) -> None:
    """The note's pictures as attachments, as an upload would leave them (the file, its preview), not read for text;
    counted towards the owner's storage only when ``counted``."""
    now = utcnow()
    for attachment_id, (relative, name) in zip(ids, source.pictures, strict=True):
        found = picture(guide.language, relative)
        attachments._write(attachments.path_of(attachment_id), found.data)
        attachments._write(attachments.path_of(attachment_id, attachments.THUMB), found.thumb)
        if found.view is not None:
            attachments._write(attachments.path_of(attachment_id, attachments.VIEW), found.view)
        # A Core insert: the ORM's events would queue the picture for text recognition.
        db.execute(insert(Attachment).values(
            id=attachment_id, note_id=note.id, owner_id=note.owner_id, uploaded_by=None, kind="image",
            name=_picture_name(name, relative), mime=found.mime, size=len(found.data),
            stored=_stored(found) if counted else 0, width=found.width,
            height=found.height, has_view=found.view is not None, has_thumb=True, inline=True, preview_failed=False,
            created_at=now, unref_at=None))
        db.execute(insert(AttachmentOcr).values(attachment_id=attachment_id, state=OCR_DONE, pages=1, languages="",
                                                source="", error="", updated_at=now))


def _markdown_with_ids(source: GuideNote) -> tuple[str, list[str]]:
    ids = [attachments.new_id() for _ in source.pictures]
    queue = iter(ids)
    lines = []
    for line in source.markdown.split("\n"):
        found = _PICTURE.match(line)
        if found:
            name = found.group(1).replace("\\", "\\\\").replace("]", "\\]").replace("[", "\\[")
            line = f"![{name}](attachment:{next(queue)})"
        lines.append(line)
    return "\n".join(lines), ids


def _make_note(db: Session, account: Account, folder_id: str, guide: Guide, source: GuideNote,
               at: Any, counted: bool) -> str:
    markdown, ids = _markdown_with_ids(source)
    note, _new = notes.create(db, account, folder_id=folder_id, title=source.title, markdown=markdown,
                              origin=ORIGIN)
    if source.pictures:
        _place_pictures(db, note, guide, source, ids, counted)
    # nexnotes wrote it, not the member; the guide's order is the order of the list (newest change first).
    note.updated_by_id = None
    note.created_at = note.updated_at = note.listed_at = at
    note.title_check = False
    if source.icon:
        note.icon = source.icon
    if source.color:
        note.color = folders.folder_color(source.color)
    if source.paper:
        note.paper = notes.check_paper(source.paper)
    if source.pinned:
        note.pinned_at = at
    state = note.ydoc
    db.add(NoteVersion(note_id=note.id, created_at=at, started_at=at, state=state, title=note.title,
                       size=len(state), authors=[{"account_id": None, "via": ORIGIN}], restored_from=None,
                       sealed=False, sealed_rev=None))
    db.commit()
    return note.id


def _free_name(db: Session, account_id: int, name: str) -> str:
    siblings = folders._siblings(db, account_id, None)
    return folders._free_name(siblings, name)


def size_of(language: str) -> int:
    """Bytes the guide's pictures take on disk, previews included."""
    guide = load(language)
    return sum(_stored(picture(guide.language, relative))
               for topic in guide.folders for source in topic.notes for relative, _name in source.pictures)


def make(account_id: int, language: str | None = None, *, counted: bool = False) -> dict[str, Any]:
    """Makes the guide for the account in ``language`` (else the account's) as a folder at the top, next to what is
    there. Returns the folder. Whatever went wrong on the way goes again (nothing half made stays).

    The guide every account gets is a gift: its pictures take nothing of the storage. One the member asks for again
    (``counted``) counts like anything else the member keeps, and needs the room for it (``storage_limit_reached``)."""
    with _lock_for(account_id):
        return _make(account_id, language, counted)


def _make(account_id: int, language: str | None, counted: bool) -> dict[str, Any]:
    started = time.monotonic()
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        if account is None or account.deleted_at is not None:
            raise LookupError("no such account")
        guide = load(language_of(language) if language else account_language(db, account))
        if counted:
            room, taken, limit = attachments._room_for(db, account_id)
            if room is not None and size_of(guide.language) > room:
                raise attachments._full(taken, limit)
        root = folders.create(db, account_id, name=_free_name(db, account_id, guide.name), icon=guide.icon,
                              color=guide.color)
        try:
            count = sum(len(topic.notes) for topic in guide.folders)
            # The first note is the newest: the lists show the guide in its order.
            at = utcnow()
            step = 0
            topic_ids = []
            for topic in guide.folders:
                made = folders.create(db, account_id, name=topic.name, parent_id=root["id"], icon=topic.icon,
                                      color=topic.color)
                topic_ids.append(made["id"])
                for source in topic.notes:
                    _make_note(db, account, made["id"], guide, source, at - timedelta(seconds=step), counted)
                    step += 1
            folders.reorder(db, account_id, parent_id=root["id"], ids=topic_ids)
        except Exception:
            db.rollback()
            _remove(db, account_id, root["id"])
            raise
    logger.info("Guide made account=%s language=%s notes=%s ms=%s", account_id, guide.language, count,
                int((time.monotonic() - started) * 1000))
    return root


def _remove(db: Session, account_id: int, root_id: str) -> None:
    """A guide that broke off halfway goes for good, with its notes and pictures."""
    from . import trash

    try:
        result = folders.trash(db, account_id, root_id)
        batch = result["batch"]
        note_ids = set(db.scalars(select(Note.id).where(Note.owner_id == account_id, Note.deleted_batch == batch)))
        folder_ids = set(db.scalars(select(Folder.id).where(Folder.owner_id == account_id,
                                                            Folder.deleted_batch == batch)))
        folders._write_lock(db)
        trash._purge(db, note_ids, folder_ids)
    except Exception:
        db.rollback()
        logger.exception("Removing a guide that broke off failed account=%s", account_id)


# --- When ---------------------------------------------------------------------------------------------------------


def enabled() -> bool:
    return get_settings().guide


@event.listens_for(Account, "after_insert")
def _account_made(_mapper: Any, connection: Any, target: Account) -> None:
    """A new account, whichever way it came: its guide into the queue, in the same transaction."""
    if not enabled():
        return
    workqueue.enqueue(connection, JOB, str(target.id), account=target.id)
    session = object_session(target)
    if session is not None:
        event.listen(session, "after_commit", lambda _session: workqueue.kick(), once=True)


def turn(ref: str) -> None:
    """The queue's turn: the guide of the account ``ref`` (nothing when the account is gone meanwhile)."""
    try:
        account_id = int(ref)
    except ValueError:
        raise workqueue.Permanent("not an account") from None
    try:
        make(account_id)
    except LookupError:
        logger.info("The guide was not made: the account is gone account=%s", account_id)


def given_up(ref: str, reason: str) -> None:
    logger.warning("The guide could not be made account=%s reason=%s", ref, reason)


def catch_up(db: Session, account_id: int) -> bool:
    """Before the folders are shown: a guide still waiting in the queue for this account is made right now (or, when
    the queue's worker is at it, waited for). Returns whether one was made or waited for. Never raises."""
    try:
        job = db.execute(select(WorkJob.id, WorkJob.state, WorkJob.attempts)
                         .where(WorkJob.kind == JOB, WorkJob.ref == str(account_id))).first()
        if job is None or job.attempts:
            # None waiting, or one that failed before: the queue tries again in its own time.
            return False
        if job.state == RUNNING:
            db.rollback()
            deadline = time.monotonic() + WAIT_SECONDS
            # The worker holds the account's lock while it makes it: waiting for the lock is waiting for the guide.
            lock = _lock_for(account_id)
            if lock.acquire(timeout=WAIT_SECONDS):
                lock.release()
            while time.monotonic() < deadline and db.execute(
                    select(WorkJob.id).where(WorkJob.id == job.id)).first() is not None:
                db.rollback()
                time.sleep(0.1)
            return True
        taken = db.execute(delete(WorkJob).where(WorkJob.id == job.id, WorkJob.state != RUNNING)).rowcount
        db.commit()
        if not taken:
            return False
        try:
            make(account_id)
        except LookupError:
            return False
        except Exception:
            logger.exception("The guide could not be made account=%s", account_id)
            with SessionLocal() as other:
                # The queue tries again later.
                workqueue.enqueue(other, JOB, str(account_id), delay=workqueue.BACKOFF[0], account=account_id)
                other.execute(update(WorkJob).where(WorkJob.kind == JOB, WorkJob.ref == str(account_id))
                              .values(attempts=1))
                other.commit()
            return False
        return True
    except Exception:
        db.rollback()
        logger.exception("Catching up with the guide failed account=%s", account_id)
        return False


def seed_existing(db: Session) -> int:
    """Accounts from before the guide get it once, through the queue. Returns how many were queued."""
    if db.get(Setting, SEEDED) is not None:
        return 0
    queued = 0
    if enabled():
        for account_id in list(db.scalars(select(Account.id).where(Account.deleted_at.is_(None)))):
            queued += workqueue.enqueue(db, JOB, str(account_id), account=account_id)
    db.add(Setting(key=SEEDED, value=True))
    db.commit()
    if queued:
        logger.info("Guide queued for the accounts from before count=%s", queued)
        workqueue.kick()
    return queued


def register() -> None:
    workqueue.register(JOB, turn, given_up)
