"""Tables of the vault (NOTES-16), on the same ``Base`` as everything else.

The server never holds the vault password, the vault key or the content of a locked note in plain text:

``vaults`` holds, per account, what a device needs to open the vault: the parameters to derive keys from the password
(``kdf``), the vault key wrapped by a key derived from the password (``wrapped_key``), and the SHA-256 of a second
value derived from the password (``auth_hash``), so that the server hands out the wrapped key only after the right
password and can count wrong ones (EC-1).

``sealed_notes`` holds the content of a locked note as the device encrypted it, with a revision that grows with every
save (EC-5). ``vault_pending`` remembers a note that is being locked or unlocked: between the start and the end of
such a step nobody writes into it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class Vault(Base):
    """The vault of one account: one password for all of its locked notes."""

    __tablename__ = "vaults"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    #: How a device derives its keys from the password: ``{"name": "PBKDF2", "hash": "SHA-256", "iterations": ...,
    #: "salt": <base64>}``.
    kdf: Mapped[Any] = mapped_column(JSON)
    #: The vault key, encrypted by the device with a key derived from the password (AES-GCM, nonce in front).
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary)
    #: SHA-256 (hex) of the check value the device derives from the password; the value itself is never stored.
    auth_hash: Mapped[str] = mapped_column(String(64))
    #: Grows with every new password and every new vault: a device holding the key of before locks again (EC-7).
    epoch: Mapped[int] = mapped_column(Integer, default=1)
    #: Wrong passwords since the last right one, and how many rounds of three of them (EC-1).
    failures: Mapped[int] = mapped_column(Integer, default=0)
    rounds: Mapped[int] = mapped_column(Integer, default=0)
    #: No further try before this time.
    wait_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    changed_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class SealedNote(Base):
    """The encrypted content of a locked note: the whole Yjs state, encrypted on the device."""

    __tablename__ = "sealed_notes"

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    content: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    #: 1 after locking, one more with every save.
    rev: Mapped[int] = mapped_column(Integer, default=1)
    saved_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    saved_by_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)


class VaultPending(Base):
    """A note being locked (``step`` = ``lock``) or unlocked (``unlock``): the parts the device must lay down before
    the step ends, and when it began. Meanwhile the note takes no change from anyone."""

    __tablename__ = "vault_pending"

    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    step: Mapped[str] = mapped_column(String(8))
    #: The parts expected: ``content``, ``version:<id>``, ``attachment:<id>``.
    parts: Mapped[Any] = mapped_column(JSON, default=list)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
