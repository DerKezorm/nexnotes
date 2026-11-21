"""The live room: protocol, rights, storing before passing on, folding, closing, restart."""

from __future__ import annotations

import asyncio
import time

import pytest
from notedoc_sim import MemoryStore, World, update_of
from pycrdt import Text, XmlFragment

from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc import schema as s
from app.notedoc.markdown import to_plain
from app.notedoc.room import (
    CLOSE_BAD,
    CLOSE_ERROR,
    CLOSE_FORBIDDEN,
    CLOSE_GONE,
    CLOSE_RESTART,
    CLOSE_RIGHTS,
    CLOSE_TOO_LARGE,
    Access,
    Rooms,
    fold_stored,
)


def _seed(world: World, text: str = "hello") -> None:
    doc = notedoc.new_doc("Note", {"type": "doc", "content": [{"type": "paragraph",
                                                               "content": [{"type": "text", "text": text}]}]})
    world.store.state = doc.get_update()


def _type(client, text: str, paragraph: int = 0) -> None:
    run = client.doc.get("body", type=XmlFragment).children[paragraph].children[0]
    run.insert(len(run), text)


def _plain(doc) -> str:
    return to_plain(doc)


def _stored(world: World):
    return notedoc.load(world.store.state, [update for update, _ in world.store.updates])


async def _pair(world: World, *, b_writes: bool = True):
    _seed(world)
    a = world.client("a", 1, client_id=1001)
    b = world.client("b", 2, can_write=b_writes, client_id=2002)
    a.connect()
    b.connect()
    await world.settle()
    return a, b


def test_notes12_ac1_a_change_reaches_the_other_connection_at_once():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        started = time.perf_counter()
        _type(a, " world")
        while _plain(b.doc) != "hello world":
            await asyncio.sleep(0)
            assert time.perf_counter() - started < 1.0
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ac2_two_connections_writing_in_different_places_keep_both():
    async def scenario():
        world = World()
        _seed(world)
        doc = notedoc.load(world.store.state)
        edit.append_paragraph(doc, "second")
        world.store.state = doc.get_update()
        a = world.client("a", 1, client_id=1)
        b = world.client("b", 2, client_id=2)
        a.connect()
        b.connect()
        await world.settle()
        _type(a, " from a", 0)
        _type(b, " from b", 1)
        await world.settle()
        for doc in (a.doc, b.doc, _stored(world), world.rooms.room_of("note").doc):
            assert _plain(doc) == "hello from a\nsecond from b"
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ac3_two_writing_at_the_same_place_keep_both_texts():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        _type(a, " AAA")
        _type(b, " BBB")
        await world.settle()
        # Both texts, one after the other (never mixed, never one replacing the other), the same everywhere.
        assert _plain(a.doc) == _plain(b.doc) == _plain(_stored(world))
        assert _plain(a.doc) in ("hello AAA BBB", "hello BBB AAA")
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_reader_update_is_dropped_and_not_stored():
    async def scenario():
        world = World()
        a, b = await _pair(world, b_writes=False)
        stored = len(world.store.updates)
        _type(b, " forged")  # a reader's browser never sends this; a forged one is dropped
        await world.settle()
        assert len(world.store.updates) == stored
        assert _plain(a.doc) == "hello"
        assert _plain(world.rooms.room_of("note").doc) == "hello"
        # The reader still follows along.
        _type(a, " there")
        await world.settle()
        assert "there" in _plain(b.doc)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_every_update_is_stored_before_it_is_passed_on():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        world.events.clear()
        for letter in "abc":
            _type(a, letter)
        await world.settle()
        saves = [(i, e[2]) for i, e in enumerate(world.events) if e[0] == "save"]
        deliveries = [(i, update_of(e[2])) for i, e in enumerate(world.events) if e[0] == "deliver" and e[1] == "b"]
        deliveries = [(i, u) for i, u in deliveries if u is not None]
        assert len(saves) == 3 and len(deliveries) == 3
        for (save_at, saved), (deliver_at, delivered) in zip(saves, deliveries, strict=True):
            assert saved == delivered
            assert save_at < deliver_at
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_a_failed_save_passes_nothing_on_and_the_change_comes_again():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        world.store.fail_next_save = True
        _type(a, "!")
        await world.settle()
        assert a.closed == [CLOSE_ERROR]
        assert _plain(b.doc) == "hello"
        assert _plain(_stored(world)) == "hello"
        a.connect()  # the browser reconnects and its change travels with the sync
        await world.settle()
        assert _plain(b.doc) == "hello!"
        assert _plain(_stored(world)) == "hello!"
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_a_resent_update_is_neither_stored_nor_passed_on():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        _type(a, "12")
        run = a.doc.get("body", type=XmlFragment).children[0].children[0]
        del run[0:1]  # a deletion, so every resend carries a delete set
        await world.settle()
        stored = len(world.store.updates)
        a.disconnect()
        a.connect()  # sends its whole state again in sync step 2
        b.disconnect()
        b.connect()
        await world.settle()
        assert len(world.store.updates) == stored
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_room_folds_after_n_updates_and_when_the_last_one_leaves():
    async def scenario():
        world = World(fold_after=3)
        a, b = await _pair(world)
        for letter in "abcd":
            _type(a, letter)
            await world.settle()
        assert len(world.store.folds) == 1
        assert len(world.store.updates) == 1
        assert notedoc.to_json(notedoc.load(world.store.folds[0].state)) != notedoc.to_json(a.doc)
        a.disconnect()
        await world.settle()
        assert len(world.store.folds) == 1  # someone is still there
        b.disconnect()
        await world.settle()
        assert len(world.store.folds) == 2 and world.store.updates == []
        last = world.store.folds[-1]
        assert last.title == "Note" and last.text == "helloabcd"
        assert _plain(notedoc.load(last.state)) == "helloabcd"
        assert world.rooms.room_of("note") is None

    asyncio.run(scenario())


def test_notes12_text_for_search_is_refreshed_shortly_after_a_change():
    async def scenario():
        world = World(summary_delay=0.02)
        a, b = await _pair(world)
        _type(a, " world")
        await world.settle()
        await asyncio.sleep(0.1)
        assert world.store.summaries[-1] == ("Note", "hello world")
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec5_right_taken_closes_and_what_did_not_arrive_is_not_stored():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        stored = len(world.store.updates)
        # The share is removed; the browser types on before it hears of it.
        world.access[1] = Access.NONE
        world.rooms.nudge()
        _type(a, " late")
        await world.settle()
        assert a.closed == [CLOSE_FORBIDDEN]
        assert len(world.store.updates) == stored
        assert _plain(b.doc) == "hello"
        assert _plain(_stored(world)) == "hello"
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec5_write_becoming_read_closes_for_a_reconnect_as_reader():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        world.access[1] = Access.READ
        world.rooms.nudge()
        _type(a, " late")
        await world.settle()
        assert a.closed == [CLOSE_RIGHTS]
        assert _plain(b.doc) == "hello"
        a.can_write = False
        a.connect()
        await world.settle()
        assert _plain(world.rooms.room_of("note").doc) == "hello"
        _type(b, "!")
        await world.settle()
        assert _plain(a.doc).endswith("!")  # the reader follows along
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec5_rights_are_checked_again_by_time_without_a_nudge():
    async def scenario():
        world = World(recheck_seconds=0.02, tick=0.005)
        a, b = await _pair(world)
        world.access[2] = Access.NONE
        for _ in range(100):
            await asyncio.sleep(0.005)
            if b.closed:
                break
        assert b.closed == [CLOSE_FORBIDDEN]
        assert a.closed == []
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec2_a_deleted_note_closes_every_connection_with_gone():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        await world.rooms.close_note("note")
        await world.settle()
        assert a.closed == [CLOSE_GONE] and b.closed == [CLOSE_GONE]
        world2 = World()
        c, d = await _pair(world2)
        world2.access[1] = Access.GONE
        world2.rooms.nudge()
        _type(c, "x")
        await world2.settle()
        assert c.closed == [CLOSE_GONE]
        assert d.closed == []
        await world2.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec7_server_restart_loses_nothing():
    async def scenario():
        store = MemoryStore()
        world = World(store=store)
        a, b = await _pair(world)
        _type(a, " one")
        _type(b, " two")
        await world.settle()
        # The process dies: no shutdown, no fold, connections broken. Browsers keep typing offline.
        a.disconnect()
        b.disconnect()
        _type(a, " offline-a")
        _type(b, " offline-b")
        world.rooms = Rooms(store, world.check, recheck_seconds=3600.0, tick=0.01, summary_delay=0.05)
        await asyncio.sleep(0)
        a.connect()
        b.connect()
        await world.settle()
        text = _plain(a.doc)
        assert text == _plain(b.doc) == _plain(world.rooms.room_of("note").doc) == _plain(_stored(world))
        for word in ("one", "two", "offline-a", "offline-b"):
            assert text.count(word) == 1, text
        # A stop with shutdown folds and closes with "restart", and what was stored folds at the start.
        await world.rooms.shutdown()
        await world.settle()
        assert a.closed[-1] == CLOSE_RESTART and b.closed[-1] == CLOSE_RESTART
        assert store.updates == []
        assert _plain(notedoc.load(store.state)) == text
        assert fold_stored(store.state, []).text == text

    asyncio.run(scenario())


def test_notes12_awareness_is_passed_on_and_gone_clients_are_said_goodbye():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        a.announce('{"user":{"name":"a"}}')
        await world.settle()
        assert any(b"\"name\":\"a\"" in message for message in b.awareness.values())
        late = world.client("c", 3, client_id=3003)
        late.connect()
        await world.settle()
        assert any(b"\"name\":\"a\"" in message for message in late.awareness.values())
        a.disconnect()
        await world.settle()
        assert any(message.endswith(b"null") for message in b.awareness.values())
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_too_large_update_closes_with_413(monkeypatch):
    async def scenario():
        world = World()
        a, b = await _pair(world)
        monkeypatch.setattr(s, "MAX_UPDATE", 50)
        _type(a, "x" * 200)
        await world.settle()
        assert a.closed == [CLOSE_TOO_LARGE]
        assert _plain(b.doc) == "hello"
        monkeypatch.setattr(s, "MAX_UPDATE", 2 * 1024 * 1024)
        monkeypatch.setattr(s, "MAX_DOC", 100)
        _type(b, "y" * 200)
        await world.settle()
        assert b.closed == [CLOSE_TOO_LARGE]
        assert world.rooms.room_of("note") is None or _plain(world.rooms.room_of("note").doc) == "hello"
        assert _plain(_stored(world)) == "hello"
        await world.rooms.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("message", [b"\x00", b"\x00\x05\xff", b"\x09\x00", b"\x00\x02\x05ab", b"\x01\x03abc"])
def test_notes12_a_broken_message_closes_the_connection(message):
    async def scenario():
        world = World()
        a, b = await _pair(world)
        a.send_raw(message)
        await world.settle()
        assert a.closed == [CLOSE_BAD]
        assert b.closed == []
        assert _plain(world.rooms.room_of("note").doc) == "hello"
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_server_change_reaches_everyone_and_is_stored():
    async def scenario():
        world = World()
        a, b = await _pair(world)
        index = await world.rooms.change("note", lambda d: edit.append_task(d, "Milch"), account_id=9)
        await world.settle()
        assert index == 0
        for doc in (a.doc, b.doc, _stored(world)):
            assert [t.text for t in edit.list_tasks(doc)] == ["Milch"]
        assert world.store.updates[-1][1] == 9
        await world.rooms.change("note", lambda d: notedoc.set_title(d, "Einkauf"))
        await world.settle()
        assert str(b.doc.get("title", type=Text)) == "Einkauf"
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_server_change_without_an_open_room_goes_to_the_store():
    async def scenario():
        world = World()
        _seed(world)
        await world.rooms.change("note", lambda d: edit.append_markdown(d, "- [x] done"))
        assert world.rooms.room_of("note") is None
        assert [t.checked for t in edit.list_tasks(_stored(world))] == [True]
        assert world.store.summaries[-1] == ("Note", "hello\ndone")
        a = world.client("a", 1)
        a.connect()
        await world.settle()
        assert [t.text for t in edit.list_tasks(a.doc)] == ["done"]
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_concurrent_deletions_leave_a_shape_the_browser_reads():
    async def scenario():
        world = World()
        doc = notedoc.new_doc("x", {"type": "doc", "content": [
            {"type": "taskList", "content": [
                {"type": "taskItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]},
                {"type": "taskItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "b"}]}]},
            ]},
            {"type": "paragraph", "content": [{"type": "text", "text": "end"}]},
        ]})
        world.store.state = doc.get_update()
        a = world.client("a", 1, client_id=1)
        b = world.client("b", 2, client_id=2)
        a.connect()
        b.connect()
        await world.settle()
        # Each deletes the other item at the same time: together they leave a checklist without items.
        del a.doc.get("body", type=XmlFragment).children[0].children[0]
        del b.doc.get("body", type=XmlFragment).children[0].children[1]
        await world.settle()
        for current in (a.doc, b.doc, _stored(world)):
            shape = notedoc.to_json(current)
            assert notedoc.clean_doc(shape) == shape
            assert shape["content"][0]["type"] == "taskList" and len(shape["content"][0]["content"]) == 1
        await world.rooms.shutdown()

    asyncio.run(scenario())
