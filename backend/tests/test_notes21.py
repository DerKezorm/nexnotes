"""NOTES-21 nexdeck-Karte: the API a nexdeck card reads with a key of a member (``/api/v1/…``), what it shows and
never shows, ticking through the live room, the walls, and the keys in the interface."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, Note
from app.models_history import NoteEdit
from app.notedoc import edit
from app.services import apibrake, apitokens, dashboard

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored_doc, token_for


@pytest.fixture(autouse=True)
def fresh(client) -> Iterator[None]:
    dashboard.forget()
    yield
    Live.close_all()
    dashboard.forget()


def program() -> TestClient:
    """nexdeck's server: no tab, no cookie, no ``Origin``."""
    return TestClient(app, base_url="http://testserver")


def make_key(client: TestClient, level: str = "read", name: str = "Küche") -> str:
    # Since NOTES-25 a card reads with an ordinary API token (AC-3 there: no new card keys).
    made = client.post("/api/tokens", json={"name": name, "level": level})
    assert made.status_code == 201, made.text
    return made.json()["token"]


def get(token: str | None, path: str, **params):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return program().get(path, headers=headers, params=params)


def tick(token: str, note_id: str, index: int, checked: bool = True, text: str | None = "",
         via: TestClient | None = None, **headers):
    """``via``: the test client whose event loop holds the live room a test watches (one room per loop); the card's
    request still carries nothing but its key. ``text=None`` leaves the item's text out."""
    body: dict = {"checked": checked}
    if text is not None:
        body["text"] = text
    return (via or program()).post(f"/api/v1/notes/{note_id}/items/{index}", json=body,
                          headers={"Authorization": f"Bearer {token}", **headers})


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def pin(client: TestClient, note_id: str) -> None:
    assert client.put(f"/api/notes/{note_id}/pin", json={"pinned": True}).status_code == 200


def lock(note_id: str) -> None:
    with SessionLocal() as db:
        db.get(Note, note_id).locked = True
        db.commit()


SHOPPING = "- [ ] Milch\n- [ ] Tomaten\n- [x] Brot\n- [ ] Eier"


# --- AC-1: keys ---------------------------------------------------------------------------------------------------


def test_notes21_ac1_a_member_makes_a_key_for_nexdeck_to_read_or_to_tick_and_sees_it_once(client, operator):
    made = client.post("/api/tokens", json={"name": "Küche", "level": "write"})
    assert made.status_code == 201, made.text
    token = made.json()["token"]
    assert token.startswith("nn_api_") and made.json()["made"]["level"] == "write"
    listing = client.get("/api/tokens").json()
    assert token not in str(listing) and listing["tokens"][0]["name"] == "Küche"
    assert listing["tokens"][0]["last_used_at"] is None
    with SessionLocal() as db:
        row = db.scalar(select(ApiToken).where(ApiToken.kind == "api"))
        assert row is not None and row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    me = get(token, "/api/v1/me")
    assert me.status_code == 200
    assert me.json()["app"] == "nexnotes" and me.json()["level"] == "write" and "check" in me.json()["features"]
    # The last use shows in the list.
    assert client.get("/api/tokens").json()["tokens"][0]["last_used_at"] is not None
    assert client.post("/api/tokens", json={"name": "x", "level": "admin"}).status_code == 422
    assert client.post("/api/tokens", json={"name": "  ", "level": "read"}).status_code == 422


def test_notes21_ac1_an_account_holds_at_most_twenty_keys(client, operator):
    for number in range(apitokens.MAX_TOKENS):
        make_key(client, name=f"k{number}")
    too_many = client.post("/api/tokens", json={"name": "one more", "level": "read"})
    assert too_many.status_code == 409 and code(too_many) == "tokens_too_many"


def test_notes21_ac1_a_card_key_opens_the_card_only_and_the_card_takes_no_other_token(client, operator):
    token = make_key(client, "write")
    note = new_note(client, markdown="x")
    # Not the routes of the interface, not MCP.
    with program() as other:
        assert other.get("/api/notes", headers={"Authorization": f"Bearer {token}"}).status_code == 401
        assert other.get(f"/api/notes/{note['id']}", headers={"Authorization": f"Bearer {token}"}).status_code == 401
        mcp = other.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                         headers={"Authorization": f"Bearer {token}"})
        assert mcp.status_code == 401
    # The other way round: an MCP key or a device token is no card key, a session cookie neither.
    with SessionLocal() as db:
        _row, mcp_key = apitokens.make(db, db.get(Account, operator.id), "mcp", kind="mcp", level="write")
        _row, device = apitokens.make(db, db.get(Account, operator.id), "iPhone", kind="device")
    assert code(get(mcp_key, "/api/v1/me")) == "token_invalid"
    assert code(get(device, "/api/v1/me")) == "token_invalid"
    assert client.get("/api/v1/me").status_code == 401


# --- AC-5: pinned notes -------------------------------------------------------------------------------------------


def test_notes21_ac5_the_card_pinned_shows_title_first_line_and_progress_never_locked_or_foreign(client, operator):
    from .test_notes13 import share

    token = make_key(client)
    week = new_note(client, title="Wochenplan Essen", markdown="Mo Linsensuppe, Di Pasta\n\nMi Reste")
    shopping = new_note(client, title="Einkauf", markdown=SHOPPING)
    loose = new_note(client, title="Nicht angeheftet", markdown="nichts")
    secret = new_note(client, title="Tresor PIN", markdown="4711")
    for note in (week, shopping, secret):
        pin(client, note["id"])
    lock(secret["id"])
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Babysitter", markdown="Nummern und Allergien")
        not_mine = new_note(as_anna, title="Annas eigenes", markdown="privat")
        pin(as_anna, not_mine["id"])
        share(as_anna, "note", theirs["id"], operator, "read")
        # Anna's own pin of a note shared with the operator is hers, not his.
        pin(as_anna, theirs["id"])
    answer = get(token, "/api/v1/dashboard")
    assert answer.status_code == 200, answer.text
    card = answer.json()
    titles = {item["title"] for item in card["pinned"]}
    assert titles == {"Wochenplan Essen", "Einkauf"}
    assert "Tresor" not in answer.text and "4711" not in answer.text and "Annas eigenes" not in answer.text
    by_title = {item["title"]: item for item in card["pinned"]}
    assert by_title["Wochenplan Essen"]["first_line"] == "Mo Linsensuppe, Di Pasta"
    assert by_title["Einkauf"]["tasks"] == {"done": 1, "total": 4}
    assert by_title["Einkauf"]["link"] == f"http://testserver/notes/{shopping['id']}"
    assert loose["id"] not in answer.text
    # The member pins the shared note for himself: now it is on his card, with its owner.
    pin(client, theirs["id"])
    again = get(token, "/api/v1/dashboard").json()
    shared = [item for item in again["pinned"] if item["id"] == theirs["id"]]
    assert shared and shared[0]["owner"] == "Anna"
    assert again["stamp"] != card["stamp"]
    # As many as asked, the rest counted.
    few = get(token, "/api/v1/dashboard", limit=1).json()
    assert len(few["pinned"]) == 1 and few["more"] == 2


def test_notes21_ac1_the_choice_of_notes_for_a_card(client, operator):
    token = make_key(client)
    new_note(client, title="Einkauf Samstag", markdown=SHOPPING)
    new_note(client, title="Urlaub", markdown="x")
    locked = new_note(client, title="Einkauf geheim", markdown="x")
    lock(locked["id"])
    found = get(token, "/api/v1/notes", q="einkauf").json()["notes"]
    assert [item["title"] for item in found] == ["Einkauf Samstag"]
    assert found[0]["tasks"] == {"done": 1, "total": 4}
    assert len(get(token, "/api/v1/notes").json()["notes"]) == 2


# --- AC-2, EC-5: one note, ticking ---------------------------------------------------------------------------------


def test_notes21_ac2_a_card_of_a_checklist_ticks_an_item_in_nexnotes(client, operator):
    token = make_key(client, "write", name="Küchen-Tablet")
    note = new_note(client, title="Einkauf Samstag", markdown=SHOPPING)
    card = get(token, f"/api/v1/notes/{note['id']}")
    assert card.status_code == 200, card.text
    body = card.json()
    assert body["title"] == "Einkauf Samstag" and body["can_check"] is True
    assert [(item["index"], item["text"], item["checked"]) for item in body["items"]] == [
        (0, "Milch", False), (1, "Tomaten", False), (2, "Brot", True), (3, "Eier", False)]
    assert body["tasks"] == {"done": 1, "total": 4} and body["lines"] == []
    ticked = tick(token, note["id"], 1, text="Tomaten")
    assert ticked.status_code == 200, ticked.text
    assert ticked.json()["tasks"] == {"done": 2, "total": 4} and ticked.json()["stamp"] != body["stamp"]
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [False, True, True, False]
    # Opened again from the card.
    assert tick(token, note["id"], 1, checked=False, text="Tomaten").json()["tasks"]["done"] == 1
    # The history names the token, not only the person (an API token since NOTES-25, AC-22 there).
    with SessionLocal() as db:
        vias = {row.via for row in db.scalars(select(NoteEdit).where(NoteEdit.note_id == note["id"]))}
    assert "api:Küchen-Tablet" in vias
    # An item that says something else by now is left alone.
    changed = tick(token, note["id"], 0, text="Butter")
    assert changed.status_code == 409 and code(changed) == "item_changed"
    assert tick(token, note["id"], 99).status_code == 409


def test_notes21_ac2_a_long_item_is_ticked_with_the_text_the_card_showed(client, operator):
    token = make_key(client, "write")
    long_item = " ".join(f"Wort{number:03d}" for number in range(86))
    assert len(long_item) > 600
    note = new_note(client, markdown=f"- [ ] {long_item}\n- [ ] Mil")
    shown = get(token, f"/api/v1/notes/{note['id']}").json()["items"]
    assert len(shown[0]["text"]) == 500 and long_item.startswith(shown[0]["text"])
    ticked = tick(token, note["id"], 0, text=shown[0]["text"])
    assert ticked.status_code == 200, ticked.text
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [True, False]
    # Only the shortened text exactly as shown counts.
    assert code(tick(token, note["id"], 0, checked=False, text=shown[0]["text"][:499])) == "item_changed"
    assert code(tick(token, note["id"], 1, text="Mi")) == "item_changed"
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [True, False]


def test_notes21_ac2_ticking_needs_the_text_of_the_item(client, operator):
    token = make_key(client, "write")
    note = new_note(client, markdown=SHOPPING)
    # By its place alone an item may be another one after a change: without its text nothing is ticked.
    refused = tick(token, note["id"], 0, text=None)
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "invalid_input" and refused.json()["detail"]["message"]
    assert "text" in refused.json()["detail"]["fields"]
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [False, False, True, False]


def test_notes21_ac4_a_card_of_a_note_without_checklist_shows_its_first_lines_and_its_link(client, operator):
    token = make_key(client)
    note = new_note(client, title="Müllabfuhr", markdown="Gelb Mittwoch\n\nPapier Freitag")
    body = get(token, f"/api/v1/notes/{note['id']}").json()
    assert body["lines"] == ["Gelb Mittwoch", "Papier Freitag"] and body["items"] == [] and body["tasks"] is None
    assert body["link"] == f"http://testserver/notes/{note['id']}" and body["can_check"] is False


def test_notes21_ec5_ticking_on_the_card_and_in_nexnotes_at_the_same_time_keeps_both(client, operator):
    token = make_key(client, "write")
    note = new_note(client, markdown=SHOPPING)
    browser = Live(client, note["id"], token_for(operator))
    assert browser.pump(lambda: browser.synced)
    edit.toggle_task(browser.doc, 3, True)
    client.cookies.clear()
    assert tick(token, note["id"], 0, text="Milch", via=client).status_code == 200
    seen = browser.pump(lambda: [task.checked for task in edit.list_tasks(browser.doc)] == [True, False, True, True])
    assert seen, ([task.checked for task in edit.list_tasks(browser.doc)],
                  [task.checked for task in edit.list_tasks(stored_doc(note["id"]))])
    browser.close()
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [True, False, True, True]


# --- EC-1, EC-2, EC-3 -----------------------------------------------------------------------------------------------


def test_notes21_ec1_every_answer_says_when_it_was_read_for_the_last_state_on_the_card(client, operator):
    token = make_key(client)
    note = new_note(client, markdown=SHOPPING)
    pin(client, note["id"])
    for path in ("/api/v1/dashboard", f"/api/v1/notes/{note['id']}"):
        body = get(token, path).json()
        assert body["as_of"] and body["stamp"]


def test_notes21_ec2_a_note_deleted_locked_or_no_longer_shared_says_so_without_content(client, operator):
    from .test_notes13 import share, unshare

    token = make_key(client, "write")
    trashed = new_note(client, title="Weg", markdown="- [ ] geheim im Papierkorb")
    assert client.delete(f"/api/notes/{trashed['id']}").status_code in (200, 204)
    answer = get(token, f"/api/v1/notes/{trashed['id']}")
    assert answer.status_code == 410 and code(answer) == "note_trashed" and "geheim" not in answer.text
    locked = new_note(client, title="Tresor", markdown="- [ ] PIN 4711")
    lock(locked["id"])
    answer = get(token, f"/api/v1/notes/{locked['id']}")
    assert answer.status_code == 409 and code(answer) == "note_locked"
    assert "4711" not in answer.text and "Tresor" not in answer.text
    assert tick(token, locked["id"], 0).status_code == 409
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Annas Liste", markdown="- [ ] Butter")
        share(as_anna, "note", theirs["id"], operator, "write")
        assert get(token, f"/api/v1/notes/{theirs['id']}").status_code == 200
        unshare(as_anna, "note", theirs["id"], operator)
        answer = get(token, f"/api/v1/notes/{theirs['id']}")
        assert answer.status_code == 404 and code(answer) == "not_found" and "Butter" not in answer.text
        assert tick(token, theirs["id"], 0).status_code == 404
        # Locked by its owner: for anybody else as if it were not there.
        other = new_note(as_anna, markdown="- [ ] x")
        share(as_anna, "note", other["id"], operator, "read")
        lock(other["id"])
        assert code(get(token, f"/api/v1/notes/{other['id']}")) == "not_found"
    with SessionLocal() as db:
        db.delete(db.get(Note, trashed["id"]))
        db.commit()
    assert code(get(token, f"/api/v1/notes/{trashed['id']}")) == "not_found"


def test_notes21_ec2_a_note_pinned_and_then_no_longer_shared_leaves_the_card_and_its_pin_goes(client, operator):
    from app.models_shares import SharePin

    from .test_notes13 import share, unshare

    token = make_key(client)
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Babysitter", markdown="Nummern und Allergien")
        share(as_anna, "note", theirs["id"], operator, "read")
        pin(client, theirs["id"])
        assert [item["id"] for item in get(token, "/api/v1/dashboard").json()["pinned"]] == [theirs["id"]]
        unshare(as_anna, "note", theirs["id"], operator)
    card = get(token, "/api/v1/dashboard")
    assert card.json()["pinned"] == [] and "Babysitter" not in card.text and "Allergien" not in card.text
    with SessionLocal() as db:
        assert db.scalars(select(SharePin).where(SharePin.account_id == operator.id)).all() == []
        # A pin left over from before (or by any other way) still shows nothing that is no longer shared.
        db.add(SharePin(account_id=operator.id, note_id=theirs["id"]))
        db.commit()
    card = get(token, "/api/v1/dashboard")
    assert card.json()["pinned"] == [] and "Babysitter" not in card.text


def test_notes21_ec3_a_revoked_key_or_one_that_only_reads_leaves_the_items_as_they_are(client, operator):
    from .test_notes13 import share

    reads = make_key(client, "read")
    writes = make_key(client, "write")
    note = new_note(client, markdown=SHOPPING)
    assert get(reads, f"/api/v1/notes/{note['id']}").json()["can_check"] is False
    refused = tick(reads, note["id"], 0, text="Milch")
    assert refused.status_code == 403 and code(refused) == "token_reads_only"
    key_id = client.get("/api/tokens").json()["tokens"][1]["id"]
    assert client.delete(f"/api/tokens/{key_id}").status_code == 204
    revoked = tick(writes, note["id"], 0, text="Milch")
    assert revoked.status_code == 401 and code(revoked) == "token_invalid"
    assert code(get(writes, "/api/v1/dashboard")) == "token_invalid"
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [False, False, True, False]
    # A key that may write, on a note shared with its member to read: not ticked either.
    anna = make_account("anna")
    writes = make_key(client, "write", name="again")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, markdown="- [ ] Butter")
        share(as_anna, "note", theirs["id"], operator, "read")
    assert get(writes, f"/api/v1/notes/{theirs['id']}").json()["can_check"] is False
    assert code(tick(writes, theirs["id"], 0)) == "not_allowed"
    # Somebody else cannot revoke the key.
    with new_client(anna) as as_anna:
        own = client.get("/api/tokens").json()["tokens"][-1]["id"]
        assert as_anna.delete(f"/api/tokens/{own}").status_code == 404


# --- The walls ----------------------------------------------------------------------------------------------------


def test_notes21_a_request_from_a_web_page_is_turned_away(client, operator):
    token = make_key(client)
    answer = program().get("/api/v1/me", headers={"Authorization": f"Bearer {token}", "Origin": "https://evil.example"})
    assert answer.status_code == 403 and code(answer) == "origin_refused"


def test_notes21_wrong_keys_are_slowed_per_sender_and_many_requests_per_key(client, operator, monkeypatch):
    for _ in range(20):
        assert get("nn_deck_wrong", "/api/v1/me").status_code == 401
    slowed = get("nn_deck_wrong", "/api/v1/me")
    assert slowed.status_code == 429 and code(slowed) == "too_many_attempts"
    from app.security import brake

    brake.forget()
    token = make_key(client)
    monkeypatch.setattr(apibrake, "PER_MINUTE", 3)
    for _ in range(3):
        assert get(token, "/api/v1/me").status_code == 200
    fast = get(token, "/api/v1/me")
    assert fast.status_code == 429 and code(fast) == "slow_down" and fast.headers["retry-after"] == "60"


def test_notes21_a_blocked_or_deleted_account_s_key_is_turned_away(client, operator):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        token = make_key(as_anna)
    assert get(token, "/api/v1/me").status_code == 200
    with SessionLocal() as db:
        from app.models import utcnow

        db.get(Account, anna.id).blocked_at = utcnow()
        db.commit()
    assert code(get(token, "/api/v1/me")) == "token_invalid"
