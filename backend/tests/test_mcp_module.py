"""nexnotes on the shared module mcp (``vendor/nexmcp`` 1.1.0): what nexnotes keeps of before on its own ways, beside
the module's contract tests (``tests/nexmcp``).

- The consent of before (``approve``, the old page) and the module's (``allow``) both answer; ``GET`` still names
  ``client_name``.
- The token endpoint still reads a JSON body as nexnotes did, besides the form of RFC 6749.
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
