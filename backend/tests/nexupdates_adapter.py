"""nexupdates contract tests: nexnotes' adapter (copied once from the module's template, now nexnotes' file).

The contract tests in ``backend/tests/nexupdates/`` run the module's routes (``/api/about``) in nexnotes, over its
setting ``update_check`` (``services/updates.py``). The database is the one of the test session (``tests/conftest.py``
empties it before every test). nexnotes has no bell for operators (U19): ``has_bell = False``, so the contract checks
that the background never looks and that the first visit of an operator to "About" asks once (updates 0.1.2). It pairs
devices (module geraete): ``has_devices = True``, an operator's device that wants ``update`` counts as a bell (U24,
updates 0.1.3); the relay is a recorder in place of ``apppush.POST``.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

from updates_contract import StandardAdapter

TAB = {"X-Nexnotes-Client": "tab-updates00"}


class Adapter(StandardAdapter):
    has_bell = False
    has_devices = True
    package = "app.vendor.nexupdates"
    prefix = "/api/about"
    also: tuple[str, ...] = ()

    def start(self) -> None:
        """An operator and a member, nothing stored for the switch (as a new installation before its setup)."""
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account
        from app.security import brake, hash_password
        from app.services import apppush

        brake.forget()
        self.clients: dict[str, Any] = {}
        self.ids: dict[str, int] = {}
        self.device: int | None = None
        self.relayed: list[dict[str, Any]] = []
        self._post = apppush.POST

        def relay(_url: str, body: dict[str, Any]) -> int:
            self.relayed.append(body)
            return 200

        apppush.POST = relay  # type: ignore[assignment]
        with SessionLocal() as db:
            for role in ("operator", "member"):
                row = Account(name=f"updates-{role}", display_name=f"Updates {role}",
                              role=OPERATOR if role == "operator" else MEMBER,
                              password_hash=hash_password(secrets.token_urlsafe(16)))
                db.add(row)
                db.flush()
                self.ids[role] = row.id
            db.commit()
        self.restart()

    def stop(self) -> None:
        from app.services import apppush

        for client in self.clients.values():
            client.close()
        self.clients = {}
        apppush.POST = self._post  # type: ignore[assignment]

    def restart(self) -> None:
        from app.services import updates

        updates.configure()

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

    def stored_switch(self) -> Any:
        from app.db import SessionLocal
        from app.models import Setting

        with SessionLocal() as db:
            row = db.get(Setting, "update_check")
            return None if row is None else row.value

    def store_legacy_switch(self, on: bool) -> None:
        """As nexnotes stored it before the module: ``settings_service`` under ``update_check``, a JSON boolean."""
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"update_check": on})

    def setup(self, on: bool) -> None:
        """nexnotes' real setup route with the box ticked or not. The setup is only there without any account, so the
        two of ``start`` go first (the contract tests of the setup use none of them)."""
        from fastapi.testclient import TestClient
        from sqlalchemy import delete

        from app.db import SessionLocal
        from app.main import app
        from app.models import Account

        self.stop()
        with SessionLocal() as db:
            db.execute(delete(Account))
            db.commit()
        # Without ``with``: the app's start would set the module up again, away from the stand-in for GitHub.
        browser = TestClient(app, base_url="https://notes.example.com", headers=TAB)
        made = browser.post("/api/setup", json={"code": os.environ["NEXNOTES_SETUP_TOKEN"], "display_name": "Operator",
                                                "password": "correct horse battery", "update_check": on})
        browser.close()
        assert made.status_code == 200, made.text

    def want_on_device(self, on: bool) -> None:
        """The operator's iPhone, paired once and signed up for notifications of the kind ``update`` (as an app that
        names it does), with that kind switched on or off on the device."""
        import hashlib
        from datetime import UTC, datetime

        from app.db import SessionLocal
        from app.services.geraete_store import GeraeteStore
        from app.vendor.nexgeraete import seal
        from app.vendor.nexgeraete.model import NewDevice, PushState

        with SessionLocal() as db:
            store = GeraeteStore(db)
            if self.device is None:
                token = secrets.token_urlsafe(32)
                made = store.add_device(NewDevice(
                    account_id=self.ids["operator"], name="Operator's iPhone", kind="ios",
                    token_hash=hashlib.sha256(token.encode()).hexdigest(), prefix="nnd_", via="qr",
                    created_at=datetime.now(UTC)))
                self.device = int(made.id)
                store.set_push(self.device, PushState(ticket="updates-operator", key=seal.key_pair()[1],
                                                      understands=("update",)))
            store.set_kinds(self.device, {"update": on})
            store.commit()

    def devices_told(self) -> list[str]:
        """The versions of every notice ``update`` that went to the relay (its ``collapse`` names the version)."""
        return [str(body["collapse"]).removeprefix("update-") for body in self.relayed
                if str(body.get("collapse", "")).startswith("update-")]
