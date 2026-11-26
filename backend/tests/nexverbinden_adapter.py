"""nexverbinden contract tests: nexnotes' adapter (copied once from the module's template, now nexnotes' file).

The partner the tests play is nextasks: nexnotes reads and writes tasks there (NOTES-19), nextasks uses nothing of
nexnotes (so every purpose nexnotes grants is refused to it). The older version had a connection to nextasks typed in
by hand (``nextasks_connections``, ``PUT /api/nextasks``) and API tokens (``nn_api_``). The database is the one of the
test session (``tests/conftest.py`` empties it before every test); ``folder`` is not needed.
"""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from verbinden_contract import StandardAdapter

TAB = {"X-Nexnotes-Client": "tab-connect00"}
NAMES = ("owner", "other", "operator")
#: The names the contract tests know the accounts by (as its partner names them).
SHOWN = {"owner": "kim", "other": "sam", "operator": "op"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexverbinden"
    partner = "nextasks"
    base = "https://notes.example.com"
    older_link = True

    def start(self, folder: Path, *, older: bool = False) -> None:
        """Three accounts with their inbox and a folder each (``owner`` has two areas to give); with ``older`` an API
        token of ``owner`` and its connection to nextasks typed in by hand, as nexnotes wrote them."""
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account, Folder
        from app.models_nextasks import NextasksConnection
        from app.security import brake, encrypt_secret, hash_password
        from app.services import apitokens
        from app.services.inbox import inbox_for
        from app.services.verbinden_store import VerbindenStore

        brake.forget()
        self.ids: dict[str, int] = {}
        self.clients: dict[str, TestClient] = {}
        with SessionLocal() as db:
            for name in NAMES:
                row = Account(name=f"connect-{name}", display_name=SHOWN[name],
                              role=OPERATOR if name == "operator" else MEMBER,
                              password_hash=hash_password(secrets.token_urlsafe(16)))
                db.add(row)
                db.flush()
                inbox_for(db, row.id)
                db.add(Folder(owner_id=row.id, name=f"Work of {name}"))
                self.ids[name] = row.id
            db.commit()
            if older:
                owner = db.get(Account, self.ids["owner"])
                assert owner is not None
                _row, self.older_key = apitokens.make(db, owner, "Home Assistant", kind="api", level="read", days=90)
                self.older_key_path = "/api/v1/me"
                key = "ntk_AbCd" + secrets.token_urlsafe(24)
                db.add(NextasksConnection(account_id=owner.id, url="https://nextasks.example.com",
                                          token_enc=encrypt_secret(key, f"nextasks:{owner.id}"), name="Kim"))
                db.commit()
        self._session = SessionLocal()
        self.store = VerbindenStore(self._session)

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()
        self.clients = {}
        self._session.close()

    def asgi(self) -> Any:
        from app.main import app

        return app

    def client(self, role: str | None) -> TestClient:
        from app.db import SessionLocal
        from app.main import app
        from app.models import Account
        from app.security import SESSION_COOKIE, start_session

        key = role or "anonymous"
        if key not in self.clients:
            browser = TestClient(app, base_url=self.base, headers=TAB if role else {})
            if role:
                with SessionLocal() as db:
                    row = db.get(Account, self.ids[role])
                    assert row is not None
                    browser.cookies.set(SESSION_COOKIE, start_session(db, row, "127.0.0.1", "contract"))
            self.clients[key] = browser
        return self.clients[key]

    def config(self) -> Any:
        from app.services.verbinden_store import CONFIG

        return CONFIG

    def block(self, role: str, blocked: bool = True) -> None:
        from app.db import SessionLocal
        from app.models import Account, utcnow

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.blocked_at = utcnow() if blocked else None
            db.commit()
        self._session.expire_all()

    def probe(self, purpose: str) -> str | None:
        # A connection with "notes.add" opens /api/v1 like an API token with its right and folders.
        return "/api/v1/notes"

    def areas_seen(self, purpose: str, answer: Any) -> set[str]:
        return {str(note["folder"]["id"]) for note in answer["notes"] if note.get("folder")}

    def everything(self) -> str:
        import sqlite3

        from app.db import engine

        path = engine.url.database
        assert path
        with sqlite3.connect(path) as db:
            return "\n".join(db.iterdump())

    def own_tables(self) -> dict[str, Any]:
        """The connection to nextasks typed in by hand and the API tokens of before, row by row."""
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import ApiToken
        from app.models_nextasks import NextasksConnection

        with SessionLocal() as db:
            links = [(row.account_id, row.url, row.token_enc, row.name, row.task_choice, row.default_list_id)
                     for row in db.scalars(select(NextasksConnection).order_by(NextasksConnection.account_id))]
            keys = [(row.id, row.kind, row.token_hash, row.level, row.folder_ids, row.allow_mcp)
                    for row in db.scalars(select(ApiToken).order_by(ApiToken.id))]
        return {"nextasks_connections": links, "api_tokens": keys}
