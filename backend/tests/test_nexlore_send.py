"""A note into nexlore over the connection of the module verbinden (pair nexnotes → nexlore, purpose ``notes.add``,
Runde 2 V19, Entwurf): the spaces nexlore offers, the note as a new note there with its title and Markdown, the
connection's own token, never a key; nothing without a connection, nothing of a locked note, nexlore away said as
such. The stand-in nexlore answers ``/api/v1/spaces`` and ``POST /api/v1/notes`` as nexlore does."""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.db import SessionLocal
from app.models import Note
from app.services.verbinden_store import VerbindenStore
from app.vendor import nexverbinden
from app.vendor.nexverbinden import reach

from .test_notes3 import new_note

ACCESS = "rlorc_" + "a" * 40
BASE = "https://lore.example.com"


class FakeNexlore:
    def __init__(self) -> None:
        self.notes: list[dict] = []
        self.down = False
        self.seen: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if self.down:
            raise httpx.ConnectError("down", request=request)
        if request.headers.get("authorization") != f"Bearer {ACCESS}":
            return httpx.Response(401, json={"detail": {"code": "token_invalid", "message": "No."}})
        if request.method == "GET" and request.url.path == "/api/v1/spaces":
            return httpx.Response(200, json=[{"name": "Wissen", "role": "owner"}, {"name": "Arbeit", "role": "editor"}])
        if request.method == "POST" and request.url.path == "/api/v1/notes":
            body = json.loads(request.content)
            self.notes.append(body)
            return httpx.Response(201, json={"path": f"{body['folder']}/{body['title']}.md", "hash": "0" * 64})
        return httpx.Response(404, json={"detail": {"code": "not_found", "message": "Not found."}})


@pytest.fixture
def lore(monkeypatch) -> FakeNexlore:
    stand_in = FakeNexlore()
    monkeypatch.setattr(reach, "RESOLVER", lambda host, port: ["93.184.215.14"])
    monkeypatch.setattr(reach, "TRANSPORT", httpx.MockTransport(stand_in.handle))
    nexverbinden.connect.BRAKE.forget()
    return stand_in


def _connect(account_id: int) -> None:
    now = datetime.now(UTC)
    with SessionLocal() as db:
        store = VerbindenStore(db)
        held = json.dumps({"access": ACCESS, "refresh": "rlorr_" + secrets.token_urlsafe(16),
                           "expires": (now + timedelta(hours=1)).isoformat(), "own": "https://notes.example.com"})
        store.save(nexverbinden.Connection(
            id=secrets.token_urlsafe(16), account_id=account_id, partner="nexlore", partner_base=BASE,
            partner_account="Robin", uses=("notes.add",), grants=(), areas_granted=None, areas_used=None,
            held=store.seal(held), issued_access_hash=secrets.token_hex(32), issued_refresh_hash=secrets.token_hex(32),
            issued_access_expires=now + timedelta(hours=1), created_at=now))
        store.commit()


def test_without_a_connection_nothing_is_offered_or_sent(client, operator, lore):
    assert client.get("/api/nexlore").json() == {"connected": False, "spaces": []}
    note = new_note(client, title="Plan", markdown="Ideen")
    refused = client.post("/api/nexlore/send", json={"note_id": note["id"], "space": "Wissen"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "nexlore_not_connected"
    assert lore.seen == []


def test_a_note_goes_into_a_space_of_nexlore_with_title_and_markdown(client, operator, lore):
    _connect(operator.id)
    found = client.get("/api/nexlore").json()
    assert found["connected"] is True and [space["id"] for space in found["spaces"]] == ["Wissen", "Arbeit"]
    note = new_note(client, title="Plan", markdown="**Ideen** für morgen\n\n- [ ] eins")
    sent = client.post("/api/nexlore/send", json={"note_id": note["id"], "space": "Arbeit"})
    assert sent.status_code == 200, sent.text
    assert sent.json() == {"sent": True, "path": "Arbeit/Plan.md"}
    (made,) = lore.notes
    assert made["folder"] == "Arbeit" and made["title"] == "Plan"
    assert "**Ideen** für morgen" in made["content"] and "- [ ] eins" in made["content"]
    assert all(request.headers["authorization"] == f"Bearer {ACCESS}" for request in lore.seen)


def test_a_locked_note_and_one_of_somebody_else_never_go(client, operator, lore):
    _connect(operator.id)
    note = new_note(client, title="Tresor", markdown="PIN")
    with SessionLocal() as db:
        db.get(Note, note["id"]).locked = True
        db.commit()
    locked = client.post("/api/nexlore/send", json={"note_id": note["id"], "space": "Wissen"})
    assert locked.status_code == 409 and locked.json()["detail"]["code"] == "note_locked"
    gone = client.post("/api/nexlore/send", json={"note_id": "no-such-note", "space": "Wissen"})
    assert gone.status_code == 404
    assert lore.notes == []


def test_nexlore_away_is_said(client, operator, lore):
    _connect(operator.id)
    note = new_note(client, title="Plan", markdown="x")
    lore.down = True
    away = client.post("/api/nexlore/send", json={"note_id": note["id"], "space": "Wissen"})
    assert away.status_code == 502 and away.json()["detail"]["code"] == "nexlore_unreachable"
