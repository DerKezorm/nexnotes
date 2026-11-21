"""The API for programs (NOTES-25): the ``external_ref`` a program gave a note it made, so that the same request sent
again gives the same note instead of a second one (AC-14, EC-13). A note gone for good takes its row along; the next
request with that reference makes a new note."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow

#: The longest ``external_ref`` a program may give.
EXTERNAL_REF_MAX = 200


class ApiRef(Base):
    __tablename__ = "api_refs"
    __table_args__ = (UniqueConstraint("account_id", "external_ref", name="uq_api_refs_account_ref"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    external_ref: Mapped[str] = mapped_column(String(EXTERNAL_REF_MAX))
    #: Deferred: the row may be written before the note in the same transaction (``services/apiwrite.py``).
    note_id: Mapped[str] = mapped_column(
        ForeignKey("notes.id", ondelete="CASCADE", deferrable=True, initially="DEFERRED"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
