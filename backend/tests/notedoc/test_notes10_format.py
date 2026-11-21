"""Format "nexnotes-doc 1" with attachments (NOTES-10): the blocks ``image``, ``attachment`` and ``linkPreview`` name an
attachment by its id, never hold a file, and read the same in the browser and on the server."""

from __future__ import annotations

import pytest
from test_notes12_format import D, P, T
from test_notes12_interop import _browser_reads, needs_node

from app.notedoc import doc as notedoc
from app.notedoc import schema as s
from app.notedoc.markdown import from_markdown, to_markdown, to_plain

PICTURE = "Zx3_aB9-cD4eF5gH6iJ7kL"
SHEET = "Pp4qQ5rR6sS7tT8uU9vV0w"
PAGE_PICTURE = "Ee8fF9gG0hH1iI2jJ3kK4l"

ATTACHED = D(
    P(T("Foto vom Platz:")),
    {"type": "image", "attrs": {"id": PICTURE, "size": "small", "name": "Wohnzimmer.heic"}},
    {"type": "attachment", "attrs": {"id": SHEET, "name": "Datenblatt [Sofa].pdf"}},
    {"type": "bulletList", "content": [{"type": "listItem", "content": [
        P(T("im Punkt")), {"type": "image", "attrs": {"id": PICTURE, "size": "full", "name": "noch mal.png"}}]}]},
    {"type": "linkPreview", "attrs": {"href": "https://moebel.example.com/ecksofa", "title": "Ecksofa, 3-Sitzer",
                                      "description": "Maße und Lieferzeit", "site": "moebel.example.com",
                                      "image": PAGE_PICTURE}},
)


def test_notes10_the_blocks_keep_every_attribute_and_only_known_ones():
    clean = notedoc.clean_doc(ATTACHED)["content"]
    assert clean[1] == {"type": "image", "attrs": {"id": PICTURE, "size": "small", "name": "Wohnzimmer.heic"}}
    assert clean[2] == {"type": "attachment", "attrs": {"id": SHEET, "name": "Datenblatt [Sofa].pdf"}}
    assert clean[4]["attrs"] == ATTACHED["content"][4]["attrs"]
    assert s.NODE_ATTRS[s.IMAGE] == {"id": None, "size": "medium", "name": None}


@pytest.mark.parametrize("node", [
    {"type": "image", "attrs": {"id": "../../etc/passwd"}},
    {"type": "image", "attrs": {"id": "short"}},
    {"type": "image", "attrs": {"src": "https://evil.example/x.png"}},
    {"type": "attachment", "attrs": {"id": None, "name": "x"}},
    {"type": "attachment", "attrs": {"id": 12345678901234567890}},
    {"type": "linkPreview", "attrs": {"href": "javascript:alert(1)", "title": "x"}},
    {"type": "linkPreview", "attrs": {"href": "mailto:a@b.c", "title": "x"}},
    {"type": "linkPreview", "attrs": {"href": "file:///etc/passwd"}},
    {"type": "linkPreview", "attrs": {}},
], ids=lambda node: f"{node['type']}-{sorted(node['attrs'].items())!s:.40}")
def test_notes10_a_block_without_a_valid_id_or_a_safe_target_goes(node):
    assert notedoc.clean_doc(D(P(T("a")), node))["content"] == [P(T("a"))]


def test_notes10_names_and_card_lines_are_one_line_and_cut():
    clean = notedoc.clean_doc(D(
        {"type": "image", "attrs": {"id": PICTURE, "name": "Zeile\nzwei\x00" + "x" * 300}},
        {"type": "linkPreview", "attrs": {"href": "https://a.example/", "title": "  ", "description": "d" * 900,
                                          "image": "not an id"}},
    ))["content"]
    assert clean[0]["attrs"]["name"].startswith("Zeile zwei") and len(clean[0]["attrs"]["name"]) == s.MAX_NAME
    assert clean[1]["attrs"]["title"] is None and len(clean[1]["attrs"]["description"]) == s.MAX_CARD_TEXT
    assert clean[1]["attrs"]["image"] is None


def test_notes10_attachment_refs_in_the_order_of_the_text_each_once():
    assert notedoc.attachment_refs(ATTACHED) == [PICTURE, SHEET, PAGE_PICTURE]
    doc = notedoc.new_doc("x", ATTACHED)
    assert notedoc.attachment_refs(doc) == [PICTURE, SHEET, PAGE_PICTURE]
    assert notedoc.attachment_refs(D(P(T("nichts")))) == []


def test_notes10_markdown_and_plain_text_of_attachments():
    markdown = to_markdown(ATTACHED)
    assert markdown == (
        "Foto vom Platz:\n\n"
        f"![Wohnzimmer.heic](attachment:{PICTURE})\n\n"
        f"[Datenblatt \\[Sofa\\].pdf](attachment:{SHEET})\n\n"
        f"- im Punkt\n\n  ![noch mal.png](attachment:{PICTURE})\n\n"
        "[Ecksofa, 3-Sitzer](https://moebel.example.com/ecksofa)\n"
    )
    assert to_plain(ATTACHED) == ("Foto vom Platz:\nWohnzimmer.heic\nDatenblatt [Sofa].pdf\nim Punkt\nnoch mal.png\n"
                                  "Ecksofa, 3-Sitzer\nMaße und Lieferzeit\nhttps://moebel.example.com/ecksofa")
    # The export gives the addresses of the files it writes beside the Markdown.
    exported = to_markdown(ATTACHED, attachment_href=lambda found, name: f"Anhänge/{name}")
    assert "![Wohnzimmer.heic](Anhänge/Wohnzimmer.heic)" in exported
    assert "[Datenblatt \\[Sofa\\].pdf](<Anhänge/Datenblatt [Sofa].pdf>)" in exported


def test_notes10_markdown_reads_back_pictures_and_files():
    back = from_markdown(to_markdown(ATTACHED))["content"]
    assert back[1] == {"type": "image", "attrs": {"id": PICTURE, "size": "medium", "name": "Wohnzimmer.heic"}}
    assert back[2] == {"type": "attachment", "attrs": {"id": SHEET, "name": "Datenblatt [Sofa].pdf"}}
    # The card comes back as the link it is in Markdown.
    assert back[-1]["type"] == "paragraph" and back[-1]["content"][0]["marks"][0]["type"] == "link"
    # Only an id of the right shape is an attachment; anything else stays text.
    assert from_markdown("![x](attachment:../../etc)")["content"][0]["type"] == "paragraph"


def test_notes10_pictures_round_trip_through_the_document():
    clean = notedoc.clean_doc(ATTACHED)
    doc = notedoc.new_doc("Sofa", clean)
    assert notedoc.to_json(doc) == clean
    # Repairing shapes leaves the blocks alone.
    assert notedoc.repair(doc) == 0


@needs_node
def test_notes10_interop_the_browser_reads_the_blocks_the_server_wrote(tmp_path):
    doc = notedoc.new_doc("Anhänge", ATTACHED)
    seen = _browser_reads(tmp_path, doc.get_update())
    assert seen["doc"] == notedoc.to_json(doc)
