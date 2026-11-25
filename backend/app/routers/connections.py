"""My account › Connections, the API keys and AI tools, and Server › General › Interfaces and Server › Accounts › API
keys of all accounts (plan "Einstellungen"; module schluessel 1.0.0): the module's routes under ``/api/connections``,
over nexnotes' table ``api_tokens`` (``services/schluessel_store.py``). Browser sessions only: a paired device or a
key never manages keys (``deps.DEVICE_REFUSED_PREFIXES``). The older ways (``/api/tokens``, ``/api/admin/tokens``) stay
in ``routers/tokens.py`` in their old shapes.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import DbSession, require_account, require_operator
from ..errors import detail
from ..services import settings_service
from ..services.schluessel_store import CONFIG, KeyStore
from ..vendor.nexschluessel import api as keys_api
from ..vendor.nexschluessel.errors import KeyRefused


def _store(db: DbSession) -> KeyStore:
    return KeyStore(db)


def _address(request: Request) -> str:
    """Where programs reach nexnotes: the public address, else the one of this request."""
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: KeyRefused) -> Exception:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.public_code, refusal.message, **values))


router = keys_api.router(config=CONFIG, store=_store, account=require_account, operator=require_operator,
                         address=_address, error=_error, tags=["keys"])
