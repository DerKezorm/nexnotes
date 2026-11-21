from app.db import SessionLocal
from app.models import FOLDER_INBOX
from app.services.inbox import inbox_for


def test_notes4_ac7_every_account_has_one_inbox(operator):
    with SessionLocal() as db:
        first = inbox_for(db, operator.id)
        db.commit()
        again = inbox_for(db, operator.id)
        assert first.id == again.id
        assert first.kind == FOLDER_INBOX
