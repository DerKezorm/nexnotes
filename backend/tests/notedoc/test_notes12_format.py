"""Format "nexnotes-doc 1": the document as y-prosemirror writes it, cleaning, title and links."""

from __future__ import annotations

import pytest
from pycrdt import Doc, Map, Text, XmlElement, XmlFragment, XmlText

from app.notedoc import doc as notedoc
from app.notedoc import schema as s


def T(text, *marks):  # noqa: N802 - short builders keep the documents readable
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = [m if isinstance(m, dict) else {"type": m} for m in marks]
    return node


def P(*content):  # noqa: N802
    return {"type": "paragraph", "content": list(content)} if content else {"type": "paragraph"}


def D(*blocks):  # noqa: N802
    return {"type": "doc", "content": list(blocks)}


#: One document with every node and mark the format knows.
EVERYTHING = D(
    {"type": "heading", "attrs": {"level": 1, "collapsed": False}, "content": [T("Title")]},
    {"type": "heading", "attrs": {"level": 2, "collapsed": True}, "content": [T("Folded")]},
    {"type": "heading", "attrs": {"level": 3, "collapsed": False}, "content": [T("Small")]},
    P(T("plain "), T("bold", "bold"), T(" "), T("it", "italic"), T(" "), T("under", "underline"), T(" "),
      T("gone", "strike"), T(" "), T("mono", "code"), T(" "),
      T("site", {"type": "link", "attrs": {"href": "https://example.com"}}), T(" "),
      T("mark", {"type": "highlight", "attrs": {"color": "green"}}), T(" "), T("plainmark", "highlight"),
      {"type": "hardBreak"}, T("next line")),
    {"type": "bulletList", "content": [
        {"type": "listItem", "content": [P(T("one")), {"type": "bulletList", "content": [
            {"type": "listItem", "content": [P(T("nested"))]}]}]},
        {"type": "listItem", "content": [P(T("two"))]}]},
    {"type": "orderedList", "attrs": {"start": 3}, "content": [
        {"type": "listItem", "content": [P(T("three"))]}, {"type": "listItem", "content": [P(T("four"))]}]},
    {"type": "taskList", "attrs": {"doneToBottom": True}, "content": [
        {"type": "taskItem", "attrs": {"checked": True}, "content": [P(T("milk"))]},
        {"type": "taskItem", "attrs": {"checked": False}, "content": [P(T("eggs")), {"type": "taskList", "content": [
            {"type": "taskItem", "attrs": {"checked": False}, "content": [P(T("brown"))]}]}]}]},
    {"type": "table", "content": [
        {"type": "tableRow", "content": [
            {"type": "tableHeader", "content": [P(T("Name"))]}, {"type": "tableHeader", "content": [P(T("Qty"))]}]},
        {"type": "tableRow", "content": [
            {"type": "tableCell", "content": [P(T("Apples"))]},
            {"type": "tableCell", "attrs": {"align": "right"}, "content": [P(T("3"))]}]}]},
    {"type": "blockquote", "content": [P(T("quoted"))]},
    {"type": "codeBlock", "attrs": {"language": "python"}, "content": [T("print('hi')\nx = 1")]},
    {"type": "horizontalRule"},
    P(),
)


def test_notes12_new_document_has_title_body_and_format():
    doc = notedoc.new_doc("Shopping")
    assert str(doc.get("title", type=Text)) == "Shopping"
    assert doc.get("meta", type=Map)["format"] == s.FORMAT == 1
    body = doc.get("body", type=XmlFragment)
    assert len(body.children) == 1 and body.children[0].tag == "paragraph"
    assert notedoc.to_json(doc) == D(P())


def test_notes12_every_node_type_round_trips_through_the_document():
    doc = notedoc.new_doc("All", EVERYTHING)
    again = notedoc.load(doc.get_update())
    assert notedoc.to_json(again) == notedoc.clean_doc(EVERYTHING)
    # Reading back what was written gives the same document, defaults filled in.
    assert notedoc.clean_doc(notedoc.to_json(again)) == notedoc.to_json(again)


def test_notes12_marks_are_formatting_attributes_like_y_prosemirror():
    doc = notedoc.new_doc("", D(P(T("a", "bold", {"type": "link", "attrs": {"href": "https://x.org"}}), T("b"))))
    paragraph = doc.get("body", type=XmlFragment).children[0]
    text = paragraph.children[0]
    assert isinstance(text, XmlText)
    chunks = text.diff()
    assert chunks[0][0] == "a"
    assert chunks[0][1] == {"bold": {}, "link": {"href": "https://x.org", "target": "_blank",
                                                 "rel": "noopener noreferrer nofollow", "class": None, "title": None}}
    assert chunks[1] == ("b", None)


def test_notes12_attributes_without_none_and_hard_break_between_texts():
    doc = notedoc.new_doc("", D({"type": "codeBlock", "content": [T("x")]},
                                {"type": "heading", "attrs": {"level": 2}, "content": [T("a"), {"type": "hardBreak"},
                                                                                       T("b")]}))
    body = doc.get("body", type=XmlFragment)
    code, heading = body.children[0], body.children[1]
    assert dict(code.attributes) == {}  # language None is left out, as y-prosemirror does
    assert dict(heading.attributes) == {"level": 2, "collapsed": False}
    kinds = [type(child).__name__ if not isinstance(child, XmlElement) else child.tag for child in heading.children]
    assert kinds == ["XmlText", "hardBreak", "XmlText"]


def test_notes12_numbers_written_by_the_browser_read_as_integers():
    doc = Doc()
    body = doc.get("body", type=XmlFragment)
    heading = body.children.append(XmlElement("heading", {"level": 2.0, "collapsed": True}))
    heading.children.append(XmlText("x"))
    assert notedoc.to_json(doc)["content"][0]["attrs"] == {"level": 2, "collapsed": True}


def test_notes12_clean_keeps_words_of_unknown_nodes_and_fixes_shapes():
    dirty = {"type": "doc", "content": [
        {"type": "image", "attrs": {"src": "x"}},
        {"type": "mystery", "content": [T("kept words")]},
        {"type": "bulletList", "content": [P(T("stray"))]},
        {"type": "taskItem", "content": [{"type": "heading", "content": [T("head first")]}]},
        {"type": "table", "content": [{"type": "tableRow", "content": [{"type": "tableCell"}]}]},
        {"type": "heading", "attrs": {"level": 9}, "content": [T("deep")]},
        {"type": "blockquote"},
        P(T("a", "code", "bold", "italic")),
        P(T("line\nbreak")),
    ]}
    clean = notedoc.clean_doc(dirty)
    assert clean["content"] == [
        P(T("kept words")),
        {"type": "bulletList", "content": [{"type": "listItem", "content": [P(T("stray"))]}]},
        {"type": "taskList", "attrs": {"doneToBottom": False}, "content": [
            {"type": "taskItem", "attrs": {"checked": False}, "content": [
                P(), {"type": "heading", "attrs": {"level": 1, "collapsed": False}, "content": [T("head first")]}]}]},
        {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None, "align": None},
             "content": [P()]}]}]},
        {"type": "heading", "attrs": {"level": 3, "collapsed": False}, "content": [T("deep")]},
        {"type": "blockquote", "content": [P()]},
        P(T("a", "code")),  # code excludes every other mark in the schema
        P(T("line"), {"type": "hardBreak"}, T("break")),
    ]
    assert notedoc.clean_doc({}) == D(P())


def test_notes12_clean_flattens_content_nested_too_deep():
    node = P(T("bottom"))
    for _ in range(s.MAX_DEPTH + 5):
        node = {"type": "blockquote", "content": [node]}
    clean = notedoc.clean_doc(D(node))
    depth = 0
    current = clean["content"][0]
    while current["type"] == "blockquote":
        depth += 1
        current = current["content"][0]
    assert depth <= s.MAX_DEPTH + 1
    assert current == P(T("bottom"))


def test_notes3_ec5_title_of_spaces_is_empty():
    assert notedoc.clean_title("   \t ") == ""
    doc = notedoc.new_doc("x")
    assert notedoc.set_title(doc, "    ") == ""
    assert notedoc.title_of(doc) == ""
    assert str(doc.get("title", type=Text)) == ""


def test_notes3_ec7_title_is_cut_at_120_characters():
    long = "x" * 200
    doc = notedoc.new_doc(long)
    assert notedoc.title_of(doc) == "x" * 120
    assert notedoc.set_title(doc, "y" * 121) == "y" * 120
    # A title someone typed longer in the browser is read cut.
    doc.get("title", type=Text).insert(0, "z" * 50)
    assert len(notedoc.title_of(doc)) == 120


def test_notes3_ec10_umlauts_emoji_and_right_to_left_stay():
    title = "Grüße 😀 مرحبا‏"
    doc = notedoc.new_doc(title, D(P(T("Äpfel 🍎 שלום"))))
    again = notedoc.load(doc.get_update())
    assert notedoc.title_of(again) == title
    assert notedoc.to_json(again) == D(P(T("Äpfel 🍎 שלום")))
    notedoc.set_title(again, "Grüße 😀 Welt")
    assert notedoc.title_of(again) == "Grüße 😀 Welt"


def test_notes12_set_title_changes_only_the_differing_part():
    doc = notedoc.new_doc("Einkauf Montag")
    other = notedoc.load(doc.get_update())
    # Someone types at the start while the server changes the end: both stay.
    before = other.get_state()
    other.get("title", type=Text).insert(0, "Neu: ")
    typed = other.get_update(before)
    notedoc.set_title(doc, "Einkauf Dienstag")
    doc.apply_update(typed)
    assert notedoc.title_of(doc) == "Neu: Einkauf Dienstag"


@pytest.mark.parametrize("href", [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>",
    "vbscript:x", "file:///etc/passwd", "//evil.example", "https://", "http:/x", "https://exa mple.com",
    "https://x.org/‮", "mailto:", "", None, 3, "ftp://x.org",
])
def test_notes3_ec8_dangerous_links_are_not_links(href):
    assert notedoc.safe_href(href) is None
    doc = notedoc.new_doc("", D(P(T("click", {"type": "link", "attrs": {"href": href}}))))
    assert notedoc.to_json(doc) == D(P(T("click")))


@pytest.mark.parametrize("href", ["https://example.com/a?b=c#d", "http://x.org", "mailto:someone@example.com", "HTTPS://X.ORG"])
def test_notes3_ec8_safe_links_stay_links_and_open_in_a_new_tab(href):
    doc = notedoc.new_doc("", D(P(T("go", {"type": "link", "attrs": {"href": href, "target": "_self",
                                                                     "rel": "opener"}}))))
    mark = notedoc.to_json(doc)["content"][0]["content"][0]["marks"][0]
    assert mark["attrs"]["href"] == href
    # Target and rel are always the safe defaults, whatever came in.
    assert mark["attrs"]["target"] == "_blank" and mark["attrs"]["rel"] == "noopener noreferrer nofollow"


def test_notes12_highlight_colours_only_from_the_fixed_row():
    doc = notedoc.new_doc("", D(P(T("a", {"type": "highlight", "attrs": {"color": "red; background: url(x)"}}),
                                  T("b", {"type": "highlight", "attrs": {"color": "rose"}}))))
    marks = [node["marks"][0]["attrs"]["color"] for node in notedoc.to_json(doc)["content"][0]["content"]]
    assert marks == [None, "rose"]


def test_notes12_newer_format_is_read_but_not_changed():
    doc = notedoc.new_doc("x")
    doc.get("meta", type=Map)["format"] = 2
    assert notedoc.to_json(doc) == D(P())
    with pytest.raises(notedoc.FormatError):
        notedoc.set_title(doc, "y")
    with pytest.raises(notedoc.FormatError):
        notedoc.change(doc, lambda d: None)


def test_notes12_change_returns_the_update_others_apply():
    doc = notedoc.new_doc("a")
    other = notedoc.load(doc.get_update())
    _, update = notedoc.change(doc, lambda d: notedoc.set_title(d, "b"))
    assert update is not None
    other.apply_update(update)
    assert notedoc.title_of(other) == "b"
    _, nothing = notedoc.change(doc, lambda d: notedoc.set_title(d, "b"))
    assert nothing is None
