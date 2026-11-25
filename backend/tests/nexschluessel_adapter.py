"""nexschluessel contract tests: nexnotes' adapter (copied once from the module's template, now nexnotes' file).

The contract tests in ``backend/tests/nexschluessel/`` run the module's routes (``/api/connections``) over nexnotes'
real table ``api_tokens`` (``app.services.schluessel_store``) and present every key, old and new, to nexnotes' own
routes: ``GET /api/v1/me`` for API keys (the older nexdeck card keys too, which open only the card's routes, ``me``
among them) and ``POST /api/mcp`` for MCP keys. The database is the one of the test session (``tests/conftest.py``
empties it before every test). Keys are made at run time.
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from schluessel_contract import LegacyKey, StandardAdapter

TAB = {"X-Nexnotes-Client": "tab-contract"}
NAMES = ("owner", "other", "operator")


class Adapter(StandardAdapter):
    package = "app.vendor.nexschluessel"
    prefix = "/api/connections"

    def start(self) -> None:
        """Three accounts with passwords and no second factor, each with a folder (and its inbox)."""
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account, Folder
        from app.security import brake, hash_password
        from app.services.inbox import inbox_for

        brake.forget()
        self.ids: dict[str, int] = {}
        self.folders: dict[str, str] = {}
        self.clients: dict[str, Any] = {}
        with SessionLocal() as db:
            for name in NAMES:
                row = Account(name=f"contract-{name}", display_name=f"Contract {name}",
                              role=OPERATOR if name == "operator" else MEMBER,
                              password_hash=hash_password(secrets.token_urlsafe(16)))
                db.add(row)
                db.flush()
                inbox_for(db, row.id)
                folder = Folder(owner_id=row.id, name=f"Folder of {name}")
                db.add(folder)
                db.flush()
                self.ids[name] = row.id
                self.folders[name] = folder.id
            db.commit()

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()

    def config(self) -> Any:
        from app.services.schluessel_store import CONFIG

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

    def legacy_keys(self) -> list[LegacyKey]:
        return [
            LegacyKey("API token (read)", "api", "nn_api_", "read"),
            LegacyKey("API token (write)", "api", "nn_api_", "write"),
            LegacyKey("nexdeck card key", "api", "nn_deck_", "read", legacy="card"),
            LegacyKey("MCP key made by hand", "mcp", "nn_mcp_", "read"),
            LegacyKey("connector of an AI tool", "mcp", "nn_mcp_", "write", program=True),
        ]

    def make_legacy(self, spec: LegacyKey, *, account: str = "owner", expired: bool = False) -> str:
        """As 1.1.0 wrote them: ``apitokens.make`` for API tokens, card keys and MCP keys made by hand, the OAuth token
        endpoint for a connector (a row with its client and an access token of an hour). A paired iPhone beside them
        in the same table, never a key of the module."""
        from app.db import SessionLocal
        from app.models import TOKEN_API, TOKEN_DASHBOARD, TOKEN_DEVICE, TOKEN_MCP, Account, ApiToken, utcnow
        from app.models_mcp import OAuthClient
        from app.services import apitokens

        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            apitokens.make(db, row, "iPhone", kind=TOKEN_DEVICE)
            if spec.program:
                client = OAuthClient(id=f"nno_{secrets.token_hex(8)}", name=spec.label, redirect_uris=[])
                db.add(client)
                token = apitokens.PREFIXES[TOKEN_MCP] + secrets.token_urlsafe(32)
                key = ApiToken(account_id=row.id, kind=TOKEN_MCP, name=spec.label, level=spec.right,
                               client_id=client.id, token_hash=apitokens.digest(token),
                               prefix=token[: len(apitokens.PREFIXES[TOKEN_MCP]) + 4], created_at=utcnow(),
                               signed_in_at=utcnow(), expires_at=utcnow() + timedelta(hours=1))
                db.add(key)
                db.commit()
            else:
                kind = {"api": TOKEN_DASHBOARD if spec.legacy == "card" else TOKEN_API, "mcp": TOKEN_MCP}[spec.kind]
                key, token = apitokens.make(db, row, spec.label, kind=kind, level=spec.right, days=90)
            if expired:
                key.expires_at = utcnow() - timedelta(hours=1)
                db.commit()
        return token

    def probe(self, kind: str, secret: str) -> int:
        from app.security import brake

        brake.forget()
        client = self.client("anonymous")
        headers = {"Authorization": f"Bearer {secret}"}
        if kind == "mcp":
            return client.post(
                "/api/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}
            ).status_code
        return client.get("/api/v1/me", headers=headers).status_code

    def owe_factor(self) -> None:
        """The operator requires a second factor; the owner signs in with a password and has none. A browser session of
        such an account reaches only its account page until it enrols (``deps.SETUP_ONLY_PATHS``); the one state in
        which it sees its keys while they rest is a sign-in through a provider that checks the second factor itself
        (``provider_checked``): the session is spared, its keys are not. The owner's browser is that session from now
        on."""
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import Account
        from app.security import SESSION_COOKIE, start_session
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"two_factor_required": True})
            row = db.get(Account, self.ids["owner"])
            assert row is not None
            cookie = start_session(db, row, "127.0.0.1", "contract", provider_checked=True)
        if "owner" in self.clients:
            self.clients.pop("owner").close()
        browser = TestClient(app, base_url="https://notes.example.com", headers=TAB)
        browser.cookies.set(SESSION_COOKIE, cookie)
        self.clients["owner"] = browser

    def foreign_area(self) -> Any:
        return self.folders["other"]
