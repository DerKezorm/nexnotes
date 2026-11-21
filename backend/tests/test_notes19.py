"""NOTES-19 An nextasks schicken: the connection of a member's own nextasks, lines sent as tasks with the way back,
the member's own marks, the failures, and which addresses nexnotes asks at all.

nextasks is a stand-in here (``FakeNextasks`` behind ``httpx.MockTransport``) and names resolve through a stand-in:
nothing goes to the network, no real nextasks is asked."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Note
from app.models_nextasks import NextasksConnection, NextasksLink
from app.services import nextasks

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored

GOOD = "ntk_" + "g" * 40
READS = "ntk_" + "r" * 40
HOME = "http://nextasks.home:8510"
PUBLIC = "https://tasks.example.com"
LIST = "11111111-1111-4111-8111-111111111111"
SECTION = "22222222-2222-4222-8222-222222222222"
OTHER_LIST = "33333333-3333-4333-8333-333333333333"


class FakeNextasks:
    """A stand-in nextasks with ``/api/v1``: tokens, lists, tasks, ``external_ref``; and the names it resolves to."""

    def __init__(self) -> None:
        self.addresses: dict[str, list[str]] = {"nextasks.home": ["192.168.1.20"], "tasks.example.com": ["93.184.216.34"]}
        self.tokens = {GOOD: "write", READS: "read"}
        self.features = ["tasks", "dashboard", "external_ref"]
        self.tasks: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.down = False
        self.slow = False
        self.no_api = False
        self.fail_after: int | None = None
        self.redirect = False

    def resolve(self, host: str, _port: int) -> list[str]:
        if host not in self.addresses:
            raise nextasks.outbound.Unreachable(host)
        return list(self.addresses[host])

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("refused", request=request)
        if self.slow:
            raise httpx.ReadTimeout("slow", request=request)
        if self.redirect:
            return httpx.Response(302, headers={"Location": "http://169.254.169.254/"})
        if self.no_api:
            return httpx.Response(404, json={"detail": "Not Found"})
        assert "origin" not in request.headers
        token = request.headers.get("authorization", "")[7:]
        level = self.tokens.get(token)
        if level is None:
            return httpx.Response(401, json={"detail": {"code": "token_invalid", "message": "No valid token."}})
        path = request.url.path.removeprefix("/api/v1/")
        if request.method == "GET" and path == "me":
            return httpx.Response(200, json={"name": "robin", "display_name": "Robin", "level": level,
                                             "features": self.features, "spaces": [], "version": "0.3.2"})
        if request.method == "GET" and path == "lists":
            return httpx.Response(200, json={"lists": [
                {"id": LIST, "space_id": "s", "space_name": "Zuhause", "name": "Renovierung", "writable": True,
                 "hidden": False, "sections": [{"id": SECTION, "name": "Bad"}]},
                {"id": OTHER_LIST, "space_id": "s", "space_name": "Familie", "name": "Einkauf", "writable": True,
                 "hidden": False, "sections": []},
                {"id": "44444444-4444-4444-8444-444444444444", "space_name": "Firma", "name": "Nur lesen",
                 "writable": False, "sections": []},
            ]})
        if request.method == "POST" and path == "tasks":
            if level != "write":
                return httpx.Response(403, json={"detail": {"code": "token_reads_only", "message": "Reads only."}})
            if self.fail_after is not None and len(self.tasks) >= self.fail_after:
                raise httpx.ConnectError("gone midway", request=request)
            body = json.loads(request.content)
            if body.get("list_id") not in (None, LIST, OTHER_LIST):
                return httpx.Response(404, json={"detail": {"code": "not_found", "message": "Not found."}})
            for task in self.tasks.values():
                if task.get("external_ref") and task["external_ref"] == body.get("external_ref"):
                    return httpx.Response(200, json=task)
            task_id = str(uuid.uuid4())
            task = {**body, "id": task_id, "trashed": False, "completed": False,
                    "link": f"{PUBLIC}/lists/{body.get('list_id')}?task={task_id}"}
            self.tasks[task_id] = task
            return httpx.Response(201, json=task)
        if request.method == "GET" and path.startswith("tasks/"):
            task = self.tasks.get(path.split("/", 1)[1])
            if task is None:
                return httpx.Response(404, json={"detail": {"code": "not_found", "message": "Not found."}})
            return httpx.Response(200, json=task)
        return httpx.Response(405, json={"detail": {"code": "method_not_allowed", "message": "No."}})


@pytest.fixture
def fake(monkeypatch) -> Iterator[FakeNextasks]:
    stand_in = FakeNextasks()
    monkeypatch.setattr(nextasks, "RESOLVER", stand_in.resolve)
    monkeypatch.setattr(nextasks, "TRANSPORT", httpx.MockTransport(stand_in.handle))
    nextasks.forget()
    yield stand_in
    nextasks.forget()
    Live.close_all()


def allow_home(client: TestClient, allowed: bool = True) -> None:
    answer = client.put("/api/settings", json={"connections_local_network": allowed})
    assert answer.status_code == 200, answer.text


def connect(client: TestClient, url: str = HOME, token: str = GOOD):
    return client.put("/api/nextasks", json={"url": url, "token": token})


def connected(client: TestClient) -> dict:
    allow_home(client)
    answer = connect(client)
    assert answer.status_code == 200, answer.text
    return answer.json()


def block_id(number: int = 1) -> str:
    return f"{4242 + number}.{number}"


def send(client: TestClient, note_id: str, texts: list[str], *, request_id: str | None = None,
         list_id: str = LIST, due: str | None = None, list_name: str = "Zuhause › Renovierung"):
    body = {"note_id": note_id, "request_id": request_id or uuid.uuid4().hex, "list_id": list_id,
            "list_name": list_name, "lines": [{"text": text, "anchor": block_id(n)} for n, text in enumerate(texts)]}
    if due:
        body["due_date"] = due
    return client.post("/api/nextasks/send", json=body)


def links(client: TestClient, note_id: str) -> list[dict]:
    answer = client.get("/api/nextasks/links", params={"note_id": note_id})
    assert answer.status_code == 200, answer.text
    return answer.json()["links"]


def code(answer: httpx.Response) -> str:
    return answer.json()["detail"]["code"]


# --- AC-4, AC-5, EC-7: connecting ----------------------------------------------------------------------------------


def test_notes19_ac4_without_a_connection_there_is_nothing_to_send(client, operator, fake):
    status = client.get("/api/nextasks").json()
    assert status == {"connected": False, "local_allowed": False}
    note = new_note(client, markdown="Waschbecken abbauen lassen")
    assert code(client.get("/api/nextasks/lists")) == "nextasks_not_connected"
    refused = send(client, note["id"], ["Waschbecken abbauen lassen"])
    assert refused.status_code == 409 and code(refused) == "nextasks_not_connected"
    assert fake.requests == []


def test_notes19_ac5_connecting_checks_address_and_key_at_once_and_says_as_whom(client, operator, fake):
    allow_home(client)
    wrong = connect(client, token="ntk_" + "x" * 40)
    assert wrong.status_code == 409 and code(wrong) == "nextasks_token_invalid"
    assert client.get("/api/nextasks").json()["connected"] is False
    made = connect(client, url=HOME + "/")
    assert made.status_code == 200, made.text
    status = made.json()
    assert status["connected"] is True and status["host"] == "nextasks.home" and status["name"] == "Robin"
    assert status["url"] == HOME
    assert fake.requests[-1].url.path == "/api/v1/me"
    # The key changed: checked again; a wrong one leaves the working one in place.
    assert code(connect(client, token="ntk_wrong")) == "nextasks_token_invalid"
    assert client.get("/api/nextasks").json()["connected"] is True
    fake.tokens["ntk_" + "n" * 40] = "write"
    assert connect(client, token="ntk_" + "n" * 40).status_code == 200
    # Disconnected: gone.
    assert client.delete("/api/nextasks").status_code == 204
    assert client.get("/api/nextasks").json()["connected"] is False


def test_notes19_ac5_the_key_is_stored_sealed_and_never_answered_or_logged(client, operator, fake, caplog):
    caplog.set_level("DEBUG")
    connected(client)
    with SessionLocal() as db:
        row = db.get(NextasksConnection, operator.id)
        assert row is not None and GOOD not in row.token_enc and len(row.token_enc) > 40
        # Sealed for this account: under another account's context it does not open.
        assert nextasks.decrypt_secret(row.token_enc, f"nextasks:{operator.id}") == GOOD
        assert nextasks.decrypt_secret(row.token_enc, f"nextasks:{operator.id + 1}") == ""
    assert GOOD not in client.get("/api/nextasks").text
    assert GOOD not in caplog.text


def test_notes19_ec7_a_nextasks_with_another_api_is_refused_when_connecting(client, operator, fake):
    allow_home(client)
    fake.no_api = True
    assert code(connect(client)) == "nextasks_too_old"
    fake.no_api = False
    fake.features = ["tasks", "dashboard"]
    assert code(connect(client)) == "nextasks_too_old"
    fake.features = ["tasks", "external_ref", "something_newer"]
    # A key that only reads cannot make tasks: said now, not at the first sending.
    assert code(connect(client, token=READS)) == "nextasks_read_only"
    assert client.get("/api/nextasks").json()["connected"] is False
    assert connect(client).status_code == 200


# --- AC-1, AC-2, AC-6, EC-2, EC-6: sending -------------------------------------------------------------------------


def test_notes19_ac1_ac6_the_lists_with_sections_and_the_one_used_last(client, operator, fake):
    connected(client)
    found = client.get("/api/nextasks/lists").json()
    names = [item["name"] for item in found["lists"]]
    assert names == ["Zuhause › Renovierung", "Zuhause › Renovierung › Bad", "Familie › Einkauf"]
    assert found["last"] is None
    note = new_note(client, markdown="Fliesen")
    assert send(client, note["id"], ["Fliesen"], list_id=f"{LIST}/{SECTION}",
                list_name="Zuhause › Renovierung › Bad").status_code == 200
    again = client.get("/api/nextasks/lists").json()
    assert again["last"] == f"{LIST}/{SECTION}"
    assert client.get("/api/nextasks").json()["last_list"]["name"] == "Zuhause › Renovierung › Bad"
    task = next(iter(fake.tasks.values()))
    assert task["list_id"] == LIST and task["section_id"] == SECTION


def test_notes19_ac1_ac2_ec2_each_line_becomes_a_task_that_leads_back_to_the_note(client, operator, fake):
    connected(client)
    note = new_note(client, title="Handwerker Bad", markdown="- [ ] Silikonfarbe\n- [ ] Waschbecken\n- [ ] Termin")
    sent = send(client, note["id"], ["Silikonfarbe   grau", "Waschbecken", "Termin"], due="2026-11-27")
    assert sent.status_code == 200, sent.text
    assert sent.json()["sent"] == 3 and len(fake.tasks) == 3
    back = f"http://testserver/notes/{note['id']}"
    titles = sorted(task["title"] for task in fake.tasks.values())
    assert titles == ["Silikonfarbe grau", "Termin", "Waschbecken"]
    for task in fake.tasks.values():
        assert task["url"] == back and back in task["notes"] and "Handwerker Bad" in task["notes"]
        assert task["due_date"] == "2026-11-27" and task["list_id"] == LIST
        assert task["external_ref"].startswith(f"nexnotes:{operator.id}:")
    marks = links(client, note["id"])
    assert [mark["anchor"] for mark in marks] == [block_id(0), block_id(1), block_id(2)]
    assert all(mark["due_date"] == "2026-11-27" and mark["task_url"].startswith(PUBLIC) for mark in marks)
    # With the operator's public address the way back is that one.
    client.put("/api/settings", json={"public_url": "https://notes.example.com"})
    later = new_note(client, markdown="Noch eins")
    send(client, later["id"], ["Noch eins"])
    newest = next(task for task in fake.tasks.values() if task["title"] == "Noch eins")
    assert newest["url"] == f"https://notes.example.com/notes/{later['id']}"


def test_notes19_ec6_two_clicks_or_a_retry_make_one_task_and_one_mark(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="Einmal")
    request_id = uuid.uuid4().hex
    first = send(client, note["id"], ["Einmal"], request_id=request_id)
    second = send(client, note["id"], ["Einmal"], request_id=request_id)
    assert first.status_code == second.status_code == 200
    assert len(fake.tasks) == 1 and len(links(client, note["id"])) == 1
    # nexnotes lost its mark (another server, a restore): nextasks still answers the same key with the same task.
    with SessionLocal() as db:
        for row in db.scalars(select(NextasksLink)):
            db.delete(row)
        db.commit()
    assert send(client, note["id"], ["Einmal"], request_id=request_id).status_code == 200
    assert len(fake.tasks) == 1 and len(links(client, note["id"])) == 1


def test_notes19_ec1_ec6_a_failure_midway_keeps_what_went_and_a_retry_makes_no_double(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="a\n\nb\n\nc")
    request_id = uuid.uuid4().hex
    fake.fail_after = 1
    failed = send(client, note["id"], ["a", "b", "c"], request_id=request_id)
    assert failed.status_code == 502 and code(failed) == "nextasks_unreachable"
    assert failed.json()["detail"]["sent"] == 1
    assert len(links(client, note["id"])) == 1
    fake.fail_after = None
    again = send(client, note["id"], ["a", "b", "c"], request_id=request_id)
    assert again.status_code == 200 and again.json()["sent"] == 3
    assert sorted(task["title"] for task in fake.tasks.values()) == ["a", "b", "c"]
    assert len(links(client, note["id"])) == 3


def test_notes19_ac1_a_list_nextasks_does_not_know_any_more_is_said(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="x")
    gone = send(client, note["id"], ["x"], list_id="55555555-5555-4555-8555-555555555555")
    assert gone.status_code == 409 and code(gone) == "nextasks_list_unknown"
    assert links(client, note["id"]) == []


# --- EC-1: nextasks away, a wrong key ------------------------------------------------------------------------------


def test_notes19_ec1_unreachable_slow_or_a_revoked_key_is_said_and_the_note_stays_as_it_was(client, operator, fake,
                                                                                            caplog):
    caplog.set_level("INFO", logger="nexnotes.nextasks")
    connected(client)
    note = new_note(client, markdown="- [ ] Silikon")
    before = stored(note["id"])
    fake.down = True
    down = send(client, note["id"], ["Silikon"])
    assert down.status_code == 502 and code(down) == "nextasks_unreachable"
    fake.down = False
    fake.slow = True
    slow = send(client, note["id"], ["Silikon"])
    # Away, too slow or something else answering: one code for the caller, the way it went wrong in the log only.
    assert slow.status_code == 502 and code(slow) == "nextasks_unreachable"
    assert slow.json()["detail"] == down.json()["detail"]
    assert "no connection (ConnectError)" in caplog.text and "no answer in time" in caplog.text
    fake.slow = False
    del fake.tokens[GOOD]
    revoked = send(client, note["id"], ["Silikon"])
    # Never 401: that would sign the member out of nexnotes. The interface leads to "Verbindungen".
    assert revoked.status_code == 409 and code(revoked) == "nextasks_token_invalid"
    assert links(client, note["id"]) == [] and fake.tasks == {}
    after = stored(note["id"])
    assert (after.ydoc, after.text, after.updated_at) == (before.ydoc, before.text, before.updated_at)
    # The member is still signed in.
    assert client.get("/api/nextasks").status_code == 200


# --- EC-3, EC-4, EC-5: the marks ----------------------------------------------------------------------------------


def test_notes19_ec3_changing_or_deleting_the_line_leaves_the_task_as_it_is(client, operator, fake):
    from app.notedoc import edit
    from app.notedoc.doc import body_of

    from .test_notes3 import token_for

    connected(client)
    note = new_note(client, markdown="- [ ] Silikonfarbe grau bestätigen")
    send(client, note["id"], ["Silikonfarbe grau bestätigen"])
    task = dict(next(iter(fake.tasks.values())))
    asked = len(fake.requests)
    browser = Live(client, note["id"], token_for(operator))
    assert browser.pump(lambda: browser.synced)
    edit.append_paragraph(browser.doc, "ganz anders jetzt")
    with browser.doc.transaction():
        del body_of(browser.doc).children[0]
    assert browser.pump(lambda: "Silikonfarbe" not in browser.text)
    browser.close()
    assert len(fake.requests) == asked and next(iter(fake.tasks.values())) == task
    # The mark stays the server's record; the browser no longer finds its line and shows none.
    assert len(links(client, note["id"])) == 1


def test_notes19_ec4_a_task_deleted_in_nextasks_is_said_when_its_mark_is_opened(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="a\n\nb\n\nc")
    send(client, note["id"], ["a", "b", "c"])
    first, second, third = links(client, note["id"])
    by_title = {task["title"]: task for task in fake.tasks.values()}
    opened = client.get(f"/api/nextasks/links/{first['id']}/open")
    assert opened.status_code == 200 and opened.json()["url"] == by_title["a"]["link"]
    del fake.tasks[by_title["b"]["id"]]
    gone = client.get(f"/api/nextasks/links/{second['id']}/open")
    assert gone.status_code == 404 and code(gone) == "nextasks_task_gone"
    assert gone.json()["detail"]["trashed"] is False
    by_title["c"]["trashed"] = True
    trashed = client.get(f"/api/nextasks/links/{third['id']}/open")
    assert trashed.status_code == 404 and trashed.json()["detail"]["trashed"] is True
    # The member takes the mark away; the task in nextasks is not touched.
    assert client.delete(f"/api/nextasks/links/{second['id']}").status_code == 204
    assert [mark["id"] for mark in links(client, note["id"])] == [first["id"], third["id"]]


def test_notes19_ec5_a_line_of_a_note_shared_to_read_is_sent_and_only_the_sender_sees_the_mark(client, operator, fake):
    from .test_notes13 import share

    anna = make_account("anna")
    with new_client(anna) as as_anna:
        note = new_note(as_anna, markdown="Einkauf: Milch")
        share(as_anna, "note", note["id"], operator, "read")
        before = stored(note["id"])
        connected(client)
        sent = send(client, note["id"], ["Milch"])
        assert sent.status_code == 200, sent.text
        assert len(links(client, note["id"])) == 1
        # Anna sees no mark, and the note's text is not touched.
        assert links(as_anna, note["id"]) == []
        mark = links(client, note["id"])[0]
        assert as_anna.get(f"/api/nextasks/links/{mark['id']}/open").status_code == 404
        assert as_anna.delete(f"/api/nextasks/links/{mark['id']}").status_code == 404
        after = stored(note["id"])
        assert (after.ydoc, after.updated_at) == (before.ydoc, before.updated_at)
        # A note nobody shared with him: as if it were not there.
        secret = new_note(as_anna, markdown="geheim")
        assert send(client, secret["id"], ["geheim"]).status_code == 404
        assert client.get("/api/nextasks/links", params={"note_id": secret["id"]}).status_code == 404
    assert "geheim" not in [task["title"] for task in fake.tasks.values()]


def test_notes19_a_locked_note_is_never_sent(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="PIN 4711")
    with SessionLocal() as db:
        db.get(Note, note["id"]).locked = True
        db.commit()
    refused = send(client, note["id"], ["PIN 4711"])
    assert refused.status_code == 409 and code(refused) == "note_locked"
    assert fake.tasks == {}


def test_notes19_the_input_is_checked(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="x")
    body = {"note_id": note["id"], "request_id": uuid.uuid4().hex, "list_id": LIST, "lines": [{"text": "x",
                                                                                                "anchor": "1.1"}]}
    for broken in ({"request_id": "short"}, {"list_id": "../me"}, {"lines": []},
                   {"lines": [{"text": "x", "anchor": "<script>"}]}, {"lines": [{"text": "   ", "anchor": "1.1"}]},
                   {"lines": [{"text": "x", "anchor": "1.1"}] * (nextasks.MAX_LINES + 1)}):
        assert client.post("/api/nextasks/send", json={**body, **broken}).status_code == 422, broken
    assert fake.tasks == {}


# --- Which addresses are asked at all ------------------------------------------------------------------------------


def test_notes19_an_address_in_the_own_network_needs_the_operator_s_switch(client, operator, fake):
    settings = client.get("/api/settings").json()
    assert settings["connections_local_network"] is False
    refused = connect(client)
    assert refused.status_code == 422 and code(refused) == "nextasks_address_local"
    assert fake.requests == [] and client.get("/api/nextasks").json()["connected"] is False
    # Public addresses need no switch.
    assert connect(client, url=PUBLIC).status_code == 200
    allow_home(client)
    assert connect(client).status_code == 200
    # The switch is asked at every request, not only when connecting.
    allow_home(client, False)
    later = client.get("/api/nextasks/lists")
    assert later.status_code == 422 and code(later) == "nextasks_address_local"
    # A member may not open it.
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        assert as_anna.put("/api/settings", json={"connections_local_network": True}).status_code == 403


@pytest.mark.parametrize("address", ["127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "::ffff:127.0.0.1",
                                     "64:ff9b::a9fe:a9fe", "224.0.0.1", "192.0.0.192",
                                     # Metadata services inside the own networks the switch opens (100.64/10, fc00::/7).
                                     "100.100.100.200", "fd00:ec2::254"])
def test_notes19_the_machine_itself_and_special_addresses_never_even_with_the_switch(client, operator, fake,
                                                                                     address):
    allow_home(client)
    fake.addresses["sneaky.home"] = ["192.168.1.20", address]
    refused = connect(client, url="http://sneaky.home:8510")
    assert refused.status_code == 422 and code(refused) == "nextasks_address_refused"
    assert fake.requests == []


@pytest.mark.parametrize("url", ["http://localhost:8510", "http://app.localhost", "ftp://nextasks.home",
                                 "http://user:pass" + chr(64) + "nextasks.home", "http://nextasks.home/?x=1",
                                 "http://nextasks.home/#a", "javascript:alert(1)", "http://"])
def test_notes19_addresses_that_are_no_address_of_nextasks(client, operator, fake, url):
    allow_home(client)
    refused = connect(client, url=url)
    assert refused.status_code == 422 and code(refused) in ("nextasks_address_invalid", "nextasks_address_refused")
    assert fake.requests == []


def test_notes19_a_redirect_is_never_followed(client, operator, fake):
    allow_home(client)
    fake.redirect = True
    refused = connect(client)
    assert refused.status_code == 502 and code(refused) == "nextasks_unreachable"
    assert len(fake.requests) == 1


def test_notes19_a_name_is_resolved_once_and_asked_at_what_was_checked(client, operator, fake):
    allow_home(client)
    connected(client)
    me = fake.requests[-1]
    # The connection goes to the checked address; the name stays in the Host header.
    assert me.url.host == "192.168.1.20" and me.headers["host"] == "nextasks.home:8510"


def test_notes19_marks_and_connection_go_with_the_account_and_the_note(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="x")
    send(client, note["id"], ["x"])
    with SessionLocal() as db:
        db.delete(db.get(Note, note["id"]))
        db.commit()
        assert db.scalars(select(NextasksLink)).all() == []
        db.delete(db.get(Account, operator.id))
        db.commit()
        assert db.get(NextasksConnection, operator.id) is None


def test_notes19_a_due_date_that_is_no_date_is_refused(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="x")
    answer = send(client, note["id"], ["x"], due="morgen")
    assert answer.status_code == 422 and fake.tasks == {}
    assert send(client, note["id"], ["x"], due=date(2026, 12, 24).isoformat()).status_code == 200


# --- The server as nobody's network tool ---------------------------------------------------------------------------


def test_notes19_an_answer_nexnotes_cannot_use_says_no_status_of_what_answered(client, operator, fake, monkeypatch):
    connected(client)
    for status in (500, 418, 302):
        answer_with = httpx.MockTransport(lambda _request, status=status: httpx.Response(status, json={"detail": "x"}))
        monkeypatch.setattr(nextasks, "TRANSPORT", answer_with)
        answer = client.get("/api/nextasks/lists")
        assert answer.status_code == 502
        assert answer.json()["detail"] == {"code": "nextasks_unreachable",
                                           "message": "nextasks cannot be reached or gave no usable answer."}


@pytest.mark.parametrize("port", [1, 21, 22, 25, 110, 389, 445, 1023])
def test_notes19_ports_below_1024_other_than_80_and_443_are_refused(client, operator, fake, port):
    allow_home(client)
    refused = connect(client, url=f"http://nextasks.home:{port}")
    assert refused.status_code == 422 and code(refused) == "nextasks_address_port"
    assert fake.requests == []


@pytest.mark.parametrize("url", ["http://nextasks.home:80", "https://nextasks.home:443", "http://nextasks.home",
                                 "http://nextasks.home:1024"])
def test_notes19_the_web_ports_and_the_ones_from_1024_are_asked(client, operator, fake, url):
    allow_home(client)
    assert connect(client, url=url).status_code == 200


def test_notes19_requests_to_nextasks_are_braked_per_account(client, operator, fake, monkeypatch):
    monkeypatch.setattr(nextasks, "CONNECTS_PER_MINUTE", 3)
    monkeypatch.setattr(nextasks, "REQUESTS_PER_MINUTE", 4)
    allow_home(client)
    for _ in range(3):
        assert connect(client, token="ntk_wrong").status_code == 409
    braked = connect(client)
    assert braked.status_code == 429 and code(braked) == "slow_down"
    assert 1 <= int(braked.headers["retry-after"]) <= 61
    asked = len(fake.requests)
    assert connect(client).status_code == 429 and len(fake.requests) == asked
    # The other requests have a brake of their own; another account is not held by this one.
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        assert as_anna.put("/api/nextasks", json={"url": HOME, "token": GOOD}).status_code == 200
        for _ in range(4):
            assert as_anna.get("/api/nextasks/lists").status_code == 200
        slowed = as_anna.get("/api/nextasks/lists")
        assert slowed.status_code == 429 and code(slowed) == "slow_down" and "retry-after" in slowed.headers
        note = new_note(as_anna, markdown="x")
        assert code(send(as_anna, note["id"], ["x"])) == "slow_down"
    assert fake.tasks == {}


def test_notes19_at_most_two_requests_of_an_account_run_at_once(client, operator, fake):
    connected(client)
    note = new_note(client, markdown="x")
    asked = len(fake.requests)
    with nextasks.outgoing(operator.id), nextasks.outgoing(operator.id):
        busy = client.get("/api/nextasks/lists")
        assert busy.status_code == 429 and code(busy) == "nextasks_busy" and busy.headers["retry-after"] == "2"
        assert code(send(client, note["id"], ["x"])) == "nextasks_busy"
        assert len(fake.requests) == asked
        # Another account has its own two.
        with nextasks.outgoing(operator.id + 1000):
            pass
    assert client.get("/api/nextasks/lists").status_code == 200
    # A request that fails gives its place back.
    fake.down = True
    for _ in range(3):
        assert code(client.get("/api/nextasks/lists")) == "nextasks_unreachable"
