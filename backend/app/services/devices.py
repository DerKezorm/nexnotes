"""The app for iPhone, iPad and Mac (NOTES-24): who a device's key belongs to, for nexnotes' own routes.

Pairing, the list of devices, renaming, disconnecting and the push ticket are the module geraete's
(``vendor/nexgeraete``, mounted in ``routers/app_pairing.py``, over nexnotes' tables in
``services/geraete_store.py``). **A device is a token** of ``api_tokens`` (kind ``device``, ``nnd_…``) with its name,
its kind (``ios``, ``ipados``, ``mac``) and, for one that came through iCloud, the device that brought it
(``via_token_id``, AC-7). It acts as its account in ``/api/app/1`` and on the browser's routes, never with more rights.
It goes when its owner disconnects it (in the browser or in the app), with "sign out everywhere", the operator's reset
of the second factor, the deletion of its account for good, or after a year without use (G27). While its account is
blocked or deleted with its days to bring it back it rests: ``account_blocked``, and afterwards it works again without
pairing anew (G26). While the operator requires a second factor the account has not set up, a device hears
``second_factor_required``; while the operator has the app switched off, ``app_disabled``.

Here: ``authenticate`` for the routes the app has beside the module's (``me``, ``changes``, ``wait``, the notes, the
live room): the module's check (G12, G38) with nexnotes' rows for the account and the token.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models import Account, ApiToken
from ..vendor import nexgeraete
from .geraete_config import CONFIG, clock

logger = logging.getLogger("nexnotes.app")

#: Devices one account may bring in through a device it has, per hour (AC-7, G9: counted in the database).
SIBLINGS_PER_HOUR = CONFIG.siblings_per_hour


@dataclass
class Caller:
    """Who calls ``/api/app/1``: the account and its device's token, detached; ``module`` is the module's view of
    both (for ``me``)."""

    account: Account
    device: ApiToken
    module: nexgeraete.Caller


class Refusal(Exception):
    """The module's reason (``device_disconnected``, ``account_blocked``, ``second_factor_required``,
    ``app_disabled``), with its status and message."""

    def __init__(self, refused: nexgeraete.DeviceRefused) -> None:
        super().__init__(refused.code)
        self.code = refused.public_code
        self.status = refused.status
        self.message = refused.message


def app_caller(db: Session, found: nexgeraete.Caller) -> Caller:
    """nexnotes' rows behind the module's caller, detached from ``db``."""
    account = db.get(Account, int(found.holder.id))
    row = db.get(ApiToken, int(found.device.id))
    if account is None or row is None:
        raise Refusal(nexgeraete.DeviceRefused("device_disconnected"))
    db.expunge(account)
    db.expunge(row)
    return Caller(account=account, device=row, module=found)


def authenticate(db: Session, token: str | None, client: nexgeraete.Client | None = None) -> Caller:
    """The device behind a key, else ``Refusal`` (the module's reasons, G12)."""
    from .geraete_store import GeraeteStore

    store = GeraeteStore(db)
    try:
        found = nexgeraete.authenticate(store, CONFIG, token, client=client, now=clock.now())
    except nexgeraete.DeviceRefused as refused:
        store.rollback()
        raise Refusal(refused) from None
    return app_caller(db, found)


def forget() -> None:
    """For the tests: nothing of devices is kept in memory any more (the count of siblings is the database's, G9)."""
