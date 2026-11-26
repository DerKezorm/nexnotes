"""Connecting nexnotes with the other nex apps (module verbinden 0.1.1, plan "Entwurf Apps verbinden"): the module's
fixed places, ``/.well-known/nex-app``, ``/api/connect/…`` (the account's card, the consent, the return, the
operator's switch and addresses, and the token, revoke and retire routes between the apps), over nexnotes' tables
(``services/verbinden_store.py``). The older way to nextasks (``PUT``/``DELETE /api/nextasks``) stays in
``routers/nextasks.py``.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import DbSession, require_account, require_operator
from ..errors import detail
from ..security import decrypt_secret
from ..services import settings_service, verbinden_store
from ..services.verbinden_store import CONFIG, VerbindenStore
from ..vendor.nexverbinden import Refused
from ..vendor.nexverbinden import api as verbinden_api


def store(db: DbSession) -> VerbindenStore:
    return VerbindenStore(db)


def _address(request: Request) -> str:
    """Where the other apps and the browser reach nexnotes: the public address, else the one of this request."""
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: Refused) -> Exception:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.code, refusal.message, **values))


def _old_key(data: Any, account_id: Any, partner: str) -> str | None:
    """The key of nextasks typed in by hand (NOTES-19): after "Neu verbinden" it ends itself there (V15)."""
    if partner != "nextasks":
        return None
    from ..models_nextasks import NextasksConnection

    row = data.db.get(NextasksConnection, int(account_id))
    return decrypt_secret(row.token_enc, f"nextasks:{row.account_id}") or None if row is not None else None


def _disconnected(data: VerbindenStore, account_id: Any, partner: str) -> None:
    # Looked up on each call, so the contract's adapter can listen in (``disconnected()``, verbinden 0.1.4).
    verbinden_store.disconnected(data, account_id, partner)


router = verbinden_api.router(config=CONFIG, store=store, account=require_account, operator=require_operator,
                              address=_address, error=_error, old_key=_old_key, on_disconnected=_disconnected,
                              tags=["connect"])
