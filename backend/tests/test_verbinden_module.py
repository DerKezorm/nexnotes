"""nexnotes on the shared module verbinden (``vendor/nexverbinden`` 0.1.4), beside the module's contract tests
(``tests/nexverbinden``):

- nextime may add notes here (catalog: ``notes.add``): its token opens ``POST /api/v1/notes`` into the folders given
  and nothing else of ``/api/v1``, under the switch "Verbindungen mit anderen nex-Apps", not the one of the API;
- nexnotes' requests to nextasks go through a connection of the module when there is one (it takes the place of a key
  typed in), else as before over the key;
- the older way ``PUT /api/nextasks`` (a key typed in, NOTES-19) keeps working beside the module;
- "Verbindungen ins eigene Netz" in the module's card and nexnotes' own switch are one setting (0.1.4);
- "Trennen" of a connection by click drops the row without a key that kept nextasks' areas and lists for it, never a
  connection typed in (``on_disconnected``, 0.1.4);
- the consent page shows the account with its shown name, its user name and its own picture at the address the
  sidebar asks for (``Store.account_card``, 0.1.8).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.routers import api_v1
from app.services import nextasks as nextasks_service
from app.services import settings_service
from app.services.verbinden_store import CONFIG, VerbindenStore
from app.vendor import nexverbinden
from app.vendor.nexverbinden import connect
from app.vendor.nexverbinden.reach import Answer

from .test_notes3 import new_note, stored


def _folder(client: TestClient, name: str) -> str:
    made = client.post("/api/folders", json={"name": name})
    assert made.status_code == 201, made.text
    return str(made.json()["id"])


def _connection(account_id: int, partner: str, grants: tuple[str, ...], areas: list[str] | None) -> str:
    """A connection as the module makes it after the consent; the access token nexnotes gave the partner."""
    access = CONFIG.access_prefix + secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    with SessionLocal() as db:
        store = VerbindenStore(db)
        store.save(nexverbinden.Connection(
            id=secrets.token_urlsafe(16), account_id=account_id, partner=partner,
            partner_base=f"https://{partner}.example.com", partner_account="kim", uses=(), grants=grants,
            areas_granted=areas, areas_used=None, held=store.seal('{"access": "x", "refresh": "y", "own": "z"}'),
            issued_access_hash=hashlib.sha256(access.encode()).hexdigest(),
            issued_refresh_hash=hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
            issued_access_expires=now + timedelta(hours=1), created_at=now))
        store.commit()
    return access


def test_the_prefix_the_api_knows_is_the_modules() -> None:
    assert api_v1.CONNECTION_PREFIX == CONFIG.access_prefix


def test_nextime_adds_notes_only_into_the_folders_it_was_given(client, operator):
    work, home = _folder(client, "Work"), _folder(client, "Home")
    new_note(client, title="Plan", markdown="x", folder_id=work)
    new_note(client, title="Groceries", markdown="y", folder_id=home)
    token = _connection(operator.id, "nextime", ("notes.add",), [home])
    program = TestClient(client.app)
    made = program.post("/api/v1/notes", headers={"Authorization": f"Bearer {token}"},
                        json={"title": "From the calendar", "folder_id": home})
    assert made.status_code == 201, made.text
    refused = program.post("/api/v1/notes", headers={"Authorization": f"Bearer {token}"},
                           json={"title": "Elsewhere", "folder_id": work})
    assert refused.status_code in (403, 404)
    # The switch of the API is not the one of connections; theirs closes the way and deletes nothing.
    with SessionLocal() as db:
        settings_service.save(db, {"api_enabled": False})
    again = program.post("/api/v1/notes", headers={"Authorization": f"Bearer {token}"},
                         json={"title": "Once more", "folder_id": home})
    assert again.status_code == 201, again.text
    with SessionLocal() as db:
        VerbindenStore(db).set_setting("connections", False)
        db.commit()
    off = program.post("/api/v1/notes", headers={"Authorization": f"Bearer {token}"},
                       json={"title": "Off", "folder_id": home})
    assert off.status_code == 403 and off.json()["detail"]["code"] == "connections_off"


def test_adding_notes_opens_nothing_else_of_the_api(client, operator):
    """Befundsuche 28.11.2026: "Notizen anlegen" is all a connection with ``notes.add`` may; no reading, no searching,
    no changing or trashing, also without a choice of folders (all of them)."""
    note = new_note(client, title="Diary", markdown="private")["id"]
    token = _connection(operator.id, "nextime", ("notes.add",), None)
    program = TestClient(client.app, headers={"Authorization": f"Bearer {token}"})
    for method, path, body in (
        ("GET", "/api/v1/notes", None), ("GET", f"/api/v1/notes/{note}", None), ("GET", "/api/v1/me", None),
        ("GET", "/api/v1/search?q=private", None), ("GET", "/api/v1/folders", None),
        ("GET", "/api/v1/dashboard", None), ("DELETE", f"/api/v1/notes/{note}", None),
        ("PATCH", f"/api/v1/notes/{note}", {"title": "Mine now"}),
        ("PUT", f"/api/v1/notes/{note}/content", {"markdown": "gone", "base": "x"}),
    ):
        answer = program.request(method, path, json=body)
        assert answer.status_code == 403, (method, path, answer.text)
        assert answer.json()["detail"]["code"] == "purpose_missing", (method, path)
    kept = stored(note)
    assert kept.title == "Diary" and kept.deleted_at is None
    assert program.post("/api/v1/notes", json={"title": "From the calendar"}).status_code == 201


def test_a_connection_finds_again_only_the_notes_it_made(client, operator):
    """The same ``external_ref`` gives the same note, but a connection's references stand apart from those of the
    account's own programs: it cannot fetch one of their notes by guessing a reference."""
    from app.models import Account
    from app.services import apitokens

    with SessionLocal() as db:
        key = apitokens.make(db, db.get(Account, operator.id), "Script", kind="api", level="write")[1]
    mine = client.post("/api/v1/notes", headers={"Authorization": f"Bearer {key}"},
                       json={"title": "Secret plan", "external_ref": "nextime:1:7:"})
    assert mine.status_code == 201, mine.text
    token = _connection(operator.id, "nextime", ("notes.add",), None)
    program = TestClient(client.app, headers={"Authorization": f"Bearer {token}"})
    first = program.post("/api/v1/notes", json={"title": "Dentist", "external_ref": "nextime:1:7:"})
    assert first.status_code == 201 and first.json()["id"] != mine.json()["id"], first.text
    assert first.json()["title"] == "Dentist"
    again = program.post("/api/v1/notes", json={"title": "Dentist", "external_ref": "nextime:1:7:"})
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]


def test_a_connection_rests_while_the_account_owes_the_second_factor(client, operator):
    """EC-9 as for API and MCP keys: the operator requires a second factor, the account has none yet; the
    connection's token is refused until it enrols (the module's ``account_resting``)."""
    token = _connection(operator.id, "nextime", ("notes.add",), None)
    program = TestClient(client.app, headers={"Authorization": f"Bearer {token}"})
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": True})
    refused = program.post("/api/v1/notes", json={"title": "From the calendar"})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "account_resting", refused.text
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": False})
    assert program.post("/api/v1/notes", json={"title": "From the calendar"}).status_code == 201


def test_a_connection_without_the_purpose_opens_nothing(client, operator):
    token = _connection(operator.id, "nextasks", (), None)
    refused = TestClient(client.app).get("/api/v1/notes", headers={"Authorization": f"Bearer {token}"})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "purpose_missing"


def test_requests_to_nextasks_go_through_the_modules_connection(client, operator, monkeypatch: pytest.MonkeyPatch):
    sent: list[tuple[Any, ...]] = []

    def call(_store: Any, _config: Any, account_id: Any, partner: str, method: str, path: str, _now: Any, **kw: Any):
        sent.append((account_id, partner, method, path))
        return Answer(200, {"lists": []}, "")

    monkeypatch.setattr(nexverbinden, "call", call)
    _connection(operator.id, "nextasks", (), None)
    with SessionLocal() as db:
        access = nextasks_service.connected_access(db, operator.id)
    assert access.connected_by == operator.id and access.token == ""
    assert nextasks_service.request(access, "GET", "lists") == {"lists": []}
    assert sent == [(operator.id, "nextasks", "GET", "/api/v1/lists")]
    # What the module says it cannot do comes as nexnotes' own refusal.
    monkeypatch.setattr(nexverbinden, "call", lambda *a, **k: (_ for _ in ()).throw(nexverbinden.Refused("resting")))
    with pytest.raises(nextasks_service.NextasksError) as refused:
        nextasks_service.request(access, "GET", "lists")
    assert refused.value.code == "nextasks_token_invalid"


def test_the_older_way_to_nextasks_keeps_working_beside_the_module(client, operator, monkeypatch):
    """NOTES-19 by hand: ``PUT /api/nextasks`` checks and keeps address and key as before; the card of the module shows
    it as a connection by API key."""
    monkeypatch.setattr(nextasks_service, "check", lambda access: "Kim")
    made = client.put("/api/nextasks", json={"url": "https://tasks.example.com", "token": "ntk_" + "a" * 40})
    assert made.status_code == 200, made.text
    assert client.get("/api/nextasks").json()["connected"] is True
    with SessionLocal() as db:
        access = nextasks_service.connected_access(db, operator.id)
    assert access.connected_by is None and access.token.startswith("ntk_")
    card = next(view for view in client.get("/api/connect/partners").json() if view["partner"] == "nextasks")
    assert card["state"] == "legacy" and card["legacy"]["shown"] == "ntk_aaaa"
    assert client.delete("/api/nextasks").status_code == 204
    assert client.get("/api/nextasks").json()["connected"] is False


def test_the_own_network_is_one_setting_in_the_card_and_in_general(client, operator):
    assert client.put("/api/connect/admin", json={"local": True}).status_code == 200
    assert client.get("/api/settings").json()["connections_local_network"] is True
    assert client.put("/api/settings", json={"connections_local_network": False}).status_code == 200
    assert client.get("/api/connect/admin").json()["local"] is False
    assert client.put("/api/connect/admin", json={"local": "yes"}).status_code == 422


def test_the_consent_page_shows_the_account_with_its_shown_name_and_own_picture(client, operator):
    from urllib.parse import quote

    from app.models import Account

    from .test_avatars import photo

    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.display_name = "Kim Example"
        db.commit()
        card = connect.account_card(VerbindenStore(db), operator.id)
    assert card == {"name": "Kim Example", "username": operator.name, "picture": None, "color": None}
    stamp = client.put("/api/auth/avatar", content=photo()).json()["avatar"]
    with SessionLocal() as db:
        card = connect.account_card(VerbindenStore(db), operator.id)
    # The address of ``lib/avatar.ts`` (``encodeURIComponent`` of the stamp), so the page shows the picture it has.
    assert card["picture"] == f"/api/avatars/{operator.id}?v={quote(stamp, safe='')}"
    shown = client.get(card["picture"])
    assert shown.status_code == 200 and shown.headers["content-type"] == "image/webp"
    # Without a shown name of its own the user name alone (the module leaves out a name equal to it).
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.display_name = ""
        db.commit()
        assert connect.account_card(VerbindenStore(db), operator.id)["name"] == ""


def test_trennen_drops_the_choice_kept_for_a_click_and_the_key_typed_in(client, operator, monkeypatch):
    from app.models_nextasks import NextasksConnection
    from app.security import encrypt_secret

    monkeypatch.setattr(connect, "_ask", lambda *args, **kwargs: {})
    _connection(operator.id, "nextasks", (), None)
    with SessionLocal() as db:
        db.add(NextasksConnection(account_id=operator.id, url="", token_enc="", task_choice='{"areas": ["a"]}'))
        db.commit()
    assert client.delete("/api/connect/partners/nextasks").status_code == 200
    with SessionLocal() as db:
        assert db.get(NextasksConnection, operator.id) is None
    # Since verbinden 0.2.0 (B9, V56) "Trennen" ends a key typed in as well: the card shows "Nicht verbunden".
    _connection(operator.id, "nextasks", (), None)
    with SessionLocal() as db:
        db.add(NextasksConnection(account_id=operator.id, url="https://nextasks.example.com",
                                  token_enc=encrypt_secret("ntk_x", f"nextasks:{operator.id}"), name="Kim"))
        db.commit()
    assert client.delete("/api/connect/partners/nextasks").status_code == 200
    with SessionLocal() as db:
        row = db.get(NextasksConnection, operator.id)
        assert row is None or not row.token_enc
        assert VerbindenStore(db).legacy(operator.id) == []


def test_forget_legacy_ends_the_key_typed_in_and_keeps_the_choice_of_lists(client, operator):
    """verbinden 0.2.0 (B9, V56): ``forget_legacy`` empties the sealed key of nextasks, also one a paired device typed
    in (NOTESIOS-22); the choice of lists stays, and nextasks answers only over the click connection."""
    from app.models_nextasks import NextasksConnection
    from app.security import encrypt_secret

    with SessionLocal() as db:
        db.add(NextasksConnection(account_id=operator.id, url="https://nextasks.example.com",
                                  token_enc=encrypt_secret("ntk_x", f"nextasks:{operator.id}"), name="Kim",
                                  device_id=4711, task_choice='{"areas": ["a"]}', default_list_id="l1"))
        db.commit()
    with SessionLocal() as db:
        store = VerbindenStore(db)
        store.forget_legacy(operator.id, "nexlore")  # another partner: nothing of nextasks ends
        assert db.get(NextasksConnection, operator.id).token_enc
        store.forget_legacy(operator.id, "nextasks")
        db.commit()
    with SessionLocal() as db:
        row = db.get(NextasksConnection, operator.id)
        assert row is not None and row.token_enc == "" and row.device_id is None
        assert row.task_choice == '{"areas": ["a"]}' and row.default_list_id == "l1"
        assert VerbindenStore(db).legacy(operator.id) == []
        with pytest.raises(nextasks_service.NextasksError) as gone:
            nextasks_service.connected_access(db, operator.id)
        assert gone.value.code == "nextasks_not_connected"
        VerbindenStore(db).forget_legacy(operator.id, "nextasks")  # twice is fine
    _connection(operator.id, "nextasks", (), None)
    with SessionLocal() as db:
        access = nextasks_service.connected_access(db, operator.id)
    assert access.connected_by == operator.id and access.token == ""


def _choice(account_id: int) -> tuple[str, str] | None:
    from app.models_nextasks import NextasksConnection

    with SessionLocal() as db:
        row = db.get(NextasksConnection, account_id)
        return None if row is None else (row.task_choice, row.default_list_id)


def _click_with_choice(account_id: int) -> None:
    from app.models_nextasks import NextasksConnection

    _connection(account_id, "nextasks", (), None)
    with SessionLocal() as db:
        db.add(NextasksConnection(account_id=account_id, url="", token_enc="", task_choice='{"areas": ["a"]}',
                                  default_list_id="l1"))
        db.commit()


@pytest.mark.parametrize("way", ["browser", "iphone"])
def test_disconnecting_the_older_way_ends_a_connection_by_click(client, operator, monkeypatch, way):
    """Befundsuche 28.11.2026: "Trennen" of ``DELETE /api/nextasks`` and of the published iPhone app
    (``DELETE /api/app/1/nextasks``, 204 as before) ends the connection made with a click too, as the card's
    "Trennen" does; nextasks hears it, and nexnotes no longer says "connected"."""
    from .test_notes24 import paired

    asked: list[str] = []
    monkeypatch.setattr(connect, "_ask", lambda _c, _s, base, method, path, **kw: asked.append(path) or {})
    _click_with_choice(operator.id)
    device = paired(client) if way == "iphone" else None
    gone = device.delete("/nextasks") if device else client.delete("/api/nextasks")
    assert gone.status_code == 204
    with SessionLocal() as db:
        assert VerbindenStore(db).connection(operator.id, "nextasks") is None
    assert asked == [f"{nexverbinden.PREFIX}/revoke"]
    assert _choice(operator.id) is None
    status = device.get("/nextasks") if device else client.get("/api/nextasks")
    assert status.status_code == 200 and status.json()["connected"] is False


def test_a_key_typed_in_takes_the_place_of_a_connection_by_click(client, operator, monkeypatch):
    """Befundsuche 28.11.2026: a key typed in for nextasks (browser or iPhone app) while connected with a click: the
    click connection ends (the last one made counts, as V56 has it the other way round), the answer says what is
    used now, and the choice of lists stays when it is the same nextasks."""
    monkeypatch.setattr(connect, "_ask", lambda *args, **kwargs: {})
    monkeypatch.setattr(nextasks_service, "check", lambda access: "Kim")
    _click_with_choice(operator.id)
    made = client.put("/api/nextasks", json={"url": "https://nextasks.example.com", "token": "ntk_" + "a" * 40})
    assert made.status_code == 200, made.text
    assert made.json()["connected"] is True and made.json()["by"] == "key"
    with SessionLocal() as db:
        assert VerbindenStore(db).connection(operator.id, "nextasks") is None
        access = nextasks_service.connected_access(db, operator.id)
    assert access.connected_by is None and access.token.startswith("ntk_")
    assert _choice(operator.id) == ('{"areas": ["a"]}', "l1")
    assert client.get("/api/nextasks").json()["by"] == "key"
    # Another nextasks has other lists: there the choice of before counts no more (as before).
    _connection(operator.id, "nextasks", (), None)
    other = client.put("/api/nextasks", json={"url": "https://tasks.other.example.com", "token": "ntk_" + "b" * 40})
    assert other.status_code == 200 and other.json()["by"] == "key"
    assert _choice(operator.id) == ("", "")
