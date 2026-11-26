"""The settings pass (plan "Einstellungen", konten 1.1.0, post 1.1.0) through nexnotes' own routes: light or dark at the
account, the box "Address not confirmed yet", Server › Sign-in with the module's rules (on the new way and on the old
``PUT /api/settings``), "Ready for the internet?", and Server › Mail beside the older ways, which stay as they were."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account
from app.services import totp

from .conftest import PASSWORD, make_account, new_client


def _set(account: Account, **values: object) -> None:
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        for name, value in values.items():
            setattr(row, name, value)
        db.commit()


def test_the_theme_is_kept_at_the_account_and_the_browsers_value_is_taken_once(
    client: TestClient, operator: Account
) -> None:
    assert client.get("/api/auth/me").json()["theme"] == ""
    assert client.post("/api/me/theme/adopt", json={"theme": "light"}).json() == {"theme": "light"}
    assert client.get("/api/auth/me").json()["theme"] == "light"
    # Taken once: another browser's value does not change the account's choice.
    assert client.post("/api/me/theme/adopt", json={"theme": "dark"}).json() == {"theme": "light"}
    assert client.put("/api/me/theme", json={"theme": "system"}).json()["theme"] == "system"
    refused = client.put("/api/me/theme", json={"theme": "sepia"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "theme_invalid"
    # Another device of the account sees the same.
    with new_client(operator) as other:
        assert other.get("/api/auth/me").json()["theme"] == "system"


def test_a_new_address_shows_the_box_and_its_link_goes_out(client: TestClient, operator: Account) -> None:
    from app.vendor.nexpost import testing

    client.put("/api/settings", json={"smtp_host": "mail.example.com", "smtp_from": "notes@example.com",
                                      "public_url": "https://notes.example.com"})
    _set(operator, email="tester@example.com", email_confirmed=True, email_proven=False)
    me = client.get("/api/auth/me").json()
    assert me["mail_server"] is True and me["email_proven"] is False
    with testing.catch_mail() as caught:
        answer = client.post("/api/me/email/prove")
    assert answer.status_code == 200, answer.text
    assert [letter.to for letter in caught.queued] == ["tester@example.com"]
    # Until the link is used the address stays as it is.
    assert client.get("/api/auth/me").json()["email"] == "tester@example.com"


def test_the_box_sends_nothing_without_a_mail_server(client: TestClient, operator: Account) -> None:
    assert client.get("/api/auth/me").json()["mail_server"] is False
    refused = client.post("/api/me/email/prove")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "mail_off"


def test_the_second_factor_for_everybody_goes_off_only_with_the_password_on_both_ways(
    client: TestClient, operator: Account
) -> None:
    # Without an own factor it does not go on (the operator would be the first one sent away).
    refused = client.put("/api/server/sign-in", json={"factor_required": True})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "own_second_factor_first"
    old = client.put("/api/settings", json={"two_factor_required": True})
    assert old.status_code == 409 and old.json()["detail"]["code"] == "own_second_factor_first"
    _set(operator, totp_secret_enc=totp.seal_seed(totp.generate_seed()))
    view = client.get("/api/server/sign-in").json()
    assert view["factor_may_go_on"] is True and view["factor_required"] is False
    assert client.put("/api/server/sign-in", json={"factor_required": True}).json()["factor_required"] is True
    # Off: the old way and the new one both ask for the password once more.
    for path, field in (("/api/settings", "two_factor_required"), ("/api/server/sign-in", "factor_required")):
        wrong = client.put(path, json={field: False, "current_password": "not the password"})
        assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "wrong_password", path
        assert client.get("/api/settings").json()["two_factor_required"] is True
    assert client.put("/api/settings", json={"two_factor_required": False, "current_password": PASSWORD}).status_code == 200
    assert client.get("/api/server/sign-in").json()["factor_required"] is False


def test_password_sign_in_goes_off_only_with_an_active_provider(client: TestClient, operator: Account) -> None:
    refused = client.put("/api/server/sign-in", json={"password_login": False})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "provider_first"
    assert client.get("/api/server/sign-in").json()["password_may_go_off"] is False
    assert client.put("/api/server/sign-in", json={"passkeys_allowed": False}).json()["passkeys_allowed"] is False
    assert client.get("/api/settings").json()["passkeys_allowed"] is False


def test_only_the_operator_reaches_the_sign_in_page(client: TestClient, operator: Account) -> None:
    member = make_account("mira")
    with new_client(member) as other:
        assert other.get("/api/server/sign-in").status_code == 403
        assert other.get("/api/server/sign-in/readiness").status_code == 403
        assert other.get("/api/server/mail").status_code == 403


def test_ready_for_the_internet_names_an_unknown_proxy_where_general_had_its_hint(
    client: TestClient, operator: Account
) -> None:
    found = client.get("/api/server/sign-in/readiness", headers={"X-Forwarded-For": "198.51.100.7"}).json()
    points = {point["key"]: point for point in found["points"]}
    assert points["address"]["state"] == "bad", "no public address with https yet"
    assert points["proxy"]["state"] == "warn" and points["brake"]["state"] == "warn"
    assert found["open"] == sum(1 for point in found["points"] if point["state"] != "ok")
    assert "proxy_unknown" in client.get("/api/settings").json(), "the old answer keeps its field"


def test_the_mail_page_and_the_old_settings_show_the_same_server(client: TestClient, operator: Account) -> None:
    saved = client.put("/api/server/mail", json={"host": "mail.example.com", "port": 465, "security": "tls",
                                                 "user": "notes", "password": "mail password",
                                                 "sender": "notes@example.com", "sender_name": ""})
    assert saved.status_code == 200, saved.text
    view = client.get("/api/server/mail").json()
    assert view["password_set"] is True and "password" not in view and view["sender_name_default"] == "nexnotes"
    old = client.get("/api/settings").json()
    assert (old["smtp_host"], old["smtp_port"], old["smtp_security"], old["smtp_user"], old["smtp_from"]) == (
        "mail.example.com", 465, "tls", "notes", "notes@example.com")
    assert old["smtp_password_set"] is True
    # The old way still saves, and the new page reads it.
    client.put("/api/settings", json={"smtp_host": "smtp.example.com"})
    assert client.get("/api/server/mail").json()["host"] == "smtp.example.com"


def test_keys_of_the_old_ways_and_the_new_ones_are_the_same_keys(client: TestClient, operator: Account) -> None:
    """schluessel 1.0.0: ``/api/tokens`` and ``/api/admin/tokens`` stay in their shapes beside ``/api/connections``."""
    from app.models import TOKEN_DEVICE
    from app.services import apitokens

    old = client.post("/api/tokens", json={"name": "Home Assistant", "level": "read", "days": 30})
    assert old.status_code == 201 and old.json()["token"].startswith("nn_api_")
    new = client.post("/api/connections/keys", json={"kind": "api", "name": "n8n", "right": "write",
                                                     "options": {"mcp": True}})
    assert new.status_code == 201, new.text
    secret = new.json()["secret"]
    assert secret.startswith("nn_api_")
    listed = {entry["name"]: entry for entry in client.get("/api/connections/keys").json()["keys"]}
    assert set(listed) == {"Home Assistant", "n8n"}
    assert listed["n8n"]["options"] == {"mcp": True} and listed["Home Assistant"]["right"] == "read"
    assert {entry["name"] for entry in client.get("/api/tokens").json()["tokens"]} == {"Home Assistant", "n8n"}
    # A paired iPhone in the same table is never a key of the module, and a device never manages keys.
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        _device, device_token = apitokens.make(db, row, "iPhone", kind=TOKEN_DEVICE)
    assert "iPhone" not in {entry["name"] for entry in client.get("/api/connections/keys").json()["keys"]}
    with new_client() as device:
        refused = device.get("/api/connections/keys", headers={"Authorization": f"Bearer {device_token}"})
        assert refused.status_code == 403
    # The new key works on the old routes of programs; blocked on the old way it stops, unblocked on the new it works.
    with new_client() as program:
        assert program.get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code == 200
        key_id = listed["n8n"]["id"]
        assert client.post(f"/api/admin/tokens/{key_id}/block").status_code == 204
        assert program.get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code == 401
        assert client.post(f"/api/connections/admin/keys/{key_id}/unblock").json()["blocked"] is False
        assert program.get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code == 200
        # Revoked on the old way, it is gone on both.
        assert client.delete(f"/api/tokens/{key_id}").status_code == 204
        assert program.get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code == 401
    assert {entry["name"] for entry in client.get("/api/connections/keys").json()["keys"]} == {"Home Assistant"}


def test_the_interfaces_card_switches_what_general_switched(client: TestClient, operator: Account) -> None:
    assert client.get("/api/connections/interfaces").json() == {"api": True, "mcp": True}
    assert client.put("/api/connections/interfaces", json={"mcp": False}).json() == {"api": True, "mcp": False}
    assert client.get("/api/settings").json()["mcp_enabled"] is False
    client.put("/api/settings", json={"api_enabled": False})
    assert client.get("/api/connections/interfaces").json()["api"] is False


def test_the_operator_sees_how_many_folders_a_key_reaches_never_which_nor_its_start(
    client: TestClient, operator: Account
) -> None:
    """E36: nexnotes' own column in "API keys of all accounts" (``admin_extra``); the start of a key stays hidden."""
    home = client.post("/api/folders", json={"name": "Home"}).json()["id"]
    work = client.post("/api/folders", json={"name": "Work"}).json()["id"]
    some = client.post("/api/connections/keys", json={"kind": "api", "name": "Two folders", "areas": [home, work]})
    every = client.post("/api/connections/keys", json={"kind": "api", "name": "All notes"})
    assert some.status_code == every.status_code == 201
    rows = {row["name"]: row for row in client.get("/api/connections/admin/keys").json()["keys"]}
    assert rows["Two folders"]["extra"] == {"folders": 2} and rows["All notes"]["extra"] == {"folders": 0}
    assert all("prefix" not in row for row in rows.values())
    assert "Home" not in str(rows) and "Work" not in str(rows)


def test_new_accounts_start_with_the_storage_for_new_accounts_the_ones_there_keep_theirs(
    client: TestClient, operator: Account
) -> None:
    """Bauplan E44: "Speicher für neue Konten" under General › Limits; empty means no limit."""
    from app.services import accounts as account_service
    from app.services.konten_store import KontenStore

    before = make_account("before")
    assert client.get("/api/settings").json()["new_account_storage_limit"] is None
    five = 5 * 1024**3
    assert client.put("/api/settings", json={"new_account_storage_limit": five}).json()["new_account_storage_limit"] == five
    # An invitation accepted (the account module), an account made by nexnotes' own way: both start with it.
    invite = client.post("/api/invites", json={}).json()["link"].split("/invite/")[1]
    with new_client() as guest:
        made = guest.post(f"/api/invite/{invite}", json={"display_name": "Nina", "name": "nina",
                                                        "password": "a long enough password"})
        assert made.status_code in (200, 201), made.text
    with SessionLocal() as db:
        nina = db.query(Account).filter(Account.name == "nina").one()
        assert nina.storage_limit == five
        assert db.get(Account, before.id).storage_limit is None, "an account that is there keeps its limit"
        made_here = account_service.create_with_password(db, display_name="Otto", email="", password="a long enough password")
        assert made_here.storage_limit == five
        assert KontenStore(db).get_account(nina.id).storage_limit == five
    # Emptied: new accounts start without a limit again.
    assert client.put("/api/settings", json={"new_account_storage_limit": None}).json()["new_account_storage_limit"] is None
    assert client.put("/api/settings", json={"new_account_storage_limit": 0}).status_code == 422


def test_the_box_passkeys_offers_adding_only_where_a_passkey_can_be_added(client: TestClient, operator: Account) -> None:
    """konten 1.1.0 (E49): ``passkeys_can_add`` in the answer for Security, with the inputs adding uses: no public
    address and a page on http elsewhere: no; the page on localhost: yes; a public https address: yes."""
    from app.db import SessionLocal
    from app.services import settings_service

    assert client.get("/api/auth/me").json()["passkeys_can_add"] is False
    assert client.post("/api/auth/passkeys/begin", json={"password": PASSWORD}).status_code >= 400
    assert client.get("/api/auth/me", headers={"origin": "http://localhost:5173"}).json()["passkeys_can_add"] is True
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "https://notes.example.com"})
    assert client.get("/api/auth/me").json()["passkeys_can_add"] is True
    assert client.post("/api/auth/passkeys/begin", json={"password": PASSWORD}).status_code == 200
