"""Attachments of notes (NOTES-10): pictures, videos, PDFs, any file, and the pictures of link cards.

**What is where.** The file lies in ``<data>/attachments/<id>`` (the backup carries that folder), with ``<id>.view``
(a WebP every browser shows) and ``<id>.thumb`` (the preview) beside it where there are such. A row in
``attachments`` says what the server found it to be (``services/media.py``: by its content, never by its name) and the
note it was attached to. The note's document names it by its id only (blocks ``image``, ``attachment``,
``linkPreview``; ``notedoc/schema.py``); ``attachment_refs`` follows the document and says which notes name which
attachment today (``sync_refs``, a hook on the text).

**Coming in** (``begin``, ``receive``, ``finish``): only who may write the note; the id comes from the browser, which
puts the block into the note at once and uploads after it (the same id twice is the same file). The operator's limit
per file (``upload_max_mb``) is checked against the length the browser declares and again while the body comes; the
account's storage (``Account.storage_limit`` against everything ``content.counts`` counts) before and while it comes,
with what the owner's other uploads in progress have claimed (``begin`` claims the declared length, ``release``
gives it back), and once more under the lock that puts the file in place (``finish``): uploads at once never take
more than the storage has. A full storage takes no attachment; writing goes on (EC-1). The body goes to a work file
(``.up-…``, never in a backup) and is renamed only once it is whole and prepared. What it is, is read in a worker
with limits of memory and time (``media.prepare``); a file past them stays a file without a preview.

**Going out**: only to whoever may read the note the attachment belongs to, or a note of the same owner that names it
or named it (a copied note, a block pasted into another note, a version in its history). Everyone else gets the same
"not found" as for one that is not there (``readable``). The headers are the router's (``routers/attachments.py``).

**Going away.** Removing a block from a note takes nothing away at once: the history keeps what its versions name
(NOTES-15 AC-3, AC-4). An attachment goes

* when its note goes for good (``trash.PURGE_HOOKS``), unless another note of the same owner names it, or named it
  and a version of it still does (``attachment_mentions``): then it moves there;
* when no note names it any more, no version of any note of its owner that named it does either, and a day has
  passed (for undo in an open editor): checked when versions are thinned (``history.VERSIONS_PURGED_HOOKS``) and in
  the cleanup round;
* as a file without a row (its account gone for good, an upload that broke off) in the cleanup round.
Files go only after the commit that removed their row.

**Sketches and recordings (NOTES-18)** come from the iOS app with a role (``as=``): ``services/sketches.py`` checks
that the content is what the role says and prepares it; the helpers behind them (a sketch's data, a transcript) never
stand in the gallery.

**For the export (NOTES-17)**: ``files_of(db, note_id)`` gives every attachment a note names today, in the order of its
text, with the path of its file; ``export_files`` hands them to ``export.ATTACHMENT_SOURCES`` (``export_total`` to
``ATTACHMENT_TOTALS``), and the export puts them at their place in the text (``to_markdown(..., attachment_href=...)``,
``export_pdf.Writer``).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import threading
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, event, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, Note, NoteUpdate, utcnow
from ..models_attachments import Attachment, AttachmentMention, AttachmentRef
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from ..notedoc.room import Access
from . import backups, content, media, notes, settings_service

logger = logging.getLogger("nexnotes.attachments")

MB = 1024 * 1024
#: The kinds the gallery filters by, in the order of its chips (AC-7). Scans, sketches and recordings come with
#: NOTES-11, NOTES-18 and the iOS app; their chips are there from the start.
GALLERY_KINDS = ("image", "scan", "pdf", "recording", "drawing", "video", "file")
#: The picture of a link card: an attachment of the note, never in the gallery.
LINK_PICTURE = "linkimage"
#: Kinds that only stand behind a block of their own (a card's picture, a sketch's data, a transcript): never in the
#: gallery.
HIDDEN_KINDS = (LINK_PICTURE, "drawingdata", "transcript", "sealed")
#: Called with every attachment once it is stored and committed (NOTES-18: the search reads a transcript's note again).
#: A hook must not raise.
STORED_HOOKS: list[Callable[[Attachment], None]] = []
#: Kinds a list and a tile show as the note's picture (NOTES-6), first one first.
PICTURE_KINDS = ("image", "scan", "drawing", "video")
#: How long an attachment no note names is kept at least (undo in an open editor).
GRACE = timedelta(days=1)
#: Files without a row older than this go in the cleanup round (an upload in progress has a work file, not a file).
ORPHAN_AGE = timedelta(hours=1)
#: Work files of uploads older than this go in the cleanup round.
WORK_AGE = timedelta(days=1)
WORK_PREFIX = ".up-"
VIEW = ".view"
THUMB = ".thumb"
_ID = re.compile(s.ATTACHMENT_ID)
_CHUNK = MB
#: Renaming files into place and writing the row, for one upload at a time (the same id twice at once, the storage).
_placing = threading.Lock()
#: Bytes the uploads in progress have claimed of their owner's storage: owner, upload, bytes.
_claimed: dict[int, dict[str, int]] = {}
_claiming = threading.Lock()


class AttachmentError(Exception):
    def __init__(self, code: str, text: str, status: int, **values: Any) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status
        self.values = values

    def http(self) -> Exception:
        return error(self.code, self.text, self.status, **self.values)


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


def root() -> Path:
    return backups.media_root()


def path_of(attachment_id: str, suffix: str = "") -> Path:
    if not _ID.match(attachment_id):
        raise ValueError("not an attachment id")
    return root() / f"{attachment_id}{suffix}"


def new_id() -> str:
    return secrets.token_urlsafe(16)


def clean_name(name: str | None) -> str:
    """The name as a person reads it: the last part of a path, one line, at most 200 characters."""
    base = re.split(r"[\\/]", name or "")[-1]
    return notedoc.clean_label(base, s.MAX_NAME) or "file"


# --- Storage ------------------------------------------------------------------------------------------------------


def used(db: Session, account_id: int) -> int:
    return content.counts(db, account_id).bytes


def limits(db: Session, account: Account) -> dict[str, Any]:
    """What the page needs before an upload: the limit per file, the storage, the operator's switch for cards."""
    taken = used(db, account.id)
    limit = account.storage_limit
    return {
        "max_mb": settings_service.upload_max_mb(db),
        "used": taken,
        "limit": limit,
        "full": limit is not None and taken >= limit,
        "link_previews": bool(settings_service.get(db, "link_previews")),
    }


def _room_for(db: Session, owner_id: int) -> tuple[int | None, int, int | None]:
    """How many bytes the owner may still take (``None``: no limit), with what is taken and the limit."""
    owner = db.get(Account, owner_id)
    limit = owner.storage_limit if owner is not None else None
    taken = used(db, owner_id)
    if limit is None:
        return None, taken, None
    return max(0, limit - taken), taken, limit


def has_room(db: Session, owner_id: int, size: int) -> bool:
    """Whether ``size`` more bytes fit into the owner's storage, with what uploads in progress have claimed."""
    room, _taken, _limit = _room_for(db, owner_id)
    if room is None:
        return True
    with _claiming:
        claimed = sum(_claimed.get(owner_id, {}).values())
    return size <= room - claimed


# --- Coming in ----------------------------------------------------------------------------------------------------


@dataclass
class Upload:
    attachment_id: str
    note_id: str
    owner_id: int
    uploader_id: int
    name: str
    max_bytes: int
    #: Bytes the owner may still take; ``None`` without a limit.
    room: int | None
    taken: int
    limit: int | None
    #: What the device means the file to be (NOTES-18, ``sketches.ROLES``); ``None``: whatever its content is.
    role: str | None = None
    #: The upload's claim on the storage (``_claimed``).
    token: str = field(default_factory=lambda: secrets.token_hex(8))


def _too_large(name: str, size: int, max_mb: int) -> AttachmentError:
    return AttachmentError("attachment_too_large", "The file is larger than allowed.", 413, name=name, size=size,
                           max_mb=max_mb)


def _full(taken: int, limit: int | None) -> AttachmentError:
    return AttachmentError("storage_limit_reached", "The storage of the account is full.", 507, used=taken,
                           limit=limit)


def existing(db: Session, attachment_id: str, note_id: str) -> Attachment | None:
    """The attachment of this id when it is there already for this note (an upload sent twice); "not found" when the id
    belongs to another note, as for any attachment one may not see."""
    found = db.get(Attachment, attachment_id)
    if found is None:
        return None
    if found.note_id != note_id:
        raise AttachmentError("not_found", "Not found.", 404)
    return found


def begin(db: Session, account: Account, note_id: str, attachment_id: str, name: str | None,
          declared: int | None, role: str | None = None) -> Upload | Attachment:
    """Checks an upload before its body is read: the right to write the note, the id, the role, the limit per file,
    the storage. Returns the attachment when it is there already."""
    from . import sketches

    note = notes.note_for(db, account, note_id, write=True)
    if note.locked:
        # A locked note takes only what the device encrypted (NOTES-16, ``PUT /api/vault/attachments``).
        raise AttachmentError("note_locked", "The note is locked.", 409)
    if not _ID.match(attachment_id or ""):
        raise AttachmentError("invalid_input", "The input is not valid.", 422, fields=["id"])
    if role is not None and role not in sketches.ROLES:
        raise AttachmentError("invalid_input", "The input is not valid.", 422, fields=["as"])
    found = existing(db, attachment_id, note.id)
    if found is not None:
        return found
    clean = clean_name(name)
    max_mb = settings_service.upload_max_mb(db)
    max_bytes = max_mb * MB
    if declared is not None and declared > max_bytes:
        raise _too_large(clean, declared, max_mb)
    room, taken, limit = _room_for(db, note.owner_id)
    upload = Upload(attachment_id=attachment_id, note_id=note.id, owner_id=note.owner_id, uploader_id=account.id,
                    name=clean, max_bytes=max_bytes, room=room, taken=taken, limit=limit, role=role)
    if room is not None:
        with _claiming:
            claims = _claimed.setdefault(note.owner_id, {})
            free = room - sum(claims.values())
            if free <= 0 or (declared is not None and declared > free):
                raise _full(taken, limit)
            claims[upload.token] = declared or 0
    return upload


def _room_left(upload: Upload, size: int) -> None:
    """The upload has received ``size`` bytes: past the room the owner had, less what the other uploads claimed, it
    stops. (An upload without a declared length claims nothing; ``finish`` decides between such ones.)"""
    if upload.room is None:
        return
    with _claiming:
        others = sum(value for token, value in _claimed.get(upload.owner_id, {}).items() if token != upload.token)
    if size + others > upload.room:
        raise _full(upload.taken, upload.limit)


def release(upload: Upload) -> None:
    """The upload is through, refused or broken off: its claim goes."""
    with _claiming:
        claims = _claimed.get(upload.owner_id)
        if claims is not None:
            claims.pop(upload.token, None)
            if not claims:
                _claimed.pop(upload.owner_id, None)


async def receive(upload: Upload, chunks: AsyncIterator[bytes]) -> Path:
    """The body into a work file, counted while it comes: past the limit per file or the storage it stops and the
    work file goes."""
    root().mkdir(parents=True, exist_ok=True)
    work = root() / f"{WORK_PREFIX}{secrets.token_hex(16)}"
    received = 0
    waiting: list[bytes] = []
    sink = await asyncio.to_thread(open, work, "wb")
    try:
        async for chunk in chunks:
            received += len(chunk)
            if received > upload.max_bytes:
                raise _too_large(upload.name, received, upload.max_bytes // MB)
            _room_left(upload, received)
            waiting.append(chunk)
            if sum(map(len, waiting)) >= _CHUNK:
                await asyncio.to_thread(sink.write, b"".join(waiting))
                waiting.clear()
        if waiting:
            await asyncio.to_thread(sink.write, b"".join(waiting))
        await asyncio.to_thread(sink.close)
    except BaseException:
        sink.close()
        work.unlink(missing_ok=True)
        raise
    return work


def _write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f"{WORK_PREFIX}{secrets.token_hex(8)}")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def finish(upload: Upload, work: Path) -> tuple[Attachment, bool]:
    """Prepares the received file (``media.prepare``, in a worker), checks the owner's storage once more, puts its
    files in place and writes its row. Returns the attachment and whether it is new."""
    from ..db import SessionLocal

    try:
        if work.stat().st_size == 0:
            raise AttachmentError("attachment_empty", "The file is empty.", 400)
        prepared = _prepare(work, upload.role)
        name = upload.name
        if prepared.suffix and not name.lower().endswith(prepared.suffix):
            name = notedoc.clean_label(re.sub(r"\.[A-Za-z0-9]{1,8}$", "", name) + prepared.suffix, s.MAX_NAME) or name
        with _placing, SessionLocal() as db:
            found = existing(db, upload.attachment_id, upload.note_id)
            if found is not None:
                return found, False
            # Uploads at once each checked their own bytes: here, one at a time, against what is taken now.
            owner = db.get(Account, upload.owner_id)
            limit = owner.storage_limit if owner is not None else None
            written = Path(prepared.redrawn_file) if prepared.redrawn_file else None
            if written is not None and written.parent != root():
                raise ValueError("a prepared file outside the attachments folder")
            if limit is not None:
                coming = len(prepared.redrawn) if prepared.redrawn is not None else \
                    (written or work).stat().st_size
                coming += sum(len(data) for data in (prepared.view, prepared.thumb) if data is not None)
                taken = used(db, upload.owner_id)
                if taken + coming > limit:
                    raise _full(taken, limit)
            target = path_of(upload.attachment_id)
            if prepared.redrawn is not None:
                _write(target, prepared.redrawn)
                work.unlink(missing_ok=True)
            elif written is not None:
                os.replace(written, target)
                work.unlink(missing_ok=True)
            else:
                os.replace(work, target)
            stored = target.stat().st_size
            size = stored
            for suffix, data in ((VIEW, prepared.view), (THUMB, prepared.thumb)):
                if data is not None:
                    _write(path_of(upload.attachment_id, suffix), data)
                    stored += len(data)
            row = Attachment(id=upload.attachment_id, note_id=upload.note_id, owner_id=upload.owner_id,
                             uploaded_by=upload.uploader_id, kind=prepared.kind, name=name, mime=prepared.mime,
                             size=size, stored=stored, width=prepared.width, height=prepared.height,
                             pages=prepared.pages, duration_ms=prepared.duration_ms,
                             has_view=prepared.view is not None, has_thumb=prepared.thumb is not None,
                             inline=prepared.inline, preview_failed=prepared.preview_failed, unref_at=utcnow())
            db.add(row)
            try:
                db.flush()
                _mark_referenced(db, [row.id])
                note = db.get(Note, upload.note_id)
                if note is not None:
                    # Lists show the note's picture (NOTES-6): they load again.
                    note.listed_at = utcnow()
                db.commit()
            except IntegrityError:
                db.rollback()
                _remove_files([row.id])
                raise _not_found() from None
            logger.info("Attachment stored note=%s attachment=%s kind=%s size=%s", upload.note_id, row.id,
                        row.kind, row.size)
        for hook in STORED_HOOKS:
            hook(row)
        return row, True
    finally:
        work.unlink(missing_ok=True)
        work.with_name(work.name + ".m4a").unlink(missing_ok=True)


def _prepare(work: Path, role: str | None) -> media.Prepared:
    """What the file is: by its content alone, or (NOTES-18) checked against the role the device gave. Read in a worker
    (``media.prepare``); a file with a role that the worker cannot read is not what it was sent as."""
    from . import media_worker, sketches

    try:
        return media.prepare(work, role)
    except (sketches.WrongKind, media_worker.MediaFailed) as exc:
        logger.info("An upload is not what its role says role=%s reason=%s", role, exc)
        raise AttachmentError("attachment_wrong_kind", "The file is not what it was sent as.", 422, role=role) from None


def store_bytes(db: Session, note_id: str, owner_id: int, kind: str, name: str, data: bytes,
                mime: str = "image/webp") -> Attachment:
    """A small file the server made itself (the picture of a link card), as an attachment of the note. The caller
    commits."""
    attachment_id = new_id()
    _write(path_of(attachment_id), data)
    row = Attachment(id=attachment_id, note_id=note_id, owner_id=owner_id, kind=kind, name=clean_name(name),
                     mime=mime, size=len(data), stored=len(data), inline=True, unref_at=utcnow())
    db.add(row)
    return row


# --- Reading ------------------------------------------------------------------------------------------------------


def _can_read(db: Session, account: Account, note: Note | None) -> bool:
    return note is not None and notes.access_to(db, account, note) in (Access.WRITE, Access.READ)


def readable(db: Session, account: Account, attachment: Attachment) -> bool:
    """Whether the account may open the attachment: it may read the note it belongs to, or a note of the same owner
    that names it or named it (its history shows it)."""
    if _can_read(db, account, db.get(Note, attachment.note_id)):
        return True
    others = db.scalars(select(Note).where(Note.id.in_(_naming(attachment.id)), Note.owner_id == attachment.owner_id,
                                           Note.id != attachment.note_id))
    return any(_can_read(db, account, note) for note in others)


def _naming(attachment_id: str) -> Any:
    """The notes that name the attachment or named it, as a subquery."""
    return (select(AttachmentRef.note_id).where(AttachmentRef.attachment_id == attachment_id)
            .union(select(AttachmentMention.note_id).where(AttachmentMention.attachment_id == attachment_id)))


def get_for(db: Session, account: Account, attachment_id: str) -> Attachment:
    found = db.get(Attachment, attachment_id) if _ID.match(attachment_id or "") else None
    if found is None or not readable(db, account, found):
        raise _not_found()
    return found


def out(attachment: Attachment) -> dict[str, Any]:
    """An attachment as the page and the iOS app read it."""
    return {
        "id": attachment.id,
        "note_id": attachment.note_id,
        "kind": attachment.kind,
        "name": attachment.name,
        "mime": attachment.mime,
        "size": attachment.size,
        "width": attachment.width,
        "height": attachment.height,
        "pages": attachment.pages,
        "duration_ms": attachment.duration_ms,
        "view": attachment.has_view,
        "thumb": attachment.has_thumb,
        "inline": attachment.inline,
        "preview_failed": attachment.preview_failed,
        "created_at": attachment.created_at.isoformat() if attachment.created_at else None,
        # Encrypted on the device (NOTES-16): the file is all the server has, the page opens it with the vault key.
        "sealed": attachment.kind == "sealed",
    }


def of_note(db: Session, account: Account, note_id: str) -> list[dict[str, Any]]:
    """Every attachment the note names today, named in its history or was attached to it: what the blocks of an open
    note and of its versions draw. Ids the note names that belong to another owner are left out."""
    note = notes.note_for(db, account, note_id)
    named = (select(AttachmentRef.attachment_id).where(AttachmentRef.note_id == note.id)
             .union(select(AttachmentMention.attachment_id).where(AttachmentMention.note_id == note.id)))
    rows = db.scalars(select(Attachment).where((Attachment.note_id == note.id)
                                               | (Attachment.id.in_(named) & (Attachment.owner_id == note.owner_id)))
                      .order_by(Attachment.created_at, Attachment.id))
    return [out(row) for row in rows]


# --- Where attachments stand --------------------------------------------------------------------------------------


#: The names of the blocks as Yjs writes them into an update: a note whose stored bytes hold none of them names no
#: attachment, and its document need not be read (10,000 notes made at once stay fast).
_BLOCK_NAMES = tuple(name.encode() for name in s.ATOMS)


def _updates_of(db: Session, note: Note) -> list[bytes]:
    return list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note.id)
                           .order_by(NoteUpdate.id))) if note.id else []


def _document_of(db: Session, note: Note, updates: list[bytes] | None = None) -> dict[str, Any] | None:
    try:
        if updates is None:
            updates = _updates_of(db, note)
        return notedoc.to_json(notedoc.load(note.ydoc or None, updates))
    except Exception:  # noqa: BLE001 - a document that cannot be read keeps what was known before
        logger.warning("Reading the attachments of a note failed note=%s", note.id)
        return None


def _mark_referenced(db: Session, ids: Iterable[str]) -> None:
    """``unref_at`` of the attachments follows whether any note names them."""
    wanted = list(set(ids))
    if not wanted:
        return
    named = set(db.scalars(select(AttachmentRef.attachment_id).where(AttachmentRef.attachment_id.in_(wanted))))
    for row in db.scalars(select(Attachment).where(Attachment.id.in_(wanted))):
        if row.id in named:
            row.unref_at = None
        elif row.unref_at is None:
            row.unref_at = utcnow()


def sync_refs(db: Session, note: Note) -> None:
    """``attachment_refs`` follows the note's document: a hook on the text (``notes.on_text_written``), in the same
    transaction. Never raises."""
    try:
        old = {ref.attachment_id: ref for ref in db.scalars(select(AttachmentRef)
                                                            .where(AttachmentRef.note_id == note.id))}
        updates = _updates_of(db, note)
        if not old and not any(name in part for part in (note.ydoc or b"", *updates) for name in _BLOCK_NAMES):
            return
        document = _document_of(db, note, updates)
        if document is None:
            return
        ids = notedoc.attachment_refs(document)
        if not ids and not old:
            return
        if ids and not old:
            # A note made in this transaction: written first, then what points at it.
            db.flush()
        for gone in set(old) - set(ids):
            db.delete(old[gone])
        for position, found in enumerate(ids):
            if found in old:
                old[found].position = position
            else:
                db.add(AttachmentRef(note_id=note.id, attachment_id=found, position=position))
        new = set(ids) - set(old)
        if new:
            # Its versions may name them from now on (NOTES-15 AC-3): remembered for as long as the note lives.
            known = set(db.scalars(select(AttachmentMention.attachment_id)
                                   .where(AttachmentMention.note_id == note.id,
                                          AttachmentMention.attachment_id.in_(new))))
            for found in new - known:
                db.add(AttachmentMention(note_id=note.id, attachment_id=found))
        db.flush()
        _mark_referenced(db, set(old) ^ set(ids))
    except Exception:
        logger.exception("Following the attachments of a note failed note=%s", note.id)


# --- Going away ---------------------------------------------------------------------------------------------------


def _remove_files(ids: Iterable[str]) -> None:
    for found in ids:
        for suffix in ("", VIEW, THUMB):
            try:
                path_of(found, suffix).unlink(missing_ok=True)
            except OSError:
                logger.warning("An attachment file could not be removed attachment=%s", found)


def _after_commit(db: Session, ids: list[str]) -> None:
    """The files of ``ids`` go once the transaction that removed their rows is committed, not before."""
    if not ids:
        return
    pending: list[str] = db.info.setdefault("attachments_to_remove", [])
    if not pending:
        def remove(session: Session) -> None:
            gone = session.info.pop("attachments_to_remove", [])
            _remove_files(gone)

        def forget(session: Session, *_args: Any) -> None:
            session.info.pop("attachments_to_remove", None)

        event.listen(db, "after_commit", remove, once=True)
        event.listen(db, "after_rollback", forget, once=True)
    pending.extend(ids)


def _purging(db: Session, note_ids: list[str]) -> None:
    """Notes about to go for good (``trash.PURGE_HOOKS``): their attachments go too, unless another note of the same
    owner names one, or a version of one still does (NOTES-15 AC-3); then it moves there (to one that names it today
    first), and the cleanup decides about it as about any other."""
    rows = list(db.scalars(select(Attachment).where(Attachment.note_id.in_(note_ids))))
    if not rows:
        return
    going = set(note_ids)
    gone: list[str] = []
    versions: dict[str, set[str]] = {}
    for row in rows:
        if row.kind == "sealed":
            # Encrypted for its own note only (NOTES-16): nowhere else could open it.
            gone.append(row.id)
            db.delete(row)
            continue
        other = db.scalar(select(AttachmentRef.note_id).join(Note, Note.id == AttachmentRef.note_id)
                          .where(AttachmentRef.attachment_id == row.id, Note.owner_id == row.owner_id,
                                 AttachmentRef.note_id.not_in(going)).limit(1))
        if other is None:
            for candidate in db.scalars(select(AttachmentMention.note_id)
                                        .join(Note, Note.id == AttachmentMention.note_id)
                                        .where(AttachmentMention.attachment_id == row.id,
                                               Note.owner_id == row.owner_id,
                                               AttachmentMention.note_id.not_in(going))):
                if candidate not in versions:
                    versions[candidate] = _named_by_versions(db, candidate, set())
                if "*" in versions[candidate] or row.id in versions[candidate]:
                    other = candidate
                    break
        if other is not None:
            row.note_id = other
            if row.unref_at is None and db.scalar(select(AttachmentRef.note_id)
                                                  .where(AttachmentRef.attachment_id == row.id,
                                                         AttachmentRef.note_id.not_in(going)).limit(1)) is None:
                # Kept only by a version: from now on no note names it.
                row.unref_at = utcnow()
        else:
            gone.append(row.id)
            db.delete(row)
    db.flush()
    _after_commit(db, gone)
    if gone:
        logger.info("Attachments removed with their notes count=%s", len(gone))


def _named_by_versions(db: Session, note_id: str, skip: set[int]) -> set[str]:
    from ..models_history import NoteVersion

    found: set[str] = set()
    for version_id, state, sealed in db.execute(select(NoteVersion.id, NoteVersion.state, NoteVersion.sealed)
                                                .where(NoteVersion.note_id == note_id)):
        if version_id in skip:
            continue
        if sealed:
            # Encrypted (NOTES-16): what it names is unknown, so it keeps everything.
            return {"*"}
        try:
            found.update(notedoc.attachment_refs(notedoc.load(state)))
        except Exception:  # noqa: BLE001 - a version that cannot be read keeps everything
            logger.warning("Reading the attachments of a version failed note=%s", note_id)
            return {"*"}
    return found


def collect(db: Session, note_ids: Iterable[str] | None = None, skip_versions: Iterable[int] = ()) -> int:
    """Removes attachments no note names for longer than ``GRACE`` and no version of a note of their owner that named
    them names either (but those in ``skip_versions``, which are about to go). With ``note_ids`` only the attachments
    of those notes or named by them. The caller commits. Returns how many went."""
    query = select(Attachment).where(Attachment.unref_at.is_not(None), Attachment.unref_at < utcnow() - GRACE,
                                     Attachment.kind != "sealed")
    if note_ids is not None:
        wanted = list(set(note_ids))
        if not wanted:
            return 0
        mentioned = select(AttachmentMention.attachment_id).where(AttachmentMention.note_id.in_(wanted))
        query = query.where(Attachment.note_id.in_(wanted) | Attachment.id.in_(mentioned))
    rows = list(db.scalars(query))
    if not rows:
        return 0
    ids = [row.id for row in rows]
    named = set(db.scalars(select(AttachmentRef.attachment_id).where(AttachmentRef.attachment_id.in_(ids))))
    holders: dict[str, list[str]] = {row.id: [row.note_id] for row in rows}
    owners = {row.id: row.owner_id for row in rows}
    for note_id, attachment_id, owner_id in db.execute(
        select(AttachmentMention.note_id, AttachmentMention.attachment_id, Note.owner_id)
        .join(Note, Note.id == AttachmentMention.note_id).where(AttachmentMention.attachment_id.in_(ids))
    ):
        if owner_id == owners[attachment_id] and note_id not in holders[attachment_id]:
            holders[attachment_id].append(note_id)
    skip = set(skip_versions)
    versions: dict[str, set[str]] = {}
    gone: list[str] = []
    for row in rows:
        if row.id in named:
            continue
        kept = False
        for note_id in holders[row.id]:
            if note_id not in versions:
                versions[note_id] = _named_by_versions(db, note_id, skip)
            if "*" in versions[note_id] or row.id in versions[note_id]:
                kept = True
                break
        if not kept:
            gone.append(row.id)
            db.delete(row)
    db.flush()
    _after_commit(db, gone)
    return len(gone)


def _versions_going(db: Session, version_ids: list[int]) -> None:
    """Versions about to be thinned (``history.VERSIONS_PURGED_HOOKS``): attachments only they named go with them."""
    from ..models_history import NoteVersion

    note_ids = set(db.scalars(select(NoteVersion.note_id).where(NoteVersion.id.in_(version_ids))))
    count = collect(db, note_ids, skip_versions=version_ids)
    if count:
        logger.info("Attachments removed with thinned versions count=%s", count)


def _sweep_files() -> int:
    """Files without a row (their account went for good, a backup brought back without them) and old work files."""
    from ..db import SessionLocal

    folder = root()
    if not folder.is_dir():
        return 0
    with SessionLocal() as db:
        known = set(db.scalars(select(Attachment.id)))
    now = utcnow().timestamp()
    removed = 0
    for entry in folder.iterdir():
        try:
            if not entry.is_file() or entry.is_symlink():
                continue
            age = now - entry.stat().st_mtime
            if entry.name.startswith(WORK_PREFIX):
                if age > WORK_AGE.total_seconds():
                    entry.unlink()
                    removed += 1
                continue
            if not backups.MEDIA_NAME.match(entry.name):
                continue
            if entry.name.split(".", 1)[0] not in known and age > ORPHAN_AGE.total_seconds():
                entry.unlink()
                removed += 1
        except OSError:
            logger.warning("A file in the attachments folder could not be removed")
    return removed


def cleanup() -> None:
    """The cleanup round: attachments nobody needs any more, then files without a row."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        count = collect(db)
        db.commit()
    files = _sweep_files()
    if count or files:
        logger.info("Attachments cleaned up removed=%s files=%s", count, files)


# --- The gallery (AC-7) -------------------------------------------------------------------------------------------

SORTS = ("newest", "largest")


def gallery(db: Session, account: Account, kind: str | None = None, sort: str = "newest", offset: int = 0,
            limit: int = 120) -> dict[str, Any]:
    """Every attachment in the account's living notes, once each, with the note it stands in (its own note where
    that names it), counted per kind; filtered by kind, newest or largest first."""
    rows = db.execute(
        select(Attachment, AttachmentRef.note_id, Note.title)
        .join(AttachmentRef, AttachmentRef.attachment_id == Attachment.id)
        .join(Note, Note.id == AttachmentRef.note_id)
        .where(Note.owner_id == account.id, Note.deleted_at.is_(None), Attachment.owner_id == account.id,
               Attachment.kind.not_in(HIDDEN_KINDS))
    ).all()
    seen: dict[str, tuple[Attachment, str, str]] = {}
    for row, note_id, title in rows:
        have = seen.get(row.id)
        if have is None or (note_id == row.note_id and have[1] != row.note_id):
            seen[row.id] = (row, note_id, title)
    every = list(seen.values())
    counts = {name: 0 for name in GALLERY_KINDS}
    for row, _, _ in every:
        counts[row.kind if row.kind in counts else "file"] += 1
    total_bytes = sum(row.stored for row, _, _ in every)
    chosen = [entry for entry in every if not kind or (entry[0].kind if entry[0].kind in counts else "file") == kind]
    if sort == "largest":
        chosen.sort(key=lambda entry: (-entry[0].size, entry[0].id))
    else:
        chosen.sort(key=lambda entry: (entry[0].created_at, entry[0].id), reverse=True)
    page = chosen[offset: offset + limit]
    return {
        "total": len(chosen),
        "all": len(every),
        "bytes": total_bytes,
        "counts": counts,
        "items": [{**out(row), "note": {"id": note_id, "title": title}} for row, note_id, title in page],
    }


# --- Lists and tiles (NOTES-6) ------------------------------------------------------------------------------------


def media_of(db: Session, _account: Account, rows: list[Any]) -> dict[str, dict[str, Any]]:
    """The note's first picture, scan, sketch or video and how many of its kind there are, for a whole list at
    once (``notes_list.ITEM_EXTRAS``)."""
    owners = {row.id: row.owner_id for row in rows}
    if not owners:
        return {}
    found: dict[str, dict[str, Any]] = {}
    counted: dict[str, dict[str, int]] = {}
    ids = list(owners)
    for start in range(0, len(ids), 500):
        chunk = ids[start: start + 500]
        for note_id, attachment_id, kind, owner_id, thumb in db.execute(
            select(AttachmentRef.note_id, Attachment.id, Attachment.kind, Attachment.owner_id, Attachment.has_thumb)
            .join(Attachment, Attachment.id == AttachmentRef.attachment_id)
            .where(AttachmentRef.note_id.in_(chunk), Attachment.kind.in_(PICTURE_KINDS))
            .order_by(AttachmentRef.note_id, AttachmentRef.position)
        ):
            if owner_id != owners.get(note_id):
                continue
            counted.setdefault(note_id, {}).setdefault(kind, 0)
            counted[note_id][kind] += 1
            if note_id not in found:
                found[note_id] = {"kind": kind, "url": f"/api/attachments/{attachment_id}/thumb" if thumb else None}
    return {note_id: {"media": {**first, "count": counted[note_id][first["kind"]]}}
            for note_id, first in found.items()}


# --- The export (NOTES-17) ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AttachmentFile:
    """An attachment of a note with the path of its file, for whoever writes it next to the note's Markdown."""

    id: str
    name: str
    kind: str
    mime: str
    size: int
    path: Path


def files_of(db: Session, note_id: str) -> list[AttachmentFile]:
    """Every attachment the note names today (its document as stored, not the lagging ``attachment_refs``), in the
    order of its text, each once, with the path of its file. Pictures of link cards are there too (kind
    ``linkimage``). Ids that name nothing, files missing on disk, and attachments of another owner are left out. The
    caller checked that the account may read the note."""
    note = db.get(Note, note_id)
    if note is None:
        return []
    document = _document_of(db, note)
    ids = notedoc.attachment_refs(document) if document is not None else []
    if not ids:
        return []
    rows = {row.id: row for row in db.scalars(select(Attachment).where(Attachment.id.in_(ids),
                                                                       Attachment.owner_id == note.owner_id))}
    files: list[AttachmentFile] = []
    for found in ids:
        row = rows.get(found)
        if row is None:
            continue
        path = path_of(row.id)
        if path.is_file():
            files.append(AttachmentFile(id=row.id, name=row.name, kind=row.kind, mime=row.mime, size=row.size,
                                        path=path))
    return files


#: The kinds of the export (``export.KINDS``) for those of the attachments; a link card's picture is no file of its own
#: there (the card is a link in Markdown and a box in the PDF).
_EXPORT_KINDS = {"image": "image", "scan": "image", "drawing": "drawing", "recording": "recording", "video": "video",
                 "pdf": "pdf", "file": "file"}


def export_files(db: Session, note: Note) -> list[Any]:
    """The note's attachments as the export takes them (``export.ATTACHMENT_SOURCES``): the files the note names in
    the order of its text, each opened only when it is written; a picture no PDF can draw (HEIC) through its WebP."""
    from .export import ExportFile

    found: list[Any] = []
    entries = files_of(db, note.id)
    rows = {row.id: row for row in db.scalars(select(Attachment).where(Attachment.id.in_(
        [entry.id for entry in entries])))} if entries else {}
    for entry in entries:
        kind = _EXPORT_KINDS.get(entry.kind)
        row = rows.get(entry.id)
        if kind is None or row is None:
            continue
        picture = None
        if row.has_view and kind == "image":
            view = path_of(row.id, VIEW)
            picture = (lambda shown=view: (shown.read_bytes(), "webp"))
        found.append(ExportFile(id=entry.id, name=entry.name, kind=kind, size=entry.size,
                                open=(lambda path=entry.path: open(path, "rb")), picture=picture))  # noqa: SIM115
    return found


def export_total(db: Session, note_ids: Iterable[str]) -> int:
    """The bytes of the attachments of these notes, each once (``export.ATTACHMENT_TOTALS``, the size the dialog
    names)."""
    ids = list(note_ids)
    if not ids:
        return 0
    named = select(AttachmentRef.attachment_id).where(AttachmentRef.note_id.in_(ids))
    return int(db.scalar(select(func.coalesce(func.sum(Attachment.size), 0))
                         .where(Attachment.id.in_(named), Attachment.kind != LINK_PICTURE)) or 0)


# --- Hooks into the frame -----------------------------------------------------------------------------------------


def _count(db: Session, account_id: int) -> content.Counts:
    size = db.scalar(select(func.coalesce(func.sum(Attachment.stored), 0)).where(Attachment.owner_id == account_id))
    return content.Counts(bytes=int(size or 0))


def register() -> None:
    """Once per start, each hook once: where attachments stand, the lists' pictures, the bytes they take, going away
    with their notes and versions, the cleanup round."""
    from . import cleanup as rounds
    from . import history, notes_list, trash

    notes.on_text_written(sync_refs)
    if media_of not in notes_list.ITEM_EXTRAS:
        notes_list.ITEM_EXTRAS.append(media_of)
    if _count not in content._counters:
        content.register_counter(_count)
    if _purging not in trash.PURGE_HOOKS:
        trash.PURGE_HOOKS.append(_purging)
    if _versions_going not in history.VERSIONS_PURGED_HOOKS:
        history.VERSIONS_PURGED_HOOKS.append(_versions_going)
    if all(job is not cleanup for _, job in rounds._jobs):
        rounds.register("attachments", cleanup)
    from . import export

    if export_files not in export.ATTACHMENT_SOURCES:
        export.ATTACHMENT_SOURCES.append(export_files)
    if export_total not in export.ATTACHMENT_TOTALS:
        export.ATTACHMENT_TOTALS.append(export_total)
    from . import sketches

    sketches.register()


def remove_all_of(db: Session, note_ids: Iterable[str]) -> None:
    """Rows and files of the attachments of notes removed without the trash (an empty note discarded)."""
    ids = list(db.scalars(select(Attachment.id).where(Attachment.note_id.in_(list(note_ids)))))
    if ids:
        db.execute(delete(Attachment).where(Attachment.id.in_(ids)))
        _after_commit(db, ids)
