"""Format "nexnotes-doc 1" with sketches and recordings (NOTES-18): the blocks ``drawing`` and ``recording`` name their
attachments by id (a sketch its picture and its data, a recording its sound and its transcript), never hold a file,
and read the same in the browser and on the server."""

from __future__ import annotations

import pytest
from test_notes12_format import D, P, T
from test_notes12_interop import _browser_reads, needs_node

from app.notedoc import doc as notedoc
from app.notedoc import schema as s
from app.notedoc.markdown import from_markdown, to_markdown, to_plain

PICTURE = "Sk3tchP1ctur3_0000000a"
DATA = "Sk3tchD4t4_00000000000a"
SOUND = "R3c0rd1ngS0und_000000a"
WORDS = "R3c0rd1ngT3xt_0000000a"

SKETCHED = D(
    P(T("Ablauf:")),
    {"type": "drawing", "attrs": {"id": PICTURE, "data": DATA, "name": "Skizze.png"}},
    {"type": "recording", "attrs": {"id": SOUND, "name": "Besprechung [Montag].m4a", "duration": 3130000,
                                    "transcript": WORDS}},
    {"type": "bulletList", "content": [{"type": "listItem", "content": [
        P(T("im Punkt")), {"type": "drawing", "attrs": {"id": PICTURE, "name": "noch mal"}}]}]},
)


def test_notes18_the_blocks_keep_every_attribute_and_only_known_ones():
    clean = notedoc.clean_doc(SKETCHED)["content"]
    assert clean[1] == SKETCHED["content"][1]
    assert clean[2] == SKETCHED["content"][2]
    assert clean[3]["content"][0]["content"][1] == {"type": "drawing",
                                                    "attrs": {"id": PICTURE, "data": None, "name": "noch mal"}}
    assert s.NODE_ATTRS[s.DRAWING] == {"id": None, "data": None, "name": None}
    assert s.NODE_ATTRS[s.RECORDING] == {"id": None, "name": None, "duration": None, "transcript": None}
    assert {s.DRAWING, s.RECORDING} <= s.ATOMS


@pytest.mark.parametrize("node", [
    {"type": "drawing", "attrs": {"id": "../../etc/passwd", "data": DATA}},
    {"type": "drawing", "attrs": {"data": DATA}},
    {"type": "recording", "attrs": {"id": "short", "transcript": WORDS}},
    {"type": "recording", "attrs": {"src": "https://evil.example/a.m4a"}},
], ids=lambda node: f"{node['type']}-{sorted(node['attrs'])}")
def test_notes18_a_block_without_a_valid_id_goes(node):
    assert notedoc.clean_doc(D(P(T("a")), node))["content"] == [P(T("a"))]


def test_notes18_what_else_a_block_names_must_be_an_id_and_a_length_a_length():
    clean = notedoc.clean_doc(D(
        {"type": "drawing", "attrs": {"id": PICTURE, "data": "../data"}},
        {"type": "recording", "attrs": {"id": SOUND, "duration": -5, "transcript": "x"}},
        {"type": "recording", "attrs": {"id": SOUND, "duration": s.MAX_DURATION + 1}},
        {"type": "recording", "attrs": {"id": SOUND, "duration": "1500", "name": "a\nb"}},
        {"type": "recording", "attrs": {"id": SOUND, "duration": True}},
    ))["content"]
    assert clean[0]["attrs"]["data"] is None
    assert clean[1]["attrs"] == {"id": SOUND, "name": None, "duration": None, "transcript": None}
    assert clean[2]["attrs"]["duration"] is None
    assert clean[3]["attrs"]["duration"] == 1500 and clean[3]["attrs"]["name"] == "a b"
    assert clean[4]["attrs"]["duration"] is None


def test_notes18_attachment_refs_name_the_picture_the_data_the_sound_and_the_transcript_in_order():
    assert notedoc.attachment_refs(SKETCHED) == [PICTURE, DATA, SOUND, WORDS]
    assert notedoc.attachment_refs(notedoc.new_doc("x", SKETCHED)) == [PICTURE, DATA, SOUND, WORDS]


def test_notes18_markdown_and_plain_text_of_sketches_and_recordings():
    markdown = to_markdown(SKETCHED)
    assert markdown == (
        "Ablauf:\n\n"
        f'![Skizze.png](attachment:{PICTURE} "drawing data={DATA}")\n\n'
        f'[Besprechung \\[Montag\\].m4a](attachment:{SOUND} "recording duration=3130000 transcript={WORDS}")\n\n'
        f'- im Punkt\n\n  ![noch mal](attachment:{PICTURE} "drawing")\n'
    )
    assert to_plain(SKETCHED) == "Ablauf:\nSkizze.png\nBesprechung [Montag].m4a\nim Punkt\nnoch mal"


def test_notes18_markdown_reads_back_sketches_and_recordings():
    assert from_markdown(to_markdown(SKETCHED)) == notedoc.clean_doc(SKETCHED)
    # Without the title it is a picture and a file, as in NOTES-10; a title of something else changes nothing.
    assert from_markdown(f"![a](attachment:{PICTURE})")["content"][0]["type"] == "image"
    assert from_markdown(f'[a](attachment:{SOUND} "drawing")')["content"][0]["type"] != "drawing"
    assert from_markdown(f'![a](attachment:{SOUND} "recording")')["content"][0]["type"] != "recording"


def test_notes18_the_export_writes_the_sketch_as_a_picture_and_the_transcript_beside_the_sound():
    exported = to_markdown(SKETCHED, attachment_href=lambda found, _name: {
        PICTURE: "Anhänge/Skizze.png", SOUND: "Anhänge/Besprechung.m4a", WORDS: "Anhänge/Besprechung.txt"}.get(found))
    lines = exported.split("\n\n")
    assert lines[1] == "![Skizze.png](Anhänge/Skizze.png)"
    assert lines[2] == "[Besprechung \\[Montag\\].m4a](Anhänge/Besprechung.m4a) · [Besprechung.txt](Anhänge/Besprechung.txt)"
    # Without a file of the transcript only the sound; without either only the name.
    only_sound = to_markdown(SKETCHED, attachment_href=lambda found, _name: "x/a.m4a" if found == SOUND else None)
    assert "[Besprechung \\[Montag\\].m4a](x/a.m4a)\n" in only_sound and "·" not in only_sound


def test_notes18_sketches_and_recordings_round_trip_through_the_document():
    clean = notedoc.clean_doc(SKETCHED)
    doc = notedoc.new_doc("Besprechung", clean)
    assert notedoc.to_json(doc) == clean
    assert notedoc.repair(doc) == 0


@needs_node
def test_notes18_interop_the_browser_reads_the_blocks_the_server_wrote(tmp_path):
    doc = notedoc.new_doc("Skizze und Aufnahme", SKETCHED)
    seen = _browser_reads(tmp_path, doc.get_update())
    assert seen["doc"] == notedoc.to_json(doc)
