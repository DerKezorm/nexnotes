"""NOTES-3 AC-19 on the server: the width of table columns (`colwidth` of the cells, in pixels) stays in the document,
reaches the Yjs document and back, and the Markdown export and the plain text leave it out."""

from __future__ import annotations

from test_notes12_format import D, P, T

from app.notedoc import doc as notedoc
from app.notedoc.markdown import to_markdown, to_plain


def _table(widths: list[list[int] | None]) -> dict:
    def cell(kind: str, text: str, width: list[int] | None) -> dict:
        attrs = {"colspan": 1, "rowspan": 1, "colwidth": width, "align": None}
        return {"type": kind, "attrs": attrs, "content": [P(T(text))]}

    return D({"type": "table", "content": [
        {"type": "tableRow", "content": [cell("tableHeader", h, w) for h, w in zip(["Name", "Qty"], widths)]},
        {"type": "tableRow", "content": [cell("tableCell", c, w) for c, w in zip(["Apples", "3"], widths)]},
    ]})


def _widths(document: dict) -> list[list[int] | None]:
    rows = document["content"][0]["content"]
    return [[cell["attrs"]["colwidth"] for cell in row["content"]] for row in rows][0]


def test_notes3_ac19_column_widths_survive_clean_doc_and_the_yjs_document():
    document = _table([[240], [96]])
    cleaned = notedoc.clean_doc(document)
    assert _widths(cleaned) == [[240], [96]]
    # Into the Yjs document as the browser writes it, and back.
    again = notedoc.to_json(notedoc.from_json(cleaned, "Shopping"))
    assert _widths(again) == [[240], [96]]


def test_notes3_ac19_column_widths_that_make_no_sense_are_dropped():
    document = _table([[-5], ["wide"]])  # type: ignore[list-item]
    assert _widths(notedoc.clean_doc(document)) == [None, None]
    spanning = D({"type": "table", "content": [{"type": "tableRow", "content": [
        {"type": "tableCell", "attrs": {"colspan": 2, "colwidth": [100, 120, 140]}, "content": [P(T("x"))]}]}]})
    cell = notedoc.clean_doc(spanning)["content"][0]["content"][0]["content"][0]
    assert cell["attrs"]["colwidth"] == [100, 120]


def test_notes3_ac19_markdown_and_plain_text_leave_the_widths_out():
    with_widths = _table([[240], [96]])
    without = _table([None, None])
    assert to_markdown(with_widths) == to_markdown(without)
    assert "240" not in to_markdown(with_widths)
    assert to_plain(with_widths) == to_plain(without)
