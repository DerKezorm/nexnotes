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
