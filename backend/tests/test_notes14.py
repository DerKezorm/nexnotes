"""NOTES-14 Mitteilungen: notifications about changes of shared notes and folders, bundled, to browsers (Web Push)
and to the iOS app (push relay).

Three accounts throughout: the operator ``tester`` owns, Anna and Lena are members it shares with. The clock is the
history's (``history.clock``), set by hand; nothing goes into the network: the push services and the relay are
recorders (``webpush.POST``, ``apppush.POST``). Changes go through the note store as an editor's do
(``notes.change`` with the writer's account).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import http_ece
import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, ApiToken, Note, Setting
from app.models_notify import NotifyOutbox, NotifyWatch, PushDevice, WebPushSubscription
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.security import decrypt_secret
from app.services import accounts, apitokens, apppush, history, notes, notify, push_crypto, tags, webpush

from .conftest import make_account, new_client
from .test_notes13 import make_folder, share, unshare

START = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)


# --- Stand-ins for the push services and the relay -----------------------------------------------------------------


class Recorder:
    """What would have gone to a push service or the relay; answers ``status`` (or raises ``error``)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object, dict]] = []
        self.status = 201
        self.error: Exception | None = None

    def web(self, url: str, body: bytes, headers: dict[str, str]) -> int:
        self.calls.append((url, body, headers))
        if self.error is not None:
            raise self.error
        return self.status

    def app(self, url: str, body: dict[str, object]) -> int:
        self.calls.append((url, body, {}))
        if self.error is not None:
            raise self.error
        return self.status


@pytest.fixture
def pushed(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()
    monkeypatch.setattr(webpush, "POST", recorder.web)
    return recorder


@pytest.fixture
def relayed(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()
    recorder.status = 200
    monkeypatch.setattr(apppush, "POST", recorder.app)
    return recorder


@pytest.fixture(autouse=True)
def set_clock() -> Iterator[None]:
    history.clock.set(START)
    notify.forget_viewing()
    yield
    history.clock.reset()
    notify.forget_viewing()


@pytest.fixture
def anna() -> Account:
    return make_account("anna")


@pytest.fixture
def lena() -> Account:
    return make_account("lena")


@pytest.fixture
def as_anna(anna: Account) -> Iterator[TestClient]:
    with new_client(anna) as client:
        yield client


@pytest.fixture
def as_lena(lena: Account) -> Iterator[TestClient]:
    with new_client(lena) as client:
        yield client


class Browser:
    """A browser's push subscription: its keys, to read what arrives."""

    count = 0

    def __init__(self) -> None:
        Browser.count += 1
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = f"https://push.example.com/send/{Browser.count}"

    def body(self) -> dict:
        point = self.key.public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)
        return {"endpoint": self.endpoint, "keys": {"p256dh": webpush.b64url(point), "auth": webpush.b64url(self.auth)}}

    def read(self, sealed: bytes) -> dict:
        return json.loads(http_ece.decrypt(sealed, private_key=self.key, auth_secret=self.auth, version="aes128gcm"))


def allow(client: TestClient) -> Browser:
    browser = Browser()
    answer = client.put("/api/notify/webpush", json=browser.body())
    assert answer.status_code == 204, answer.text
    return browser


def german(account: Account) -> None:
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        row.language = "de"
        db.commit()


def shopping(client: TestClient, title: str = "Einkauf Samstag", folder_id: str | None = None) -> str:
    body: dict = {"title": title, "markdown": "- [ ] Milch\n- [ ] Tomaten"}
    if folder_id:
        body["folder_id"] = folder_id
    answer = client.post("/api/notes", json=body)
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def change(note_id: str, account: Account | None, editing) -> None:
    asyncio.run(notes.change(note_id, editing, account_id=account.id if account is not None else None))


def add(note_id: str, account: Account | None, *texts: str) -> None:
    def editing(doc):
        for text in texts:
            edit.append_task(doc, text)

    change(note_id, account, editing)


def tick_after(**delta: float) -> tuple[int, int]:
    history.clock.advance(**delta)
    return notify.tick()


def switch(client: TestClient, kind: str, item_id: str, on: bool = True) -> dict:
    answer = client.put(f"/api/notify/{kind}/{item_id}", json={"on": on})
    assert answer.status_code == 200, answer.text
    return answer.json()


def shared_note(client: TestClient, anna: Account, level: str = "write") -> str:
    note_id = shopping(client)
    share(client, "note", note_id, anna, level)
    return note_id


# --- AC-1: off from the start, per note or folder, a folder for everything below --------------------------------------


def test_notes14_ac1_off_from_the_start_and_on_per_note_or_folder_with_everything_below(client, operator, anna,
                                                                                       as_anna):
    note_id = shared_note(client, anna)
    for who in (client, as_anna):
        state = who.get(f"/api/notify/note/{note_id}").json()
        assert state["on"] is False and state["shared"] is True
    assert switch(as_anna, "note", note_id)["on"] is True
    assert client.get(f"/api/notify/note/{note_id}").json()["on"] is False
    assert as_anna.get(f"/api/notes/{note_id}").json()["notify"] is True

    # A folder: the switch holds for every note and folder below it.
    top = make_folder(client, "Haushalt")
    below = make_folder(client, "Einkauf", top)
    deep = shopping(client, "Wochenmarkt", below)
    share(client, "folder", top, anna, "write")
    assert as_anna.get(f"/api/notify/note/{deep}").json()["on"] is False
    switch(as_anna, "folder", top)
    state = as_anna.get(f"/api/notify/note/{deep}").json()
    assert state["on"] is True and state["via"] == {"id": top, "name": "Haushalt"}
    assert as_anna.get(f"/api/notify/folder/{below}").json()["on"] is True
    # One note off inside the folder that is on; and on again without a row of its own.
    assert switch(as_anna, "note", deep, False)["on"] is False
    assert switch(as_anna, "note", deep, True)["on"] is True
    with SessionLocal() as db:
        assert db.scalar(select(NotifyWatch).where(NotifyWatch.note_id == deep)) is None

    # Nothing to switch on what is not shared, and nothing at all of what one may not see.
    alone = shopping(client, "Nur meins")
    assert client.put(f"/api/notify/note/{alone}", json={"on": True}).json()["detail"]["code"] == "notify_not_shared"
    assert as_anna.get(f"/api/notify/note/{alone}").status_code == 404
    assert as_anna.put(f"/api/notify/folder/{make_folder(client, 'Privat')}", json={"on": True}).status_code == 404


def test_notes14_ac1_a_folder_switch_brings_notifications_from_its_subfolders(client, operator, anna, as_anna, pushed):
    top = make_folder(client, "Haushalt")
    below = make_folder(client, "Einkauf", top)
    deep = shopping(client, "Wochenmarkt", below)
    share(client, "folder", top, anna, "write")
    switch(as_anna, "folder", top)
    browser = allow(as_anna)
    add(deep, operator, "Käse")
    assert tick_after(minutes=3) == (1, 1)
    assert browser.read(pushed.calls[0][1])["body"] == "+ Käse"


# --- AC-2: who, which note, what came or was ticked ------------------------------------------------------------------


def test_notes14_ac2_names_the_person_the_note_and_what_came_or_was_ticked(client, operator, anna, as_anna, pushed):
    german(operator)
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    browser = allow(client)
    add(note_id, anna, "Eier", "Butter")
    change(note_id, anna, lambda doc: edit.toggle_task(doc, 0, True))
    assert tick_after(minutes=3) == (1, 1)
    url, sealed, _headers = pushed.calls[0]
    assert url == browser.endpoint
    shown = browser.read(sealed)
    assert shown["title"] == "Anna in „Einkauf Samstag“"
    assert shown["body"] == "✓ Milch, + Eier, + Butter"
    assert shown["tag"] == f"note-{note_id}"
    # The first changed line is where the note opens (AC-5): "Milch" is the first line of the text.
    assert shown["url"] == f"/notes/{note_id}?change=0"


def test_notes14_ac2_lines_and_changes():
    before = [["Milch", False], ["Tomaten", False], ["", None]]
    after = [["Milch", True], ["Tomaten", False], ["Eier", False], ["Butter", False], ["Notiz", None]]
    found, first = notify.changes(before, after)
    assert found == [("✓", "Milch"), ("+", "Eier"), ("+", "Butter"), ("+", "Notiz")]
    assert first == 0
    assert notify.changes(after, after) == ([], None)
    # Unticking, removing and moving are no news.
    assert notify.changes(after, list(reversed(before))) == ([], None)
    doc = notedoc.new_doc("Titel", {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Obst"}]},
        {"type": "taskList", "content": [{"type": "taskItem", "attrs": {"checked": True}, "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Äpfel"}]}]}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "eins"}, {"type": "hardBreak"},
                                          {"type": "text", "text": "zwei"}]}]})
    assert notify.lines_of(doc) == [["Obst", None], ["Äpfel", True], ["eins zwei", None]]


# --- AC-3: bundled after two quiet minutes ---------------------------------------------------------------------------


def test_notes14_ac3_minutes_of_writing_make_one_notification_after_two_quiet_minutes(client, operator, anna, as_anna,
                                                                                       pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    browser = allow(client)
    for word in ("Eier", "Butter", "Mehl", "Zucker", "Salz"):
        add(note_id, anna, word)
        assert tick_after(seconds=90) == (0, 0)
    assert pushed.calls == []
    assert tick_after(seconds=29) == (0, 0)
    assert tick_after(seconds=2) == (1, 1)
    assert browser.read(pushed.calls[0][1])["body"] == "+ Eier, + Butter, + Mehl, + Zucker and 1 more"
    # Done: nothing more until somebody writes again.
    assert tick_after(minutes=10) == (0, 0)
    add(note_id, anna, "Hefe")
    assert tick_after(minutes=2) == (1, 1)
    assert browser.read(pushed.calls[1][1])["body"] == "+ Hefe"


def test_notes14_ac3_writing_without_a_pause_is_bundled_after_half_an_hour(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    allow(client)
    sent = 0
    for minute in range(31):
        add(note_id, anna, f"Zeile {minute}")
        sent += tick_after(minutes=1)[1]
    assert sent == 1


# --- AC-4: own changes tell nothing ------------------------------------------------------------------------------------


def test_notes14_ac4_own_changes_from_other_devices_and_mcp_keys_tell_nothing(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    switch(as_anna, "note", note_id)
    mine = allow(client)
    with new_client(operator) as laptop:
        allow(laptop)
        # The owner writes in the browser, from a second browser, and through an MCP key.
        add(note_id, operator, "Eier")
        with history.acting_via("mcp:Laptop"):
            add(note_id, operator, "Butter")
        annas = allow(as_anna)
        assert tick_after(minutes=3) == (1, 1)
        # Signing out takes this browser's notifications along.
        assert laptop.post("/api/auth/logout").status_code in (200, 204)
    assert [call[0] for call in pushed.calls] == [annas.endpoint]
    assert annas.read(pushed.calls[0][1])["title"] == "Tester in “Einkauf Samstag”"
    assert mine.endpoint not in [call[0] for call in pushed.calls]

    # Both write: each hears only of the other.
    pushed.calls.clear()
    add(note_id, operator, "Mehl")
    add(note_id, anna, "Zucker")
    assert tick_after(minutes=3)[1] == 2
    titles = {call[0]: annas.read(call[1])["title"] if call[0] == annas.endpoint else mine.read(call[1])["title"]
              for call in pushed.calls}
    assert titles[annas.endpoint] == "Tester in “Einkauf Samstag”"
    assert titles[mine.endpoint] == "Anna in “Einkauf Samstag”"


def test_notes14_ac4_changes_of_the_server_itself_tell_nobody(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    switch(as_anna, "note", note_id)
    allow(client)
    allow(as_anna)
    change(note_id, None, lambda doc: notedoc.set_title(doc, "Vorschlag"))
    assert tick_after(minutes=3) == (0, 0)


# --- AC-9: not to the browser that shows the note ---------------------------------------------------------------------


def test_notes14_ac9_no_notification_on_the_browser_that_shows_the_note(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    here = allow(client)
    with new_client(operator) as phone:
        there = allow(phone)
        add(note_id, anna, "Eier")
        history.clock.advance(minutes=3)
        # The page says it again every half minute while the note is in view.
        assert client.put("/api/notify/viewing", json={"note_id": note_id}).status_code == 204
        assert notify.tick() == (1, 1)
        assert [call[0] for call in pushed.calls] == [there.endpoint]

        # Another note in view, or none: this browser hears again.
        assert client.put("/api/notify/viewing", json={"note_id": None}).status_code == 204
        add(note_id, anna, "Butter")
        assert tick_after(minutes=3) == (2, 2)
        assert sorted(call[0] for call in pushed.calls[1:]) == sorted([here.endpoint, there.endpoint])

        # The word holds only while the page repeats it.
        client.put("/api/notify/viewing", json={"note_id": note_id})
        history.clock.advance(minutes=5)
        add(note_id, anna, "Mehl")
        assert tick_after(minutes=3) == (2, 2)


# --- AC-6, AC-7: only encrypted, to every browser that allowed it -------------------------------------------------------


def test_notes14_ac7_every_browser_that_allowed_it_and_only_encrypted_and_signed(client, operator, anna, as_anna,
                                                                                  pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    state = client.get("/api/notify/webpush").json()
    assert state["subscribed"] is False and len(webpush.unb64url(state["key"])) == 65
    browser = allow(client)
    assert client.get("/api/notify/webpush").json()["subscribed"] is True
    devices = client.get(f"/api/notify/note/{note_id}").json()["devices"]
    assert devices["this_browser"] is True and len(devices["browsers"]) == 1
    add(note_id, anna, "Geheimzutat")
    tick_after(minutes=3)
    _url, sealed, headers = pushed.calls[0]
    assert b"Geheimzutat" not in sealed and b"Anna" not in sealed
    assert headers["Content-Encoding"] == "aes128gcm" and headers["TTL"]
    assert headers["Authorization"].startswith("vapid t=") and f"k={state['key']}" in headers["Authorization"]
    assert browser.read(sealed)["body"] == "+ Geheimzutat"

    # Without permission nothing: a browser that stopped gets none.
    assert client.delete("/api/notify/webpush").status_code == 204
    add(note_id, anna, "Mehr")
    assert tick_after(minutes=3) == (0, 0)


def test_notes14_ac7_what_a_browser_brings_is_checked(client, operator):
    good = Browser().body()
    for endpoint in ("http://push.example.com/x", "https://localhost/x", "https://user:pw@push.example.com/x",
                     "https://box.local/x"):
        answer = client.put("/api/notify/webpush", json={**good, "endpoint": endpoint})
        assert answer.status_code == 422, endpoint
    answer = client.put("/api/notify/webpush", json={**good, "keys": {"p256dh": "AAAA", "auth": "AAAA"}})
    assert answer.json()["detail"]["code"] == "webpush_keys"
    # Never a push into the own network, whatever a browser names.
    with SessionLocal() as db:
        row = WebPushSubscription(account_id=operator.id, session_id=0, endpoint="https://127.0.0.1/x",
                                  p256dh=good["keys"]["p256dh"], auth=good["keys"]["auth"])
        with pytest.raises(webpush.Failed) as refused:
            webpush.deliver(db, row, b"{}")
    assert refused.value.code == "refused"
    # A token (a device, a program) cannot sign a browser up.
    with SessionLocal() as db:
        _row, token = apitokens.make(db, db.get(Account, operator.id), "Skript")
    with new_client() as program:
        program.headers["Authorization"] = f"Bearer {token}"
        assert program.put("/api/notify/webpush", json=good).status_code == 403


def test_notes14_ac7_the_vapid_key_is_made_at_the_start_and_kept_sealed(client):
    with SessionLocal() as db:
        stored = db.get(Setting, webpush.KEY_SETTING)
        assert stored is not None
        value = str(stored.value)
        assert "PRIVATE KEY" not in value
        assert "PRIVATE KEY" in decrypt_secret(value, webpush.KEY_CONTEXT)
        first = webpush.public_key(db)
    # The same pair at the next start.
    with new_client() as again:
        assert again.get("/api/health").status_code in (200, 503)
    with SessionLocal() as db:
        assert webpush.public_key(db) == first


def test_notes14_ac6_the_relay_gets_only_what_is_encrypted_for_the_device(client, operator, anna, as_anna, relayed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    device = X25519PrivateKey.generate()
    public = base64.b64encode(device.public_key().public_bytes(serialization.Encoding.Raw,
                                                               serialization.PublicFormat.Raw)).decode()
    private = base64.b64encode(device.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                                    serialization.NoEncryption())).decode()
    with SessionLocal() as db:
        row, _token = apitokens.make(db, db.get(Account, operator.id), "iPhone von Tester")
        apppush.remember(db, operator.id, row.id, "1.ticket", public)
    assert client.get(f"/api/notify/note/{note_id}").json()["devices"]["apps"][0]["name"] == "iPhone von Tester"
    add(note_id, anna, "Eier")
    assert tick_after(minutes=3) == (1, 1)
    url, body, _ = relayed.calls[0]
    assert url == "https://push.nexapps.dev/v1/send"
    assert set(body) == {"ticket", "enc", "collapse"} and body["ticket"] == "1.ticket"
    assert "Eier" not in json.dumps(body) and "Anna" not in json.dumps(body)
    shown = json.loads(push_crypto.decrypt(body["enc"], private))
    assert shown == {"title": "Anna in “Einkauf Samstag”", "text": "+ Eier", "note_id": note_id, "at": 2,
                     "type": "changed", "account": operator.id, "server": apppush.server_id(), "who": "Anna",
                     "note": "Einkauf Samstag", "anchor": {"block": 2, "text": "Eier"}, "locked": False}


# --- EC-1: a locked note tells no content --------------------------------------------------------------------------------


def test_notes14_ec1_a_locked_note_says_only_that_it_was_changed(client, operator, anna, as_anna, pushed,
                                                                 monkeypatch):
    german(operator)
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    browser = allow(client)
    add(note_id, anna, "Geheimnis")
    # Locked meanwhile (NOTES-16 locks only what is not shared; the owner ended the share and locked it).
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id == note_id])
    assert tick_after(minutes=3) == (1, 1)
    sealed = pushed.calls[0][1]
    shown = browser.read(sealed)
    assert shown["body"] == "wurde geändert"
    assert "Geheimnis" not in json.dumps(shown) and "change=" not in shown["url"]


# --- EC-2: the relay out of reach ----------------------------------------------------------------------------------------


def test_notes14_ec2_the_relay_out_of_reach_is_tried_again_for_a_while_and_logged(client, operator, anna, as_anna,
                                                                                  relayed, pushed, caplog):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    browser = allow(client)
    device = X25519PrivateKey.generate().public_key().public_bytes(serialization.Encoding.Raw,
                                                                   serialization.PublicFormat.Raw)
    with SessionLocal() as db:
        row, _token = apitokens.make(db, db.get(Account, operator.id), "iPhone")
        apppush.remember(db, operator.id, row.id, "1.ticket", base64.b64encode(device).decode())
    relayed.error = httpx.ConnectError("down")
    add(note_id, anna, "Eier")
    with caplog.at_level(logging.WARNING, logger="nexnotes.notify"):
        assert tick_after(minutes=3) == (2, 1)
    # The browser got it all the same; the relay's message waits.
    assert [call[0] for call in pushed.calls] == [browser.endpoint]
    assert "tried again later channel=app" in caplog.text and "1.ticket" not in caplog.text
    assert len(relayed.calls) == 1
    assert tick_after(seconds=30) == (0, 0) and len(relayed.calls) == 1
    assert tick_after(seconds=31) == (0, 0) and len(relayed.calls) == 2
    relayed.error = None
    assert tick_after(minutes=5) == (0, 1) and len(relayed.calls) == 3
    # Out of reach for good: given up after the last try, said in the log.
    relayed.error = httpx.ConnectError("down")
    add(note_id, anna, "Butter")
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="nexnotes.notify"):
        for _ in range(8):
            tick_after(minutes=61)
    assert "Notification given up channel=app" in caplog.text
    with SessionLocal() as db:
        rows = list(db.scalars(select(NotifyOutbox).where(NotifyOutbox.channel == "app")))
        assert [row.payload for row in rows] == [{}, {}]
        assert rows[-1].failed_at is not None and rows[-1].attempts == len(notify.RETRY_MINUTES) + 1


# --- EC-4: a device gone, a ticket gone ---------------------------------------------------------------------------------


def test_notes14_ec4_a_gone_ticket_or_browser_is_dropped_and_a_disconnected_device_hears_nothing(
        client, operator, anna, as_anna, relayed, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    key = base64.b64encode(X25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    with SessionLocal() as db:
        account = db.get(Account, operator.id)
        first, _one = apitokens.make(db, account, "iPhone")
        second, _two = apitokens.make(db, account, "iPad")
        apppush.remember(db, operator.id, first.id, "1.gone", key)
        apppush.remember(db, operator.id, second.id, "1.ipad", key)
        # Disconnecting a device takes its ticket along.
        db.delete(db.get(ApiToken, second.id))
        db.commit()
        assert db.get(PushDevice, second.id) is None
    allow(client)
    relayed.status = 410
    pushed.status = 410
    add(note_id, anna, "Eier")
    assert tick_after(minutes=3) == (2, 0)
    assert [call[1]["ticket"] for call in relayed.calls] == ["1.gone"]
    with SessionLocal() as db:
        assert db.get(PushDevice, first.id) is None
        assert db.scalar(select(WebPushSubscription)) is None
    add(note_id, anna, "Butter")
    assert tick_after(minutes=3) == (0, 0)
    assert len(relayed.calls) == 1


# --- EC-5: the right taken --------------------------------------------------------------------------------------------------


def test_notes14_ec5_no_notification_once_the_right_was_taken(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna, "read")
    switch(as_anna, "note", note_id)
    annas = allow(as_anna)
    add(note_id, operator, "Eier")
    assert tick_after(minutes=3) == (1, 1)
    # Taken while changes wait to be bundled: nothing of them either.
    add(note_id, operator, "Butter")
    unshare(client, "note", note_id, anna)
    assert tick_after(minutes=3) == (0, 0)
    add(note_id, operator, "Mehl")
    assert tick_after(minutes=3) == (0, 0)
    assert [call[0] for call in pushed.calls] == [annas.endpoint]


# --- EC-6: many people, many changes ---------------------------------------------------------------------------------------


def test_notes14_ec6_many_changes_of_several_people_name_all_and_cut_the_text(client, operator, anna, lena, as_anna,
                                                                              as_lena, pushed):
    german(operator)
    note_id = shared_note(client, anna)
    share(client, "note", note_id, lena, "write")
    switch(client, "note", note_id)
    browser = allow(client)
    add(note_id, anna, *[f"Sache {number}" for number in range(6)])
    add(note_id, lena, *[f"Ding {number}" for number in range(6)])
    add(note_id, anna, "Ein sehr langer Eintrag, der so lang ist, dass er nicht ganz in eine Mitteilung passt")
    assert tick_after(minutes=3) == (1, 1)
    shown = browser.read(pushed.calls[0][1])
    assert shown["title"] == "Anna und Lena in „Einkauf Samstag“"
    assert shown["body"] == "+ Sache 0, + Sache 1, + Sache 2, + Sache 3 und 9 weitere"
    long = notify.summary([("+", "x" * 300)], "de")
    assert len(long) <= notify.ITEM_CHARS + 2 and long.endswith("…")


# --- EC-7: into the trash ---------------------------------------------------------------------------------------------------


def test_notes14_ec7_a_note_put_in_the_trash_says_who_did_it(client, operator, anna, as_anna, pushed):
    german(operator)
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    browser = allow(client)
    assert as_anna.delete(f"/api/notes/{note_id}").status_code in (200, 204)
    assert tick_after(minutes=3) == (1, 1)
    shown = browser.read(pushed.calls[0][1])
    assert shown["body"] == "Anna hat „Einkauf Samstag“ in den Papierkorb gelegt"
    assert shown["url"] == "/trash"

    # Taken back right after ("Rückgängig"): nobody hears of it.
    assert as_anna.post(f"/api/notes/{note_id}/restore").status_code == 200
    as_anna.delete(f"/api/notes/{note_id}")
    as_anna.post(f"/api/notes/{note_id}/restore")
    assert tick_after(minutes=3) == (0, 0)


# --- Push subscriptions belong to the account ---------------------------------------------------------------------------


def test_notes14_browsers_and_devices_end_with_sign_out_block_and_delete(client, operator, anna, lena, as_anna,
                                                                         as_lena, pushed):
    allow(as_anna)
    with new_client(anna) as second:
        allow(second)
        assert second.post("/api/auth/logout").status_code in (200, 204)
    allow(as_lena)
    key = base64.b64encode(X25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    with SessionLocal() as db:
        row, _token = apitokens.make(db, db.get(Account, lena.id), "iPhone")
        apppush.remember(db, lena.id, row.id, "1.lena", key)

        def rows(account_id: int) -> int:
            return len(db.scalars(select(WebPushSubscription).where(
                WebPushSubscription.account_id == account_id)).all())

        # Signing out takes that browser along, not the other.
        assert rows(anna.id) == 1
        accounts.block(db, db.get(Account, anna.id))
        assert rows(anna.id) == 0
        accounts.delete_account(db, db.get(Account, lena.id))
        db.expire_all()
        assert rows(lena.id) == 0 and db.scalar(select(PushDevice)) is None


def test_notes14_the_head_of_the_note_says_whether_the_bell_is_on(client, operator, anna, as_anna):
    note_id = shared_note(client, anna)
    assert client.get(f"/api/notes/{note_id}").json()["notify"] is False
    switch(client, "note", note_id)
    assert client.get(f"/api/notes/{note_id}").json()["notify"] is True
    preview = client.get(f"/api/notify/note/{note_id}").json()["preview"]
    assert preview == {"title": "Anna in “Einkauf Samstag”", "text": "+ Eggs, + Butter"}
    german(operator)
    preview = client.get(f"/api/notify/note/{note_id}").json()["preview"]
    assert preview == {"title": "Anna in „Einkauf Samstag“", "text": "+ Eier, + Butter"}


def test_notes14_sent_messages_keep_no_text(client, operator, anna, as_anna, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    allow(client)
    add(note_id, anna, "Eier")
    tick_after(minutes=3)
    with SessionLocal() as db:
        row = db.scalar(select(NotifyOutbox))
        assert row is not None and row.sent_at is not None and row.payload == {}
    notify.tidy(history.clock.now() + timedelta(days=8))
    with SessionLocal() as db:
        assert db.scalar(select(NotifyOutbox)) is None


# --- Before every try: the right and the lock again (EC-5, EC-1) -------------------------------------------------------


def test_notes14_ec5_a_message_tried_again_after_a_failure_asks_the_right_again(client, operator, anna, as_anna,
                                                                               pushed):
    note_id = shared_note(client, anna, "read")
    switch(as_anna, "note", note_id)
    allow(as_anna)
    pushed.error = httpx.ConnectError("down")
    add(note_id, operator, "Eier")
    assert tick_after(minutes=3) == (1, 0)
    # The right goes between the bundle and the next try: the message goes nowhere, its text is dropped.
    unshare(client, "note", note_id, anna)
    pushed.error = None
    assert tick_after(minutes=2) == (0, 0)
    assert len(pushed.calls) == 1
    with SessionLocal() as db:
        row = db.scalar(select(NotifyOutbox))
        assert row is not None and row.failed_at is not None and row.last_error == "no_right" and row.payload == {}


def test_notes14_ec1_a_message_tried_again_after_the_note_was_locked_tells_nothing(client, operator, anna, as_anna,
                                                                                  pushed, monkeypatch):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    allow(client)
    pushed.error = httpx.ConnectError("down")
    add(note_id, anna, "Geheimnis")
    assert tick_after(minutes=3) == (1, 0)
    # Locked meanwhile (NOTES-16): the message with content does not go on the next try.
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id == note_id])
    pushed.error = None
    assert tick_after(minutes=2) == (0, 0)
    assert len(pushed.calls) == 1
    with SessionLocal() as db:
        row = db.scalar(select(NotifyOutbox))
        assert row is not None and row.last_error == "locked" and row.payload == {}


# --- AC-6: no note id for the relay and the push service ------------------------------------------------------------


def test_notes14_ac6_the_relay_and_the_push_service_get_a_keyed_mark_instead_of_the_note_id(
        client, operator, anna, as_anna, relayed, pushed):
    note_id = shared_note(client, anna)
    switch(client, "note", note_id)
    allow(client)
    with SessionLocal() as db:
        row, _token = apitokens.make(db, db.get(Account, operator.id), "iPhone")
        public = X25519PrivateKey.generate().public_key().public_bytes(serialization.Encoding.Raw,
                                                                       serialization.PublicFormat.Raw)
        apppush.remember(db, operator.id, row.id, "1.ticket", base64.b64encode(public).decode())
    add(note_id, anna, "Eier")
    assert tick_after(minutes=3) == (2, 2)
    _url, body, _ = relayed.calls[0]
    _endpoint, _sealed, headers = pushed.calls[0]
    compact = note_id.replace("-", "")
    for seen in (body["collapse"], headers["Topic"]):
        assert note_id not in seen and compact[:12] not in seen
    # The same mark for the same note (a newer message replaces the older), another for another note.
    assert body["collapse"] == headers["Topic"] == notify.opaque(note_id)
    assert len(headers["Topic"]) <= 32 and notify.opaque(note_id) != notify.opaque(shopping(client))


# --- The page Notifications (plan "Einstellungen", E57) --------------------------------------------------------------


def test_e57_the_page_lists_the_browsers_removes_another_and_sends_a_test(
    as_anna: TestClient, anna: Account, pushed: Recorder
) -> None:
    """``GET /api/notify/devices``: the account's browsers with this one marked (and since when); ``DELETE
    /api/notify/webpush/{id}``: another browser of the account gets nothing any more, another account's stays out of
    reach; ``POST /api/notify/webpush/test``: one notification to this browser, in the account's language."""
    with new_client(anna) as other:
        allow(other)
    german(anna)
    here = allow(as_anna)
    listed = as_anna.get("/api/notify/devices").json()
    mine = [entry for entry in listed["browsers"] if entry["this"]]
    others = [entry for entry in listed["browsers"] if not entry["this"]]
    assert len(mine) == 1 and len(others) == 1 and listed["this_browser"] is True
    assert mine[0]["since"] and mine[0]["last_ok_at"] is None

    answer = as_anna.post("/api/notify/webpush/test")
    assert answer.status_code == 204, answer.text
    assert len(pushed.calls) == 1 and pushed.calls[0][0] == here.endpoint
    arrived = here.read(pushed.calls[0][1])
    assert arrived["title"] == "Probemeldung von nexnotes" and arrived["url"] == "/settings/notifications"
    assert as_anna.get("/api/notify/devices").json()["browsers"][-1]["last_ok_at"]

    lena = make_account("lena-e57")
    with new_client(lena) as stranger:
        assert stranger.delete(f"/api/notify/webpush/{others[0]['id']}").status_code == 404
    assert as_anna.delete(f"/api/notify/webpush/{others[0]['id']}").status_code == 204
    assert [entry["this"] for entry in as_anna.get("/api/notify/devices").json()["browsers"]] == [True]

    pushed.status = 410
    gone = as_anna.post("/api/notify/webpush/test")
    assert gone.status_code == 409 and gone.json()["detail"]["code"] == "webpush_off"
    assert as_anna.get("/api/notify/webpush").json()["subscribed"] is False
