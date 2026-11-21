"""Tables of the attachments (NOTES-10), on the same ``Base`` as everything else.

``attachments`` holds one row per file in ``<data>/attachments/``: what the server found it to be, its name, its size,
and the note it was attached to (its home). The file itself is never in the database, and never in the note's
document, which names it by its id only.

``attachment_refs`` says which notes name which attachment today, in the order of their text. It follows the document
(``services/attachments.sync_refs``, a hook on the text) and is what the gallery, the lists and the rights read.

``attachment_mentions`` says which notes have ever named an attachment: today, or in a version of their history. It
only grows (a note gone for good takes its rows along) and tells whose versions keep an attachment (NOTES-15 AC-3).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class Attachment(Base):
    """A file attached to a note."""

    __tablename__ = "attachments"
    __table_args__ = (Index("ix_attachments_owner_created", "owner_id", "created_at"),)

    #: Made by the browser (22 characters of base64url), the name of the file in the attachments folder.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    #: The note it was attached to. When that note goes for good while another of the same owner still names it, the
    #: attachment moves there (``services/attachments.py``).
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    #: Whose storage it counts towards: the owner of the note.
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    #: image, video, pdf, file; later scan, drawing, recording; linkimage for the picture of a link card.
    kind: Mapped[str] = mapped_column(String(16))
    #: The name as the member gave it (one line, at most 200 characters).
    name: Mapped[str] = mapped_column(String(200), default="")
    #: The type it is given out with, decided from its content.
    mime: Mapped[str] = mapped_column(String(100), default="application/octet-stream")
    #: Bytes of the file.
    size: Mapped[int] = mapped_column(Integer, default=0)
    #: Bytes it takes on disk with its picture for the browser and its preview: what counts towards the storage.
    stored: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Pages of a PDF.
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Length of a video, in milliseconds.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Whether ``<id>.view`` (a WebP any browser shows) and ``<id>.thumb`` (the preview) exist.
    has_view: Mapped[bool] = mapped_column(default=False)
    has_thumb: Mapped[bool] = mapped_column(default=False)
    #: Whether the file itself may be shown in the page (a picture drawn anew, a PDF, a video); everything else is
    #: only downloaded.
    inline: Mapped[bool] = mapped_column(default=False)
    #: Reading it went past the limits of the media worker (memory, time, pixels): a file to download without a
    #: preview, whatever its content (``services/media_worker.py``).
    preview_failed: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: Since when no note names it (``None`` while one does): kept for the history, and for a while for "undo".
    unref_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True, index=True)


class AttachmentRef(Base):
    """A note names an attachment in its text today, at ``position`` (0 for the first)."""

    __tablename__ = "attachment_refs"
    __table_args__ = (Index("ix_attachment_refs_attachment", "attachment_id"),)

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    #: No foreign key: a note names an attachment the moment it is dropped in, before its upload is through.
    attachment_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class AttachmentMention(Base):
    """A note named an attachment at some time; its versions may still name it."""

    __tablename__ = "attachment_mentions"
    __table_args__ = (Index("ix_attachment_mentions_attachment", "attachment_id"),)

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    attachment_id: Mapped[str] = mapped_column(String(32), primary_key=True)
