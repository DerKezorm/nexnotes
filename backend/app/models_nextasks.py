"""A member's own nextasks (NOTES-19): the connection, and the lines sent there as tasks.

The token is stored sealed with the server's key (``security.encrypt_secret``), never in the clear. A sent line keeps
no text here: the mark sits on the block of the note by the id the Yjs document gave that block (``anchor``), so the
note's format stays as it is and the mark shows only for the member who sent it (EC-5).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class NextasksConnection(Base):
    """One per account: where its nextasks is, the sealed token, who the token says it is, the list used last."""

    __tablename__ = "nextasks_connections"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    url: Mapped[str] = mapped_column(String(500))
    token_enc: Mapped[str] = mapped_column(String(2000))
    #: The name nextasks gave for the token's account ("Verbunden mit … als …", AC-5).
    name: Mapped[str] = mapped_column(String(200), default="")
    checked_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: The list (``<list>`` or ``<list>/<section>``) chosen last, preselected in the dialog (AC-6).
    last_list_id: Mapped[str] = mapped_column(String(100), default="")
    last_list_name: Mapped[str] = mapped_column(String(300), default="")


class NextasksLink(Base):
    """A line of a note sent as a task: the mark beside it, for the account that sent it only."""

    __tablename__ = "nextasks_links"
    __table_args__ = (UniqueConstraint("account_id", "request_id", "position", name="uq_nextasks_link_request"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    #: The sending as the dialog named it, and the line's place in it: one task and one mark each, however often sent.
    request_id: Mapped[str] = mapped_column(String(64))
    position: Mapped[int] = mapped_column(Integer)
    #: The Yjs id of the block element (``<client>.<clock>``) the line is.
    anchor: Mapped[str] = mapped_column(String(64))
    task_id: Mapped[str] = mapped_column(String(100))
    task_url: Mapped[str] = mapped_column(String(2000), default="")
    list_name: Mapped[str] = mapped_column(String(300), default="")
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
