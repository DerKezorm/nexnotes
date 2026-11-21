"""Tags of notes (NOTES-5): the words with ``#`` the server found in a note's text.

A tag is text in the note; nothing in the document marks it. This table is what the server read from the text, one
row per note and spelling, kept in step by ``services/tags.py`` whenever ``Note.text`` follows the document.
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


class NoteTag(Base):
    """One tag in one note, in one spelling."""

    __tablename__ = "note_tags"
    __table_args__ = (Index("ix_note_tags_key_note", "key", "note_id"),)

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    #: As typed, without the ``#`` (NFC): what a list shows.
    label: Mapped[str] = mapped_column(String(64), primary_key=True)
    #: The same tag whatever the case (NFC, case folded): what tags are compared and grouped by.
    key: Mapped[str] = mapped_column(String(200))
    #: How often it stands in the note.
    count: Mapped[int] = mapped_column(Integer, default=1)
