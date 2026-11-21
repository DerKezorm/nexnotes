"""Sharing (NOTES-13): notes and folders shared with members, the notices of shares that ended, pins of notes others
shared, and read links for people without an account. The rules are in ``services/shares.py``."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow

#: The two rights a share gives (AC-1).
READ = "read"
WRITE = "write"
LEVELS = (READ, WRITE)


class Share(Base):
    """One note or one folder (with everything in it and below, AC-2) of ``owner_id``, shared with ``account_id``.
    Exactly one of ``note_id`` and ``folder_id`` is set; one row per person and thing (EC-9)."""

    __tablename__ = "shares"
    __table_args__ = (
        UniqueConstraint("account_id", "note_id"),
        UniqueConstraint("account_id", "folder_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    note_id: Mapped[str | None] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), nullable=True,
                                                index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), nullable=True,
                                                  index=True)
    #: ``read`` or ``write``.
    level: Mapped[str] = mapped_column(String(8), default=READ)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ShareNotice(Base):
    """What a member hears in "Mit mir geteilt" about something that is not there any more: "… ist nicht mehr da:
    <Name> hat das Teilen beendet" (AC-5), or its owner's account went (EC-4). Kept as text: the thing itself may be
    gone. Put away by the member."""

    __tablename__ = "share_notices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: ``ended`` (the owner stopped sharing) or ``owner_gone`` (the owner's account was deleted).
    reason: Mapped[str] = mapped_column(String(16), default="ended")
    #: ``note`` or ``folder``.
    kind: Mapped[str] = mapped_column(String(8), default="note")
    title: Mapped[str] = mapped_column(String(120), default="")
    owner_name: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class SharePin(Base):
    """A note somebody else shared, pinned by the member for itself (NOTES-6 AC-6): the pin of the note itself is its
    owner's."""

    __tablename__ = "share_pins"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    pinned_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ReadLink(Base):
    """A link to read one note without an account (AC-9). Only the SHA-256 of its token is kept: the link is shown
    once, when it is made; whoever needs it again makes a new one (the old one stops working)."""

    __tablename__ = "read_links"
    __table_args__ = (Index("ix_read_links_expires", "expires_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: One link per note.
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), unique=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: The last day it works (``YYYY-MM-DD``), as the member chose it in its calendar.
    expires_on: Mapped[str] = mapped_column(String(10))
    #: The end of that day in the member's time zone: after it the link says "Dieser Link gilt nicht mehr" (EC-5).
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
