"""NOTES-25 Programmschnittstelle (API), the tokens and the walls: making one (shown once), the list with the older
keys, revoking, where each kind counts, the operator's switch, run-out, blocked accounts, ``Origin``, the brakes, the
log, the operator's overview with "Sperren", ``/me`` and the description at ``/api/v1/docs``."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, utcnow
from app.services import apibrake, apitokens, settings_service

from .conftest import make_account, new_client
from .test_notes3 import new_note


@pytest.fixture(autouse=True)
def fresh(client) -> Iterator[None]:
    apibrake.forget()
    from app.services import mcp

    mcp.forget()
    yield
    apibrake.forget()


def program() -> TestClient:
    """A program: no tab, no cookie, no ``Origin``."""
    return TestClient(app, base_url="http://testserver")


def make(client: TestClient, **body) -> dict:
    answer = client.post("/api/tokens", json={"name": "n8n", "level": "read", **body})
    assert answer.status_code == 201, answer.text
    return answer.json()


def token_of(client: TestClient, **body) -> str:
    return make(client, **body)["token"]


def get(token: str | None, path: str, **params):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return program().get(path, headers=headers, params=params)


def rpc(token: str, method: str = "ping", params: dict | None = None):
    return program().post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                          headers={"Authorization": f"Bearer {token}"})


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def legacy(account: Account, kind: str, level: str = "write", name: str = "alt") -> str:
    """An MCP key or a card key as they were made before NOTES-25."""
    with SessionLocal() as db:
        _row, token = apitokens.make(db, db.get(Account, account.id), name, kind=kind, level=level)
    return token


def listed(client: TestClient) -> list[dict]:
    return client.get("/api/tokens").json()["tokens"]


# --- AC-1: making a token -------------------------------------------------------------------------------------------


def test_notes25_ac1_a_token_with_name_right_mcp_folders_and_run_out_is_shown_once(client, operator):
    made = make(client, name="Home Assistant", level="write")
    token = made["token"]
    assert token.startswith("nn_api_") and len(token) > 40
    entry = made["made"]
    # From the start: MCP off, all notes, 90 days.
    assert entry["access"] == ["api"] and entry["folders"] is None and entry["level"] == "write"
    with SessionLocal() as db:
        row = db.scalar(select(ApiToken).where(ApiToken.kind == "api"))
        assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert token not in str([getattr(row, column.name) for column in ApiToken.__table__.columns])
        assert abs((row.expires_at - utcnow()) - timedelta(days=90)) < timedelta(minutes=1)
    # Never again: not in the list.
    assert token not in client.get("/api/tokens").text
    # The other run-outs, and "Nie".
    for days in (30, 365):
        with SessionLocal() as db:
            found = make(client, name=f"d{days}", days=days)["made"]
            row = db.get(ApiToken, found["id"])
            assert abs((row.expires_at - utcnow()) - timedelta(days=days)) < timedelta(minutes=1)
    assert make(client, name="never", days=None)["made"]["expires_at"] is None
    # MCP and folders as chosen.
    folder = client.post("/api/folders", json={"name": "Haushalt"}).json()["id"]
    chosen = make(client, name="limited", mcp=True, folders=[folder, "inbox"])["made"]
    assert chosen["access"] == ["api", "mcp"] and len(chosen["folders"]) == 2 and chosen["folders"][0] == folder


def test_notes25_ac1_what_a_token_cannot_be_made_with(client, operator):
    def refused(**body):
        return client.post("/api/tokens", json={"name": "x", "level": "read", **body})

    assert refused(level="admin").status_code == 422
    assert refused(name="   ").json()["detail"]["fields"] == ["name"]
    assert refused(name="x" * 101).status_code == 422
    assert refused(days=7).json()["detail"]["fields"] == ["days"]
    assert refused(folders=[]).json()["detail"]["fields"] == ["folders"]
    assert refused(folders=["no-such-folder"]).json()["detail"]["fields"] == ["folders"]
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = as_anna.post("/api/folders", json={"name": "Privat"}).json()["id"]
    # A folder of another account is no folder to choose (EC-2).
    assert refused(folders=[theirs]).json()["detail"]["fields"] == ["folders"]
    assert listed(client) == []


# --- AC-2: the list, revoking ---------------------------------------------------------------------------------------


def test_notes25_ac2_the_list_names_right_access_folders_run_out_and_last_use(client, operator):
    token = token_of(client, name="Skript", level="read")
    make(client, name="Assistent", level="write", mcp=True, days=None)
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        token_of(as_anna, name="Not mine")
    rows = listed(client)
    assert [(row["name"], row["level"], row["access"], row["folders"], row["last_used_at"]) for row in rows] == [
        ("Skript", "read", ["api"], None, None), ("Assistent", "write", ["api", "mcp"], None, None)]
    assert rows[0]["expires_at"] is not None and rows[1]["expires_at"] is None
    assert rows[0]["expired"] is False and rows[0]["blocked"] is False and rows[0]["legacy"] is None
    assert get(token, "/api/v1/me").status_code == 200
    assert listed(client)[0]["last_used_at"] is not None


def test_notes25_ac2_revoking_ends_a_token_at_once_and_only_its_owner_revokes(client, operator):
    made = make(client, name="Desk")
    token = made["token"]
    assert get(token, "/api/v1/me").status_code == 200
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        assert as_anna.delete(f"/api/tokens/{made['made']['id']}").status_code == 404
    assert get(token, "/api/v1/me").status_code == 200
    assert client.delete(f"/api/tokens/{made['made']['id']}").status_code == 204
    gone = get(token, "/api/v1/me")
    assert gone.status_code == 401 and code(gone) == "token_invalid"
    assert listed(client) == []


# --- AC-3: the older kinds ------------------------------------------------------------------------------------------


def test_notes25_ac3_older_keys_keep_exactly_their_rights_and_stand_in_the_list(client, operator):
    mcp_key = legacy(operator, "mcp", name="Chat")
    card_key = legacy(operator, "dashboard", name="Küche")
    note = new_note(client, markdown="- [ ] Milch")
    # An MCP key: MCP only.
    assert rpc(mcp_key).status_code == 200
    assert code(get(mcp_key, "/api/v1/me")) == "token_invalid"
    # A card key: the five routes of the card only, never MCP.
    for path in ("/api/v1/me", "/api/v1/dashboard", "/api/v1/notes", f"/api/v1/notes/{note['id']}"):
        assert get(card_key, path).status_code == 200, path
    for path in ("/api/v1/search", "/api/v1/folders", "/api/v1/tags", "/api/v1/trash", "/api/v1/shares/with-me",
                 f"/api/v1/notes/{note['id']}/attachments"):
        answer = get(card_key, path, q="Milch")
        assert answer.status_code == 403 and code(answer) == "token_card_only", path
    assert rpc(card_key).status_code == 401
    # A card key gets the card's answer: no Markdown unless it asks.
    assert "markdown" not in get(card_key, f"/api/v1/notes/{note['id']}").json()
    rows = {row["name"]: row for row in listed(client)}
    assert rows["Chat"]["legacy"] == "mcp" and rows["Chat"]["access"] == ["mcp"]
    assert rows["Küche"]["legacy"] == "card" and rows["Küche"]["access"] == ["card"]
    # No new ones of these kinds: their routes are gone.
    assert client.post("/api/mcp/keys", json={"name": "x", "level": "read"}).status_code in (404, 405)
    assert client.post("/api/dashboard/keys", json={"name": "x", "level": "read"}).status_code in (404, 405)


def test_notes25_ec11_twenty_tokens_with_the_older_keys_counted_and_more_kept(client, operator):
    for number in range(10):
        legacy(operator, "mcp", name=f"m{number}")
    for number in range(5):
        legacy(operator, "dashboard", name=f"d{number}")
    for number in range(5):
        make(client, name=f"a{number}")
    too_many = client.post("/api/tokens", json={"name": "one more", "level": "read"})
    assert too_many.status_code == 409 and code(too_many) == "tokens_too_many" and too_many.json()["detail"]["max"] == 20
    # An account that had more than 20 before keeps all of them, and they work.
    anna = make_account("anna")
    keys = [legacy(anna, "dashboard", name=f"k{number}") for number in range(22)]
    with new_client(anna) as as_anna:
        assert len(listed(as_anna)) == 22
    assert all(get(key, "/api/v1/me").status_code == 200 for key in (keys[0], keys[-1]))


# --- AC-4, EC-14: MCP -----------------------------------------------------------------------------------------------


def test_notes25_ac4_a_token_with_mcp_opens_mcp_by_its_right_and_one_without_does_not(client, operator):
    without = token_of(client, name="plain", level="write")
    answer = rpc(without)
    assert answer.status_code == 401 and code(answer) == "key_invalid"
    reads = token_of(client, name="reads", level="read", mcp=True)
    writes = token_of(client, name="writes", level="write", mcp=True)
    assert rpc(reads).status_code == 200
    names = {tool["name"] for tool in rpc(reads, "tools/list").json()["result"]["tools"]}
    assert "search_notes" in names and "create_note" not in names
    names = {tool["name"] for tool in rpc(writes, "tools/list").json()["result"]["tools"]}
    assert "create_note" in names
    made = rpc(writes, "tools/call", {"name": "create_note", "arguments": {"text": "Milch"}}).json()["result"]
    assert made["isError"] is False
    # Connectors stay apart, as "Verbundene KI-Werkzeuge".
    assert client.get("/api/tokens").json()["connectors"] == []


def test_notes25_ec14_mcp_off_stops_mcp_and_leaves_the_api(client, operator):
    token = token_of(client, mcp=True)
    assert client.put("/api/settings", json={"mcp_enabled": False}).status_code == 200
    off = rpc(token)
    assert off.status_code == 403 and code(off) == "mcp_off"
    assert get(token, "/api/v1/me").status_code == 200
    # No token with MCP while it is off.
    refused = client.post("/api/tokens", json={"name": "x", "level": "read", "mcp": True})
    assert refused.status_code == 403 and code(refused) == "mcp_off"


# --- AC-5, EC-6: the operator's switch ------------------------------------------------------------------------------


def test_notes25_ac5_ec6_switched_off_every_route_answers_api_off_tokens_stay(client, operator):
    with SessionLocal() as db:
        assert settings_service.get(db, "api_enabled") is True
    token = token_of(client, mcp=True)
    card_key = legacy(operator, "dashboard")
    note = new_note(client, markdown="- [ ] Milch")
    assert client.put("/api/settings", json={"api_enabled": False}).status_code == 200
    assert client.get("/api/settings").json()["api_enabled"] is False
    for path in ("/api/v1/me", "/api/v1/dashboard", "/api/v1/notes", f"/api/v1/notes/{note['id']}", "/api/v1/search"):
        answer = get(token, path, q="x")
        assert answer.status_code == 403 and code(answer) == "api_off", path
    assert code(get(card_key, "/api/v1/dashboard")) == "api_off"
    ticked = program().post(f"/api/v1/notes/{note['id']}/items/0", json={"text": "Milch"},
                            headers={"Authorization": f"Bearer {token}"})
    assert code(ticked) == "api_off"
    # Before the token is looked at, and without counting wrong ones (EC-6).
    for _ in range(25):
        assert code(get("nn_api_wrong", "/api/v1/me")) == "api_off"
    made = client.post("/api/tokens", json={"name": "x", "level": "read"})
    assert made.status_code == 403 and code(made) == "api_off"
    assert client.get("/api/tokens").json()["allowed"] is False and len(listed(client)) == 2
    # The MCP switch is its own.
    assert rpc(token).status_code == 200
    assert client.put("/api/settings", json={"api_enabled": True}).status_code == 200
    assert get(token, "/api/v1/me").status_code == 200
    wrong = get("nn_api_wrong", "/api/v1/me")
    assert wrong.status_code == 401 and code(wrong) == "token_invalid"


def test_notes25_ac5_a_member_cannot_switch_the_api(client, operator):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        assert as_anna.put("/api/settings", json={"api_enabled": False}).status_code == 403
    with SessionLocal() as db:
        assert settings_service.get(db, "api_enabled") is True


# --- EC-5, EC-9, EC-10: invalid tokens, accounts, web pages --------------------------------------------------------


def test_notes25_ec5_a_token_run_out_answers_token_invalid_and_the_list_says_so(client, operator):
    made = make(client, days=30)
    with SessionLocal() as db:
        db.get(ApiToken, made["made"]["id"]).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    answer = get(made["token"], "/api/v1/me")
    assert answer.status_code == 401 and code(answer) == "token_invalid"
    assert listed(client)[0]["expired"] is True
    assert code(get("nn_api_unknown", "/api/v1/me")) == "token_invalid"
    assert code(get(None, "/api/v1/me")) == "token_invalid"


def test_notes25_ec9_a_blocked_deleted_or_second_factor_owing_account_s_token_is_refused(client, operator):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        token = token_of(as_anna)
    assert get(token, "/api/v1/me").status_code == 200
    # Owes the second factor the operator requires.
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": True})
    assert code(get(token, "/api/v1/me")) == "token_invalid"
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": False})
    assert get(token, "/api/v1/me").status_code == 200
    # Blocked through the interface: the tokens are gone for good.
    from .test_notes2 import _confirm

    assert client.post(f"/api/accounts/{anna.id}/block", json=_confirm()).status_code in (200, 204)
    assert code(get(token, "/api/v1/me")) == "token_invalid"
    with SessionLocal() as db:
        assert db.scalar(select(ApiToken).where(ApiToken.account_id == anna.id)) is None
    # Deleted.
    lena = make_account("lena")
    with new_client(lena) as as_lena:
        token = token_of(as_lena)
    with SessionLocal() as db:
        db.get(Account, lena.id).deleted_at = utcnow()
        db.commit()
    assert code(get(token, "/api/v1/me")) == "token_invalid"


def test_notes25_ec10_a_request_with_origin_is_refused_and_the_session_cookie_counts_for_nothing(client, operator):
    token = token_of(client)
    answer = program().get("/api/v1/me", headers={"Authorization": f"Bearer {token}", "Origin": "https://evil.example"})
    assert answer.status_code == 403 and code(answer) == "origin_refused"
    # The member's own browser with its cookie, no token.
    signed_in = client.get("/api/v1/notes")
    assert signed_in.status_code == 401 and code(signed_in) == "token_invalid"


# --- AC-23, AC-24: brakes and the log -------------------------------------------------------------------------------


def test_notes25_ac23_more_than_600_a_minute_slow_down_and_wrong_tokens_count_per_sender(client, operator, monkeypatch):
    assert apibrake.PER_MINUTE == 600
    token = token_of(client)
    monkeypatch.setattr(apibrake, "PER_MINUTE", 3)
    for _ in range(3):
        assert get(token, "/api/v1/me").status_code == 200
    fast = get(token, "/api/v1/me")
    assert fast.status_code == 429 and code(fast) == "slow_down" and fast.headers["retry-after"] == "60"
    # Another token has its own bucket.
    assert get(token_of(client, name="other"), "/api/v1/me").status_code == 200
    for _ in range(20):
        assert get("nn_api_wrong", "/api/v1/me").status_code == 401
    slowed = get("nn_api_wrong", "/api/v1/me")
    assert slowed.status_code == 429 and code(slowed) == "too_many_attempts" and "retry-after" in slowed.headers


def test_notes25_ac24_writes_are_logged_with_token_and_id_reads_only_deep_never_token_or_content(client, operator,
                                                                                               caplog):
    made = make(client, name="Geheimer Name", level="write")
    token = made["token"]
    note = new_note(client, title="Streng geheimer Titel", markdown="- [ ] Vertrauliche Milch")
    caplog.set_level(logging.INFO, logger="nexnotes.api")
    caplog.clear()
    assert get(token, f"/api/v1/notes/{note['id']}").status_code == 200
    assert not [record for record in caplog.records if record.name == "nexnotes.api" and record.levelno >= logging.INFO]
    ticked = program().post(f"/api/v1/notes/{note['id']}/items/0", json={"text": "Vertrauliche Milch"},
                            headers={"Authorization": f"Bearer {token}"})
    assert ticked.status_code == 200, ticked.text
    lines = [record.getMessage() for record in caplog.records if record.name == "nexnotes.api"]
    assert any(note["id"] in line and f"token_id={made['made']['id']}" in line for line in lines)
    caplog.set_level(logging.DEBUG, logger="nexnotes.api")
    caplog.clear()
    assert get(token, "/api/v1/notes").status_code == 200
    reads = [record for record in caplog.records if record.name == "nexnotes.api"]
    assert reads and all(record.levelno == logging.DEBUG for record in reads)
    every = caplog.text + "\n".join(lines)
    for secret in (token, "Streng geheimer Titel", "Vertrauliche Milch"):
        assert secret not in every


# --- AC-27: the operator's overview ---------------------------------------------------------------------------------


def test_notes25_ac27_the_operator_sees_every_token_without_contents_and_blocks_one(client, operator, caplog):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        folder = as_anna.post("/api/folders", json={"name": "Geheimprojekt"}).json()["id"]
        made = make(as_anna, name="Annas Skript", level="write", folders=[folder])
        token = made["token"]
        # A member sees no overview.
        assert as_anna.get("/api/admin/tokens").status_code == 403
        assert as_anna.post(f"/api/admin/tokens/{made['made']['id']}/block").status_code == 403
    overview = client.get("/api/admin/tokens")
    assert overview.status_code == 200
    row = next(row for row in overview.json()["tokens"] if row["id"] == made["made"]["id"])
    assert row["account"]["name"] and row["name"] == "Annas Skript" and row["level"] == "write"
    assert row["folders"] == 1 and row["access"] == ["api"] and row["last_used_at"] is None
    assert token not in overview.text and "Geheimprojekt" not in overview.text and folder not in overview.text
    assert "prefix" not in row and "token_hash" not in overview.text
    assert get(token, "/api/v1/me").status_code == 200
    caplog.set_level(logging.INFO, logger="nexnotes.api")
    assert client.post(f"/api/admin/tokens/{made['made']['id']}/block").status_code == 204
    blocked = get(token, "/api/v1/me")
    assert blocked.status_code == 401 and code(blocked) == "token_invalid"
    assert any("blocked" in record.getMessage() and str(made["made"]["id"]) in record.getMessage()
               for record in caplog.records)
    with new_client(anna) as as_anna:
        assert listed(as_anna)[0]["blocked"] is True
    # Devices are not the operator's to see here.
    with SessionLocal() as db:
        device, _token = apitokens.make(db, db.get(Account, anna.id), "iPhone")
    assert device.id not in {row["id"] for row in client.get("/api/admin/tokens").json()["tokens"]}
    assert client.post(f"/api/admin/tokens/{device.id}/block").status_code == 404


# --- AC-25, AC-26: the description and /me --------------------------------------------------------------------------


def test_notes25_ac25_the_description_is_for_signed_in_members_only_and_holds_only_the_api(client, operator):
    token = token_of(client)
    for path in ("/api/v1/docs", "/api/v1/openapi.json"):
        assert program().get(path).status_code == 401
        # A token is no sign-in here.
        assert get(token, path).status_code == 401
    page = client.get("/api/v1/docs")
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    # Everything from this server: no address of another site, no "Try it out".
    assert "http://" not in page.text and "https://" not in page.text and "//cdn" not in page.text
    assert '/api-docs/swagger-ui-bundle.js' in page.text and '/api-docs/init.js' in page.text
    schema = client.get("/api/v1/openapi.json").json()
    assert schema["info"]["title"] == "nexnotes API"
    paths = set(schema["paths"])
    assert paths and all(path.startswith("/api/v1/") for path in paths)
    assert {"/api/v1/me", "/api/v1/notes", "/api/v1/notes/{note_id}", "/api/v1/search", "/api/v1/folders",
            "/api/v1/tags", "/api/v1/smart-folders", "/api/v1/shares/with-me", "/api/v1/trash",
            "/api/v1/attachments/{attachment_id}/file"} <= paths
    assert "/api/v1/docs" not in paths and "/api/v1/openapi.json" not in paths
    assert schema["components"]["securitySchemes"]["bearerAuth"]["scheme"] == "bearer"
    assert "curl -H \"Authorization: Bearer" in schema["paths"]["/api/v1/notes"]["get"]["description"]
    # Switched off, the page says so.
    assert client.put("/api/settings", json={"api_enabled": False}).status_code == 200
    assert "switched the API off" in client.get("/api/v1/docs").text
    # The start script never lets a request go out from the page.
    from pathlib import Path

    init = (Path(__file__).resolve().parents[2] / "frontend" / "public" / "api-docs" / "init.js").read_text("utf-8")
    assert "supportedSubmitMethods: []" in init and "validatorUrl: null" in init


def test_notes25_ac26_me_names_account_right_access_folders_run_out_version_and_features(client, operator):
    folder = client.post("/api/folders", json={"name": "Haushalt"}).json()["id"]
    token = token_of(client, level="write", mcp=True, folders=[folder], days=30)
    me = get(token, "/api/v1/me").json()
    assert me["app"] == "nexnotes" and me["name"] == operator.name and me["level"] == "write"
    assert me["access"] == ["api", "mcp"] and me["folders"] == [folder] and me["expires_at"]
    assert me["version"] and me["token"]["name"] == "n8n"
    assert {"pinned", "notes", "check", "read", "search", "folders", "tags", "smart", "attachments",
            "trash"} <= set(me["features"])
    plain = get(token_of(client, name="plain", days=None), "/api/v1/me").json()
    assert plain["folders"] is None and plain["expires_at"] is None and plain["access"] == ["api"]
