"""nexgeraete contract tests: nexnotes' adapter (copied once from the module's template, now nexnotes' file).

The contract tests in ``backend/tests/nexgeraete/`` run the module's routes inside nexnotes (``routers/app_pairing.py``)
over nexnotes' real tables (``services/geraete_store.py``: ``api_tokens`` kind ``device``, ``push_devices``,
``app_pairings``, ``app_codes``) and present every device to nexnotes' own device route ``GET /api/app/1/me``.

Devices of before are written the way 1.1.0 wrote them: ``apitokens.make`` with ``device_kind`` (a QR code or the
sign-in page), ``via_token_id`` (iCloud), ``apppush.remember`` (push). The relay is the module's recorder in place of
``apppush.POST``; the clock is ``geraete_config.clock``. The database is the one of the test session
(``tests/conftest.py`` empties it before every test). Keys are made at run time.
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from geraete_contract import LegacyDevice, Made, Relay, StandardAdapter

TAB = {"X-Nexnotes-Client": "tab-contract"}
NAMES = ("owner", "other", "operator")


class Adapter(StandardAdapter):
    package = "app.vendor.nexgeraete"
    app_prefix = "/api/app/1"
    browser_prefix = "/api"

    def start(self) -> None:
        """Three accounts with passwords and no second factor; the relay recorder in place of ``apppush.POST``."""
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account
        from app.security import brake, hash_password
        from app.services import apppush, geraete_store
        from app.services.geraete_config import clock
        from app.services.inbox import inbox_for

        brake.forget()
        clock.fixed = None
        self.relay = Relay()
        self.clients: dict[str, Any] = {}
        self.ids: dict[str, int] = {}
        self.mails: list[tuple[Any, str]] = []
        self._post = apppush.POST
        self._on_paired = geraete_store.on_paired
        apppush.POST = self.relay  # type: ignore[assignment]

        def on_paired(holder: Any, device: Any) -> None:
            self.mails.append((holder.id, device.name))
            self._on_paired(holder, device)

        geraete_store.on_paired = on_paired  # type: ignore[assignment]
        with SessionLocal() as db:
            for name in NAMES:
                row = Account(name=f"contract-{name}", display_name=f"Contract {name}", email=f"{name}@example.com",
                              role=OPERATOR if name == "operator" else MEMBER,
                              password_hash=hash_password(secrets.token_urlsafe(16)))
                db.add(row)
                db.flush()
                inbox_for(db, row.id)
                self.ids[name] = row.id
            db.commit()

    def stop(self) -> None:
        from app.services import apppush, geraete_store
        from app.services.geraete_config import clock

        for client in self.clients.values():
            client.close()
        apppush.POST = self._post  # type: ignore[assignment]
        geraete_store.on_paired = self._on_paired  # type: ignore[assignment]
        clock.fixed = None

    def restart(self) -> None:
        """nexnotes keeps nothing of devices in memory: new clients on the same database."""
        for client in self.clients.values():
            client.close()
        self.clients = {}

    def config(self) -> Any:
        from app.services.geraete_config import CONFIG

        return CONFIG

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import Account
        from app.security import SESSION_COOKIE, start_session

        if role not in self.clients:
            browser = TestClient(app, base_url="https://notes.example.com", headers=TAB)
            if role != "anonymous":
                with SessionLocal() as db:
                    row = db.get(Account, self.ids[role])
                    assert row is not None
                    browser.cookies.set(SESSION_COOKIE, start_session(db, row, "127.0.0.1", "contract"))
            self.clients[role] = browser
        return self.clients[role]

    def account_id(self, role: str) -> Any:
        return self.ids[role]

    def legacy_devices(self) -> list[LegacyDevice]:
        return [
            LegacyDevice("QR code"),
            LegacyDevice("sign-in page"),
            LegacyDevice("brought in over iCloud"),
            LegacyDevice("with push", push=True),
        ]

    def make_legacy(self, spec: LegacyDevice, *, account: str = "owner") -> Made:
        """As 1.1.0 wrote them (``devices.make_device``, ``apppush.remember``): no model, no way, no kinds."""
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TOKEN_DEVICE, Account, ApiToken, utcnow
        from app.services import apitokens, apppush

        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            via = None
            if "iCloud" in spec.label:
                via = db.scalar(select(ApiToken.id).where(ApiToken.account_id == row.id,
                                                          ApiToken.kind == TOKEN_DEVICE).limit(1))
            device, token = apitokens.make(db, row, spec.label, kind=TOKEN_DEVICE)
            device.device_kind = "ios"
            device.via_token_id = via
            device.created_at = device.last_used_at = utcnow() - timedelta(days=3)
            db.commit()
            made = Made(token)
            if spec.push:
                from app.vendor.nexgeraete import seal

                made.private_key, public = seal.key_pair()
                made.ticket = f"legacy-{secrets.token_urlsafe(6)}"
                apppush.remember(db, row.id, device.id, made.ticket, public)
        return made

    def probe(self, token: str | None, headers: dict[str, str] | None = None) -> Any:
        sent = dict(headers or {})
        if token is not None:
            sent["Authorization"] = f"Bearer {token}"
        return self.device_client().get(f"{self.app_prefix}/me", headers=sent)

    def database_text(self) -> bytes:
        from pathlib import Path

        from app.db import engine

        path = Path(str(engine.url.database))
        found = path.read_bytes()
        wal = path.with_name(path.name + "-wal")
        return found + (wal.read_bytes() if wal.exists() else b"")

    def _account(self, account: str) -> Any:
        from app.db import SessionLocal
        from app.models import Account

        db = SessionLocal()
        row = db.get(Account, self.ids[account])
        assert row is not None
        return db, row

    def block(self, account: str = "owner") -> None:
        from app.services import accounts

        if account == "operator":
            self._spare_operator()
        db, row = self._account(account)
        with db:
            accounts.block(db, row)

    def _spare_operator(self) -> None:
        """nexnotes never blocks its last operator (``last_operator``): a second one without devices, once."""
        from app.db import SessionLocal
        from app.models import OPERATOR, Account
        from app.security import hash_password

        if getattr(self, "spare", None) is not None:
            return
        with SessionLocal() as db:
            row = Account(name="contract-spare", display_name="Contract spare", email="spare@example.com",
                          role=OPERATOR, password_hash=hash_password(secrets.token_urlsafe(16)))
            db.add(row)
            db.commit()
            self.spare = row.id

    def unblock(self, account: str = "owner") -> None:
        """Unblocking ends the browser sessions of before (konten): the account's browser signs in anew."""
        from app.services import accounts

        db, row = self._account(account)
        with db:
            accounts.unblock(db, row)
        self._sign_in_again(account)

    def _sign_in_again(self, account: str) -> None:
        found = self.clients.pop(account, None)
        if found is not None:
            found.close()

    def remove(self, account: str = "owner") -> None:
        from app.services import accounts

        db, row = self._account(account)
        with db:
            accounts.delete_account(db, row)

    def restore(self, account: str = "owner") -> None:
        from app.services import accounts

        db, row = self._account(account)
        with db:
            accounts.restore_account(db, row)
        self._sign_in_again(account)

    def purge(self, account: str = "owner") -> None:
        from app.services import accounts

        db, row = self._account(account)
        with db:
            accounts.delete_account(db, row)
            row.deleted_at = row.deleted_at - timedelta(days=accounts.DELETE_GRACE_DAYS + 1)
            db.commit()
            accounts.purge_deleted(db)

    def owe_factor(self, account: str = "owner") -> None:
        """The operator requires a second factor; ``account`` signs in with a password and has none, the others have
        an authenticator."""
        from app.db import SessionLocal
        from app.models import Account
        from app.services import settings_service, totp

        with SessionLocal() as db:
            for name, account_id in self.ids.items():
                row = db.get(Account, account_id)
                assert row is not None
                row.totp_secret_enc = "" if name == account else totp.seal_seed("JBSWY3DPEHPK3PXP")
            settings_service.save(db, {"two_factor_required": True})

    def switch(self, name: str, on: bool) -> None:
        from app.db import SessionLocal
        from app.services import settings_service
        from app.services.geraete_store import SWITCHES

        with SessionLocal() as db:
            settings_service.save(db, {SWITCHES[name]: on})

    def travel(self, delta: timedelta) -> None:
        from app.services.geraete_config import clock

        clock.set(clock.now() + delta)

    def tell(self, account: str, kind: str) -> None:
        """nexnotes' own event: a message of ``kind`` queued for the account (``notify._enqueue``) and sent
        (``notify.send_round``), as a change of a shared note does."""
        from app.db import SessionLocal
        from app.models import Account, Note
        from app.services import notify
        from app.services.inbox import inbox_for

        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            note = Note(id=secrets.token_hex(8), owner_id=row.id, folder_id=inbox_for(db, row.id).id,
                        title="Contract")
            db.add(note)
            db.flush()
            payload = {"title": "Contract", "text": "changed something", "note_id": note.id, "at": None,
                       "type": kind, "account": row.id, "locked": False}
            notify._enqueue(db, row, note.id, payload)
            db.commit()
        notify.send_round()

    def announce(self, version: str) -> None:
        """``geraete_store.newer`` as ``nexupdates`` calls it (``on_devices``, G56), with the running version."""
        from app.services import geraete_store

        geraete_store.newer(version)

    def update_wanted(self) -> bool:
        """``geraete_store.update_wanted``, what ``nexupdates`` asks as ``devices_want`` (G56)."""
        from app.services import geraete_store

        return geraete_store.update_wanted()

    def running(self) -> str:
        from app import __version__

        return __version__

    def sweep(self) -> int:
        from app.services import geraete_store

        return geraete_store.sweep()

    def paired_mails(self) -> list[tuple[Any, str]]:
        return list(self.mails)
