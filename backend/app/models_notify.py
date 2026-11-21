"""Notifications (NOTES-14): who wants to hear about changes of a shared note or folder, what is waiting to be bundled,
the messages on their way, and where they go (browsers with Web Push, the iOS app through the push relay). The rules
are in ``services/notify.py``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class NotifyWatch(Base):
    """The switch of one account at one note or one folder (AC-1). Off from the start: no row. A folder's switch holds
    for every note and folder below it; the nearest switch counts, so a note can be off inside a folder that is on."""

    __tablename__ = "notify_watches"
    __table_args__ = (
        UniqueConstraint("account_id", "note_id"),
        UniqueConstraint("account_id", "folder_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    note_id: Mapped[str | None] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), nullable=True,
                                                index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), nullable=True,
                                                  index=True)
    on: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class NotifyEdit(Base):
    """Somebody changed a note since its last notification. One row per note and writer, widened by every update;
    the rows go into the next bundle (AC-3) and are removed with it."""

    __tablename__ = "notify_edits"

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    first_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_at: Mapped[datetime] = mapped_column(UtcDateTime, index=True)


class NotifyBaseline(Base):
    """The note as it was before the first change of a bundle: its lines, to tell what came or was ticked (AC-2).
    ``trashed_by``: the bundle ends with the note in the trash, put there by this account (EC-7)."""

    __tablename__ = "notify_baselines"

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    #: ``[[text, checked], ...]``: one entry per line of text, ``checked`` null outside a checklist.
    lines: Mapped[Any] = mapped_column(JSON, default=list)
    taken_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    trashed_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)


class NotifyOutbox(Base):
    """One message to one browser or one device, sent in the background and tried again after a failure (EC-2).
    The text is encrypted for its receiver only when it is sent; until then it is in the database like the note."""

    __tablename__ = "notify_outbox"
    __table_args__ = (Index("ix_notify_outbox_due", "sent_at", "failed_at", "next_try_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: ``web`` (a browser, ``target_id`` = ``webpush_subscriptions.id``) or ``app`` (``push_devices.token_id``).
    channel: Mapped[str] = mapped_column(String(8))
    target_id: Mapped[int] = mapped_column(Integer)
    payload: Mapped[Any] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    next_try_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(40), default="")


class WebPushSubscription(Base):
    """One browser that allowed notifications (AC-7): its address at its push service and its two keys. It belongs to
    the session it was made in: signing out, a new password, "sign out everywhere" and the session's end take it along
    (``ON DELETE CASCADE``); a blocked or deleted account loses it at once (``notify._accounts_out``)."""

    __tablename__ = "webpush_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("auth_sessions.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(Text, unique=True)
    p256dh: Mapped[str] = mapped_column(String(100))
    auth: Mapped[str] = mapped_column(String(40))
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class PushDevice(Base):
    """The push ticket of a paired iOS device and the public key its messages are encrypted for (AC-6). The device
    is its token (``api_tokens``, kind ``device``): disconnecting it removes the token and with it this row (EC-4).
    Filled when the app signs up for notifications (NOTES-24 AC-6); a ticket the relay calls gone is dropped."""

    __tablename__ = "push_devices"

    token_id: Mapped[int] = mapped_column(ForeignKey("api_tokens.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    ticket: Mapped[str] = mapped_column(Text)
    #: X25519 public key of the device, base64.
    key: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
