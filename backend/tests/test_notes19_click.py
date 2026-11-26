"""NOTES-19 over both kinds of connection (module verbinden, Runde 2 V18): every use of nextasks goes the same way over
a key typed in by hand (``PUT /api/nextasks``) and over a connection made with a click and a consent: the lists and
the one used last, the areas and lists chosen, each line a task with its mark and its way back, and the refusals
(nextasks away, the access gone). The stand-in nextasks is ``FakeNextasks`` of ``test_notes19``; over the connection
nexnotes reaches it through the module's own way of asking (``reach``)."""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.services.verbinden_store import VerbindenStore
from app.vendor import nexverbinden
from app.vendor.nexverbinden import reach

from .test_notes3 import new_note
from .test_notes19 import FAMILY_AREA, GOOD, HOME, LIST, OTHER_LIST, allow_home, code, connect, fake, links, send

__all__ = ["fake"]


def _by_click(account_id: int, stand_in) -> None:
    """A connection as the module keeps it after "Verbinden" and the consent: the access nextasks gave, sealed."""
    now = datetime.now(UTC)
    with SessionLocal() as db:
        store = VerbindenStore(db)
        held = json.dumps({"access": GOOD, "refresh": "ntcr_" + secrets.token_urlsafe(16),
                           "expires": (now + timedelta(hours=1)).isoformat(), "own": "https://notes.example.com"})
        store.save(nexverbinden.Connection(
            id=secrets.token_urlsafe(16), account_id=account_id, partner="nextasks", partner_base=HOME,
            partner_account="Robin", uses=("tasks.read", "tasks.write"), grants=(), areas_granted=None,
            areas_used=None, held=store.seal(held), issued_access_hash=secrets.token_hex(32),
            issued_refresh_hash=secrets.token_hex(32), issued_access_expires=now + timedelta(hours=1), created_at=now))
        store.commit()


@pytest.fixture(params=["key", "click"])
def way(request, client: TestClient, operator, fake, monkeypatch) -> str:
    allow_home(client)
    monkeypatch.setattr(reach, "RESOLVER", fake.resolve)
    monkeypatch.setattr(reach, "TRANSPORT", httpx.MockTransport(fake.handle))
    nexverbinden.connect.BRAKE.forget()
    if request.param == "key":
        assert connect(client).status_code == 200
    else:
        _by_click(operator.id, fake)
    return request.param


def test_v18_the_status_says_connected_and_by_which_way(client, way):
    found = client.get("/api/nextasks").json()
    assert found["connected"] is True and found["by"] == ("key" if way == "key" else "connection")
    assert found["host"] == "nextasks.home"


def test_v18_lists_and_the_one_used_last(client, way, fake):
    names = [item["name"] for item in client.get("/api/nextasks/lists").json()["lists"]]
    assert names == ["Zuhause › Renovierung", "Zuhause › Renovierung › Bad", "Familie › Einkauf"]
    note = new_note(client, markdown="Fliesen")
    assert send(client, note["id"], ["Fliesen"], list_id=OTHER_LIST, list_name="Familie › Einkauf").status_code == 200
    assert client.get("/api/nextasks/lists").json()["last"] == OTHER_LIST
    # Over the connection the token is nextasks' own for the connection, never one typed in.
    assert all(request.headers["authorization"] == f"Bearer {GOOD}" for request in fake.requests)


def test_v18_areas_and_lists_chosen_decide_what_the_sending_offers(client, way):
    areas = client.get("/api/nextasks/areas")
    assert areas.status_code == 200, areas.text
    assert all(area["whole"] for area in areas.json()["areas"])
    chosen = client.put("/api/nextasks/areas", json={"areas": [FAMILY_AREA], "lists": [], "default": OTHER_LIST})
    assert chosen.status_code == 200, chosen.text
    offered = client.get("/api/nextasks/lists").json()["lists"]
    assert [item["name"] for item in offered] == ["Familie › Einkauf"] and offered[0]["default"] is True


def test_v18_each_line_becomes_a_task_with_its_mark(client, way, fake, operator):
    note = new_note(client, title="Bad", markdown="- [ ] Silikon\n- [ ] Termin")
    sent = send(client, note["id"], ["Silikon", "Termin"])
    assert sent.status_code == 200, sent.text
    assert len(fake.tasks) == 2 and all(task["list_id"] == LIST for task in fake.tasks.values())
    assert all(task["external_ref"].startswith(f"nexnotes:{operator.id}:") for task in fake.tasks.values())
    marks = links(client, note["id"])
    assert len(marks) == 2
    opened = client.get(f"/api/nextasks/links/{marks[0]['id']}/open")
    assert opened.status_code == 200, opened.text


def test_v18_nextasks_away_or_the_access_gone_is_said_and_never_401(client, way, fake):
    note = new_note(client, markdown="- [ ] Silikon")
    fake.down = True
    down = send(client, note["id"], ["Silikon"])
    assert down.status_code == 502 and code(down) == "nextasks_unreachable"
    fake.down = False
    del fake.tokens[GOOD]
    gone = send(client, note["id"], ["Silikon"])
    assert gone.status_code == 409 and code(gone) == "nextasks_token_invalid"
    assert client.get("/api/nextasks").status_code == 200
