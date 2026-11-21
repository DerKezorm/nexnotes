"""NOTES-12 EC-1: a paragraph is deleted while someone else writes in it; the new text stays."""

from __future__ import annotations

import asyncio

import pytest
from notedoc_sim import World
from pycrdt import XmlElement, XmlFragment, XmlText

from app.notedoc import doc as notedoc
from app.notedoc import to_plain


def _seed(world: World) -> None:
    doc = notedoc.new_doc("Plan", {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "first"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "second"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "third"}]},
    ]})
    world.store.state = doc.get_update()


def _body(client) -> XmlFragment:
    return client.doc.get("body", type=XmlFragment)


def _texts(client) -> list[str]:
    return to_plain(client.doc).split("\n")


async def _two() -> tuple[World, object, object]:
    world = World()
    _seed(world)
    a = world.client("a", 1, client_id=101)
    b = world.client("b", 2, client_id=202)
    a.connect()
    b.connect()
    await world.settle()
    return world, a, b


def test_notes12_ec1_text_typed_into_a_paragraph_deleted_first_stays():
    async def scenario():
        world, a, b = await _two()
        # A deletes "second" and the room has it first; B, cut off, types into it before it learns of the deletion.
        b.disconnect()
        del _body(a).children[1]
        await world.settle()
        paragraph = _body(b).children[1]
        text = paragraph.children[0]
        text.insert(len(text), " plus")
        text.insert(len(text), " more")
        b.connect()
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["first", " plus more", "third"], _texts(client)
        assert notedoc.to_json(a.doc) == notedoc.to_json(b.doc)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec1_paragraph_deleted_after_someone_typed_unseen_text_keeps_it():
    async def scenario():
        world, a, b = await _two()
        a.disconnect()  # A deletes without seeing what B types
        text = _body(b).children[1].children[0]
        text.insert(len(text), " typed by b")
        await world.settle()
        del _body(a).children[1]
        a.connect()
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["first", " typed by b", "third"], _texts(client)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec1_deleting_a_paragraph_one_has_seen_whole_deletes_it():
    async def scenario():
        world, a, b = await _two()
        del _body(a).children[1]
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["first", "third"]
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec1_keystrokes_after_the_deletion_come_back_as_one_paragraph():
    async def scenario():
        world, a, b = await _two()
        b.disconnect()
        del _body(a).children[1]
        await world.settle()
        b.connect()
        text = _body(b).children[1].children[0]
        # B keeps typing letter by letter while its own deletion message is still on the way.
        for letter in " xyz":
            text.insert(len(text), letter)
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["first", " xyz", "third"], _texts(client)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec1_a_table_row_deleted_while_someone_types_in_a_cell_keeps_the_text():
    async def scenario():
        world = World()
        doc = notedoc.new_doc("T", {"type": "doc", "content": [
            {"type": "table", "content": [
                {"type": "tableRow", "content": [
                    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text",
                                                                                         "text": "h"}]}]}]},
                {"type": "tableRow", "content": [
                    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text",
                                                                                       "text": "cell"}]}]}]},
            ]},
            {"type": "paragraph", "content": [{"type": "text", "text": "after"}]},
        ]})
        world.store.state = doc.get_update()
        a = world.client("a", 1, client_id=11)
        b = world.client("b", 2, client_id=22)
        a.connect()
        b.connect()
        await world.settle()
        b.disconnect()
        table = _body(a).children[0]
        del table.children[1]
        await world.settle()
        cell_text = _body(b).children[0].children[1].children[0].children[0].children[0]
        assert isinstance(cell_text, XmlText)
        cell_text.insert(len(cell_text), " new")
        b.connect()
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["h", " new", "after"], _texts(client)
            assert isinstance(_body(client).children[1], XmlElement)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec3_a_connection_gets_changes_only_after_its_own_have_arrived():
    async def scenario():
        world = World(sync_timeout=0.05)
        _seed(world)
        a = world.client("a", 1, client_id=1)
        a.connect()
        await world.settle()
        quiet = world.client("q", 2, client_id=2)
        quiet.answers = False  # sends its state vector, never its own changes
        quiet.connect()
        await world.settle()
        text = _body(a).children[0].children[0]
        text.insert(len(text), "!")
        await world.settle()
        assert _texts(quiet) == [""]  # nothing yet: not the document, not the change
        await asyncio.sleep(0.1)
        await world.settle()
        assert _texts(quiet) == ["first!", "second", "third"]
        await world.rooms.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("rounds", [1, 2, 3, 4, 6, 8, 12, 20])
def test_notes12_ac4_ec1_offline_text_in_a_deleted_paragraph_survives_a_reconnect_that_breaks(rounds):
    async def scenario():
        world, a, b = await _two()
        b.disconnect()
        text = _body(b).children[1].children[0]
        text.insert(len(text), " offline")
        del _body(a).children[1]
        await world.settle()
        # B reconnects and the line breaks again after a few steps: whatever was in flight is lost.
        b.connect()
        await world.step(rounds)
        b.disconnect()
        await world.settle()
        b.connect()
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["first", " offline", "third"], (rounds, _texts(client))
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec3_text_sent_twice_comes_back_once():
    # Newer pycrdt names an item it gets a second time in the transaction's delete set again when its paragraph is
    # gone; such an item is old for the room and must not come back a second time.
    from pycrdt import Doc

    from app.notedoc import rescue

    base = notedoc.new_doc("x", {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "keep"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "gone"}]},
    ]})
    typist = Doc()
    typist.apply_update(base.get_update())
    before = typist.get_state()
    run = typist.get("body", type=XmlFragment).children[1].children[0]
    run.insert(len(run), " late")
    typed = typist.get_update(before)
    deleter = notedoc.load(base.get_update())
    _, deletion = notedoc.change(deleter, lambda d: d.get("body", type=XmlFragment).children.__delitem__(1))
    room_doc = notedoc.load(base.get_update(), [deletion])
    rescuer = rescue.Rescuer()
    first = rescue.apply(room_doc, typed)
    with notedoc.recording(room_doc):
        assert rescuer.after(room_doc, typed, first, None) == len(" late")
    again = rescue.apply(room_doc, typed)
    again.deleted = first.deleted  # as pycrdt 0.14 reports it
    again.changed = True
    with notedoc.recording(room_doc):
        assert rescuer.after(room_doc, typed, again, None) == 0
    assert to_plain(room_doc) == "keep\n late"


def test_notes12_ec1_late_text_finds_its_place_after_other_changes():
    async def scenario():
        world, a, b = await _two()
        b.disconnect()
        del _body(a).children[1]  # "second" goes; its place is before "third"
        await world.settle()
        top = _body(a).children.insert(0, XmlElement("paragraph"))
        top.children.append(XmlText("new top"))
        await world.settle()
        text = _body(b).children[1].children[0]
        text.insert(len(text), " late")
        b.connect()
        await world.settle()
        for client in (a, b):
            assert _texts(client) == ["new top", "first", " late", "third"], _texts(client)
        await world.rooms.shutdown()

    asyncio.run(scenario())


def test_notes12_ec1_text_comes_back_and_an_emptied_checklist_is_mended_in_one_go():
    async def scenario():
        world = World()
        doc = notedoc.new_doc("x", {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "intro"}]},
            {"type": "taskList", "content": [
                {"type": "taskItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]},
                {"type": "taskItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "b"}]}]},
            ]},
        ]})
        world.store.state = doc.get_update()
        a = world.client("a", 1, client_id=1)
        b = world.client("b", 2, client_id=2)
        a.connect()
        b.connect()
        await world.settle()
        a.disconnect()
        # B types into the intro and deletes item "b"; A, cut off, deletes the intro and item "a" in one go.
        run = _body(b).children[0].children[0]
        run.insert(len(run), " typed")
        del _body(b).children[1].children[1]
        await world.settle()
        with a.doc.transaction():
            del _body(a).children[1].children[0]
            del _body(a).children[0]
        a.connect()
        await world.settle()
        for client in (a, b):
            shape = notedoc.to_json(client.doc)
            assert notedoc.clean_doc(shape) == shape, shape
            assert _texts(client)[0] == " typed"
        await world.rooms.shutdown()

    asyncio.run(scenario())
