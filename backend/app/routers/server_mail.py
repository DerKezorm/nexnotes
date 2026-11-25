"""Server › Mail (plan "Einstellungen", Mail; post 1.1.0): the routes of the shared post module under
``/api/server/mail`` (the mail server as the page shows it, saving it, the test mail with nexnotes' logo). The settings
stay where 1.0.1 kept them (``smtp_*``, the password sealed, ``services/post_store``); the older ways
(``/api/settings`` with ``smtp_*``, ``POST /api/settings/mail-test``) stay as they were.
"""

from __future__ import annotations

from ..deps import DbSession, require_operator
from ..errors import error
from ..services.post_store import PostStore
from ..vendor.nexpost import api as post_api


def _store(db: DbSession) -> PostStore:
    return PostStore(db)


def _error(code: str, text: str, status: int) -> Exception:
    return error(code, text, status)


router = post_api.router(operator=require_operator, store=_store, error=_error, tags=["settings"])
