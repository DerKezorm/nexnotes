"""Smart folders (NOTES-7): a saved list of conditions, shown as a folder.

A smart folder holds no notes. Opened, it asks the conditions anew (``services/search.py``, section "Conditions"), so
it always shows what fits now, and changing or deleting it never touches a note (AC-4, AC-6).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, new_uuid, utcnow


class SmartFolder(Base):
    """One smart folder of one account."""

    __tablename__ = "smart_folders"
    __table_args__ = (UniqueConstraint("owner_id", "name_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: As the member named it; empty for one that came with the account (``preset``) and was never renamed: the
    #: interface shows that one's name in its own language.
    name: Mapped[str] = mapped_column(String(60), default="")
    #: The name as names are compared (EC-6: no two of the same name); for a preset its key (``preset:recent``).
    name_key: Mapped[str] = mapped_column(String(200))
    #: ``open_tasks`` or ``recent`` for the two every account gets (AC-7); empty for the member's own.
    preset: Mapped[str] = mapped_column(String(16), default="")
    #: ``all``: every condition must hold; ``any``: at least one (AC-2).
    match: Mapped[str] = mapped_column(String(8), default="all")
    #: The conditions, as ``services/search.py`` reads them.
    conditions: Mapped[Any] = mapped_column(JSON, default=list)
    #: Its symbol, from the folders' row (``services/symbols.py``): the filter unless its owner picks another; the
    #: presets carry the symbol of the entry they stand for. Empty is allowed and shows the filter.
    icon: Mapped[str] = mapped_column(String(32), default="filter", server_default="filter")
    #: Its colour as a folder's: a key of ``FOLDER_COLORS``, ``#rrggbb`` or empty for none.
    color: Mapped[str] = mapped_column(String(16), default="", server_default="")
    #: Its place in the sidebar (AC-8), from 0.
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, onupdate=utcnow)
