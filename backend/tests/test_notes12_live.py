"""NOTES-12 Gleichzeitig bearbeiten over the real endpoint ``WS /api/notes/{id}/live`` with the database store.

The room itself is tested on its own in ``tests/notedoc``; here the app around it: sessions, rights, deleting, the
store in SQLite, "changed by".
"""

from __future__ import annotations

import random
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from pycrdt import Text, XmlElement, XmlFragment, XmlText

from app.db import SessionLocal
from app.models import Account, Note
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.notedoc.room import Access
from app.security import SESSION_COOKIE, end_session
from app.services import accounts, notes

from .conftest import make_account
from .notes_live import Live, refused
from .test_notes3 import new_note, stored, stored_doc, token_for, wait_for


@pytest.fixture(autouse=True)
def close_connections(client):
    """Connections left open by a failing test are closed before the test client goes."""
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


@pytest.fixture
def shared_with(monkeypatch: pytest.MonkeyPatch):
    """Stands in for sharing (NOTES-13): the accounts given here may write every note."""
    writers: dict[int, Access] = {}

    def rule(_db, account, _note):
        return writers.get(account.id)

    monkeypatch.setattr(notes, "ACCESS_RULES", [rule])
    return writers


def _connected(*lives: Live) -> None:
    for live in lives:
        assert live.pump(lambda live=live: live.synced), "not synced"


def _paragraphs(live: Live) -> list[XmlElement]:
    return [child for child in live.doc.get("body", type=XmlFragment).children
            if isinstance(child, XmlElement) and child.tag == "paragraph"]


@pytest.mark.timing
def test_notes12_ac1_what_one_window_types_shows_in_the_other_within_a_second(client, operator):
    note = new_note(client, markdown="hello")
    laptop = Live(client, note["id"], token_for(operator))
    tablet = Live(client, note["id"], token_for(operator))
    _connected(laptop, tablet)
    started = time.perf_counter()
    edit.append_paragraph(laptop.doc, "from the laptop")
    assert tablet.pump(lambda: "from the laptop" in tablet.text, timeout=1.0)
    assert time.perf_counter() - started < 1.0
    laptop.close()
    tablet.close()


def _type_somewhere(rng: random.Random, live: Live, token: str) -> bool:
    """Types ``token`` into a random paragraph, checklist item or table cell."""
    runs = []

    def walk(node):
        for child in node.children:
            if isinstance(child, XmlText):
                runs.append(child)
            elif isinstance(child, XmlElement):
                walk(child)

    walk(live.doc.get("body", type=XmlFragment))
    if not runs:
        return False
    run = rng.choice(runs)
    current = str(run)
    # Between words only, so that a token never lands inside another one.
    at = rng.choice([0, len(current), *[i for i, char in enumerate(current) if char == " "]])
    # pycrdt counts UTF-8 bytes; the tokens and the seed text are ASCII.
    run.insert(at, f" {token} ")
    return True


def test_notes12_ac2_ac3_ac4_ac7_ec1_ec3_three_sessions_one_dropping_out_end_alike(client, operator):
    """Random changes from three sessions at once, one of them losing its connection again and again: in the end every
    session, the room and the database hold the same note, and no typed word is lost unless its paragraph was deleted
    by someone who had seen it."""
    rng = random.Random(1234)
    note = new_note(client, markdown="first paragraph\n\nsecond paragraph\n\n- [ ] milk\n- [ ] bread\n- [ ] eggs\n\n"
                                     "| a | b |\n|---|---|\n| c | d |\n\nlast paragraph")
    sessions = [Live(client, note["id"], token_for(operator)) for _ in range(3)]
    _connected(*sessions)
    typed: set[str] = set()
    removed: set[str] = set()
    ticked: set[int] = set()
    counter = 0
    for step in range(90):
        live = rng.choice(sessions)
        if live is sessions[2] and step % 15 == 7:
            # The train goes into a tunnel: the connection breaks, typing goes on offline (EC-3, AC-4).
            if live.connected:
                live.disconnect()
            else:
                live.connect()
            continue
        action = rng.random()
        if action < 0.55:
            counter += 1
            token = f"w{counter:03d}"
            if _type_somewhere(rng, live, token):
                typed.add(token)
        elif action < 0.7:
            counter += 1
            token = f"w{counter:03d}"
            edit.append_paragraph(live.doc, token)
            typed.add(token)
        elif action < 0.85:
            tasks = edit.list_tasks(live.doc)
            if tasks:
                index = rng.randrange(len(tasks))
                edit.toggle_task(live.doc, index, True)  # AC-7: ticking, never unticking
                ticked.add(index)
        else:
            paragraphs = _paragraphs(live)
            if len(paragraphs) > 2:
                gone = rng.choice(paragraphs)
                removed.update(word for word in str(gone).replace("<", " ").replace(">", " ").split()
                               if word.startswith("w") and word[1:].isdigit())
                body = live.doc.get("body", type=XmlFragment)
                index = list(body.children).index(gone)
                del body.children[index]
        for other in sessions:
            if other.connected:
                other.pump(timeout=0.01)
    if not sessions[2].connected:
        sessions[2].connect()
    for live in sessions:
        live.settle(0.4)
    for live in sessions:
        live.settle(0.2)
    texts = {to_plain(live.doc) for live in sessions}
    room_text = stored_text = None
    assert len(texts) == 1, texts
    final = texts.pop()
    for live in sessions:
        live.close()
    stored_text = to_plain(stored_doc(note["id"]))
    room_text = stored(note["id"]).text
    assert stored_text == final == room_text
    lost = sorted(token for token in typed - removed if token not in final)
    assert lost == [], (lost, final)
    # Every tick from any session is there (AC-7): nobody unticks, and no item goes.
    assert ticked
    assert {i for i, task in enumerate(edit.list_tasks(stored_doc(note["id"]))) if task.checked} == ticked


def test_notes12_ac7_two_people_tick_different_items_and_both_stay_ticked(client, operator, shared_with):
    other = make_account("other")
    shared_with[other.id] = Access.WRITE
    note = new_note(client, markdown="- [ ] milk\n- [ ] bread")
    mine = Live(client, note["id"], token_for(operator))
    theirs = Live(client, note["id"], token_for(other))
    _connected(mine, theirs)
    edit.toggle_task(mine.doc, 0, True)
    edit.toggle_task(theirs.doc, 1, True)
    for live in (mine, theirs, mine, theirs):
        live.settle(0.2)
    for live in (mine, theirs):
        assert [task.checked for task in edit.list_tasks(live.doc)] == [True, True]
    mine.close()
    theirs.close()
    assert [task.checked for task in edit.list_tasks(stored_doc(note["id"]))] == [True, True]


def test_notes12_ac9_changed_by_names_who_wrote_last(client, operator, shared_with):
    other = make_account("anna")
    shared_with[other.id] = Access.WRITE
    note = new_note(client, title="Shopping")
    theirs = Live(client, note["id"], token_for(other))
    _connected(theirs)
    edit.append_paragraph(theirs.doc, "Milk")
    assert wait_for(lambda: stored(note["id"]).updated_by_id == other.id)
    head = client.get(f"/api/notes/{note['id']}").json()
    assert head["updated_by"] == {"id": other.id, "name": "Anna"}
    theirs.close()
    # A change of the server (a suggested title) is nobody's change.
    with SessionLocal() as db:
        db.get(Note, note["id"]).title = ""
        db.commit()
    client.post(f"/api/notes/{note['id']}/title/suggestion", json={"title": "Weekend"})
    assert client.get(f"/api/notes/{note['id']}").json()["updated_by"]["id"] == other.id


def test_notes12_ec2_a_note_deleted_while_open_closes_with_gone_and_can_come_back(client, operator):
    note = new_note(client, markdown="open in two windows")
    window = Live(client, note["id"], token_for(operator))
    _connected(window)
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert window.pump(lambda: window.closed is not None)
    assert window.closed == 4404
    assert refused(client, note["id"], token_for(operator)) == 4404
    # The owner may take it back out of the trash, and write again.
    client.post(f"/api/notes/{note['id']}/restore")
    again = Live(client, note["id"], token_for(operator))
    _connected(again)
    assert again.text == "open in two windows"
    again.close()


@contextmanager
def _real_server() -> Iterator[int]:
    """The app under uvicorn on a free port, as in the container: the test client's WebSocket forgives what a real
    server answers with HTTP 403 (a close before ``accept()``)."""
    import uvicorn

    from app.main import app

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        while not server.started:
            assert time.monotonic() < deadline, "the server did not start"
            time.sleep(0.02)
        yield port
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()


def _close_code(port: int, note_id: str, token: str | None) -> int:
    """What a browser learns when the room will not have it: the close code of the connection."""
    from websockets.exceptions import ConnectionClosed, InvalidStatus
    from websockets.sync.client import connect

    headers = {"Cookie": f"{SESSION_COOKIE}={token}"} if token else {}
    try:
        with connect(f"ws://127.0.0.1:{port}/api/notes/{note_id}/live", additional_headers=headers,
                     origin=f"http://127.0.0.1:{port}", open_timeout=5) as ws:
            try:
                ws.recv(timeout=5)
            except ConnectionClosed as closed:
                return closed.rcvd.code if closed.rcvd else 1006
            return 0
    except InvalidStatus as refused_status:
        raise AssertionError(f"handshake refused with HTTP {refused_status.response.status_code}: "
                             "a browser sees 1006 and reconnects for ever") from refused_status


def test_notes12_ec2_ec5_a_real_server_closes_with_the_room_s_code_not_before_the_handshake(client, operator):
    """NOTES-12 EC-2, EC-5 against uvicorn: a deleted note says 4404, no session or no right 4403, never HTTP 403."""
    gone = new_note(client, markdown="in the trash")
    assert client.delete(f"/api/notes/{gone['id']}").status_code == 204
    other = make_account("other")
    mine = new_note(client, markdown="only mine")
    with _real_server() as port:
        assert _close_code(port, gone["id"], token_for(operator)) == 4404
        assert _close_code(port, mine["id"], None) == 4403
        assert _close_code(port, mine["id"], token_for(other)) == 4403
        assert _close_code(port, "no-such-note", token_for(operator)) == 4403
        # A note that may be written: the room speaks first (its sync step 1), nothing is closed.
        assert _close_code(port, mine["id"], token_for(operator)) == 0


def test_notes12_ec5_a_right_taken_while_writing_ends_the_connection_and_nothing_more_is_stored(
        client, operator, shared_with):
    other = make_account("other")
    shared_with[other.id] = Access.WRITE
    note = new_note(client, markdown="shared")
    theirs = Live(client, note["id"], token_for(other))
    _connected(theirs)
    del shared_with[other.id]
    notes.nudge_all()  # what sharing does when it takes a right
    edit.append_paragraph(theirs.doc, "too late")
    assert theirs.pump(lambda: theirs.closed is not None)
    assert theirs.closed == 4403
    time.sleep(0.3)
    assert "too late" not in to_plain(stored_doc(note["id"]))
    # Write became read: the connection starts again as a reader.
    shared_with[other.id] = Access.READ
    reader = Live(client, note["id"], token_for(other))
    _connected(reader)
    edit.append_paragraph(reader.doc, "a reader cannot write")
    reader.settle(0.3)
    assert "a reader cannot write" not in to_plain(stored_doc(note["id"]))
    reader.close()


def test_notes12_ec5_signing_out_blocking_or_deleting_the_account_ends_live_connections(client, operator):
    member = make_account("member")
    note_answer = None
    from .conftest import new_client

    theirs_client = new_client(member)
    note_answer = theirs_client.post("/api/notes", json={"title": "Mine"}).json()
    token = token_for(member)
    live = Live(client, note_answer["id"], token)
    _connected(live)
    with SessionLocal() as db:
        end_session(db, token)
    assert live.pump(lambda: live.closed is not None)
    assert live.closed == 4403
    for act in (accounts.block, accounts.delete_account):
        with SessionLocal() as db:
            row = db.get(Account, member.id)
            row.blocked_at = None
            row.deleted_at = None
            db.commit()
        token = token_for(member)
        live = Live(client, note_answer["id"], token)
        _connected(live)
        with SessionLocal() as db:
            act(db, db.get(Account, member.id))
        assert live.pump(lambda live=live: live.closed is not None)
        assert live.closed == 4403


def test_notes12_ec7_a_stopping_server_tells_every_browser_to_come_back(client, operator):
    note = new_note(client, markdown="before the restart")
    live = Live(client, note["id"], token_for(operator))
    _connected(live)
    edit.append_paragraph(live.doc, "typed just before")
    live.settle(0.2)
    client.portal.call(notes.shutdown)
    assert live.pump(lambda: live.closed is not None)
    assert live.closed == 1012
    # Nothing lost: the room folded on the way out, and a new connection reads it all.
    assert "typed just before" in stored(note["id"]).text
    again = Live(client, note["id"], token_for(operator))
    _connected(again)
    assert "typed just before" in again.text
    again.close()


def test_notes12_ec8_two_windows_of_one_person_are_two_connections_of_one_account(client, operator):
    note = new_note(client, title="Mine")
    first = Live(client, note["id"], token_for(operator))
    second = Live(client, note["id"], token_for(operator))
    _connected(first, second)
    room = client.portal.call(_room_of, note["id"])
    assert [peer.account_id for peer in room.peers] == [operator.id, operator.id]
    first.close()
    second.close()


async def _room_of(note_id: str):
    return notes.rooms().room_of(note_id)


def test_notes12_the_title_is_written_together_like_the_text(client, operator):
    note = new_note(client)
    one = Live(client, note["id"], token_for(operator))
    two = Live(client, note["id"], token_for(operator))
    _connected(one, two)
    one.doc.get("title", type=Text).insert(0, "Shop")
    assert two.pump(lambda: two.title == "Shop")
    two.doc.get("title", type=Text).insert(4, "ping")
    assert one.pump(lambda: one.title == "Shopping")
    assert wait_for(lambda: stored(note["id"]).title == "Shopping", timeout=3.0)
    one.close()
    two.close()
    assert notedoc.title_of(stored_doc(note["id"])) == "Shopping"
