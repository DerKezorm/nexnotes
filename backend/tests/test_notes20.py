"""NOTES-20 MCP-Zugang: keys of a member for AI tools, the tools over JSON-RPC (``POST /api/mcp``) with real keys,
the walls in front of them, and signing in as a connector with OAuth."""

from __future__ import annotations

import base64
import hashlib
import secrets
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, Folder, Note
from app.models_history import NoteEdit
from app.notedoc import doc as notedoc
from app.notedoc import schema as s
from app.routers import oauth
from app.services import apitokens, history, mcp, search, settings_service

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored, stored_doc, token_for

ENDPOINT = "/api/mcp"


@pytest.fixture(autouse=True)
def fresh_brakes(client) -> Iterator[None]:
    mcp.forget()
    oauth.forget()
    yield
    Live.close_all()
    mcp.forget()


@pytest.fixture
def anna() -> Account:
    return make_account("anna")


@pytest.fixture
def as_anna(anna: Account) -> Iterator[TestClient]:
    with new_client(anna) as browser:
        yield browser
        Live.close_all()


def key_for(account: Account, level: str = "write", name: str = "Desk") -> str:
    with SessionLocal() as db:
        _row, token = apitokens.make(db, db.get(Account, account.id), name, kind="mcp", level=level)
    return token


def rpc(client: TestClient, token: str | None, method: str, params: dict | None = None, *, message_id: Any = 1,
        headers: dict | None = None):
    sent = {"Authorization": f"Bearer {token}"} if token else {}
    sent.update(headers or {})
    body: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if message_id is not None:
        body["id"] = message_id
    if params is not None:
        body["params"] = params
    return client.post(ENDPOINT, json=body, headers=sent)


def call(client: TestClient, token: str, tool: str, **args: Any) -> dict:
    """A tool's result (``content``, ``isError``, ``structuredContent``)."""
    answer = rpc(client, token, "tools/call", {"name": tool, "arguments": args})
    assert answer.status_code == 200, answer.text
    return answer.json()["result"]


def ok(client: TestClient, token: str, tool: str, **args: Any) -> dict:
    result = call(client, token, tool, **args)
    assert result["isError"] is False, result["content"][0]["text"]
    return result["structuredContent"]


def refused(client: TestClient, token: str, tool: str, **args: Any) -> str:
    result = call(client, token, tool, **args)
    assert result["isError"] is True, result
    return result["content"][0]["text"]


def tool_names(client: TestClient, token: str) -> set[str]:
    answer = rpc(client, token, "tools/list")
    assert answer.status_code == 200, answer.text
    return {tool["name"] for tool in answer.json()["result"]["tools"]}


READ_TOOLS = {"search_notes", "read_note", "list_notes", "list_folders", "list_tags", "list_smart_folders"}
WRITE_TOOLS = {"create_note", "append_to_note", "check_item", "move_note", "create_folder", "trash_note"}


def markdown_of(note_id: str) -> str:
    from app.notedoc.markdown import to_markdown

    return to_markdown(stored_doc(note_id))


# --- AC-1, AC-5, AC-9: keys --------------------------------------------------------------------------------------


def test_notes20_ac1_a_member_makes_a_key_with_a_name_and_a_right_and_sees_it_once(client, operator):
    made = client.post("/api/mcp/keys", json={"name": "Einkaufsliste per Chat", "level": "read"})
    assert made.status_code == 201, made.text
    token = made.json()["token"]
    assert token.startswith("nn_mcp_") and len(token) > 40
    assert made.json()["key"]["name"] == "Einkaufsliste per Chat" and made.json()["key"]["level"] == "read"
    # Never again: the list has no key, the database only its SHA-256.
    listing = client.get("/api/mcp/keys").json()
    assert token not in str(listing) and "token" not in listing["keys"][0]
    with SessionLocal() as db:
        row = db.scalar(select(ApiToken).where(ApiToken.kind == "mcp"))
        assert row is not None and row.token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert token not in str([getattr(row, column.name) for column in ApiToken.__table__.columns])
    # The address to give the tool comes with the list.
    assert listing["address"].endswith("/api/mcp")
    # The key works, with the right chosen; "read and write" is the other choice, nothing else.
    assert rpc(client, token, "ping").json()["result"] == {}
    assert client.post("/api/mcp/keys", json={"name": "x", "level": "admin"}).status_code == 422
    assert client.post("/api/mcp/keys", json={"name": "   ", "level": "write"}).status_code == 422
    write = client.post("/api/mcp/keys", json={"name": "Laptop", "level": "write"})
    assert write.status_code == 201 and write.json()["key"]["level"] == "write"


def test_notes20_ac1_an_account_holds_at_most_twenty_keys(client, operator):
    for number in range(mcp.MAX_KEYS):
        assert client.post("/api/mcp/keys", json={"name": f"k{number}", "level": "read"}).status_code == 201
    too_many = client.post("/api/mcp/keys", json={"name": "one more", "level": "read"})
    assert too_many.status_code == 409 and too_many.json()["detail"]["code"] == "mcp_too_many_keys"


def test_notes20_ac5_a_revoked_key_stops_at_once(client, operator, anna, as_anna):
    made = client.post("/api/mcp/keys", json={"name": "Desk", "level": "write"}).json()
    token = made["token"]
    assert rpc(client, token, "ping").status_code == 200
    # Nobody else revokes it.
    assert as_anna.delete(f"/api/mcp/keys/{made['key']['id']}").status_code == 404
    assert rpc(client, token, "ping").status_code == 200
    assert client.delete(f"/api/mcp/keys/{made['key']['id']}").status_code == 204
    gone = rpc(client, token, "tools/list")
    assert gone.status_code == 401 and gone.json()["detail"]["code"] == "key_invalid"
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac9_the_list_names_each_key_its_right_and_its_last_use(client, operator, anna):
    read = client.post("/api/mcp/keys", json={"name": "Skript Wochenplan", "level": "read"}).json()
    client.post("/api/mcp/keys", json={"name": "Assistent", "level": "write"})
    key_for(anna, name="Not mine")
    listing = client.get("/api/mcp/keys").json()["keys"]
    assert [(key["name"], key["level"], key["last_used_at"]) for key in listing] == [
        ("Skript Wochenplan", "read", None), ("Assistent", "write", None)]
    assert rpc(client, read["token"], "ping").status_code == 200
    used = {key["name"]: key["last_used_at"] for key in client.get("/api/mcp/keys").json()["keys"]}
    assert used["Skript Wochenplan"] is not None and used["Assistent"] is None


# --- AC-2: the member's notes, never more ---------------------------------------------------------------------------


def test_notes20_ac2_a_key_sees_what_its_member_sees_and_never_more(client, operator, anna, as_anna):
    from .test_notes13 import share

    token = key_for(operator)
    mine = new_note(client, markdown="Kompost umsetzen")
    secret = new_note(as_anna, markdown="Anna geheim Kompost")
    readable = new_note(as_anna, markdown="Anna liest Kompost vor")
    writable = new_note(as_anna, markdown="Anna Einkauf Kompost")
    share(as_anna, "note", readable["id"], operator, "read")
    share(as_anna, "note", writable["id"], operator, "write")

    found = {note["id"] for note in ok(client, token, "search_notes", query="Kompost")["notes"]}
    assert found == {mine["id"], readable["id"], writable["id"]}
    listed = {note["id"] for note in ok(client, token, "list_notes")["notes"]}
    assert secret["id"] not in listed and {mine["id"], readable["id"], writable["id"]} <= listed
    # A note of somebody else that is not shared is not there, whatever the tool.
    for tool, args in (("read_note", {}), ("append_to_note", {"text": "x"}), ("trash_note", {}),
                       ("check_item", {"index": 0, "text": "x"}), ("move_note", {"folder_id": "inbox"})):
        assert refused(client, token, tool, note_id=secret["id"], **args) == "Not found."
    assert stored(secret["id"]).deleted_at is None
    # Shared to read: read, never written.
    assert "Anna liest" in ok(client, token, "read_note", note_id=readable["id"])["markdown"]
    assert refused(client, token, "append_to_note", note_id=readable["id"], text="mehr") == \
        "This note is shared with you to read only."
    assert refused(client, token, "trash_note", note_id=readable["id"]) == "This note is shared with you to read only."
    assert "mehr" not in markdown_of(readable["id"])
    # Shared to write: written, as the member could.
    ok(client, token, "append_to_note", note_id=writable["id"], text="- [ ] Milch")
    assert "Milch" in markdown_of(writable["id"])
    # Only its owner moves a note, as in the interface.
    assert refused(client, token, "move_note", note_id=writable["id"], folder_id="inbox") == "Only its owner moves a note."


def test_notes20_ac2_an_mcp_key_opens_mcp_only_and_mcp_takes_no_other_token(client, operator):
    token = key_for(operator, level="read")
    mine = new_note(client, markdown="nur lesen")
    program = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {token}"})
    # The other routes would let a key that may only read write through them.
    assert program.get("/api/auth/me").status_code == 401
    assert program.get(f"/api/notes/{mine['id']}").status_code == 401
    assert program.delete(f"/api/notes/{mine['id']}").status_code == 401
    assert stored(mine["id"]).deleted_at is None
    # A paired device's token is no MCP key, and the session cookie counts for nothing here.
    with SessionLocal() as db:
        _row, device = apitokens.make(db, db.get(Account, operator.id), "iPhone")
    assert rpc(client, device, "ping").status_code == 401
    assert rpc(client, None, "ping").status_code == 401


# --- AC-3: reading --------------------------------------------------------------------------------------------------


def test_notes20_ac3_a_read_key_searches_reads_and_lists_folders_notes_and_tags(client, operator):
    from .test_notes13 import make_folder

    token = key_for(operator, level="read")
    assert tool_names(client, token) == READ_TOOLS
    kitchen = make_folder(client, "Küche")
    note = new_note(client, folder_id=kitchen, title="Einkauf",
                    markdown="Für #rezept\n\n- [ ] Nudeln\n- [x] Parmesan\n\n**fett** und [Link](https://example.com)")
    found = ok(client, token, "search_notes", query="Nudeln")
    assert found["total"] == 1 and found["notes"][0]["id"] == note["id"]
    assert "«Nudeln»" in found["notes"][0]["snippet"]
    assert ok(client, token, "search_notes", query="Nudeln", folder_id=kitchen)["total"] == 1
    assert ok(client, token, "search_notes", query="Nudeln", folder_id="inbox")["total"] == 0
    assert ok(client, token, "search_notes", query="", tag="rezept")["total"] == 1
    read = ok(client, token, "read_note", note_id=note["id"])
    assert read["title"] == "Einkauf" and read["locked"] is False and read["can_write"] is True
    assert "**fett**" in read["markdown"] and "[Link](https://example.com)" in read["markdown"]
    assert read["tags"] == ["rezept"] and read["folder"]["name"] == "Küche"
    assert read["checklist"] == [{"index": 0, "text": "Nudeln", "checked": False, "depth": 0},
                                 {"index": 1, "text": "Parmesan", "checked": True, "depth": 0}]
    folders = ok(client, token, "list_folders")
    assert [(entry["name"], entry["notes"]) for entry in folders["folders"]] == [("Küche", 1)]
    assert folders["inbox"]["id"] and folders["shared_with_me"] == []
    listed = ok(client, token, "list_notes", folder_id=kitchen)
    assert [entry["id"] for entry in listed["notes"]] == [note["id"]] and listed["more"] is False
    assert ok(client, token, "list_notes", folder_id="inbox")["notes"] == []
    assert ok(client, token, "list_tags")["tags"] == [{"name": "rezept", "notes": 1}]
    # Nothing to write with: the write tools do not exist for this key.
    assert refused(client, token, "create_note", text="x") == "No tool called 'create_note'."
    assert refused(client, token, "append_to_note", note_id=note["id"], text="x") == "No tool called 'append_to_note'."
    assert "x" not in markdown_of(note["id"]).split()


def test_notes20_ac3_lists_have_a_limit_and_say_there_is_more(client, operator):
    token = key_for(operator, level="read")
    for number in range(5):
        new_note(client, markdown=f"Zettel {number}")
    page = ok(client, token, "list_notes", limit=2)
    assert len(page["notes"]) == 2 and page["total"] == 5 and page["more"] is True
    rest = ok(client, token, "list_notes", limit=2, offset=4)
    assert len(rest["notes"]) == 1 and rest["more"] is False
    assert refused(client, token, "list_notes", limit=1000) == "'limit' is out of range."


# --- AC-4, AC-6: writing --------------------------------------------------------------------------------------------


def test_notes20_ac4_a_new_note_goes_into_the_inbox_with_a_suggested_title_to_check(client, operator):
    token = key_for(operator, name="Claw")
    made = ok(client, token, "create_note", text="Einkaufsliste für Samstag\n\n- [ ] Nudeln\n- [ ] Basilikum")
    assert made["folder"]["inbox"] is True and made["title"] == "Einkaufsliste für Samstag"
    assert made["title_check"] is True
    inbox = client.get("/api/folders/inbox").json()["notes"]
    assert [(entry["id"], entry["origin"], entry["title_check"]) for entry in inbox] == [
        (made["id"], "mcp:Claw", True)]
    # A title the tool gives is still nobody's typing: "Titel prüfen" too.
    titled = ok(client, token, "create_note", title="Wochenplan", text="Montag")
    assert titled["title"] == "Wochenplan" and stored(titled["id"]).title_check is True
    assert ok(client, token, "create_note", title="Nur Titel")["title_check"] is True


def test_notes20_ac4_a_write_key_appends_ticks_moves_makes_folders_and_trashes(client, operator):
    token = key_for(operator)
    assert tool_names(client, token) == READ_TOOLS | WRITE_TOOLS
    folder = ok(client, token, "create_folder", name="Haushalt")
    sub = ok(client, token, "create_folder", name="Garten", parent_id=folder["id"])
    assert sub["parent_id"] == folder["id"]
    note = ok(client, token, "create_note", text="- [ ] Milch\n- [ ] Brot", folder_id=folder["id"])
    assert note["folder"]["id"] == folder["id"]
    ok(client, token, "append_to_note", note_id=note["id"], text="- [ ] Eier\n\nNicht vergessen")
    assert "Eier" in markdown_of(note["id"]) and "Nicht vergessen" in markdown_of(note["id"])
    ok(client, token, "check_item", note_id=note["id"], index=1, text="Brot")
    items = ok(client, token, "read_note", note_id=note["id"])["checklist"]
    assert [(item["text"], item["checked"]) for item in items] == [("Milch", False), ("Brot", True), ("Eier", False)]
    ok(client, token, "check_item", note_id=note["id"], index=1, checked=False, text="Brot")
    assert ok(client, token, "read_note", note_id=note["id"])["checklist"][1]["checked"] is False
    # The item changed meanwhile: nothing is ticked.
    assert "different one" in refused(client, token, "check_item", note_id=note["id"], index=0, text="Brot")
    assert "No checklist item 9" in refused(client, token, "check_item", note_id=note["id"], index=9, text="Brot")
    # Without its text an item is not ticked: by its place alone it may be another one by now.
    assert refused(client, token, "check_item", note_id=note["id"], index=0)
    assert ok(client, token, "read_note", note_id=note["id"])["checklist"][0]["checked"] is False
    moved = ok(client, token, "move_note", note_id=note["id"], folder_id=sub["id"])
    assert moved["folder"]["id"] == sub["id"] and stored(note["id"]).folder_id == sub["id"]
    assert ok(client, token, "move_note", note_id=note["id"], folder_id="inbox")["folder"]["inbox"] is True
    assert refused(client, token, "move_note", note_id=note["id"], folder_id=secrets.token_hex(8)) == "Folder not found."
    assert ok(client, token, "trash_note", note_id=note["id"]) == {"id": note["id"], "in_trash": True}
    assert stored(note["id"]).deleted_at is not None


def test_notes20_ac4_a_long_checklist_item_is_ticked_with_the_text_read_note_showed(client, operator):
    token = key_for(operator)
    long_item = " ".join(f"Wort{number:03d}" for number in range(86))
    assert len(long_item) > 600
    note = ok(client, token, "create_note", text=f"Liste\n\n- [ ] {long_item}\n- [ ] Mil")
    shown = ok(client, token, "read_note", note_id=note["id"])["checklist"]
    assert len(shown[0]["text"]) == 500 and long_item.startswith(shown[0]["text"])
    ok(client, token, "check_item", note_id=note["id"], index=0, text=shown[0]["text"])
    assert ok(client, token, "read_note", note_id=note["id"])["checklist"][0]["checked"] is True
    # Only the shortened text exactly as shown counts; any other beginning is another item.
    assert "different one" in refused(client, token, "check_item", note_id=note["id"], index=0,
                                      text=shown[0]["text"][:499], checked=False)
    assert "different one" in refused(client, token, "check_item", note_id=note["id"], index=1, text="Mi")
    assert ok(client, token, "read_note", note_id=note["id"])["checklist"][0]["checked"] is True


def test_notes20_ac6_ec6_a_tool_writing_while_somebody_types_loses_nothing_and_the_history_names_the_key(
        client, operator):
    from app.notedoc import edit

    token = key_for(operator, name="Laptop-KI")
    note = new_note(client, markdown="Anfang")
    browser = Live(client, note["id"], token_for(operator))
    assert browser.pump(lambda: browser.synced)
    edit.append_paragraph(browser.doc, "getippt im Browser")
    ok(client, token, "append_to_note", note_id=note["id"], text="vom Werkzeug")
    assert browser.pump(lambda: "vom Werkzeug" in browser.text and "getippt im Browser" in browser.text)
    edit.append_paragraph(browser.doc, "noch mehr getippt")
    assert browser.pump(lambda: False, timeout=0.3) is False
    browser.close()
    text = markdown_of(note["id"])
    assert all(part in text for part in ("Anfang", "getippt im Browser", "vom Werkzeug", "noch mehr getippt"))
    # The history: the person and, apart, the key.
    with SessionLocal() as db:
        writers = {(row.account_id, row.via) for row in db.scalars(select(NoteEdit).where(NoteEdit.note_id ==
                                                                                           note["id"]))}
    assert (operator.id, "mcp:Laptop-KI") in writers and (operator.id, "") in writers
    history.take_now(note["id"], force=True)
    versions = client.get(f"/api/notes/{note['id']}/history").json()["versions"]
    assert {"id": operator.id, "name": "Tester", "via": "mcp:Laptop-KI"} in versions[0]["authors"]


# --- AC-7: a connector signs in with OAuth --------------------------------------------------------------------------


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _program() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def _connect(client: TestClient, level: str, client_id: str | None = None) -> tuple[dict, str]:
    """Registers a program (unless it did already), agrees as the signed-in member, trades the code: the tokens and
    the client id."""
    program = _program()
    redirect = "http://127.0.0.1:33418/callback"
    if client_id is None:
        unknown = program.post(ENDPOINT, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        assert unknown.status_code == 401
        assert "/.well-known/oauth-protected-resource" in unknown.headers["www-authenticate"]
        resource = program.get("/.well-known/oauth-protected-resource").json()
        assert resource["resource"].endswith("/api/mcp")
        server = program.get("/.well-known/oauth-authorization-server").json()
        assert server["code_challenge_methods_supported"] == ["S256"]
        registered = program.post("/api/oauth/register",
                                  json={"client_name": "Chat program", "redirect_uris": [redirect]})
        assert registered.status_code == 201, registered.text
        client_id = registered.json()["client_id"]
    code, verifier = _agree(client, client_id, redirect, level)
    traded = _trade(program, client_id, code, verifier, redirect)
    assert traded.status_code == 200, traded.text
    return traded.json(), client_id


def _agree(client: TestClient, client_id: str, redirect: str, level: str) -> tuple[str, str]:
    """The member agrees on the consent page: the code the program gets back, and the verifier that belongs to it."""
    verifier, challenge = _pkce()
    asked = {"client_id": client_id, "redirect_uri": redirect, "code_challenge": challenge,
             "code_challenge_method": "S256"}
    info = client.get("/api/oauth/authorize", params=asked)
    assert info.status_code == 200, info.text
    agreed = client.post("/api/oauth/authorize", json={**asked, "state": "abc", "approve": True, "level": level})
    assert agreed.status_code == 200, agreed.text
    back = urlsplit(agreed.json()["redirect"])
    query = parse_qs(back.query)
    assert back.netloc == urlsplit(redirect).netloc and query["state"] == ["abc"]
    return query["code"][0], verifier


def _trade(program: TestClient, client_id: str, code: str, verifier: str, redirect: str) -> Any:
    return program.post("/api/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                   "client_id": client_id, "redirect_uri": redirect,
                                                   "code_verifier": verifier})


def _refresh(program: TestClient, client_id: str, refresh_token: str) -> Any:
    return program.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                   "refresh_token": refresh_token})


def test_notes20_ac7_a_connector_signs_in_with_oauth_choosing_read_or_read_and_write(client, operator):
    tokens, client_id = _connect(client, "read")
    assert tool_names(client, tokens["access_token"]) == READ_TOOLS
    listed = client.get("/api/mcp/keys").json()["keys"]
    assert [(key["name"], key["level"], key["kind"]) for key in listed] == [("Chat program", "read", "connector")]
    # Signing in again with read and write gives the same connector more.
    tokens, _ = _connect(client, "write", client_id)
    assert len(client.get("/api/mcp/keys").json()["keys"]) == 1
    assert tool_names(client, tokens["access_token"]) == READ_TOOLS | WRITE_TOOLS
    made = ok(client, tokens["access_token"], "create_note", text="Einkaufsliste\n\n- [ ] Nudeln")
    assert stored(made["id"]).origin == "mcp:Chat program"
    # The refresh token changes every time; the old one brought again ends the connector.
    program = _program()
    fresh = program.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                    "refresh_token": tokens["refresh_token"]})
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["refresh_token"] != tokens["refresh_token"]
    assert rpc(client, tokens["access_token"], "ping").status_code == 401
    assert rpc(client, fresh.json()["access_token"], "ping").status_code == 200
    stolen = program.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                     "refresh_token": tokens["refresh_token"]})
    assert stolen.status_code == 400
    assert rpc(client, fresh.json()["access_token"], "ping").status_code == 401
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac7_any_spent_refresh_token_brought_again_ends_the_connector(client, operator):
    tokens, client_id = _connect(client, "write")
    program = _program()
    first = tokens["refresh_token"]
    second = _refresh(program, client_id, first).json()
    third = _refresh(program, client_id, second["refresh_token"]).json()
    assert rpc(client, third["access_token"], "ping").status_code == 200
    # Two changes ago, not only the one before: a copy all the same.
    stolen = _refresh(program, client_id, first)
    assert stolen.status_code == 400 and stolen.json()["error"] == "invalid_grant"
    assert rpc(client, third["access_token"], "ping").status_code == 401
    assert _refresh(program, client_id, third["refresh_token"]).status_code == 400
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac7_only_the_last_spent_tokens_are_kept_and_go_with_their_connector(client, operator):
    from app.models_mcp import OAuthSpent

    tokens, client_id = _connect(client, "read")
    program = _program()
    refresh = tokens["refresh_token"]
    for _ in range(oauth.SPENT_KEPT + 5):
        refresh = _refresh(program, client_id, refresh).json()["refresh_token"]
    with SessionLocal() as db:
        assert len(db.scalars(select(OAuthSpent)).all()) == oauth.SPENT_KEPT
    key_id = client.get("/api/mcp/keys").json()["keys"][0]["id"]
    assert client.delete(f"/api/mcp/keys/{key_id}").status_code in (200, 204)
    with SessionLocal() as db:
        assert db.scalars(select(OAuthSpent)).all() == []


def test_notes20_ac7_a_refresh_token_spent_before_the_update_still_ends_the_connector(client, operator):
    """Keys refreshed by an earlier version know only the refresh token before their last one."""
    tokens, client_id = _connect(client, "read")
    old = "nnr_" + secrets.token_urlsafe(32)
    with SessionLocal() as db:
        key = db.scalar(select(ApiToken).where(ApiToken.client_id == client_id))
        key.refresh_old_hash = apitokens.digest(old)
        db.commit()
    assert _refresh(_program(), client_id, old).status_code == 400
    assert rpc(client, tokens["access_token"], "ping").status_code == 401
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac7_a_code_traded_twice_ends_the_tokens_it_gave(client, operator):
    program = _program()
    redirect = "http://127.0.0.1:33418/callback"
    client_id = program.post("/api/oauth/register", json={"client_name": "Chat program",
                                                          "redirect_uris": [redirect]}).json()["client_id"]
    code, verifier = _agree(client, client_id, redirect, "write")
    traded = _trade(program, client_id, code, verifier, redirect)
    assert traded.status_code == 200, traded.text
    access = traded.json()["access_token"]
    assert rpc(client, access, "ping").status_code == 200
    again = _trade(program, client_id, code, verifier, redirect)
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"
    assert rpc(client, access, "ping").status_code == 401
    assert _refresh(program, client_id, traded.json()["refresh_token"]).status_code == 400
    assert client.get("/api/mcp/keys").json()["keys"] == []
    # Brought under another program's name, a spent code ends nothing: that is not its connector.
    code, verifier = _agree(client, client_id, redirect, "read")
    tokens = _trade(program, client_id, code, verifier, redirect).json()
    other_id = program.post("/api/oauth/register", json={"redirect_uris": [redirect]}).json()["client_id"]
    assert _trade(program, other_id, code, verifier, redirect).status_code == 400
    assert rpc(client, tokens["access_token"], "ping").status_code == 200


def test_notes20_ac7_a_code_is_traded_only_with_the_return_address_it_was_given_for(client, operator):
    program = _program()
    given, other = "https://app.example/cb", "https://app.example/other"
    client_id = program.post("/api/oauth/register", json={"redirect_uris": [given, other]}).json()["client_id"]
    code, verifier = _agree(client, client_id, given, "write")
    wrong = _trade(program, client_id, code, verifier, other)
    assert wrong.status_code == 400 and wrong.json()["error"] == "invalid_grant"
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac7_a_blocked_account_trades_no_code(client, operator):
    from app.models import utcnow

    program = _program()
    redirect = "https://app.example/cb"
    client_id = program.post("/api/oauth/register", json={"redirect_uris": [redirect]}).json()["client_id"]
    code, verifier = _agree(client, client_id, redirect, "write")
    with SessionLocal() as db:
        db.get(Account, operator.id).blocked_at = utcnow()
        db.commit()
    refused = _trade(program, client_id, code, verifier, redirect)
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_grant"
    with SessionLocal() as db:
        db.get(Account, operator.id).blocked_at = None
        db.commit()
    assert client.get("/api/mcp/keys").json()["keys"] == []


def test_notes20_ac7_a_declined_sign_in_gives_no_code_and_strange_return_addresses_are_refused(client, operator):
    program = _program()
    bad = program.post("/api/oauth/register", json={"redirect_uris": ["http://evil.example/cb"]})
    assert bad.status_code == 400
    redirect = "https://app.example/cb"
    client_id = program.post("/api/oauth/register", json={"redirect_uris": [redirect]}).json()["client_id"]
    _verifier, challenge = _pkce()
    asked = {"client_id": client_id, "redirect_uri": "https://other.example/cb", "code_challenge": challenge,
             "code_challenge_method": "S256"}
    assert client.get("/api/oauth/authorize", params=asked).status_code == 400
    asked["redirect_uri"] = redirect
    assert client.get("/api/oauth/authorize", params={**asked, "code_challenge_method": "plain"}).status_code == 400
    declined = client.post("/api/oauth/authorize", json={**asked, "approve": False})
    assert "error=access_denied" in declined.json()["redirect"] and "code=" not in declined.json()["redirect"]
    # A code is traded only with the verifier that belongs to its challenge (PKCE).
    agreed = client.post("/api/oauth/authorize", json={**asked, "approve": True, "level": "write"})
    code = parse_qs(urlsplit(agreed.json()["redirect"]).query)["code"][0]
    stolen = program.post("/api/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                     "client_id": client_id, "redirect_uri": redirect,
                                                     "code_verifier": _pkce()[0]})
    assert stolen.status_code == 400 and stolen.json()["error"] == "invalid_grant"
    assert client.get("/api/mcp/keys").json()["keys"] == []
    # The consent needs the member's own session; a key is not enough.
    assert TestClient(app, base_url="http://testserver").get("/api/oauth/authorize", params=asked).status_code == 401


# --- AC-8: the operator's switch ------------------------------------------------------------------------------------


def test_notes20_ac8_switched_off_every_tool_is_turned_away_and_no_key_is_made(client, operator):
    token = key_for(operator)
    assert rpc(client, token, "ping").status_code == 200
    assert client.put("/api/settings", json={"mcp_enabled": False}).status_code == 200
    off = rpc(client, token, "tools/call", {"name": "create_note", "arguments": {"text": "x"}})
    assert off.status_code == 403 and off.json()["detail"]["code"] == "mcp_off"
    made = client.post("/api/mcp/keys", json={"name": "Desk", "level": "read"})
    assert made.status_code == 403 and made.json()["detail"]["code"] == "mcp_off"
    assert client.get("/api/mcp/keys").json()["allowed"] is False
    assert client.get("/.well-known/oauth-authorization-server").status_code == 404
    assert client.post("/api/oauth/register", json={"redirect_uris": ["https://a.example/cb"]}).status_code == 403
    with SessionLocal() as db:
        assert db.scalar(select(Note.id)) is None
    assert client.put("/api/settings", json={"mcp_enabled": True}).status_code == 200
    assert rpc(client, token, "ping").status_code == 200


# --- Edge cases -----------------------------------------------------------------------------------------------------


def test_notes20_ec1_deleting_puts_a_note_into_the_trash_never_away_for_good(client, operator):
    token = key_for(operator)
    note = new_note(client, markdown="Kompost")
    ok(client, token, "trash_note", note_id=note["id"])
    assert stored(note["id"]).deleted_at is not None
    trash = client.get("/api/trash").json()
    assert note["id"] in str(trash)
    assert client.post(f"/api/trash/notes/{note['id']}/restore").status_code == 200
    assert stored(note["id"]).deleted_at is None
    # No tool removes anything for good.
    assert not {name for name in tool_names(client, token) if "purge" in name or "empty" in name}
    assert refused(client, token, "trash_note", note_id=note["id"], forever=True) == "There is no argument 'forever'."


def test_notes20_ec2_many_requests_in_a_short_time_are_slowed(client, operator, monkeypatch):
    token = key_for(operator)
    other = key_for(operator, name="Other")
    monkeypatch.setattr(mcp, "PER_MINUTE", 5)
    for _ in range(5):
        assert rpc(client, token, "ping").status_code == 200
    slowed = rpc(client, token, "ping")
    assert slowed.status_code == 429 and slowed.headers["retry-after"] == "60"
    # Per key: the other key of the account goes on.
    assert rpc(client, other, "ping").status_code == 200
    # Wrong keys count per sender, like wrong passwords.
    for _ in range(20):
        assert rpc(client, "nn_mcp_" + secrets.token_urlsafe(32), "ping").status_code == 401
    assert rpc(client, "nn_mcp_" + secrets.token_urlsafe(32), "ping").status_code == 429


def test_notes20_ec3_a_locked_note_gives_its_title_and_locked_and_nothing_else(client, operator):
    token = key_for(operator)
    note = new_note(client, title="Tresor", markdown="PIN 4711\n\n- [ ] geheim")
    with SessionLocal() as db:
        db.get(Note, note["id"]).locked = True
        db.commit()
    # As the vault does when it locks a note: the index forgets the text.
    search.reindex(note["id"])
    read = ok(client, token, "read_note", note_id=note["id"])
    assert read["title"] == "Tresor" and read["locked"] is True
    assert "4711" not in str(read) and "markdown" not in read and "checklist" not in read
    found = ok(client, token, "search_notes", query="Tresor")
    assert [hit["id"] for hit in found["notes"]] == [note["id"]] and "4711" not in str(found)
    assert ok(client, token, "search_notes", query="4711")["total"] == 0
    listed = ok(client, token, "list_notes")["notes"]
    assert listed[0]["locked"] is True and "4711" not in str(listed)
    for tool, args in (("append_to_note", {"text": "mehr"}), ("check_item", {"index": 0, "text": "x"}),
                       ("trash_note", {}),
                       ("move_note", {"folder_id": "inbox"})):
        assert "locked" in refused(client, token, tool, note_id=note["id"], **args)
    assert stored(note["id"]).deleted_at is None


def test_notes20_ec4_a_request_with_an_origin_header_is_turned_away(client, operator):
    token = key_for(operator)
    refused_answer = rpc(client, token, "tools/call", {"name": "create_note", "arguments": {"text": "x"}},
                         headers={"Origin": "https://evil.example"})
    assert refused_answer.status_code == 403 and refused_answer.json()["detail"]["code"] == "origin_refused"
    assert rpc(client, token, "ping", headers={"Origin": "http://testserver"}).status_code == 403
    with SessionLocal() as db:
        assert db.scalar(select(Note.id)) is None


def test_notes20_ec5_a_blocked_or_deleted_account_s_key_is_turned_away(client, operator, anna):
    from app.models import utcnow

    token = key_for(anna)
    assert rpc(client, token, "ping").status_code == 200
    with SessionLocal() as db:
        db.get(Account, anna.id).blocked_at = utcnow()
        db.commit()
    assert rpc(client, token, "ping").status_code == 401
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        row.blocked_at = None
        row.deleted_at = utcnow()
        db.commit()
    assert rpc(client, token, "ping").status_code == 401


def test_notes20_ec5_blocking_through_the_interface_ends_the_keys(client, operator, anna):
    from .test_notes2 import _confirm

    token = key_for(anna)
    blocked = client.post(f"/api/accounts/{anna.id}/block", json=_confirm())
    assert blocked.status_code in (200, 204), blocked.text
    assert rpc(client, token, "ping").status_code == 401


def test_notes20_ec7_html_and_script_become_text_and_dangerous_links_go(client, operator):
    token = key_for(operator)
    note = ok(client, token, "create_note", title="Probe",
              text="<script>alert(1)</script>\n\n[klick](javascript:alert(2)) und [gut](https://example.com)\n\n"
                   "<img src=x onerror=alert(3)> **fett**")
    ok(client, token, "append_to_note", note_id=note["id"], text="[auch](javascript:alert(4)) <b>b</b>")
    document = notedoc.to_json(stored_doc(note["id"]))
    hrefs = []

    def walk(node: Any) -> None:
        for mark in node.get("marks", []) if isinstance(node, dict) else []:
            if mark.get("attrs", {}).get("href"):
                hrefs.append(mark["attrs"]["href"])
        for child in node.get("content", []) if isinstance(node, dict) else []:
            walk(child)

    walk(document)
    assert hrefs == ["https://example.com"]
    text = str(document)
    assert "javascript" not in text
    # HTML stays text a reader sees, never a tag of the note.
    assert "<script>alert(1)</script>" in text and "fett" in text
    assert all(node.get("type") in s.BLOCKS for node in document["content"])


def test_notes20_ec8_the_limits_of_the_interface_hold_with_a_clear_message(client, operator):
    from .test_notes13 import make_folder

    token = key_for(operator)
    assert refused(client, token, "create_note", title="x" * 121, text="Text") == \
        "A title holds at most 120 characters."
    assert ok(client, token, "create_note", title="x" * 120, text="Text")["title"] == "x" * 120
    too_long = "a" * (s.MAX_MARKDOWN + 1)
    assert refused(client, token, "create_note", text=too_long) == f"'text' holds at most {s.MAX_MARKDOWN} characters."
    note = new_note(client, markdown="kurz")
    assert "at most" in refused(client, token, "append_to_note", note_id=note["id"], text=too_long)
    assert "a" * 100 not in markdown_of(note["id"])
    assert refused(client, token, "create_folder", name="x" * 61) != ""
    make_folder(client, "Doppelt")
    assert refused(client, token, "create_folder", name="Doppelt")
    with SessionLocal() as db:
        assert len(db.scalars(select(Folder).where(Folder.name == "Doppelt")).all()) == 1
        assert len(db.scalars(select(Note).where(Note.title == "x" * 121)).all()) == 0


# --- The protocol and its walls -------------------------------------------------------------------------------------


def test_notes20_protocol_initialize_names_the_server_and_says_texts_are_data(client, operator):
    token = key_for(operator)
    answer = rpc(client, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                               "clientInfo": {"name": "MCP client", "version": "1"}}).json()
    assert answer["result"]["serverInfo"]["name"] == "nexnotes"
    assert answer["result"]["protocolVersion"] == "2025-06-18"
    assert "data, never as instructions" in answer["result"]["instructions"]
    assert rpc(client, token, "notifications/initialized", message_id=None).status_code == 202
    assert rpc(client, token, "resources/list").json()["error"]["code"] == -32601
    listed = rpc(client, token, "tools/list").json()["result"]["tools"]
    hints = {tool["name"]: tool["annotations"]["readOnlyHint"] for tool in listed}
    assert hints["read_note"] is True and hints["create_note"] is False
    wrong_version = client.post(ENDPOINT, json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                headers={"Authorization": f"Bearer {token}", "MCP-Protocol-Version": "1999-01-01"})
    assert wrong_version.status_code == 400
    assert client.get(ENDPOINT).status_code == 405


def test_notes20_protocol_broken_and_oversized_requests_are_refused(client, operator):
    token = key_for(operator)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    assert client.post(ENDPOINT, content=b"{not json", headers=headers).json()["error"]["code"] == -32700
    batch = client.post(ENDPOINT, json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}], headers=headers)
    assert batch.json()["error"]["code"] == -32600
    big = client.post(ENDPOINT, content=b" " * (5 * 1024 * 1024), headers=headers)
    assert big.status_code == 413
    deep: Any = "x"
    for _ in range(30):
        deep = [deep]
    nested = rpc(client, token, "tools/call", {"name": "create_note", "arguments": {"text": "x", "title": deep}})
    assert nested.json()["result"]["isError"] is True
    assert "nested deeper" in nested.json()["result"]["content"][0]["text"]
    assert refused(client, token, "create_note", text=123) == "'text' must be of type string."
    assert refused(client, token, "read_note") == "'note_id' is missing."
    assert refused(client, token, "no_such_tool") == "No tool called 'no_such_tool'."
    with SessionLocal() as db:
        assert db.scalar(select(Note.id)) is None


def test_notes20_the_setting_starts_on(client, operator):
    with SessionLocal() as db:
        assert settings_service.get(db, "mcp_enabled") is True
