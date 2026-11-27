"""The module geraete over nexnotes' own tables (``geraete/NACHZIEHEN.md``, nexnotes): a device is a row of
``api_tokens`` with ``kind='device'`` (its key's SHA-256, name, ``device_kind``, ``via_token_id``), its push ticket a
row of ``push_devices``. The module's columns came in beside them (``model``, ``system``, ``app_version``, ``via``,
``push_kinds``, ``push_devices.understands``); devices of before keep ``NULL`` there. Pairings and one-time codes stay
in ``app_pairings`` (with ``code_hash``) and ``app_codes`` (with ``challenge``). A token the operator blocked
(``blocked_at``) counts as disconnected: the store never hands it out. ``app_gone_devices`` is only read (G42).

Also here: what nexnotes does around the module, the mail "Neue Anmeldung" after a new device (G29), the notice of a
new version to the operators' devices (G18) and the daily sweep of devices unused for a year (G27)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import OPERATOR, TOKEN_DEVICE, Account, ApiToken
from ..models_app import AppCode, AppGoneDevice, AppPairing
from ..models_notify import PushDevice
from ..security import account_out
from ..vendor import nexgeraete
from ..vendor.nexgeraete.model import (
    ConnectCode,
    Device,
    DeviceChange,
    Holder,
    NewDevice,
    NewPairing,
    Pairing,
    PushState,
)
from . import settings_service
from .geraete_config import CONFIG, clock

logger = logging.getLogger("nexnotes.app")

#: The operator's switches under nexnotes' names (the same settings as the card "Schnittstellen", module schluessel);
#: both on where nothing is stored.
SWITCHES = {"app": "app_enabled", "pairing": "app_pairing_allowed"}
LANGUAGES = ("de", "en", "fr")
#: Pairings and one-time codes this long past their end go when the next one is made.
KEEP_ENDED = timedelta(days=1)


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _iso(moment: datetime | None) -> str:
    return moment.isoformat().replace("+00:00", "Z") if moment else ""


def language_of(account: Account) -> str:
    code = (account.language or account.browser_language or "en").split("-")[0].lower()
    return code if code in LANGUAGES else "en"


class GeraeteStore:
    """The module's ``Store`` over one database session (one transaction per request)."""

    def __init__(self, db: Session) -> None:
        self.db = db
        #: A device went: open live connections look again once the change is committed (NOTESIOS-14).
        self._removed = False

    # --- devices ---------------------------------------------------------------------------------------------------

    @staticmethod
    def _devices() -> Any:
        return select(ApiToken).where(ApiToken.kind == TOKEN_DEVICE, ApiToken.blocked_at.is_(None))

    def _device(self, row: ApiToken) -> Device:
        push = self.db.get(PushDevice, row.id)
        state = None
        if push is not None and push.ticket and push.key:
            understands = push.understands
            state = PushState(push.ticket, push.key,
                              tuple(str(kind) for kind in understands) if isinstance(understands, list) else None)
        kinds = row.push_kinds if isinstance(row.push_kinds, dict) else {}
        return Device(
            id=row.id, account_id=row.account_id, name=row.name or "iPhone", kind=row.device_kind or None,
            model=row.model, system=row.system, app_version=row.app_version, via=row.via,
            created_at=_aware(row.created_at), last_seen_at=_aware(row.last_used_at), push=state,
            kinds={str(key): bool(value) for key, value in kinds.items()},
        )

    def _row(self, device_id: Any) -> ApiToken | None:
        if not isinstance(device_id, int):
            return None
        return self.db.scalar(self._devices().where(ApiToken.id == device_id))

    def devices_of(self, account_id: Any) -> list[Device]:
        rows = self.db.scalars(self._devices().where(ApiToken.account_id == int(account_id))
                               .order_by(ApiToken.created_at.desc(), ApiToken.id.desc()))
        return [self._device(row) for row in rows]

    def device(self, device_id: Any) -> Device | None:
        row = self._row(device_id)
        return self._device(row) if row is not None else None

    def device_by_hash(self, token_hash: str) -> Device | None:
        row = self.db.scalar(self._devices().where(ApiToken.token_hash == token_hash))
        return self._device(row) if row is not None else None

    def add_device(self, new: NewDevice) -> Device:
        row = ApiToken(
            account_id=int(new.account_id), kind=TOKEN_DEVICE, name=new.name[:100], level="write",
            token_hash=new.token_hash, prefix=new.prefix[:16], created_at=new.created_at, device_kind=new.kind,
            via_token_id=new.via_device if isinstance(new.via_device, int) else None, model=new.model,
            system=new.system, app_version=new.app_version, via=new.via,
        )
        self.db.add(row)
        self.db.flush()
        logger.info("Device paired token_id=%s kind=%s via=%s", row.id, new.kind, new.via)
        return self._device(row)

    def change_device(self, device_id: Any, change: DeviceChange) -> Device:
        row = self._row(device_id)
        if row is None:
            raise LookupError(device_id)
        for part in ("name", "model", "system", "app_version"):
            value = getattr(change, part)
            if value is not None:
                setattr(row, part, value[:100] if part == "name" else value[:32 if part == "app_version" else 64])
        self.db.flush()
        return self._device(row)

    def remove_device(self, device_id: Any) -> None:
        """Disconnect: the token goes, and with it its push ticket (and a nextasks connection made in the app)."""
        if not isinstance(device_id, int):
            return
        self.db.execute(delete(PushDevice).where(PushDevice.token_id == device_id))
        gone = self.db.execute(delete(ApiToken).where(ApiToken.id == device_id, ApiToken.kind == TOKEN_DEVICE))
        if gone.rowcount:
            self._removed = True
            logger.info("Device disconnected token_id=%s", device_id)

    def touch(self, device_id: Any, when: datetime) -> None:
        self.db.execute(update(ApiToken).where(ApiToken.id == device_id).values(last_used_at=when))

    def idle_devices(self, before: datetime) -> list[Device]:
        rows = self.db.scalars(self._devices().where(
            func.coalesce(ApiToken.last_used_at, ApiToken.created_at) < before))
        return [self._device(row) for row in rows]

    def set_push(self, device_id: Any, state: PushState | None) -> None:
        row = self._row(device_id)
        if row is None:
            return
        if state is None:
            self.db.execute(delete(PushDevice).where(PushDevice.token_id == row.id))
            return
        understands = list(state.understands) if state.understands is not None else None
        push = self.db.get(PushDevice, row.id)
        if push is None:
            self.db.add(PushDevice(token_id=row.id, account_id=row.account_id, ticket=state.ticket, key=state.key,
                                   updated_at=clock.now(), understands=understands))
        else:
            push.ticket, push.key, push.updated_at = state.ticket, state.key, clock.now()
            push.understands = understands
        self.db.flush()

    def set_kinds(self, device_id: Any, kinds: dict[str, bool]) -> None:
        row = self._row(device_id)
        if row is not None:
            row.push_kinds = dict(kinds)
            self.db.flush()

    def gone_account(self, token_hash: str) -> int | None:
        row = self.db.get(AppGoneDevice, token_hash)
        return row.account_id if row is not None else None

    # --- accounts --------------------------------------------------------------------------------------------------

    def holder(self, account_id: Any) -> Holder | None:
        from . import totp

        row = self.db.get(Account, int(account_id)) if str(account_id).isdigit() else None
        if row is None:
            return None
        return Holder(
            id=row.id, name=row.display_name or row.name, login=row.name, email=row.email or "",
            avatar=_iso(_aware(row.avatar_at)), operator=row.role == OPERATOR, out=account_out(row),
            language=language_of(row), factor_owed=totp.setup_required(self.db, row),
        )

    def operators(self) -> list[int]:
        return list(self.db.scalars(select(Account.id).where(Account.role == OPERATOR)))

    # --- pairings and codes ----------------------------------------------------------------------------------------

    @staticmethod
    def _pairing(row: AppPairing | None) -> Pairing | None:
        if row is None:
            return None
        return Pairing(
            id=row.id, account_id=row.account_id, secret_hash=row.secret_hash, code_hash=row.code_hash or "",
            created_at=_aware(row.created_at), expires_at=_aware(row.expires_at),  # type: ignore[arg-type]
            used_at=_aware(row.used_at), device_id=row.device_token_id,
        )

    def add_pairing(self, new: NewPairing) -> Pairing:
        self.db.execute(delete(AppPairing).where(AppPairing.expires_at < new.created_at - KEEP_ENDED))
        row = AppPairing(id=new.id, account_id=int(new.account_id), secret_hash=new.secret_hash,
                         code_hash=new.code_hash, created_at=new.created_at, expires_at=new.expires_at)
        self.db.add(row)
        self.db.flush()
        found = self._pairing(row)
        assert found is not None
        return found

    def pairing(self, pairing_id: str) -> Pairing | None:
        return self._pairing(self.db.get(AppPairing, pairing_id[:32]))

    def pairing_by_code(self, code_hash: str) -> Pairing | None:
        return self._pairing(self.db.scalar(select(AppPairing).where(AppPairing.code_hash == code_hash)
                                            .order_by(AppPairing.created_at.desc()).limit(1)))

    def open_pairings(self, account_id: Any, now: datetime) -> list[Pairing]:
        rows = self.db.scalars(select(AppPairing).where(AppPairing.account_id == int(account_id),
                                                        AppPairing.used_at.is_(None), AppPairing.expires_at > now))
        return [found for found in (self._pairing(row) for row in rows) if found is not None]

    def use_pairing(self, pairing_id: str, device_id: Any, when: datetime) -> bool:
        hit = self.db.execute(
            update(AppPairing)
            .where(AppPairing.id == pairing_id, AppPairing.used_at.is_(None), AppPairing.expires_at > when)
            .values(used_at=when, device_token_id=device_id)
        ).rowcount
        return hit == 1

    def remove_pairing(self, pairing_id: str) -> None:
        self.db.execute(delete(AppPairing).where(AppPairing.id == pairing_id))

    def add_connect_code(self, new: ConnectCode) -> None:
        self.db.execute(delete(AppCode).where(AppCode.expires_at < new.created_at - KEEP_ENDED))
        self.db.add(AppCode(code_hash=new.code_hash, account_id=int(new.account_id), state=new.state,
                            challenge=new.challenge, created_at=new.created_at, expires_at=new.expires_at))
        self.db.flush()

    def take_connect_code(self, code_hash: str, when: datetime) -> ConnectCode | None:
        hit = self.db.execute(
            update(AppCode).where(AppCode.code_hash == code_hash, AppCode.used_at.is_(None), AppCode.expires_at > when)
            .values(used_at=when)
        ).rowcount
        if hit != 1:
            return None
        row = self.db.get(AppCode, code_hash)
        if row is None:
            return None
        return ConnectCode(code_hash=row.code_hash, account_id=row.account_id, state=row.state or "",
                           challenge=row.challenge, created_at=_aware(row.created_at),  # type: ignore[arg-type]
                           expires_at=_aware(row.expires_at))  # type: ignore[arg-type]

    # --- settings --------------------------------------------------------------------------------------------------

    def switch(self, name: str) -> bool:
        value = settings_service.get(self.db, SWITCHES[name])
        return True if value is None else bool(value)

    def commit(self) -> None:
        self.db.commit()
        if self._removed:
            self._removed = False
            # Its open live connections close at once (NOTESIOS-14), as when a session ends.
            from . import notes

            notes.nudge_all()

    def rollback(self) -> None:
        self.db.rollback()
        self._removed = False


def store() -> Iterator[GeraeteStore]:
    """The dependency of the module's routes: one session per request."""
    with SessionLocal() as db:
        yield GeraeteStore(db)


# --- What nexnotes does around the module ---------------------------------------------------------------------------


def send(url: str, body: dict[str, Any]) -> int:
    """The module's posts to the relay go the way nexnotes' own go (``apppush.POST``: no proxy of the environment, the
    tests' recorder)."""
    from . import apppush

    return apppush.POST(url, body)


def on_paired(holder: Holder, device: Device) -> None:
    """After a new device (G29): the mail "Neue Anmeldung", as after a sign-in from a browser not known yet, to a
    confirmed address and unless the person turned it off; the device's name and model in place of the browser."""
    from ..vendor.nexkonten import sessions as konten_sessions
    from . import kontenpost
    from .konten_store import KontenStore

    with SessionLocal() as db:
        row = db.get(Account, int(holder.id))
        konto = KontenStore(db).get_account(int(holder.id))
        if row is None or konto is None:
            return
        mail = konten_sessions.new_sign_in(konto, known=False, wanted=bool(row.new_sign_in_mail))
        if kontenpost.queue(db, mail, where=nexgeraete.describe(device)):
            logger.info("Mail about a new device queued name=%s", row.name)


def newer(version: str, current: str = "") -> int:
    """A newer nexnotes is out (G18): a notice to the operators' devices that understand ``update`` and have it on,
    leading to "Was ist neu". ``current``: the running version (this one where not given). Returns how many devices
    took it."""
    from .. import __version__

    with SessionLocal() as db:
        url = f"{settings_service.public_url(db)}/settings/about"
        told = nexgeraete.notices.newer(GeraeteStore(db), CONFIG, version, current or __version__, url, send=send)
    return told.sent


def tell_newer() -> str | None:
    """nexnotes has no bell and asks GitHub only when an operator opens "Über nexnotes" (U19): what that question
    found goes to the operators' devices once per version, without a question of its own. Returns the version told
    about, else None."""
    from ..vendor.nexupdates import check

    if not check.switch_on():
        return None
    known = check.state(on=False)
    if not known.latest or not known.newer:
        return None
    with SessionLocal() as db:
        told = str(settings_service.get(db, "update_told") or "")
        if told and not check.is_newer(known.latest, told):
            return None
        settings_service.save(db, {"update_told": known.latest})
    newer(known.latest)
    return known.latest


def sweep() -> int:
    """The daily run (G27): every device unused for a year is disconnected."""
    with SessionLocal() as db:
        gone = nexgeraete.devices.sweep(GeraeteStore(db), CONFIG, clock.now())
    if gone:
        logger.info("Devices unused for a year disconnected count=%s", gone)
    return gone
