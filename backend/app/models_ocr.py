"""Tables of the work queue and of text recognition (NOTES-11), on the same ``Base`` as everything else.

``work_jobs`` is the queue of work done in the background (``services/workqueue.py``): one row per piece of work that
is still to do, with its kind (``ocr`` for text recognition; other features may add theirs) and what it is about
(``ref``). A finished job goes; a job that was running when the server stopped is queued again at the next start.

``attachment_ocr`` holds how far the recognition of an attachment got, ``attachment_texts`` the text of each of its
pages (a picture has one). Both go with their attachment (``ON DELETE CASCADE``).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow

# --- The work queue ---------------------------------------------------------------------------------------------------

#: Waiting for its turn (``run_after`` says from when).
QUEUED = "queued"
#: Taken by the worker.
RUNNING = "running"


class WorkJob(Base):
    """A piece of work waiting or running in the background."""

    __tablename__ = "work_jobs"
    __table_args__ = (Index("ix_work_jobs_kind_ref", "kind", "ref", unique=True),
                      Index("ix_work_jobs_turn", "state", "run_after", "id"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: What kind of work: the handler registered for it does it (``ocr``).
    kind: Mapped[str] = mapped_column(String(32))
    #: What it is about (an attachment's id).
    ref: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(16), default=QUEUED)
    #: Not before this; a job that did a part of its work comes back with "now", behind the others waiting.
    run_after: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: Failed turns so far.
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    #: Whose work it is (an attachment's owner): the queue serves the accounts in rounds.
    account_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


# --- Text recognition -------------------------------------------------------------------------------------------------

#: The states of an attachment's recognition.
OCR_QUEUED = "queued"
OCR_WORKING = "working"
OCR_DONE = "done"
#: Every try failed, or the file could not be read: the attachment stays usable without text (EC-2).
OCR_FAILED = "failed"
#: No Tesseract on this server: only the text a PDF carries itself was read.
OCR_UNAVAILABLE = "unavailable"
#: The note is locked (NOTES-16): nothing is read (EC-7).
OCR_LOCKED = "locked"
#: Uploaded by the iOS app, which brings the text itself (AC-5); the server waits for it a while.
OCR_DEVICE = "device"

#: The states of one page.
PAGE_PENDING = "pending"
PAGE_DONE = "done"
#: Read, but nothing worth keeping on it (a holiday photo, EC-3).
PAGE_EMPTY = "empty"
PAGE_FAILED = "failed"


class AttachmentOcr(Base):
    """How far the recognition of an attachment got."""

    __tablename__ = "attachment_ocr"

    attachment_id: Mapped[str] = mapped_column(ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default=OCR_QUEUED)
    #: Pages of the attachment (a picture 1); 0 while not known yet.
    pages: Mapped[int] = mapped_column(Integer, default=0)
    #: The languages it was read with (Tesseract's codes joined with "+").
    languages: Mapped[str] = mapped_column(String(64), default="")
    #: Where the text came from at last: ``layer`` (the PDF's own), ``ocr``, ``device``, ``mixed``.
    source: Mapped[str] = mapped_column(String(16), default="")
    #: Why it failed (``broken``, ``timeout``, ``failed``), for the log and the page.
    error: Mapped[str] = mapped_column(String(32), default="")
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class AttachmentText(Base):
    """The text of one page of an attachment."""

    __tablename__ = "attachment_texts"

    attachment_id: Mapped[str] = mapped_column(ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True)
    #: From 1.
    page: Mapped[int] = mapped_column(Integer, primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default=PAGE_PENDING)
    text: Mapped[str] = mapped_column(Text, default="")
    #: The language the text is in, of the operator's (``de``, ``en``, ...); empty when it could not be told.
    language: Mapped[str] = mapped_column(String(8), default="")
    #: ``layer``, ``ocr`` or ``device``.
    source: Mapped[str] = mapped_column(String(16), default="")
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
