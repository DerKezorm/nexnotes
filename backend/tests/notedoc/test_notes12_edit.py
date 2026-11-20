"""Changes the server makes: title, paragraph, Markdown snippet, checklist items."""

from __future__ import annotations

import pytest
from test_notes12_format import D, P, T

from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_markdown


def test_notes12_append_paragraph_goes_before_the_last_empty_paragraph():
    doc = notedoc.new_doc("x")
    assert edit.append_paragraph(doc, "first line\nsecond line") == 1
    assert notedoc.to_json(doc) == D(P(T("first line"), {"type": "hardBreak"}, T("second line")), P())
    edit.append_paragraph(doc, "more")
    assert notedoc.to_json(doc)["content"][1] == P(T("more"))


def test_notes12_append_markdown_adds_the_snippet_at_the_end():
    doc = notedoc.new_doc("x", D(P(T("start"))))
    count = edit.append_markdown(doc, "## Neu\n\n- [ ] Milch\n- [x] Brot\n\n[link](javascript:alert(1))")
    assert count == 3
    assert to_markdown(doc) == "start\n\n## Neu\n\n- [ ] Milch\n- [x] Brot\n\nlink\n"
    assert edit.append_markdown(doc, "   ") == 0
    with pytest.raises(ValueError):
        edit.append_markdown(doc, "x" * (600 * 1024))


def test_notes12_append_task_joins_the_checklist_at_the_end():
    doc = notedoc.new_doc("x", D(P(T("intro"))))
    assert edit.append_task(doc, "Milch") == 0
    assert edit.append_task(doc, "Brot", checked=True) == 1
    assert [block["type"] for block in notedoc.to_json(doc)["content"]] == ["paragraph", "taskList"]
    edit.append_paragraph(doc, "between")
    assert edit.append_task(doc, "Eier") == 2
    assert [block["type"] for block in notedoc.to_json(doc)["content"]] == ["paragraph", "taskList", "paragraph",
                                                                            "taskList"]
    assert [(t.index, t.text, t.checked) for t in edit.list_tasks(doc)] == [
        (0, "Milch", False), (1, "Brot", True), (2, "Eier", False)]


def test_notes12_toggle_task_flips_sets_and_checks_the_text():
    doc = notedoc.new_doc("x", D({"type": "taskList", "content": [
        {"type": "taskItem", "content": [P(T("a")), {"type": "taskList", "content": [
            {"type": "taskItem", "content": [P(T("a1"))]}]}]},
        {"type": "taskItem", "attrs": {"checked": True}, "content": [P(T("b"))]}]}))
    assert [(t.text, t.depth) for t in edit.list_tasks(doc)] == [("a", 0), ("a1", 1), ("b", 0)]
    assert edit.toggle_task(doc, 1) is True
    assert edit.toggle_task(doc, 1) is False
    assert edit.toggle_task(doc, 2, checked=True) is True
    assert edit.toggle_task(doc, 0, expect="a") is True
    with pytest.raises(edit.TaskNotFound):
        edit.toggle_task(doc, 0, expect="something else")
    with pytest.raises(edit.TaskNotFound):
        edit.toggle_task(doc, 3)
    assert [t.checked for t in edit.list_tasks(doc)] == [True, False, True]


def test_notes12_server_changes_travel_as_one_update():
    doc = notedoc.new_doc("x")
    other = notedoc.load(doc.get_update())
    _, update = notedoc.change(doc, lambda d: (notedoc.set_title(d, "Einkauf"), edit.append_task(d, "Milch")))
    other.apply_update(update)
    assert notedoc.title_of(other) == "Einkauf"
    assert [t.text for t in edit.list_tasks(other)] == ["Milch"]


def test_notes12_ac7_two_items_ticked_at_the_same_time_are_both_ticked():
    base = notedoc.new_doc("x", D({"type": "taskList", "content": [
        {"type": "taskItem", "content": [P(T("a"))]}, {"type": "taskItem", "content": [P(T("b"))]}]}))
    one = notedoc.load(base.get_update())
    two = notedoc.load(base.get_update())
    _, first = notedoc.change(one, lambda d: edit.toggle_task(d, 0))
    _, second = notedoc.change(two, lambda d: edit.toggle_task(d, 1))
    one.apply_update(second)
    two.apply_update(first)
    assert [t.checked for t in edit.list_tasks(one)] == [True, True]
    assert notedoc.to_json(one) == notedoc.to_json(two)
