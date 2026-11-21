"""Every account has exactly one inbox: a folder that cannot be deleted, renamed or moved (NOTES-4 AC-7).

Made the first time anybody asks for it, so accounts from before, from invitations and from OIDC all get one.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FOLDER_INBOX, Folder


def inbox_for(db: Session, account_id: int) -> Folder:
    """The account's inbox, made (and flushed) if it has none yet."""
    found = db.scalars(
        select(Folder).where(Folder.owner_id == account_id, Folder.kind == FOLDER_INBOX).limit(1)
    ).first()
    if found is None:
        found = Folder(owner_id=account_id, kind=FOLDER_INBOX, name="")
        db.add(found)
        db.flush()
    return found
