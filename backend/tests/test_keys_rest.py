"""Bauplan E41: an account's own keys rest while it is blocked or deleted and come back with it; paired devices and AI
tools connected by OAuth are disconnected like its sessions and do not come back; only the end of the 30 days removes
the keys."""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import TOKEN_API, TOKEN_DASHBOARD, TOKEN_DEVICE, TOKEN_MCP, Account, ApiToken, utcnow
from app.models_mcp import OAuthClient
from app.services import accounts, apitokens

from .conftest import PASSWORD, make_account, new_client


def _keys(account: Account) -> dict[str, str]:
    """Every form of key nexnotes made, as it made them; a connector the way the OAuth token endpoint writes it."""
    made: dict[str, str] = {}
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        for label, kind in (("api", TOKEN_API), ("mcp", TOKEN_MCP), ("card", TOKEN_DASHBOARD), ("device", TOKEN_DEVICE)):
            _row, made[label] = apitokens.make(db, row, label, kind=kind, level="read")
        client = OAuthClient(id=f"nno_{secrets.token_hex(6)}", name="Desk tool", redirect_uris=[])
        db.add(client)
        token = apitokens.PREFIXES[TOKEN_MCP] + secrets.token_urlsafe(32)
        db.add(ApiToken(account_id=row.id, kind=TOKEN_MCP, name="Desk tool", level="read", client_id=client.id,
                        token_hash=apitokens.digest(token), prefix=token[:11], created_at=utcnow(),
                        expires_at=utcnow() + timedelta(hours=1)))
        db.commit()
        made["program"] = token
    return made


def _works(program: TestClient, label: str, token: str) -> bool:
    headers = {"Authorization": f"Bearer {token}"}
    if label in ("mcp", "program"):
        answer = program.post("/api/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    elif label == "device":
        answer = program.get("/api/app/1/me", headers=headers)
    else:
        answer = program.get("/api/v1/me", headers=headers)
    return answer.status_code == 200


def _rows(account: Account) -> set[str]:
    with SessionLocal() as db:
        return {row.name for row in db.query(ApiToken).filter(ApiToken.account_id == account.id)}


def test_own_keys_rest_while_the_account_is_out_and_come_back_devices_and_programs_do_not(
    client: TestClient, operator: Account
) -> None:
    kim = make_account("kim")
    keys = _keys(kim)
    confirm = {"current_password": PASSWORD}
    with new_client() as program:
        assert all(_works(program, label, token) for label, token in keys.items())
        own = ("api", "mcp", "card")

        assert client.post(f"/api/accounts/{kim.id}/block", json=confirm).status_code == 204
        assert not any(_works(program, label, token) for label, token in keys.items())
        assert _rows(kim) == set(own), "the own keys stay and rest; device and program are gone"
        assert client.post(f"/api/accounts/{kim.id}/unblock", json=confirm).status_code == 204
        assert all(_works(program, label, keys[label]) for label in own)
        assert not _works(program, "program", keys["program"]), "an AI tool is connected anew after unblocking"
        assert not _works(program, "device", keys["device"])

        program_again = _keys(kim)["program"]
        assert client.request("DELETE", f"/api/accounts/{kim.id}", json=confirm).status_code == 204
        assert not any(_works(program, label, keys[label]) for label in own)
        assert client.post(f"/api/accounts/{kim.id}/restore", json=confirm).status_code == 200
        assert all(_works(program, label, keys[label]) for label in own)
        assert not _works(program, "program", program_again)

        # Deleted for good after its 30 days: the keys go with it.
        assert client.request("DELETE", f"/api/accounts/{kim.id}", json=confirm).status_code == 204
        with SessionLocal() as db:
            row = db.get(Account, kim.id)
            assert row is not None and row.deleted_at is not None
            row.deleted_at = row.deleted_at - timedelta(days=31)
            db.commit()
            assert accounts.purge_deleted(db) == 1
        assert not any(_works(program, label, keys[label]) for label in own)
    with SessionLocal() as db:
        assert db.query(ApiToken).filter(ApiToken.account_id == kim.id).count() == 0
