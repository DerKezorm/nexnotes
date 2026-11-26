"""nexmcp contract tests: nexnotes' adapter (copied once from the module's template, now nexnotes' file).

The contract tests in ``backend/tests/nexmcp/`` run the module's routes (``/api/mcp``, ``/api/oauth/…``,
``/api/connections/mcp``) over nexnotes' tables (``services/mcp_store.py``) with nexnotes' tools and its own check of
keys. The database is the one of the test session (``tests/conftest.py`` empties it before every test). A fresh app has
nothing stored for "MCP-Zugang" (decision 5: off); the older app is the database as nexnotes before the module wrote it
(an MCP key made by hand, an API token with "also for AI tools", a connector with its current refresh token, the
switch never stored), started as the new version does (``mcp_store.migrate`` on the start that adds its column).
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from mcp_contract import LegacyKey, LegacyProgram, StandardAdapter

TAB = {"X-Nexnotes-Client": "tab-mcp000000"}
NAMES = ("owner", "other", "operator")
REDIRECT = "http://127.0.0.1:33418/callback"


class Adapter(StandardAdapter):
    package = "app.vendor.nexmcp"
    keys_prefix = "/api/connections"
    prefix = "/api/connections/mcp"
    has_ai = False
    older_had_mcp_on = True

    def _accounts(self) -> None:
        """Three accounts with passwords and no second factor, each with its inbox and a note in it; nothing stored
        for "MCP-Zugang"."""
        from sqlalchemy import delete

        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account, Setting
        from app.security import brake, hash_password
        from app.services.inbox import inbox_for

        brake.forget()
        self.ids: dict[str, int] = {}
        self.notes: dict[str, str] = {}
        self.clients: dict[str, Any] = {}
        self.legacy: dict[str, str] = {}
        self.program: LegacyProgram | None = None
        with SessionLocal() as db:
            db.execute(delete(Setting).where(Setting.key == "mcp_enabled"))
            for name in NAMES:
                row = Account(name=f"mcp-{name}", display_name=f"Mcp {name}",
                              role=OPERATOR if name == "operator" else MEMBER,
                              password_hash=hash_password(secrets.token_urlsafe(16)))
                db.add(row)
                db.flush()
                inbox_for(db, row.id)
                self.ids[name] = row.id
            db.commit()
        for name in ("owner", "other"):
            made = self.client(name).post("/api/notes", json={"title": f"Note of {name}", "markdown": "milk"})
            assert made.status_code == 201, made.text
            self.notes[name] = made.json()["id"]

    def start(self) -> None:
        self._accounts()

    def start_older(self) -> None:
        """As nexnotes before the module: ``apitokens.make`` for the MCP key and the API token, the OAuth token
        endpoint's row for a connector (a client, an access token of an hour, the hash of its refresh token)."""
        from app.db import SessionLocal, engine
        from app.models import TOKEN_API, TOKEN_MCP, Account, ApiToken, utcnow
        from app.models_mcp import OAuthClient
        from app.services import apitokens, mcp_store

        self._accounts()
        refresh = "nnr_" + secrets.token_urlsafe(32)
        with SessionLocal() as db:
            owner = db.get(Account, self.ids["owner"])
            assert owner is not None
            _hand, hand = apitokens.make(db, owner, "old mcp", kind=TOKEN_MCP, level="write")
            _api, api = apitokens.make(db, owner, "old api", kind=TOKEN_API, level="read", allow_mcp=True)
            client = OAuthClient(id="nno_" + secrets.token_urlsafe(24), name="Old program", redirect_uris=[REDIRECT])
            db.add(client)
            access = "nn_mcp_" + secrets.token_urlsafe(32)
            db.add(ApiToken(account_id=owner.id, kind=TOKEN_MCP, name=client.name, level="read", client_id=client.id,
                            token_hash=apitokens.digest(access), prefix=access[:11], created_at=utcnow(),
                            signed_in_at=utcnow(), expires_at=utcnow() + timedelta(hours=1),
                            refresh_hash=apitokens.digest(refresh)))
            db.commit()
            client_id = client.id
        self.legacy = {"hand": hand, "api": api}
        self.program = LegacyProgram(client_id, REDIRECT, refresh)
        # The new version's start on that database: its column comes, the switch is written down as it stood.
        mcp_store.migrate(engine, [mcp_store.MARK])

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()
        self.clients = {}

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

    def config(self) -> Any:
        from app.services.mcp import CONFIG

        return CONFIG

    def keys_config(self) -> Any:
        from app.services.schluessel_store import CONFIG

        return CONFIG

    def read_call(self) -> tuple[str, dict[str, Any]]:
        return "read_note", {"note_id": self.notes["owner"]}

    def change_call(self) -> tuple[str, dict[str, Any]]:
        return "create_note", {"title": "From the program", "text": "eggs"}

    def foreign_call(self) -> tuple[str, dict[str, Any]]:
        return "read_note", {"note_id": self.notes["other"]}

    def legacy_keys(self) -> list[LegacyKey]:
        return [LegacyKey("MCP key made by hand", "hand"), LegacyKey("API token also for MCP", "api")]

    def make_legacy(self, spec: LegacyKey) -> str:
        return self.legacy[spec.form]

    def legacy_program(self) -> LegacyProgram | None:
        return self.program
