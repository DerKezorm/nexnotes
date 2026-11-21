"""Markdown and plain text of every node type, and Markdown snippets read back."""

from __future__ import annotations

import pytest
from pycrdt import XmlFragment
from test_notes12_format import EVERYTHING, D, P, T

from app.notedoc import doc as notedoc
from app.notedoc.markdown import from_markdown, parse_inline, to_markdown, to_plain

CASES = [
    ("heading", D({"type": "heading", "attrs": {"level": 2}, "content": [T("Plan "), T("B", "bold")]}),
     "## Plan **B**\n", "Plan B"),
    ("folded heading", D({"type": "heading", "attrs": {"level": 3, "collapsed": True}, "content": [T("Old")]}),
     "### Old\n", "Old"),
    ("paragraph with marks", D(P(T("a "), T("b", "bold"), T(" "), T("c", "italic"), T(" "), T("d", "strike"), T(" "),
                                 T("e", "code"), T(" "), T("f", {"type": "link", "attrs": {"href": "https://x.org"}}))),
     "a **b** *c* ~~d~~ `e` [f](https://x.org)\n", "a b c d e f"),
    ("underline and highlight", D(P(T("u", "underline"), T(" "), T("h", "highlight"), T(" "),
                                    T("g", {"type": "highlight", "attrs": {"color": "green"}}))),
     '<u>u</u> <mark>h</mark> <mark data-color="green">g</mark>\n', "u h g"),
    ("overlapping marks", D(P(T("x", "bold"), T("y", "bold", "italic"), T("z", "italic"))),
     "**x*y***_z_\n", "xyz"),
    ("hard break", D(P(T("one"), {"type": "hardBreak"}, T("two"))), "one\\\ntwo\n", "one\ntwo"),
    ("bullet list", D({"type": "bulletList", "content": [
        {"type": "listItem", "content": [P(T("a")), {"type": "bulletList", "content": [
            {"type": "listItem", "content": [P(T("a1"))]}]}]},
        {"type": "listItem", "content": [P(T("b"))]}]}),
     "- a\n  - a1\n- b\n", "a\na1\nb"),
    ("ordered list", D({"type": "orderedList", "attrs": {"start": 9}, "content": [
        {"type": "listItem", "content": [P(T("nine"))]}, {"type": "listItem", "content": [P(T("ten"))]}]}),
     "9. nine\n10. ten\n", "nine\nten"),
    ("checklist", D({"type": "taskList", "content": [
        {"type": "taskItem", "attrs": {"checked": True}, "content": [P(T("milk"))]},
        {"type": "taskItem", "attrs": {"checked": False}, "content": [P(T("eggs")), {"type": "taskList", "content": [
            {"type": "taskItem", "attrs": {"checked": True}, "content": [P(T("brown"))]}]}]}]}),
     "- [x] milk\n- [ ] eggs\n  - [x] brown\n", "milk\neggs\nbrown"),
    ("table", D({"type": "table", "content": [
        {"type": "tableRow", "content": [{"type": "tableHeader", "content": [P(T("Name"))]},
                                         {"type": "tableHeader", "attrs": {"align": "right"},
                                          "content": [P(T("Qty"))]}]},
        {"type": "tableRow", "content": [{"type": "tableCell", "content": [P(T("A|B"), {"type": "hardBreak"},
                                                                            T("C"))]},
                                         {"type": "tableCell", "content": [P(T("3", "bold"))]}]}]}),
     "| Name | Qty |\n| --- | ---: |\n| A\\|B<br>C | **3** |\n", "Name\tQty\nA|B C\t3"),
    ("quote", D({"type": "blockquote", "content": [P(T("said")), P(T("more"))]}), "> said\n>\n> more\n",
     "said\nmore"),
    ("code block", D({"type": "codeBlock", "attrs": {"language": "js"}, "content": [T("let a = 1\n```")]}),
     "````js\nlet a = 1\n```\n````\n", "let a = 1\n```"),
    ("link with brackets", D(P(T("wiki", {"type": "link", "attrs": {"href": "https://w.org/A_(b)?q=<1>"}}))),
     "[wiki](https://w.org/A_\\(b\\)?q=\\<1\\>)\n", "wiki"),
    ("rule", D(P(T("a")), {"type": "horizontalRule"}, P(T("b"))), "a\n\n---\n\nb\n", "a\nb"),
    ("escaping", D(P(T("# not a heading * _ [x] <b> 1. ~~"))), "\\# not a heading \\* \\_ \\[x\\] \\<b> 1. \\~\\~\n",
     "# not a heading * _ [x] <b> 1. ~~"),
]


@pytest.mark.parametrize(("name", "document", "markdown", "plain"), CASES, ids=[case[0] for case in CASES])
def test_notes12_markdown_and_plain_text_of_each_node(name, document, markdown, plain):
    assert to_markdown(document) == markdown
    assert to_plain(document) == plain


@pytest.mark.parametrize(("name", "document", "markdown", "plain"), CASES, ids=[case[0] for case in CASES])
def test_notes12_markdown_reads_back_to_the_same_note(name, document, markdown, plain):
    lossy = {"folded heading"}  # folding is a view; the Markdown does not carry it
    back = from_markdown(markdown)
    if name in lossy:
        assert to_markdown(back) == markdown
        return
    expected = notedoc.clean_doc(document)
    if name == "table":
        # The header row comes back as header cells, alignment is not read back.
        expected["content"][0]["content"][0]["content"][1]["attrs"]["align"] = None
    assert back == expected


def test_notes12_everything_round_trips_through_markdown():
    doc = notedoc.new_doc("All", EVERYTHING)
    markdown = to_markdown(doc, title="All")
    assert markdown.startswith("# All\n\n# Title\n\n## Folded\n")
    again = from_markdown(markdown)
    # Without the title heading, folding, the empty last paragraph and the alignment, it is the same note.
    expected = notedoc.clean_doc(EVERYTHING)["content"]
    expected[1]["attrs"]["collapsed"] = False
    expected[6]["attrs"]["doneToBottom"] = False
    expected[7]["content"][1]["content"][1]["attrs"]["align"] = None
    expected[7]["content"][1]["content"][1]["type"] = "tableCell"
    assert again["content"][1:] == expected[:-1]


def test_notes12_plain_text_of_a_document_from_pycrdt():
    doc = notedoc.new_doc("x", EVERYTHING)
    plain = to_plain(doc)
    assert plain.startswith("Title\nFolded\nSmall\nplain bold it under gone mono site mark plainmark\nnext line\n")
    assert "milk\neggs\nbrown" in plain
    assert "Name\tQty\nApples\t3" in plain
    assert "print('hi')\nx = 1" in plain


def test_notes12_markdown_snippets_from_mcp():
    snippet = (
        "Einkauf für *Samstag*\nzweite Zeile\n\n"
        "* [ ] Milch\n* [X] Brot\n\n"
        "1) erstens\n2) zweitens\n\n"
        "#### tief\n\n"
        "==markiert== und <u>unter</u> und <mark data-color=\"blue\">blau</mark>\n\n"
        "[böse](javascript:alert(1)) <https://ok.example> ![Bild](https://x.org/a.png)\n\n"
        "~~~\ncode\n~~~\n\n***\n"
    )
    content = from_markdown(snippet)["content"]
    assert content[0] == P(T("Einkauf für "), T("Samstag", "italic"), {"type": "hardBreak"}, T("zweite Zeile"))
    assert content[1]["type"] == "taskList"
    assert [item["attrs"]["checked"] for item in content[1]["content"]] == [False, True]
    assert content[2]["type"] == "orderedList" and content[2]["attrs"]["start"] == 1
    assert content[3] == {"type": "heading", "attrs": {"level": 3, "collapsed": False}, "content": [T("tief")]}
    assert content[4] == P(T("markiert", {"type": "highlight", "attrs": {"color": None}}), T(" und "),
                           T("unter", "underline"), T(" und "),
                           T("blau", {"type": "highlight", "attrs": {"color": "blue"}}))
    link = {"type": "link", "attrs": {"href": "https://ok.example", "target": "_blank",
                                      "rel": "noopener noreferrer nofollow", "class": None, "title": None}}
    assert content[5] == P(T("böse "), T("https://ok.example", link), T(" Bild"))
    assert content[6] == {"type": "codeBlock", "attrs": {"language": None}, "content": [T("code")]}
    assert content[7] == {"type": "horizontalRule"}


def test_notes12_mixed_checklist_and_bullets_become_two_lists():
    content = from_markdown("- [ ] a\n- b\n- [x] c\n")["content"]
    assert [block["type"] for block in content] == ["taskList", "bulletList", "taskList"]


@pytest.mark.parametrize(("text", "expected"), [
    ("**a** __b__ *c* _d_", [T("a", "bold"), T(" "), T("b", "bold"), T(" "), T("c", "italic"), T(" "),
                              T("d", "italic")]),
    ("***both***", [T("both", "bold", "italic")]),
    ("snake_case_name", [T("snake_case_name")]),
    ("2 * 3 * 4", [T("2 * 3 * 4")]),
    ("``a ` b``", [T("a ` b", "code")]),
    ("`a ` b`", [T("a ", "code"), T(" b`")]),
    ("\\*not\\*", [T("*not*")]),
    ("[a **b**](https://x.org/(y))", [T("a ", {"type": "link", "attrs": {"href": "https://x.org/(y)"}}),
                                       T("b", "bold", {"type": "link", "attrs": {"href": "https://x.org/(y)"}})]),
    ("unclosed **bold", [T("unclosed **bold")]),
    ("<u>open only", [T("<u>open only")]),
    ("a<br>b", [T("a"), {"type": "hardBreak"}, T("b")]),
])
def test_notes12_inline_markdown(text, expected):
    assert parse_inline(text) == notedoc.clean_doc(D(P(*expected)))["content"][0].get("content", [])


def test_notes12_markdown_never_breaks_on_garbage():
    for snippet in ["", "\n\n\n", "|", "| a |\n| - |", "- ", "1.", "> ", "```", "[](", "<", "**", "\x00\x01",
                    "- [ ]", "  - a\n- b", "\t- x", "# ", "a\\", "~~a~", "[a](<b>)", "|a|b|\n|--|--|\n|c|"]:
        result = from_markdown(snippet)
        assert result["type"] == "doc" and result["content"]
        assert notedoc.clean_doc(result) == result


@pytest.mark.parametrize("href", ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example"])
def test_notes3_ec8_a_link_written_straight_into_the_document_leaves_markdown_and_text_without_its_target(href):
    """The server keeps Yjs updates from the browser as they come; what it writes out (Markdown export, MCP, the text
    for search) shows only safe links, an unsafe one as its words."""
    doc = notedoc.new_doc("", {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "click here", "marks": [{"type": "link", "attrs": {"href": "https://ok.example"}}]}]}]})
    run = doc.get("body", type=XmlFragment).children[0].children[0]
    run.format(0, 5, {"link": {"href": href, "target": "_blank"}})  # as a browser's update would
    assert href in str(list(run.diff()))  # the document itself is not touched
    markdown = to_markdown(doc)
    assert markdown == "click [here](https://ok.example)\n"
    assert href not in to_plain(doc) and href not in markdown
