"""NOTES-2 Accounts and sign-in: every acceptance criterion and edge case whose check is an automatic test.

AC-1 and EC-1 rest on the shared sign-in blueprint: its contract tests 1 to 39 run unchanged in ``tests/nexoidc``;
here only that they are all there and that nexnotes keeps the blueprint's promise when the provider is down.
"""

from __future__ import annotations

import json
import threading
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.main import app
from app.models import MEMBER, OPERATOR, Account, ApiToken, Invite, utcnow
from app.security import SESSION_COOKIE
from app.services import accounts, apitokens, content

from . import oidc_helpers
from .conftest import PASSWORD, TAB, make_account, new_client, sign_in
from .oidc_helpers import FakeProvider, configure, error_in, fresh_browser, location, sign_in_via_oidc

provider = oidc_helpers.provider

GOOD = "twelve chars"  # exactly 12
SHORT = "eleven char"  # exactly 11
CONTRACT = Path(__file__).resolve().parent / "nexoidc"


def _code(answer: object) -> str:
    return str(answer.json()["detail"]["code"])  # type: ignore[attr-defined]


def _invite(client: TestClient, **body: object) -> str:
    made = client.post("/api/invites", json=body)
    assert made.status_code == 201, made.text
    return str(made.json()["link"]).rsplit("/", 1)[1]


def _reset(client: TestClient, account_id: int, **body: object) -> str:
    made = client.post(f"/api/accounts/{account_id}/reset-link", json=_confirm(**body))
    assert made.status_code == 201, made.text
    return str(made.json()["link"]).rsplit("/", 1)[1]


def _row(name: str) -> Account:
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == name))
        assert row is not None
        db.expunge(row)
        return row


def _confirm(**extra: object) -> dict[str, object]:
    return {"current_password": PASSWORD, **extra}


# --- AC-1, EC-1: the blueprint ---------------------------------------------------------------------------------------


def test_notes2_ac1_the_contract_tests_of_the_blueprint_are_all_there_and_unchanged() -> None:
    manifest = json.loads((Path(__file__).resolve().parents[1] / "app" / "vendor" / "nexoidc" /
                           "MANIFEST.json").read_text(encoding="utf-8"))
    assert manifest["version"] >= "1.0.14"
    for name in ("test_nexoidc_flow.py", "test_nexoidc_entra.py", "test_nexoidc_accounts.py",
                 "test_nexoidc_authentik.py", "test_nexoidc_address.py", "test_nexoidc_paths.py",
                 "test_nexoidc_duties.py", "test_nexoidc_vendored.py", "test_nexoidc_wayback.py"):
        assert (CONTRACT / name).is_file(), name
    text = "\n".join(path.read_text(encoding="utf-8") for path in CONTRACT.glob("test_*.py"))
    assert text.count("\ndef test_") + text.count("\nasync def test_") >= 39


def test_notes2_ec1_a_provider_that_cannot_be_reached_says_so_and_the_operator_still_has_the_password(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    configure(client, provider)
    assert client.put("/api/settings", json={"password_login": False}).status_code == 200
    browser = fresh_browser()
    target = oidc_helpers.start(browser)
    provider.reachable = False  # type: ignore[attr-defined]
    answer = oidc_helpers.come_back(browser, provider, target)
    assert location(answer).startswith("/login?") and error_in(answer) == "oidc_provider_unreachable"
    assert browser.get("/api/auth/me").status_code == 401
    # The operator's way in stays open; a member's password does not.
    make_account("anna")
    member = fresh_browser().post("/api/auth/login", json={"name": "anna@example.com", "password": PASSWORD})
    assert member.status_code == 403 and _code(member) == "password_login_off"
    boss = fresh_browser().post("/api/auth/login", json={"name": "tester@example.com", "password": PASSWORD})
    assert boss.status_code == 200


# --- AC-2, AC-3, EC-5, EC-6, EC-7: invitations, passwords, names, addresses ---------------------------------------


def test_notes2_ac2_an_invitation_makes_an_account_with_a_password(client: TestClient, operator: Account) -> None:
    token = _invite(client, email="lena@example.com")
    guest = fresh_browser()
    offer = guest.get(f"/api/invite/{token}").json()
    assert offer["by"] == "Tester" and offer["email"] == "lena@example.com" and offer["min_password"] == 12
    made = guest.post(f"/api/invite/{token}", json={"display_name": "Lena", "password": GOOD})
    assert made.status_code == 200, made.text
    assert made.json()["role"] == MEMBER and made.json()["email"] == "lena@example.com"
    assert guest.get("/api/auth/me").json()["display_name"] == "Lena"


def test_notes2_ac2_an_invitation_makes_an_account_through_a_provider(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    configure(client, provider, auto_create=False)
    token = _invite(client)
    browser = fresh_browser()
    back = sign_in_via_oidc(browser, provider, sub="p-9", preferred_username="mia", email="mia@example.com",
                            invite=token)
    assert location(back) == "/"
    assert browser.get("/api/auth/me").json()["name"] == "mia"
    assert _row("mia").sign_in == "oidc"


def test_notes2_ac3_a_password_has_at_least_twelve_characters(client: TestClient, operator: Account) -> None:
    assert len(GOOD) == 12 and len(SHORT) == 11
    token = _invite(client)
    short = fresh_browser().post(f"/api/invite/{token}", json={"display_name": "Lena", "password": SHORT})
    assert short.status_code == 422 and _code(short) == "password_too_short"
    assert short.json()["detail"]["minimum"] == 12
    assert fresh_browser().post(f"/api/invite/{token}", json={"display_name": "Lena", "password": GOOD}).status_code == 200
    changed = client.put("/api/auth/password", json={"current": PASSWORD, "new": SHORT})
    assert changed.status_code == 422 and _code(changed) == "password_too_short"
    anna = make_account("anna")
    given = fresh_browser().post(f"/api/reset/{_reset(client, anna.id)}", json={"password": SHORT})
    assert given.status_code == 422 and _code(given) == "password_too_short"
    with SessionLocal() as db:
        db.query(Account).delete()
        db.commit()
    from .conftest import SETUP_CODE

    setup = fresh_browser().post("/api/setup", json={"display_name": "Boss", "password": SHORT, "code": SETUP_CODE})
    assert setup.status_code == 422 and _code(setup) == "password_too_short"


def test_notes2_ac10_password_confirmation_a_second_password_that_differs_is_refused_everywhere(
        client: TestClient, operator: Account) -> None:
    """Every way to a new password takes ``password_confirm``; when it differs, 422
    ``password_mismatch`` and nothing changes. Without the field the password is taken as before (scripts, an app
    with one field): only a person typing twice can mistype."""
    other = GOOD + "!"

    def refused(answer: object) -> bool:
        return answer.status_code == 422 and _code(answer) == "password_mismatch"  # type: ignore[attr-defined]

    # The invitation: no account comes of it, and the link still holds.
    token = _invite(client)
    assert refused(fresh_browser().post(f"/api/invite/{token}",
                                        json={"display_name": "Lena", "password": GOOD, "password_confirm": other}))
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Account).where(Account.display_name == "Lena")) == 0
    lena = fresh_browser()
    made = lena.post(f"/api/invite/{token}", json={"display_name": "Lena", "password": GOOD, "password_confirm": GOOD})
    assert made.status_code == 200, made.text
    # The reset link: the old password stays, and the link is not used up.
    anna = make_account("anna")
    link = _reset(client, anna.id)
    assert refused(fresh_browser().post(f"/api/reset/{link}", json={"password": GOOD, "password_confirm": other}))
    assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
    assert fresh_browser().post(f"/api/reset/{link}", json={"password": GOOD, "password_confirm": GOOD}).status_code == 204
    assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": GOOD}).status_code == 200
    # "My account": the password stays the old one.
    assert refused(lena.put("/api/auth/password", json={"current": GOOD, "new": other, "password_confirm": GOOD}))
    assert fresh_browser().post("/api/auth/login", json={"name": "lena", "password": GOOD}).status_code == 200
    assert lena.put("/api/auth/password",
                    json={"current": GOOD, "new": other, "password_confirm": other}).status_code == 204
    assert lena.put("/api/auth/password", json={"current": other, "new": GOOD}).status_code == 204
    # The setup of the first account: nothing is made.
    with SessionLocal() as db:
        db.query(Account).delete()
        db.commit()
    from .conftest import SETUP_CODE

    first = {"display_name": "Boss", "password": GOOD, "code": SETUP_CODE}
    assert refused(fresh_browser().post("/api/setup", json={**first, "password_confirm": other}))
    assert fresh_browser().get("/api/setup").json()["needs_setup"] is True
    assert fresh_browser().post("/api/setup", json={**first, "password_confirm": GOOD}).status_code == 200


def test_notes2_ec5_an_expired_or_used_invitation_says_so_and_makes_nothing(
    client: TestClient, operator: Account
) -> None:
    used = _invite(client)
    assert fresh_browser().post(f"/api/invite/{used}", json={"display_name": "Lena", "password": GOOD}).status_code == 200
    expired = _invite(client)
    with SessionLocal() as db:
        for row in db.scalars(select(Invite)):
            row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    before = len(client.get("/api/accounts").json())
    for token, code in ((used, "invite_invalid"), (expired, "invite_expired")):
        stranger = fresh_browser()
        assert _code(stranger.get(f"/api/invite/{token}")) == code
        answer = stranger.post(f"/api/invite/{token}", json={"display_name": "Mia", "password": GOOD})
        assert answer.status_code == 404 and _code(answer) == code
    assert len(client.get("/api/accounts").json()) == before


def test_notes2_ec5_one_invitation_used_twice_at_once_makes_one_account(client: TestClient,
                                                                        operator: Account) -> None:
    token = _invite(client)
    results: list[int] = []

    def accept(number: int) -> None:
        with TestClient(app, base_url="http://testserver", headers={"X-Nexnotes-Client": f"tab-race{number:05d}"},
                        client=(f"198.51.100.{number}", 5000)) as tab:
            results.append(tab.post(f"/api/invite/{token}",
                                    json={"display_name": f"Person {number}", "password": GOOD}).status_code)

    racers = [threading.Thread(target=accept, args=(n,)) for n in range(1, 5)]
    for thread in racers:
        thread.start()
    for thread in racers:
        thread.join()
    assert sorted(results) == [200, 404, 404, 404]


@pytest.mark.parametrize(("typed", "kept"), [
    ("  Jürgen Öztürk  ", "Jürgen Öztürk"),
    ("Mia 🌻", "Mia 🌻"),
    ("\tFamilie 👨‍👩‍👧 ", "Familie 👨‍👩‍👧"),
])
def test_notes2_ec6_umlauts_and_emoji_stay_and_blanks_at_the_edges_go(
    client: TestClient, operator: Account, typed: str, kept: str
) -> None:
    saved = client.put("/api/me/profile", json={"display_name": typed})
    assert saved.status_code == 200 and saved.json()["display_name"] == kept
    token = _invite(client)
    made = fresh_browser().post(f"/api/invite/{token}", json={"display_name": typed, "password": GOOD}).json()
    assert made["display_name"] == kept
    assert client.put("/api/me/profile", json={"display_name": "   "}).status_code == 422


def test_notes2_ec7_an_address_another_account_has_is_refused_whatever_its_case(
    client: TestClient, operator: Account
) -> None:
    make_account("anna")
    invited = client.post("/api/invites", json={"email": "ANNA@Example.com"})
    assert invited.status_code == 409 and _code(invited) == "email_taken"
    own = client.put("/api/me/profile", json={"email": "Anna@EXAMPLE.com"})
    assert own.status_code == 409 and _code(own) == "email_taken"
    token = _invite(client)
    taken = fresh_browser().post(f"/api/invite/{token}",
                                 json={"display_name": "Anna 2", "email": "anna@example.COM", "password": GOOD})
    assert taken.status_code == 409 and _code(taken) == "email_taken"
    # Its own address in another case is no conflict.
    assert client.put("/api/me/profile", json={"email": "TESTER@example.com"}).status_code == 200


# --- AC-4, EC-4, EC-9: blocking ----------------------------------------------------------------------------------


def test_notes2_ac4_a_blocked_account_is_out_on_every_device_at_once_and_does_not_get_back_in(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    laptop, phone = new_client(anna), new_client(anna)
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        _device, token = apitokens.make(db, row, "iPad")
    ipad = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {token}"})
    assert ipad.get("/api/auth/me").status_code == 200
    assert client.post(f"/api/accounts/{anna.id}/block", json=_confirm()).status_code == 204
    for device in (laptop, phone, ipad):
        assert device.get("/api/auth/me").status_code == 401
    again = fresh_browser().post("/api/auth/login", json={"name": "anna@example.com", "password": PASSWORD})
    assert again.status_code == 403 and _code(again) == "account_blocked"
    listed = {row["name"]: row for row in client.get("/api/accounts").json()}
    assert listed["anna"]["blocked"] is True
    # Its notes stay: the account and what it owns are still there.
    with SessionLocal() as db:
        assert db.get(Account, anna.id) is not None
    assert client.post(f"/api/accounts/{anna.id}/unblock", json=_confirm()).status_code == 204
    assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_notes2_ec4_an_open_window_of_a_blocked_account_hears_that_it_is_blocked(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    window = new_client(anna)
    assert window.put("/api/me/language", json={"language": "de"}).status_code == 200
    assert client.post(f"/api/accounts/{anna.id}/block", json=_confirm()).status_code == 204
    refused = window.put("/api/me/language", json={"language": "en"})
    assert refused.status_code == 401 and _code(refused) == "account_blocked"
    assert _row("anna").language == "de", "nothing more is saved"


def test_notes2_ec9_the_device_of_a_blocked_or_deleted_account_gets_nothing_accepted(
    client: TestClient, operator: Account
) -> None:
    for way in ("block", "delete"):
        person = make_account(f"p{way}")
        with SessionLocal() as db:
            row = db.get(Account, person.id)
            assert row is not None
            _device, token = apitokens.make(db, row, "iPhone")
        device = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {token}"})
        assert device.put("/api/me/language", json={"language": "de"}).status_code == 200
        if way == "block":
            assert client.post(f"/api/accounts/{person.id}/block", json=_confirm()).status_code == 204
        else:
            assert client.request("DELETE", f"/api/accounts/{person.id}", json=_confirm()).status_code == 204
        refused = device.put("/api/me/language", json={"language": "en"})
        assert refused.status_code == 401
        assert _row(f"p{way}").language == "de"
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(ApiToken).where(ApiToken.account_id == person.id)) == 0
    # A token that is still there counts for nothing while its account is blocked, however the block came about.
    late = make_account("plate")
    with SessionLocal() as db:
        row = db.get(Account, late.id)
        assert row is not None
        _device, token = apitokens.make(db, row, "iPad")
        row.blocked_at = utcnow()
        db.commit()
    device = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {token}"})
    assert device.get("/api/auth/me").status_code == 401


# --- AC-5, EC-8: deleting, 30 days to bring it back -------------------------------------------------------------


def test_notes2_ac5_deleting_asks_with_the_numbers_blocks_at_once_and_is_undone_within_thirty_days(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    gone: list[int] = []
    content.register_counter(lambda _db, account_id: content.Counts(notes=12, shared=3) if account_id == anna.id
                             else content.Counts())
    content.on_deleted(lambda _db, account_id: gone.append(account_id))
    try:
        impact = client.get(f"/api/accounts/{anna.id}/impact").json()
        assert impact == {"notes": 12, "shared": 3, "days": 30}
        window = new_client(anna)
        assert client.request("DELETE", f"/api/accounts/{anna.id}", json=_confirm()).status_code == 204
        assert gone == [anna.id], "what it shared disappears for the others (the features listen)"
        assert window.get("/api/auth/me").status_code == 401
        row = {item["name"]: item for item in client.get("/api/accounts").json()}["anna"]
        assert row["deleted_at"] and row["purge_at"]
        # Day 29: it comes back.
        with SessionLocal() as db:
            db.get(Account, anna.id).deleted_at = utcnow() - timedelta(days=29)  # type: ignore[union-attr]
            db.commit()
            assert accounts.purge_deleted(db) == 0
        back = client.post(f"/api/accounts/{anna.id}/restore", json=_confirm())
        assert back.status_code == 200 and back.json()["deleted_at"] is None
        assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
        # Deleted again, day 31: gone for good, with everything it owned.
        purged: list[int] = []
        content.on_purged(lambda _db, account_id: purged.append(account_id))
        assert client.request("DELETE", f"/api/accounts/{anna.id}", json=_confirm()).status_code == 204
        with SessionLocal() as db:
            db.get(Account, anna.id).deleted_at = utcnow() - timedelta(days=31)  # type: ignore[union-attr]
            db.commit()
            assert accounts.purge_deleted(db) == 1
            assert db.get(Account, anna.id) is None
        assert purged == [anna.id]
        assert client.post(f"/api/accounts/{anna.id}/restore", json=_confirm()).status_code == 404
    finally:
        content._counters.clear()
        content._deleted.clear()
        content._purged.clear()


def test_notes2_ac5_after_thirty_days_the_operator_cannot_bring_it_back(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    assert client.request("DELETE", f"/api/accounts/{anna.id}", json=_confirm()).status_code == 204
    with SessionLocal() as db:
        db.get(Account, anna.id).deleted_at = utcnow() - timedelta(days=30, minutes=1)  # type: ignore[union-attr]
        db.commit()
    late = client.post(f"/api/accounts/{anna.id}/restore", json=_confirm())
    assert late.status_code == 404


def test_notes2_ec8_the_others_of_a_shared_note_learn_of_a_deleted_account(client: TestClient,
                                                                           operator: Account) -> None:
    """The notice itself belongs to simultaneous editing (NOTES-12 EC-2); the frame tells every listener at the
    moment the deletion takes hold, and ends the account's live sessions at once."""
    anna = make_account("anna")
    told: list[tuple[int, bool]] = []
    content.on_deleted(lambda db, account_id: told.append((account_id, db.get(Account, account_id).deleted_at
                                                           is not None)))
    try:
        live = new_client(anna)
        assert client.request("DELETE", f"/api/accounts/{anna.id}", json=_confirm()).status_code == 204
        assert told == [(anna.id, True)]
        assert live.get("/api/auth/me").status_code == 401
    finally:
        content._deleted.clear()


# --- AC-6, AC-7: own notes only, the operator sees no contents --------------------------------------------------


ALLOWED_KEYS = {
    "id", "name", "display_name", "email", "role", "sign_in", "language", "version", "whats_new_seen", "provider_email",
    "two_factor", "password_changed_at", "created_at", "last_seen_at", "locked", "blocked", "blocked_at", "deleted_at",
    "purge_at", "has_password", "providers", "storage_used", "storage_limit", "avatar",
}


def test_notes2_ac7_the_operator_sees_name_address_way_role_storage_and_last_use_never_content(
    client: TestClient, operator: Account
) -> None:
    make_account("anna")
    rows = client.get("/api/accounts").json()
    for row in rows:
        assert set(row) == ALLOWED_KEYS, set(row) ^ ALLOWED_KEYS
        assert {"name", "email", "sign_in", "role", "storage_used", "storage_limit", "last_seen_at"} <= set(row)
    impact = client.get(f"/api/accounts/{rows[1]['id']}/impact").json()
    assert set(impact) == {"notes", "shared", "days"}, "numbers only"


def test_notes2_ac6_ac7_no_route_of_the_frame_hands_out_another_accounts_data_to_a_member(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    with new_client(anna) as member:
        for method, path in (("GET", "/api/accounts"), ("GET", f"/api/accounts/{operator.id}/impact"),
                             ("GET", "/api/invites"), ("GET", "/api/settings"), ("GET", "/api/backups"),
                             ("GET", "/api/logs")):
            assert member.request(method, path).status_code == 403, path
        assert member.get("/api/auth/me").json()["name"] == "anna"


# --- AC-8, EC-2: roles, and the last operator ---------------------------------------------------------------


def test_notes2_ac8_a_new_role_counts_at_once(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    window = new_client(anna)
    assert window.get("/api/accounts").status_code == 403
    made = client.put(f"/api/accounts/{anna.id}/role", json=_confirm(role=OPERATOR))
    assert made.status_code == 200 and made.json()["role"] == OPERATOR
    assert window.get("/api/accounts").status_code == 200, "the open session has the new role at once"
    with new_client(anna) as anna_as_operator:
        back = anna_as_operator.put(f"/api/accounts/{operator.id}/role",
                                    json={"role": MEMBER, "current_password": PASSWORD})
        assert back.status_code == 200
    assert client.get("/api/accounts").status_code == 403


def test_notes2_ec2_the_last_operator_is_never_blocked_deleted_or_made_a_member(
    client: TestClient, operator: Account
) -> None:
    second = make_account("boss2", OPERATOR)
    with new_client(second) as other:
        # Two operators: one may take the other's role.
        assert other.put(f"/api/accounts/{operator.id}/role", json=_confirm(role=MEMBER)).status_code == 200
        # Now ``boss2`` is the last: nobody takes it, not even itself (and the member cannot anyway).
        for answer in (
            other.put(f"/api/accounts/{second.id}/role", json=_confirm(role=MEMBER)),
            other.post(f"/api/accounts/{second.id}/block", json=_confirm()),
            other.request("DELETE", f"/api/accounts/{second.id}", json=_confirm()),
        ):
            assert answer.status_code == 409, answer.text
    with SessionLocal() as db:
        lone = db.get(Account, second.id)
        assert lone is not None
        for act in (lambda: accounts.set_role(db, lone, MEMBER), lambda: accounts.block(db, lone),
                    lambda: accounts.delete_account(db, lone)):
            with pytest.raises(accounts.AccountError) as refused:
                act()
            assert refused.value.code == "last_operator"
        assert lone.role == OPERATOR and lone.blocked_at is None and lone.deleted_at is None


def test_notes2_ec2_a_blocked_operator_does_not_count_as_the_one_that_stays(client: TestClient,
                                                                             operator: Account) -> None:
    second = make_account("boss2", OPERATOR)
    assert client.post(f"/api/accounts/{second.id}/block", json=_confirm()).status_code == 204
    with SessionLocal() as db:
        me = db.get(Account, operator.id)
        assert me is not None
        with pytest.raises(accounts.AccountError):
            accounts.set_role(db, me, MEMBER)


# --- EC-3: the session runs out while writing -------------------------------------------------------------------


def test_notes2_ec3_a_session_that_ran_out_asks_to_sign_in_again_and_the_next_one_saves(
    client: TestClient, operator: Account
) -> None:
    from app.models import AuthSession

    anna = make_account("anna")
    window = new_client(anna)
    with SessionLocal() as db:
        for session in db.scalars(select(AuthSession).where(AuthSession.account_id == anna.id)):
            session.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    ran_out = window.put("/api/me/language", json={"language": "de"})
    assert ran_out.status_code == 401 and _code(ran_out) == "sign_in_required"
    # Signed in again in the same window (the page keeps the text meanwhile): the change goes through.
    sign_in(window, anna)
    assert window.put("/api/me/language", json={"language": "de"}).status_code == 200
    assert _row("anna").language == "de"
    assert window.cookies.get(SESSION_COOKIE)


def test_notes2_ac2_the_operator_may_invite_another_operator(client: TestClient, operator: Account) -> None:
    token = _invite(client, role=OPERATOR)
    made = fresh_browser().post(f"/api/invite/{token}", json={"display_name": "Kim", "password": GOOD})
    assert made.status_code == 200 and made.json()["role"] == OPERATOR


# --- AC-7: the operator never knows another account's password ------------------------------------------------------


def test_notes2_ac7_the_operator_gives_no_password_only_a_link_the_person_sets_one_with(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    # The old way is gone: no route sets another account's password.
    assert client.put(f"/api/accounts/{anna.id}/password", json=_confirm(password=GOOD)).status_code in (404, 405)
    with new_client(anna) as browser, SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        _device, device_token = apitokens.make(db, row, "iPhone")
        _mcp, mcp_token = apitokens.make(db, row, "Desk", kind="mcp")
        made = client.post(f"/api/accounts/{anna.id}/reset-link", json=_confirm())
        assert made.status_code == 201 and "/reset/" in made.json()["link"]
        assert "link" not in client.get("/api/accounts").json()[1]
        token = made.json()["link"].rsplit("/", 1)[1]
        # Making the link changes nothing: the old password and the sessions still hold.
        assert browser.get("/api/auth/me").status_code == 200
        assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
        stranger = fresh_browser()
        assert stranger.get(f"/api/reset/{token}").json()["name"] == "Anna"
        assert stranger.post(f"/api/reset/{token}", json={"password": GOOD}).status_code == 204
        # Every session and every paired device of the account ended; keys made by hand stay.
        assert browser.get("/api/auth/me").status_code == 401
        device = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {device_token}"})
        assert device.get("/api/auth/me").status_code == 401
        # An MCP key counts at /api/mcp only (NOTES-20).
        mcp = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {mcp_token}"})
        assert mcp.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 200
    # Used once, then gone.
    again = fresh_browser().post(f"/api/reset/{token}", json={"password": "another twelve"})
    assert again.status_code == 404 and _code(again) == "reset_invalid"
    assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 401
    # At the next sign-in the account hears that its password was set through the operator's link, until it puts
    # the notice away.
    person = fresh_browser()
    assert person.post("/api/auth/login", json={"name": "anna", "password": GOOD}).status_code == 200
    assert person.get("/api/auth/me").json()["password_reset_notice"] is True
    assert person.post("/api/me/password-reset-notice/seen").json()["password_reset_notice"] is False
    assert person.get("/api/auth/me").json()["password_reset_notice"] is False


def test_notes2_ac7_a_reset_link_runs_out_like_an_invitation_and_a_new_one_replaces_the_old(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    for days in (0, 2, 365):
        refused = client.post(f"/api/accounts/{anna.id}/reset-link", json=_confirm(days=days))
        assert refused.status_code == 422 and _code(refused) == "invalid_days"
    first = _reset(client, anna.id, days=1)
    second = _reset(client, anna.id, days=30)
    assert _code(fresh_browser().get(f"/api/reset/{first}")) == "reset_invalid"
    from app.models import PasswordReset

    with SessionLocal() as db:
        row = db.scalar(select(PasswordReset).where(PasswordReset.account_id == anna.id))
        assert row is not None
        assert timedelta(days=29) < row.expires_at - utcnow() <= timedelta(days=30)
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    late = fresh_browser().post(f"/api/reset/{second}", json={"password": GOOD})
    assert late.status_code == 404 and _code(late) == "reset_expired"
    assert fresh_browser().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_notes2_ac7_a_provider_account_stays_one_until_the_person_sets_a_password(
    client: TestClient, operator: Account
) -> None:
    with SessionLocal() as db:
        mia = Account(name="mia", display_name="Mia", email="mia@example.com", role=MEMBER, sign_in="oidc",
                      password_hash="")
        db.add(mia)
        db.commit()
        mia_id = mia.id
    token = _reset(client, mia_id)
    listed = {row["name"]: row for row in client.get("/api/accounts").json()}
    assert listed["mia"]["sign_in"] == "oidc" and listed["mia"]["has_password"] is False
    assert _row("mia").sign_in == "oidc" and _row("mia").password_hash == ""
    assert fresh_browser().post(f"/api/reset/{token}", json={"password": GOOD}).status_code == 204
    assert _row("mia").sign_in == "password" and _row("mia").password_reset_notice is True


def test_notes2_ac7_making_a_reset_link_asks_for_the_operators_password_and_is_for_operators_only(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    wrong = client.post(f"/api/accounts/{anna.id}/reset-link", json={"current_password": "wrong"})
    assert wrong.status_code == 401 and _code(wrong) == "wrong_password"
    with new_client(anna) as member:
        assert member.post(f"/api/accounts/{operator.id}/reset-link", json={"current_password": PASSWORD}).status_code == 403


def test_notes2_ac7_an_operator_from_a_provider_confirms_operator_acts_with_a_fresh_sign_in_there(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    from urllib.parse import parse_qs, urlsplit

    from app.models import AuthSession

    configure(client, provider)
    boss = fresh_browser()
    assert location(sign_in_via_oidc(boss, provider, sub="p-boss", preferred_username="boss")) == "/"
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == "boss"))
        assert row is not None and row.sign_in == "oidc"
        row.role = OPERATOR
        db.commit()
        boss_id = row.id
    anna = make_account("anna")
    # Just signed in at the provider: the act goes through without a password.
    assert boss.post(f"/api/accounts/{anna.id}/block", json={}).status_code == 204
    # Eleven minutes later a stolen session is not enough any more.
    with SessionLocal() as db:
        for session in db.scalars(select(AuthSession).where(AuthSession.account_id == boss_id)):
            session.created_at = utcnow() - timedelta(minutes=11)
        db.commit()
    assert boss.get("/api/auth/me").status_code == 200
    for refused in (
        boss.post(f"/api/accounts/{anna.id}/unblock", json={}),
        boss.post(f"/api/accounts/{anna.id}/reset-link", json={}),
        boss.put(f"/api/accounts/{anna.id}/role", json={"role": "operator"}),
        boss.request("DELETE", f"/api/accounts/{anna.id}", json={}),
    ):
        assert refused.status_code == 403 and _code(refused) == "fresh_sign_in_required"
        assert refused.json()["detail"]["minutes"] == 10
        assert refused.json()["detail"]["providers"] == [{"slug": "sso", "label": "Test SSO"}]
    assert _row("anna").blocked_at is not None
    # The way back asks the provider for a new sign-in, not its running session; afterwards the act goes through.
    target = oidc_helpers.start(boss, fresh="1", next="/settings/accounts")
    asked = parse_qs(urlsplit(target).query)
    assert asked["prompt"] == ["login"] and asked["max_age"] == ["0"]
    assert "prompt" not in parse_qs(urlsplit(oidc_helpers.start(fresh_browser())).query)
    assert location(oidc_helpers.come_back(boss, provider, target)) == "/settings/accounts"
    assert boss.post(f"/api/accounts/{anna.id}/unblock", json={}).status_code == 204
    # A token of the operator is never enough, fresh or not: a paired device reaches no operator act at all (NOTES-24).
    with SessionLocal() as db:
        row = db.get(Account, boss_id)
        assert row is not None
        _device, token = apitokens.make(db, row, "iPhone")
    device = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {token}", **TAB})
    refused = device.post(f"/api/accounts/{anna.id}/block", json={})
    assert refused.status_code == 403 and _code(refused) == "browser_only"
