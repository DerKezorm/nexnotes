"""nexnotes on the shared module mcp (``vendor/nexmcp`` 1.1.1): what nexnotes keeps of before on its own ways, beside
the module's contract tests (``tests/nexmcp``).

- The consent of before (``approve``, the old page) and the module's (``allow``) both answer; ``GET`` still names
  ``client_name``.
- The token endpoint still reads a JSON body as nexnotes did, besides the form of RFC 6749 (the module's since 1.1.1).
- While MCP is switched off, registering and the consent answer as before (E55): 403 ``access_denied`` and 403
  ``mcp_off``, not the module's 404; the operator's newer switch "programs" keeps the module's 404.
- MCP keys are made by hand again, limited to folders like an API token; a connector may be limited to folders on the
  consent page, and its tools see nothing else.
- The older way ``POST /api/tokens`` still sets "also for AI tools" (decision 12), and such a token opens MCP.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from .test_notes3 import new_note
from .test_notes20 import _pkce, _program, ok, refused, rpc

REDIRECT = "http://127.0.0.1:33418/callback"


def _register(program: TestClient) -> str:
    made = program.post("/api/oauth/register", json={"client_name": "Chat program", "redirect_uris": [REDIRECT]})
    assert made.status_code == 201, made.text
    return str(made.json()["client_id"])


def _code(client: TestClient, client_id: str, **answer: object) -> tuple[str, str]:
    verifier, challenge = _pkce()
    asked = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
             "code_challenge_method": "S256"}
    shown = client.get("/api/oauth/authorize", params=asked)
    assert shown.status_code == 200, shown.text
    assert shown.json()["client_name"] == "Chat program" and shown.json()["client"]["name"] == "Chat program"
    agreed = client.post("/api/oauth/authorize", json={**asked, "state": "s", **answer})
    assert agreed.status_code == 200, agreed.text
    query = parse_qs(urlsplit(agreed.json()["redirect"]).query)
    return query.get("code", [""])[0], verifier


def test_the_consent_takes_approve_of_before_and_allow_of_the_module(client, operator):
    program = _program()
    client_id = _register(program)
    for answer in ({"approve": True}, {"allow": True}):
        code, _verifier = _code(client, client_id, **answer)
        assert code.startswith("nnc_"), answer
    for answer in ({"approve": False}, {"allow": False}, {}):
        code, _verifier = _code(client, client_id, **answer)
        assert code == "", answer


def test_the_token_endpoint_still_reads_json_as_before(client, operator):
    program = _program()
    client_id = _register(program)
    code, verifier = _code(client, client_id, allow=True, level="write")
    traded = program.post("/api/oauth/token", json={"grant_type": "authorization_code", "code": code,
                                                     "client_id": client_id, "redirect_uri": REDIRECT,
                                                     "code_verifier": verifier})
    assert traded.status_code == 200, traded.text
    assert traded.headers["cache-control"] == "no-store"
    tokens = traded.json()
    assert tokens["access_token"].startswith("nn_mcp_") and tokens["refresh_token"].startswith("nnr_")
    again = program.post("/api/oauth/token", json={"grant_type": "refresh_token", "client_id": client_id,
                                                    "refresh_token": tokens["refresh_token"]})
    assert again.status_code == 200, again.text
    assert rpc(client, again.json()["access_token"], "ping").status_code == 200
    # The form of RFC 6749 goes on too.
    form = program.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                   "refresh_token": again.json()["refresh_token"]})
    assert form.status_code == 200, form.text


def test_mcp_switched_off_keeps_the_answers_of_before_on_registering_and_the_consent(client, operator):
    program = _program()
    client_id = _register(program)
    _verifier, challenge = _pkce()
    asked = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
             "code_challenge_method": "S256"}
    assert client.put("/api/settings", json={"mcp_enabled": False}).status_code == 200
    registered = program.post("/api/oauth/register", json={"redirect_uris": [REDIRECT]})
    assert registered.status_code == 403, registered.text
    assert registered.json() == {"error": "access_denied", "error_description": "MCP is switched off here."}
    assert registered.headers["cache-control"] == "no-store"
    shown = client.get("/api/oauth/authorize", params=asked)
    agreed = client.post("/api/oauth/authorize", json={**asked, "approve": True})
    for answer in (shown, agreed):
        assert answer.status_code == 403 and answer.json()["detail"]["code"] == "mcp_off", answer.text
    # MCP on, programs switched off by the operator (a switch of the module): the module's answers.
    assert client.put("/api/settings", json={"mcp_enabled": True}).status_code == 200
    assert client.put("/api/connections/mcp/admin", json={"programs": False}).status_code == 200
    assert program.post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 404
    shown = client.get("/api/oauth/authorize", params=asked)
    assert shown.status_code == 404 and shown.json()["detail"]["code"] == "programs_off", shown.text
    assert client.put("/api/connections/mcp/admin", json={"programs": True}).status_code == 200
    assert program.post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 201


def _folder(client: TestClient, name: str) -> str:
    made = client.post("/api/folders", json={"name": name})
    assert made.status_code == 201, made.text
    return str(made.json()["id"])


def test_an_mcp_key_made_by_hand_and_a_connector_reach_only_their_folders(client, operator):
    work, home = _folder(client, "Work"), _folder(client, "Home")
    at_work = new_note(client, title="Plan", markdown="milestones", folder_id=work)
    at_home = new_note(client, title="Groceries", markdown="milk", folder_id=home)
    made = client.post("/api/connections/keys", json={"kind": "mcp", "name": "Desk", "right": "read",
                                                      "areas": [work]})
    assert made.status_code == 201, made.text
    secret = made.json()["secret"]
    assert secret.startswith("nn_mcp_")
    assert ok(client, secret, "read_note", note_id=at_work["id"])["title"] == "Plan"
    assert refused(client, secret, "read_note", note_id=at_home["id"]) == "Not found."
    # A connector limited to "Home" on the consent page.
    program = _program()
    client_id = _register(program)
    code, verifier = _code(client, client_id, allow=True, level="read", areas=[home])
    tokens = program.post("/api/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                     "client_id": client_id, "redirect_uri": REDIRECT,
                                                     "code_verifier": verifier}).json()
    assert ok(client, tokens["access_token"], "read_note", note_id=at_home["id"])["title"] == "Groceries"
    assert refused(client, tokens["access_token"], "read_note", note_id=at_work["id"]) == "Not found."


def test_the_older_way_still_makes_a_token_also_for_ai_tools(client, operator):
    made = client.post("/api/tokens", json={"name": "Script", "level": "read", "mcp": True})
    assert made.status_code == 201, made.text
    assert made.json()["made"]["access"] == ["api", "mcp"]
    assert rpc(client, made.json()["token"], "ping").status_code == 200
    plain = client.post("/api/tokens", json={"name": "Plain", "level": "read"})
    assert rpc(client, plain.json()["token"], "ping").status_code == 401


def test_a_request_that_waits_is_told_to_the_accounts_browsers(client, operator, monkeypatch):
    """Module mcp, decision 14: nexnotes has no bell; "A program is waiting for your yes" goes as Web Push to the
    account's browsers, leading to the request's page, and only while the request still waits."""
    import json

    from app.db import SessionLocal
    from app.models import AuthSession
    from app.models_notify import NotifyOutbox, WebPushSubscription
    from app.services import notify, webpush

    with SessionLocal() as db:
        session = db.query(AuthSession).filter_by(account_id=operator.id).first()
        db.add(WebPushSubscription(account_id=operator.id, session_id=session.id, endpoint="https://push.example.com/a",
                                   p256dh="x", auth="y"))
        db.commit()
    made = client.post("/api/connections/keys", json={"kind": "mcp", "name": "Desk", "right": "write"})
    secret, key_id = made.json()["secret"], made.json()["key"]["id"]
    assert client.put(f"/api/connections/mcp/keys/{key_id}/rights",
                      json={"rights": {"create_note": "ask"}}).status_code == 200
    asked = ok(client, secret, "create_note", title="Plan")
    assert asked.get("status") == "waiting" or "request" in json.dumps(asked)
    sent: list[dict] = []
    monkeypatch.setattr(webpush, "deliver", lambda db, row, body, topic="": sent.append(json.loads(body)))
    assert notify.send_round() == 1
    (told,) = sent
    assert told["title"] == "A program is waiting for your yes" and told["url"].startswith("/mcp/requests/")
    assert told["body"].startswith("Desk: ")
    # Decided meanwhile: a message still waiting is dropped.
    request_id = int(told["url"].rsplit("/", 1)[1])
    assert client.post(f"/api/connections/mcp/requests/{request_id}/decline").status_code == 200
    with SessionLocal() as db:
        db.add(NotifyOutbox(account_id=operator.id, channel="web", target_id=db.query(WebPushSubscription).first().id,
                            payload={"kind": notify.MCP_REQUEST, "request_id": request_id, "title": "t", "text": "x",
                                     "url": "/"}))
        db.commit()
    assert notify.send_round() == 0 and len(sent) == 1
