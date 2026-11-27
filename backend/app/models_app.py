"""The app for iPhone, iPad and Mac (NOTES-24): pairings by QR code, one-time codes of the sign-in page, the counter
behind ``changes`` and what went for good since a cursor. The rules are in ``services/devices.py`` and
``services/appsync.py``.

A paired device itself is a row of ``api_tokens`` (kind ``device``) with ``device_kind`` and ``via_token_id``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class AppCounter(Base):
    """One row: the last number handed out to a change (``value``) and the highest number of a tombstone that went
    after its 400 days (``floor``). A cursor below the floor gets the full list (EC-4)."""

    __tablename__ = "app_counter"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
    floor: Mapped[int] = mapped_column(Integer, default=0)


class AppTombstone(Base):
    """A note or folder that went for good, or that somebody may no longer see (a share withdrawn, a note moved out
    of a shared folder, a note locked): ``removed`` in ``changes``. ``account_id`` names whom it concerns: the owner, or
    an account the owner shares with (who still sees the thing never hears of it). Kept 400 days."""

    __tablename__ = "app_tombstones"
    __table_args__ = (Index("ix_app_tombstones_seq", "seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer)
    #: ``note`` or ``folder``.
    kind: Mapped[str] = mapped_column(String(8))
    object_id: Mapped[str] = mapped_column(String(36))
    account_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)


class AppPairing(Base):
    """A QR code of "iPhone oder iPad verbinden" (AC-1): ten minutes, one device. Only the SHA-256 of the secret is
    kept; ``token_id`` is the device it made."""

    __tablename__ = "app_pairings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    secret_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    device_token_id: Mapped[int | None] = mapped_column(ForeignKey("api_tokens.id", ondelete="SET NULL"),
                                                        nullable=True)
    #: The SHA-256 of the code to type beside the QR code (module geraete, G7); empty for pairings of before.
    code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class AppCode(Base):
    """The one-time code the page ``/app-connect`` hands back to the app (AC-2): five minutes, once. Only its SHA-256
    is kept."""

    __tablename__ = "app_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: What the app sent along to ``/app-connect`` and gets back beside the code.
    state: Mapped[str] = mapped_column(String(128), default="")
    #: The app's PKCE challenge (S256), where it sent one (module geraete, G8).
    challenge: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class AppGoneDevice(Base):
    """The SHA-256 of a device token an earlier version deleted with its account's block or deletion: such a device
    hears ``account_blocked`` while its account is out, else ``device_disconnected`` (EC-5). Since the module geraete
    (G26, G42) a block deletes no device; the table is only read."""

    __tablename__ = "app_gone_devices"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class AppGoneSibling(Base):
    """When a device that came in over iCloud (``via='icloud'``) was made, kept once it is disconnected (module geraete
    0.1.5, G33 anew): the limit of siblings per hour counts it still, also after a restart. Rows older than a day go
    when the next one comes."""

    __tablename__ = "app_gone_siblings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime)
