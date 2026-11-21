"""Notes out of nexnotes (NOTES-17): one note as Markdown or PDF, a folder or everything as a ZIP.

**One note** goes at once: its Markdown (``note_markdown``), with attachments a small ZIP of the file and a folder of
the attachments; the PDF comes from ``export_pdf``. **A folder or everything** runs in the background as a job
(``models_export.ExportJob``): a worker thread writes the ZIP note by note into a file under ``<data>/exports``, never
the whole of it into memory; attachments go in as a stream. At most ``MAX_PARALLEL`` jobs run at a time in the whole
server and one per account, a second job of the same account waits (EC-2). A ready ZIP can be fetched for ``KEEP``
(24 hours), as often as one likes; then the cleaning round removes it (AC-8). It counts towards no account's storage
and is in no backup.

What a note is comes from the database: the folded document and every update after it. Every update is stored before
it goes anywhere else, so that is the note as it is, also while somebody writes in it.

**Names** (EC-3, EC-5): ``safe_name`` turns a title into a file name (forbidden characters replaced, length and bytes
limited, Windows' device names avoided), ``Namer`` gives the second of two equal names in one folder "(2)". Paths in
a ZIP are only ever made of such parts (``zip_path`` checks once more), so nothing in a ZIP can point outside it.

**Rights**: only notes the account may read: its own, in its own folders, and those ``tags.SHARED_NOTES`` names
(sharing, NOTES-13), each checked once more with ``notes.access_to`` (reading is enough, EC-8). Locked notes
(``tags.HIDDEN_NOTES``, NOTES-16) are there with their title and "locked, not exported" only (EC-1).

**Attachments** (NOTES-10, NOTES-18) dock on through ``ATTACHMENT_SOURCES``: each gives the files of a note as
``ExportFile`` (``services/attachments.export_files`` for NOTES-10). Those the note's text names (the blocks ``image``
and ``attachment``) stand at their place: in Markdown as a picture or a link into the note's attachment folder, in the
PDF as the picture or a line with name and size. Files no block names (a source that knows no place) follow the text
under "Attachments". A link card is the link in Markdown and a small box in the PDF.
"""

from __future__ import annotations

import contextlib
import errno
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import unicodedata
import zipfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO
from urllib.parse import quote

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal, sort_key
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note, NoteUpdate, utcnow
from ..models_export import FAILED, QUEUED, READY, RUNNING, ExportJob
from ..notedoc import doc as notedoc
from ..notedoc.markdown import to_markdown
from ..notedoc.room import Access
from ..security import account_out
from . import notes, tags

logger = logging.getLogger("nexnotes.export")

#: How long a ready ZIP can be fetched (AC-8).
KEEP = timedelta(hours=24)
#: Jobs that run at the same time in the whole server; one per account (EC-2).
MAX_PARALLEL = 2
#: What must stay free on the disk while a ZIP is written (EC-7): the server never fills its disk for an export.
RESERVE = 256 * 1024 * 1024
#: A file name takes at most this many characters and UTF-8 bytes, before " (2)" and the extension.
MAX_NAME_CHARS = 100
MAX_NAME_BYTES = 180
#: The guess per note on top of its text: the head with the properties, Markdown's marks.
NOTE_OVERHEAD = 400
#: Worker threads start by themselves when an export is started (also with ``NEXNOTES_DISABLE_BACKGROUND``: an export
#: is asked for, not a round of the clock). Off, as in the server's tests, the jobs wait for ``run_pending``.
AUTO = True

#: The words an export adds, by the account's language.
WORDS: dict[str, dict[str, str]] = {
    "de": {
        "untitled": "Ohne Titel", "inbox": "Eingang", "shared": "Mit mir geteilt",
        "locked": "gesperrt, nicht exportiert", "attachments": "Anhänge", "changed": "geändert am {date}",
        "date": "%d.%m.%Y, %H:%M",
        "page": "Seite {page} von {pages}", "everything": "nexnotes {date}", "day": "%Y-%m-%d", "unknown": "Unbekannt",
    },
    "en": {
        "untitled": "Untitled", "inbox": "Inbox", "shared": "Shared with me", "locked": "locked, not exported",
        "attachments": "Attachments", "changed": "changed {date}", "date": "%Y-%m-%d %H:%M",
        "page": "Page {page} of {pages}", "everything": "nexnotes {date}", "day": "%Y-%m-%d", "unknown": "Unknown",
    },
}


def language_of(account: Account) -> str:
    language = (account.language or account.browser_language or "en").split("-")[0].lower()
    return language if language in WORDS else "en"


def words_for(account: Account) -> dict[str, str]:
    return WORDS[language_of(account)]


# --- Attachments: where NOTES-10 docks on ---------------------------------------------------------------------------

#: Kinds of attachment files.
KINDS = ("image", "drawing", "recording", "video", "pdf", "file")
#: Kinds whose picture the PDF draws (with ``picture``, or the file itself when Typst can read it).
PICTURE_KINDS = frozenset({"image", "drawing"})
#: What Typst draws as it is.
PICTURE_FORMATS = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".gif": "gif", ".webp": "webp", ".svg": "svg"}
#: Packed already: stored in the ZIP as they are, packing them again costs time for nothing.
PACKED = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif", ".mp4", ".mov", ".m4v", ".webm", ".mkv",
    ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".zip", ".gz", ".7z", ".rar", ".pdf", ".docx", ".xlsx", ".pptx",
})


@dataclass(frozen=True)
class ExportFile:
    """One attachment of a note, as an export takes it.

    ``id``: the attachment's id; ``name``: its file name as the member knows it; ``kind``: one of ``KINDS``;
    ``size``: bytes; ``open``: the bytes as a stream (read in pieces, closed by the export); ``picture``: for the PDF,
    a picture of it (a sketch drawn, a HEIC as JPEG) with its format (``png``, ``jpg``, ``webp``, ``svg``) when the
    file itself is none Typst can draw.
    """

    id: str
    name: str
    kind: str
    size: int
    open: Callable[[], BinaryIO]
    picture: Callable[[], tuple[bytes, str]] | None = None


#: The attachments of a note: each source gives the files of one note (``attachments.files_of`` of NOTES-10, the
#: sketches and recordings of NOTES-18).
AttachmentSource = Callable[[Session, Note], Iterable[ExportFile]]
ATTACHMENT_SOURCES: list[AttachmentSource] = []
#: The bytes of the attachments of many notes at once, for the size the dialog names (AC-7).
AttachmentTotal = Callable[[Session, Sequence[str]], int]
ATTACHMENT_TOTALS: list[AttachmentTotal] = []


def files_of(db: Session, note: Note) -> list[ExportFile]:
    found: list[ExportFile] = []
    for source in ATTACHMENT_SOURCES:
        found.extend(source(db, note))
    return found


# --- Names ----------------------------------------------------------------------------------------------------------

#: Forbidden in a file name on one of the systems (and control characters, line and paragraph separators).
_FORBIDDEN = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f-\x9f  ]')
#: Windows' device names: ``CON``, ``CON.md`` and ``con.tar.md`` open the device, not a file.
_DEVICE = re.compile(r"^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)", re.IGNORECASE)
#: What may not end a name after cutting: half an emoji or a joiner.
_DANGLING = "‍︎️ "


def _cut(name: str) -> str:
    name = name[:MAX_NAME_CHARS]
    while len(name.encode("utf-8")) > MAX_NAME_BYTES:
        name = name[:-1]
    return name.rstrip(_DANGLING)


def safe_name(title: str | None, fallback: str) -> str:
    """A file or folder name from a title (EC-3): the same title, only what no system takes replaced by ``_``, no dot
    or blank at the edges (a leading dot hides a file, a trailing one Windows drops), never one of Windows' device
    names, at most ``MAX_NAME_CHARS`` characters and ``MAX_NAME_BYTES`` bytes; ``fallback`` when nothing is left."""
    name = unicodedata.normalize("NFC", title or "")
    name = _FORBIDDEN.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    name = _DEVICE.sub(lambda found: found.group(1) + "_", name)
    name = _cut(name).strip(" .")
    return name or fallback


def safe_file_name(name: str | None, fallback: str) -> str:
    """An attachment's name: the stem as ``safe_name``, the extension kept when it is a plain one."""
    path = PurePosixPath((name or "").replace("\\", "/").split("/")[-1])
    suffix = path.suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", path.suffix or "") else ""
    stem = path.name[: len(path.name) - len(suffix)] if suffix else path.name
    return safe_name(stem, fallback) + suffix.lower()


class Namer:
    """The names in one folder of a ZIP: the second of two equal names gets " (2)", the third " (3)" (EC-5). Equal
    means equal ignoring case: on Windows and macOS the two would be one file."""

    def __init__(self) -> None:
        self.taken: set[str] = set()

    def take(self, base: str, suffix: str = "") -> str:
        number = 1
        while True:
            candidate = base + ("" if number == 1 else f" ({number})") + suffix
            key = unicodedata.normalize("NFC", candidate).casefold()
            if key not in self.taken:
                self.taken.add(key)
                return candidate
            number += 1


class UnsafePath(ValueError):
    pass


def zip_path(*parts: str) -> str:
    """A path in a ZIP from names; refuses any part that could lead out of the ZIP (``..``, a slash, a drive)."""
    for part in parts:
        if (not part or part in (".", "..") or any(char in part for char in "/\\:\x00")
                or part != part.strip() or part.startswith(".")):
            raise UnsafePath(part)
    return "/".join(parts)


def link_target(*parts: str) -> str:
    """A relative link to a file in the ZIP, as Markdown wants it: every part percent-encoded (blanks, brackets and
    umlauts become ``%20``, ``%28``, ``%C3%A4``)."""
    return "/".join(quote(part, safe="") for part in parts)


# --- One note -------------------------------------------------------------------------------------------------------


@dataclass
class NoteData:
    """A note as an export takes it."""

    note: Note
    title: str
    document: dict[str, Any]
    locked: bool
    files: list[ExportFile] = field(default_factory=list)
    owner: str = ""


def current_doc(db: Session, note_id: str) -> Any:
    """The note's document as it is now. The updates are read before the folded state: a fold that comes between the
    two has put them into that state already, nothing gets lost."""
    updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note_id).order_by(NoteUpdate.id)))
    state = db.scalar(select(Note.ydoc).where(Note.id == note_id))
    return notedoc.load(state or None, updates)


def locked_ids(db: Session, ids: Sequence[str]) -> set[str]:
    """Which of these notes are locked (NOTES-16, through ``tags.HIDDEN_NOTES``)."""
    if not tags.HIDDEN_NOTES or not ids:
        return set()
    found: set[str] = set()
    for start in range(0, len(ids), 500):
        chunk = list(ids[start:start + 500])
        found.update(db.scalars(select(Note.id).where(Note.id.in_(chunk),
                                                      or_(*(hidden() for hidden in tags.HIDDEN_NOTES)))))
    return found


def note_data(db: Session, note: Note, *, locked: bool | None = None) -> NoteData:
    if locked is None:
        locked = note.id in locked_ids(db, [note.id])
    if locked:
        # Nothing of the text, not even the title of the document: the column is what lists show of a locked note.
        return NoteData(note, note.title, {"type": "doc", "content": []}, True)
    doc = current_doc(db, note.id)
    title = notedoc.title_of(doc) or note.title
    return NoteData(note, title, notedoc.clean_doc(notedoc.to_json(doc)), False, files_of(db, note))


def _iso(value: datetime | None) -> str:
    return (value or utcnow()).astimezone(UTC).isoformat(timespec="seconds")


def _yaml(value: str) -> str:
    """A YAML string: JSON's double quotes are valid YAML and leave nothing open (colons, ``#``, quotes)."""
    return json.dumps(value, ensure_ascii=False)


def front_matter(data: NoteData) -> list[str]:
    """The properties at the top of the file (AC-5): title, dates, pinned, colour and symbol."""
    note = data.note
    lines = ["---", f"title: {_yaml(data.title)}"]
    if data.locked:
        lines += ["locked: true", "---"]
        return lines
    lines += [f"created: {_iso(note.created_at)}", f"updated: {_iso(note.updated_at)}",
              f"pinned: {'true' if note.pinned_at else 'false'}"]
    if note.pinned_at:
        lines.append(f"pinned_at: {_iso(note.pinned_at)}")
    if note.color:
        lines.append(f"color: {_yaml(note.color)}")
    if note.icon:
        lines.append(f"icon: {_yaml(note.icon)}")
    lines.append("---")
    return lines


_MD_SPECIAL = re.compile(r"([\\`*_\[\]<>~|#!])")


def _md_text(text: str) -> str:
    return _MD_SPECIAL.sub(r"\\\1", text)


def note_markdown(data: NoteData, words: dict[str, str], *, attachment_dir: str | None = None,
                  attachment_names: Sequence[str] = ()) -> str:
    """The note as a Markdown file: properties, ``# title``, the text with its attachments at their place as links into
    ``attachment_dir`` (``attachment_names`` in the order of ``data.files``), then the files no block of the text
    names."""
    head = "\n".join(front_matter(data)) + "\n\n"
    if data.locked:
        title = to_markdown({"type": "doc", "content": []}, title=data.title or words["untitled"])
        return head + title + "\n*" + _md_text(words["locked"]) + "*\n"
    targets: dict[str, str] = {}
    if attachment_dir is not None:
        targets = {file.id: link_target(attachment_dir, name)
                   for file, name in zip(data.files, attachment_names, strict=True)}
    body = to_markdown(data.document, title=data.title or words["untitled"],
                       attachment_href=lambda found, _name: targets.get(found))
    placed = set(notedoc.attachment_refs(data.document))
    rest = [(file, name) for file, name in zip(data.files, attachment_names, strict=False) if file.id not in placed]
    if not rest or attachment_dir is None:
        return head + body
    lines = ["", f"## {_md_text(words['attachments'])}", ""]
    for file, name in rest:
        target = link_target(attachment_dir, name)
        label = _md_text(file.name or name)
        if file.kind in PICTURE_KINDS:
            lines += [f"![{label}]({target})", ""]
        else:
            lines += [f"- [{label}]({target})"]
    return head + body.rstrip("\n") + "\n" + "\n".join(lines).rstrip("\n") + "\n"


# --- Writing a ZIP ----------------------------------------------------------------------------------------------------


class DiskFull(Exception):
    """The disk would get too full (EC-7)."""


def export_dir() -> Path:
    folder = get_settings().data_dir / "exports"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def free_bytes() -> int:
    """Free space where the ZIPs are written (tests replace it)."""
    return shutil.disk_usage(export_dir()).free


def _zip_time(value: datetime | None) -> tuple[int, int, int, int, int, int]:
    moment = (value or utcnow()).astimezone(UTC)
    if moment.year < 1980:
        moment = datetime(1980, 1, 1, tzinfo=UTC)
    return (moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second)


class ZipWriter:
    """Writes entries one by one into an open ZIP; after every entry it looks at the disk (EC-7)."""

    def __init__(self, archive: zipfile.ZipFile, *, watch: bool = True) -> None:
        self.archive = archive
        self.watch = watch
        self.count = 0

    def _check(self) -> None:
        if self.watch and free_bytes() < RESERVE:
            raise DiskFull

    def folder(self, path: str) -> None:
        info = zipfile.ZipInfo(path + "/", date_time=_zip_time(None))
        info.external_attr = (0o40755 << 16) | 0x10
        self.archive.writestr(info, b"")

    def text(self, path: str, text: str, when: datetime | None) -> None:
        info = zipfile.ZipInfo(path, date_time=_zip_time(when))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        self.archive.writestr(info, text.encode("utf-8"))
        self.count += 1
        self._check()

    def stream(self, path: str, source: BinaryIO, when: datetime | None = None) -> None:
        info = zipfile.ZipInfo(path, date_time=_zip_time(when))
        packed = PurePosixPath(path).suffix.lower() in PACKED
        info.compress_type = zipfile.ZIP_STORED if packed else zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with self.archive.open(info, "w", force_zip64=True) as target:
            while True:
                piece = source.read(1024 * 1024)
                if not piece:
                    break
                target.write(piece)
                if self.watch and free_bytes() < RESERVE:
                    raise DiskFull
        self.count += 1


def write_note(out: ZipWriter, data: NoteData, words: dict[str, str], folder: Sequence[str], namer: Namer) -> None:
    """One note into the ZIP: ``<title>.md`` in ``folder``, its attachments in ``<title> (Attachments)`` beside it."""
    stem = namer.take(safe_name(data.title, words["untitled"]), ".md")[:-3]
    attachment_dir = None
    names: list[str] = []
    if data.files and not data.locked:
        attachment_dir = namer.take(f"{stem} ({words['attachments']})")
        inner = Namer()
        names = [inner.take(*_split(safe_file_name(file.name, words["untitled"]))) for file in data.files]
        out.folder(zip_path(*folder, attachment_dir))
    out.text(zip_path(*folder, stem + ".md"),
             note_markdown(data, words, attachment_dir=attachment_dir, attachment_names=names), data.note.updated_at)
    for file, name in zip(data.files if attachment_dir else [], names, strict=False):
        assert attachment_dir is not None
        with contextlib.closing(file.open()) as source:
            out.stream(zip_path(*folder, attachment_dir, name), source, data.note.updated_at)


def _split(name: str) -> tuple[str, str]:
    suffix = PurePosixPath(name).suffix
    if suffix and suffix != name:
        return name[: -len(suffix)], suffix
    return name, ""


# --- What a folder or everything holds -------------------------------------------------------------------------------


@dataclass
class Plan:
    """What a ZIP will hold: folders to make and notes to write, each with the folder it goes in."""

    folders: list[tuple[str, ...]] = field(default_factory=list)
    notes: list[tuple[tuple[str, ...], str]] = field(default_factory=list)
    namers: dict[tuple[str, ...], Namer] = field(default_factory=dict)

    def namer(self, folder: tuple[str, ...]) -> Namer:
        return self.namers.setdefault(folder, Namer())


def _readable(db: Session, account: Account, note_ids: Iterable[str]) -> list[str]:
    """Of these notes, those the account may read, alive (the rights checked once more for every note)."""
    keep = []
    for note_id in note_ids:
        note = db.get(Note, note_id)
        if note is not None and notes.access_to(db, account, note) in (Access.WRITE, Access.READ):
            keep.append(note_id)
    return keep


def _notes_in(db: Session, account: Account, folder_id: str) -> list[str]:
    """The notes of one folder the account may read, oldest first (the second of two equal titles gets "(2)"). Its
    own notes it may read anyway; a note of somebody else in it (a shared folder, NOTES-13) is asked about."""
    rows = db.execute(select(Note.id, Note.owner_id).where(Note.folder_id == folder_id, Note.deleted_at.is_(None))
                      .order_by(Note.created_at, Note.id)).all()
    if account_out(account):
        return []
    others = set(_readable(db, account, [row.id for row in rows if row.owner_id != account.id]))
    return [row.id for row in rows if row.owner_id == account.id or row.id in others]


def _folders_of(db: Session, account_id: int) -> dict[str | None, list[Folder]]:
    children: dict[str | None, list[Folder]] = {}
    for folder in db.scalars(select(Folder).where(Folder.owner_id == account_id, Folder.deleted_at.is_(None))):
        children.setdefault(folder.parent_id, []).append(folder)
    for siblings in children.values():
        siblings.sort(key=lambda folder: (sort_key(folder.name), folder.id))
    return children


def _plan_folder(db: Session, account: Account, plan: Plan, folder: Folder, path: tuple[str, ...],
                 children: dict[str | None, list[Folder]], words: dict[str, str]) -> None:
    plan.folders.append(path)
    namer = plan.namer(path)
    for child in children.get(folder.id, []):
        if child.kind == FOLDER_INBOX:
            continue
        name = namer.take(safe_name(child.name, words["untitled"]))
        _plan_folder(db, account, plan, child, (*path, name), children, words)
    for note_id in _notes_in(db, account, folder.id):
        plan.notes.append((path, note_id))


def _shared_with(db: Session, account: Account) -> list[str]:
    """Notes others shared with the account (``tags.SHARED_NOTES``), readable for it, not its own."""
    if not tags.SHARED_NOTES:
        return []
    found = select(Note.id).where(Note.owner_id != account.id, Note.deleted_at.is_(None),
                                  or_(*(Note.id.in_(rule(account.id)) for rule in tags.SHARED_NOTES)))
    return _readable(db, account, db.scalars(found.order_by(Note.created_at, Note.id)))


class FolderGone(Exception):
    pass


def plan_for(db: Session, account: Account, folder_id: str | None, words: dict[str, str]) -> Plan:
    """What the ZIP of a folder (with everything below, AC-4) or of everything (AC-3) holds."""
    plan = Plan()
    children = _folders_of(db, account.id)
    if folder_id is not None:
        folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
        if folder is None or folder.owner_id != account.id or folder.deleted_at is not None:
            raise FolderGone
        name = words["inbox"] if folder.kind == FOLDER_INBOX else safe_name(folder.name, words["untitled"])
        _plan_folder(db, account, plan, folder, (plan.namer(()).take(name),), children, words)
        return plan
    root = plan.namer(())
    shared = _shared_with(db, account)
    # The folder of shared notes keeps its name; a folder of the member called the same gets "(2)".
    shared_dir = root.take(safe_name(words["shared"], "shared")) if shared else None
    for folder in children.get(None, []):
        if folder.kind == FOLDER_INBOX:
            name = root.take(safe_name(words["inbox"], "inbox"))
        else:
            name = root.take(safe_name(folder.name, words["untitled"]))
        _plan_folder(db, account, plan, folder, (name,), children, words)
    if shared_dir is not None:
        plan.folders.append((shared_dir,))
        owners: dict[int, tuple[str, ...]] = {}
        names = plan.namer((shared_dir,))
        for note_id in shared:
            note = db.get(Note, note_id)
            assert note is not None
            if note.owner_id not in owners:
                owner = db.get(Account, note.owner_id)
                shown = owner.shown_name if owner is not None else words["unknown"]
                owners[note.owner_id] = (shared_dir, names.take(safe_name(shown, words["unknown"])))
                plan.folders.append(owners[note.owner_id])
            plan.notes.append((owners[note.owner_id], note_id))
    return plan


def write_plan(account: Account, plan: Plan, out: ZipWriter, words: dict[str, str]) -> int:
    """Writes the planned folders and notes, every note read in a session of its own (a long export holds no read
    open for hours). Returns the number of notes."""
    for folder in plan.folders:
        out.folder(zip_path(*folder))
    written = 0
    for start in range(0, len(plan.notes), 200):
        batch = plan.notes[start:start + 200]
        with SessionLocal() as db:
            locked = locked_ids(db, [note_id for _path, note_id in batch])
        for path, note_id in batch:
            with SessionLocal() as db:
                note = db.get(Note, note_id)
                # Gone or no longer readable since the plan was made: left out.
                if note is None or notes.access_to(db, account, note) not in (Access.WRITE, Access.READ):
                    continue
                data = note_data(db, note, locked=note_id in locked)
                db.expunge_all()
            write_note(out, data, words, path, plan.namer(path))
            written += 1
    return written


# --- The size before (AC-7) -------------------------------------------------------------------------------------------


def estimate(db: Session, account: Account, folder_id: str | None) -> dict[str, int]:
    """About how big the ZIP of a folder or of everything gets: the notes' text with what Markdown adds, and their
    attachments. Packing makes the ZIP smaller than this as a rule."""
    plan = plan_for(db, account, folder_id, words_for(account))
    return {"bytes": plan_size(db, plan), "notes": len(plan.notes)}


def plan_size(db: Session, plan: Plan) -> int:
    ids = [note_id for _path, note_id in plan.notes]
    size = 0
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        text = db.scalar(select(func.coalesce(func.sum(func.length(Note.text)), 0)).where(Note.id.in_(chunk))) or 0
        size += int(text * 1.15) + NOTE_OVERHEAD * len(chunk)
        for total in ATTACHMENT_TOTALS:
            size += int(total(db, chunk) or 0)
    return size


# --- Jobs ---------------------------------------------------------------------------------------------------------

_lock = threading.Lock()
_workers = 0


def _job_file(job_id: str, part: bool = False) -> Path:
    return export_dir() / (f"{job_id}.part" if part else f"{job_id}.zip")


def job_out(job: ExportJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "folder_id": job.folder_id,
        "label": job.label,
        "filename": job.filename,
        "status": job.status,
        "problem": job.problem,
        "estimate": job.estimate,
        "size": job.size,
        "notes": job.notes,
        "created_at": _iso(job.created_at),
        "finished_at": _iso(job.finished_at) if job.finished_at else None,
        "expires_at": _iso(job.expires_at) if job.expires_at else None,
        "seen": job.seen,
    }


def start(db: Session, account: Account, folder_id: str | None) -> ExportJob:
    """A new export of a folder or of everything. It waits while another of the account runs (EC-2)."""
    words = words_for(account)
    label = ""
    if folder_id is not None:
        folder = db.get(Folder, folder_id) if len(folder_id) <= 36 else None
        if folder is None or folder.owner_id != account.id or folder.deleted_at is not None:
            raise error("not_found", "Not found.", 404)
        label = words["inbox"] if folder.kind == FOLDER_INBOX else folder.name
        filename = safe_name(label, "export") + ".zip"
    else:
        today = datetime.now().astimezone().strftime(words["day"])
        filename = safe_name(words["everything"].format(date=today), "nexnotes") + ".zip"
    size = estimate(db, account, folder_id)
    job = ExportJob(account_id=account.id, folder_id=folder_id, label=label, filename=filename,
                    estimate=size["bytes"], notes=size["notes"])
    db.add(job)
    db.commit()
    db.refresh(job)
    logger.info("Export queued job=%s account=%s notes=%s", job.id, account.id, job.notes)
    kick()
    return job


def restart(db: Session, account: Account, job_id: str) -> ExportJob:
    """The same export once more, after it failed (EC-6, EC-7)."""
    old = own_job(db, account, job_id)
    if old.status != FAILED:
        raise error("export_not_failed", "Only a failed export can be started again.", 409)
    old.seen = True
    db.commit()
    return start(db, account, old.folder_id)


def own_job(db: Session, account: Account, job_id: str) -> ExportJob:
    job = db.get(ExportJob, job_id) if len(job_id) <= 36 else None
    if job is None or job.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    return job


def jobs_of(db: Session, account: Account) -> list[ExportJob]:
    """The account's exports of the last 24 hours, and every ZIP that can still be fetched."""
    now = utcnow()
    recent = or_(ExportJob.created_at >= now - KEEP, and_(ExportJob.status == READY, ExportJob.expires_at > now))
    return list(db.scalars(select(ExportJob).where(ExportJob.account_id == account.id, recent)
                           .order_by(ExportJob.created_at.desc())))


def download_path(db: Session, account: Account, job_id: str) -> tuple[Path, str]:
    """The ready ZIP, for 24 hours and as often as asked (AC-8)."""
    job = own_job(db, account, job_id)
    if job.status != READY:
        raise error("export_not_ready", "The export is not ready.", 409)
    path = _job_file(job.id)
    if job.expires_at is None or utcnow() >= job.expires_at or not path.is_file():
        raise error("export_expired", "The export was there for 24 hours and is gone.", 410)
    return path, job.filename


def _claim() -> str | None:
    """The next waiting job whose account runs none; marked as running."""
    with _lock, SessionLocal() as db:
        busy = select(ExportJob.account_id).where(ExportJob.status == RUNNING)
        running = db.scalar(select(func.count()).select_from(ExportJob).where(ExportJob.status == RUNNING)) or 0
        if running >= MAX_PARALLEL:
            return None
        job = db.scalars(select(ExportJob).where(ExportJob.status == QUEUED, ExportJob.account_id.not_in(busy))
                         .order_by(ExportJob.created_at, ExportJob.id).limit(1)).first()
        if job is None:
            return None
        job.status = RUNNING
        job.started_at = utcnow()
        db.commit()
        return job.id


def _finish(job_id: str, status: str, problem: str = "", size: int = 0, notes_written: int | None = None) -> None:
    with SessionLocal() as db:
        job = db.get(ExportJob, job_id)
        if job is None:
            return
        job.status = status
        job.problem = problem
        job.finished_at = utcnow()
        if status == READY:
            job.size = size
            job.expires_at = job.finished_at + KEEP
            if notes_written is not None:
                job.notes = notes_written
        db.commit()


def run_job(job_id: str) -> None:
    """Writes the ZIP of one claimed job."""
    with SessionLocal() as db:
        job = db.get(ExportJob, job_id)
        if job is None:
            return
        account = db.get(Account, job.account_id)
        folder_id = job.folder_id
        if account is None or account_out(account):
            _finish(job_id, FAILED, "failed")
            return
        db.expunge(account)
        words = words_for(account)
        try:
            plan = plan_for(db, account, folder_id, words)
        except FolderGone:
            _finish(job_id, FAILED, "not_found")
            return
        guess = plan_size(db, plan)
    if free_bytes() < guess + RESERVE:
        logger.warning("Export refused, the disk is too full job=%s", job_id)
        _finish(job_id, FAILED, "disk_full")
        return
    part = _job_file(job_id, part=True)
    try:
        with open(part, "wb") as raw, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            written = write_plan(account, plan, ZipWriter(archive), words)
        os.replace(part, _job_file(job_id))
    except (DiskFull, OSError) as exc:
        part.unlink(missing_ok=True)
        if isinstance(exc, DiskFull) or getattr(exc, "errno", None) in (errno.ENOSPC, errno.EDQUOT):
            logger.warning("Export stopped, the disk got too full job=%s", job_id)
            _finish(job_id, FAILED, "disk_full")
            return
        logger.exception("Export failed job=%s", job_id)
        _finish(job_id, FAILED, "failed")
        return
    except Exception:
        part.unlink(missing_ok=True)
        logger.exception("Export failed job=%s", job_id)
        _finish(job_id, FAILED, "failed")
        return
    size = _job_file(job_id).stat().st_size
    _finish(job_id, READY, size=size, notes_written=written)
    logger.info("Export ready job=%s notes=%s bytes=%s", job_id, written, size)


def run_pending() -> int:
    """Runs waiting jobs here, one after the other, until none can start (tests; the worker threads do the same)."""
    done = 0
    while (job_id := _claim()) is not None:
        run_job(job_id)
        done += 1
    return done


def _work() -> None:
    global _workers
    try:
        run_pending()
    except Exception:
        logger.exception("The export worker failed")
    finally:
        with _lock:
            _workers -= 1
    # A job queued while this worker was about to stop finds a worker all the same.
    if _claimable():
        kick()


def _claimable() -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(select(func.count()).select_from(ExportJob).where(ExportJob.status == QUEUED)))


def kick() -> None:
    """Starts a worker thread when there is room: exports run beside everything else, never in the way (EC-2)."""
    global _workers
    if not AUTO:
        return
    with _lock:
        if _workers >= MAX_PARALLEL:
            return
        _workers += 1
    threading.Thread(target=_work, name="nexnotes-export", daemon=True).start()


def recover() -> None:
    """At the start: an export that ran when the server stopped is broken off and says so (EC-6); its half file
    goes. Waiting ones run."""
    with SessionLocal() as db:
        for job in db.scalars(select(ExportJob).where(ExportJob.status == RUNNING)):
            job.status = FAILED
            job.problem = "interrupted"
            job.finished_at = utcnow()
            job.seen = False
            logger.warning("Export broken off by a restart job=%s", job.id)
        db.commit()
    for leftover in [*export_dir().glob("*.part"), *export_dir().glob("*.tmp")]:
        leftover.unlink(missing_ok=True)
    purge_expired()
    kick()


def purge_expired() -> int:
    """The cleaning round (AC-8): ZIPs past their 24 hours go, rows of jobs older than that too, and files nobody
    owns any more (an account that went)."""
    now = utcnow()
    removed = 0
    with SessionLocal() as db:
        for job in db.scalars(select(ExportJob).where(ExportJob.status == READY, ExportJob.expires_at <= now)):
            _job_file(job.id).unlink(missing_ok=True)
            removed += 1
        old = list(db.scalars(select(ExportJob).where(
            ExportJob.status.in_((READY, FAILED)), ExportJob.created_at < now - KEEP,
            or_(ExportJob.expires_at.is_(None), ExportJob.expires_at <= now))))
        for job in old:
            db.delete(job)
        db.commit()
        known = set(db.scalars(select(ExportJob.id).where(ExportJob.status.in_((READY, RUNNING, QUEUED)))))
    for path in export_dir().glob("*.zip"):
        if path.stem not in known:
            path.unlink(missing_ok=True)
            removed += 1
    if removed:
        logger.info("Exports removed count=%s", removed)
    return removed


# --- One note as a file --------------------------------------------------------------------------------------------


def note_for_export(db: Session, account: Account, note_id: str) -> Note:
    """A note the account may read (EC-8: reading is enough, as for copying), not in the trash."""
    return notes.note_for(db, account, note_id)


def single_markdown(account: Account, note_id: str) -> tuple[str, bytes | Path, str]:
    """One note as Markdown (AC-1): ``(filename, content, type)``. With attachments it is a ZIP of the file and a
    folder of the attachments, written to a temporary file the caller removes once it is sent."""
    words = words_for(account)
    with SessionLocal() as db:
        note = note_for_export(db, account, note_id)
        data = note_data(db, note)
        db.expunge_all()
    stem = safe_name(data.title, words["untitled"])
    if not data.files or data.locked:
        return stem + ".md", note_markdown(data, words).encode("utf-8"), "text/markdown; charset=utf-8"
    handle = tempfile.NamedTemporaryFile(prefix="note-", suffix=".tmp", dir=export_dir(), delete=False)  # noqa: SIM115
    path = Path(handle.name)
    try:
        with handle, zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            write_note(ZipWriter(archive, watch=False), data, words, (), Namer())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return stem + ".zip", path, "application/zip"


def note_pdf(account: Account, note_id: str) -> tuple[str, bytes]:
    """One note as PDF (AC-2)."""
    from . import export_pdf

    words = words_for(account)
    with SessionLocal() as db:
        note = note_for_export(db, account, note_id)
        data = note_data(db, note)
        db.expunge_all()
    return safe_name(data.title, words["untitled"]) + ".pdf", export_pdf.build(data, words, language_of(account))


def register() -> None:
    from . import cleanup

    if not any(name == "exports" for name, _job in cleanup._jobs):
        cleanup.register("exports", purge_expired)
