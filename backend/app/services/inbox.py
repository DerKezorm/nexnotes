"""Every account has exactly one inbox: a folder that cannot be deleted, renamed or moved (NOTES-4 AC-7).

Made the first time anybody asks for it, so accounts from before, from invitations and from OIDC all get one. The
database holds the "exactly one" (``uq_folders_one_inbox``): when two first requests make it at the same moment, the
second one's row is dropped and both go on with the first one's.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..models import FOLDER_INBOX, Folder


def _find(db: Session, account_id: int) -> Folder | None:
    return db.scalars(
        select(Folder).where(Folder.owner_id == account_id, Folder.kind == FOLDER_INBOX).limit(1)
    ).first()


def inbox_for(db: Session, account_id: int) -> Folder:
    """The account's inbox, made if it has none yet. The new row is written, not committed: the caller commits."""
    found = _find(db, account_id)
    if found is not None:
        return found
    # Another request may have made it since the read above. Its row wins; ours is left out without an error, so the
    # session stays usable and keeps whatever else the caller has pending.
    db.execute(insert(Folder).values(owner_id=account_id, kind=FOLDER_INBOX, name="").on_conflict_do_nothing())
    found = _find(db, account_id)
    if found is None:  # pragma: no cover - the insert either wrote the row or met the one that was there
        raise RuntimeError("the inbox could not be made")
    return found
