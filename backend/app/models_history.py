"""Tables of the history of notes (NOTES-15), on the same ``Base`` as everything else.

``note_versions`` holds the versions of a note: each one the whole Yjs state at the end of an editing session, with
its title and who wrote in it. ``note_edits`` remembers who wrote since the last version, so that the next one can name
them; it empties every time a version is taken.

Both hang on ``notes`` with ``ON DELETE CASCADE``: a note removed for good takes its history along.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Index, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime


class NoteVersion(Base):
    """One version of a note: what it was at the end of an editing session (or right before and after a restore)."""

    __tablename__ = "note_versions"
    __table_args__ = (Index("ix_note_versions_note_created", "note_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    #: When the session ended (the version was taken); the time the list shows.
    created_at: Mapped[datetime] = mapped_column(UtcDateTime)
    #: The first change of the session.
    started_at: Mapped[datetime] = mapped_column(UtcDateTime)
    #: The whole document as one Yjs update (``doc.get_update()``).
    state: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    title: Mapped[str] = mapped_column(String(120), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    #: Who wrote in the session: ``[{"account_id": 3, "via": ""}, {"account_id": 3, "via": "mcp:Laptop"}]``.
    authors: Mapped[Any] = mapped_column(JSON, default=list)
    #: Set on the version a restore made: the time of the version it brought back.
    restored_from: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class NoteEdit(Base):
    """Somebody wrote in a note since its last version. One row per note and writer, the times widened by every
    update; the rows go into the next version and are removed with it."""

    __tablename__ = "note_edits"

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    #: ``"<account id>|<via>"``: an account, or an account through a program (an MCP key).
    writer: Mapped[str] = mapped_column(String(160), primary_key=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    via: Mapped[str] = mapped_column(String(140), default="")
    first_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_at: Mapped[datetime] = mapped_column(UtcDateTime, index=True)
