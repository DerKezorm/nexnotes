"""The table of exports that run in the background (NOTES-17 AC-7, AC-8), on the same ``Base`` as everything else.

A folder or everything goes out as a ZIP that is written in the background (``services/export.py``). ``export_jobs``
holds one row per such export: what it takes, how far it got, and until when its ZIP can be fetched. The file itself
lies under ``<data>/exports/<id>.zip``; the row goes with the account (``ON DELETE CASCADE``), the file with the next
cleaning round.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Integer, String, false
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, new_uuid, utcnow

#: Waiting for its turn (one export per account at a time, two in the whole server).
QUEUED = "queued"
RUNNING = "running"
#: The ZIP is there and can be fetched until ``expires_at``.
READY = "ready"
#: Ended without a ZIP; ``problem`` says why.
FAILED = "failed"
STATUSES = (QUEUED, RUNNING, READY, FAILED)


class ExportJob(Base):
    __tablename__ = "export_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The folder it takes with everything below; ``None``: everything the account has and what was shared with it.
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    #: What the notice calls it: the folder's name at the start, empty for everything.
    label: Mapped[str] = mapped_column(String(200), default="")
    #: The name of the download.
    filename: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(16), default=QUEUED, index=True)
    #: Why it failed: ``disk_full``, ``interrupted`` (the server started anew while it ran), ``not_found`` (the folder
    #: went), ``failed``.
    problem: Mapped[str] = mapped_column(String(32), default="")
    #: The size the dialog named before, and the size of the ZIP, in bytes.
    estimate: Mapped[int] = mapped_column(Integer, default=0)
    size: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Until when the ZIP can be fetched (24 hours after it was ready).
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The member saw the notice that it is ready (or that it failed).
    seen: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
