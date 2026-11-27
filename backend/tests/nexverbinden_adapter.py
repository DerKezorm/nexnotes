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
#: The user names the contract tests know the accounts by (as its partner names them, ``Store.account_name``).
USER = {"owner": "kim", "other": "sam", "operator": "op"}
#: Their shown names (``display_name``), which the consent page shows with the user name (verbinden 0.1.8, V43).
SHOWN = {"owner": "Kim Example", "other": "Sam Example", "operator": "Op Example"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexverbinden"
    partner = "nextasks"
    base = "https://notes.example.com"
    older_link = True
    #: Since verbinden 0.1.8: the shown names ``account_card`` gives beside the user names.
    shown_names = {"owner": SHOWN["owner"], "other": SHOWN["other"]}  # noqa: RUF012 (read only)

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
                row = Account(name=USER[name], display_name=SHOWN[name],
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
        # Every call of nexnotes' ``on_disconnected``, heard before nexnotes clears up (``disconnected()``).
        from app.services import verbinden_store

        self._ended: list[tuple[Any, str]] = []
        self._clear_up = verbinden_store.disconnected

        def heard(store: Any, account_id: Any, partner: str) -> None:
            self._ended.append((account_id, partner))
            self._clear_up(store, account_id, partner)

        verbinden_store.disconnected = heard  # type: ignore[assignment]

    def disconnected(self) -> list[tuple[Any, str]]:
        return list(self._ended)

    def stop(self) -> None:
        from app.services import verbinden_store

        if hasattr(self, "_clear_up"):
            verbinden_store.disconnected = self._clear_up  # type: ignore[assignment]
            del self._clear_up
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

    def account_id(self, role: str) -> Any:
        return self.ids[role]

    def block(self, role: str, blocked: bool = True) -> None:
        from app.db import SessionLocal
        from app.models import Account, utcnow

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.blocked_at = utcnow() if blocked else None
            db.commit()
        self._session.expire_all()

    def probe(self, purpose: str) -> tuple[str, str, Any] | None:
        # A connection with "notes.add" opens the one route that adds a note, into the folders given.
        return ("POST", "/api/v1/notes", {"title": "From the partner"})

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
