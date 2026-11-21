"""Changes the server makes to a note (MCP, nexdeck, nextasks, the REST API).

Each function changes the document it gets, in one transaction. Use them through ``doc.change`` (returns the update)
or ``Rooms.change`` (also stores it and passes it to everyone who has the note open)::

    result, update = change(doc, lambda d: append_markdown(d, "- [ ] milk"))
    await rooms.change(note_id, lambda d: toggle_task(d, 0), account_id=account.id)

Appending goes to the end of the text; a last empty paragraph (where the cursor of a new note waits) stays last.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from . import schema as s
from .doc import _read_element, body_of, check_format, clean_doc, set_title, write_blocks
from .markdown import from_markdown, to_markdown

__all__ = ["SHOWN_TASK_TEXT", "Task", "TaskNotFound", "append_markdown", "append_paragraph", "append_task",
           "list_tasks", "replace_markdown", "set_title", "shown_task_text", "toggle_task"]


#: The most characters of a checklist item a program is shown (MCP ``read_note``, the nexdeck card). Ticking with that
#: shortened text still finds the item (``toggle_task``).
SHOWN_TASK_TEXT = 500


def shown_task_text(text: str) -> str:
    """A checklist item's text as programs are shown it: its first ``SHOWN_TASK_TEXT`` characters."""
    return text[:SHOWN_TASK_TEXT]


def _same_task(text: str, expect: str) -> bool:
    """Whether ``expect`` names the item with ``text``: its whole text, or the shortened one a program was shown."""
    expect = expect.strip()
    return text.strip() == expect or (len(text) > SHOWN_TASK_TEXT and shown_task_text(text).strip() == expect)


class TaskNotFound(LookupError):
    """No checklist item at that place, or a different one than expected (the note changed meanwhile)."""


@dataclass
class Task:
    #: Position among all checklist items of the note, in reading order (nested ones included).
    index: int
    text: str
    checked: bool
    #: 0 for an item of a top-level checklist, 1 for one nested in it, and so on.
    depth: int


def _is_empty_paragraph(element: Any) -> bool:
    if not isinstance(element, XmlElement) or element.tag != s.PARAGRAPH:
        return False
    return all(isinstance(child, XmlText) and len(child) == 0 for child in element.children)


def _end(body: XmlFragment) -> int:
    """Where appended blocks go: the end, or before a last empty paragraph."""
    count = len(body.children)
    if count and _is_empty_paragraph(body.children[count - 1]):
        return count - 1
    return count


def append_blocks(doc: Doc, blocks: list[dict[str, Any]]) -> int:
    """Appends ProseMirror blocks (cleaned first); returns how many."""
    check_format(doc)
    cleaned = clean_doc({"type": s.DOC, "content": blocks})["content"]
    body = body_of(doc)
    with doc.transaction():
        write_blocks(body, _end(body), cleaned)
    return len(cleaned)


def append_paragraph(doc: Doc, text: str) -> int:
    """Appends plain text as one paragraph (its line breaks stay line breaks)."""
    return append_blocks(doc, [{"type": s.PARAGRAPH, "content": [{"type": s.TEXT, "text": str(text or "")}]}])


def append_markdown(doc: Doc, markdown: str) -> int:
    """Appends a Markdown snippet (see ``markdown.py`` for what it understands); returns the number of blocks."""
    if len(markdown or "") > s.MAX_MARKDOWN:
        raise ValueError("Markdown too long.")
    blocks = from_markdown(markdown)["content"]
    if len(blocks) == 1 and blocks[0] == {"type": s.PARAGRAPH}:
        return 0
    return append_blocks(doc, blocks)


def _block_markdown(block: dict[str, Any]) -> str:
    return to_markdown({"type": s.DOC, "content": [block]})


def replace_markdown(doc: Doc, markdown: str) -> dict[str, int]:
    """Replaces the whole text by ``markdown`` block by block (the REST API, NOTES-25 AC-17): each block of the
    document and of the new text is compared as Markdown, and what is the same stays exactly as it is, with its Yjs
    identity and everything Markdown cannot say (highlights, folded sections, column widths, attachments, anchors).
    Only blocks that differ go, and the new ones come in their place. The title stays. Returns how many blocks were
    kept, removed and added."""
    if len(markdown or "") > s.MAX_MARKDOWN:
        raise ValueError("Markdown too long.")
    check_format(doc)
    new_blocks = from_markdown(markdown)["content"]
    body = body_of(doc)
    with doc.transaction():
        old = [(index, child) for index, child in enumerate(body.children) if isinstance(child, XmlElement)]
        old_md = [_block_markdown(_read_element(child)) for _index, child in old]
    new_md = [_block_markdown(block) for block in new_blocks]
    counts = {"kept": 0, "removed": 0, "added": 0}
    operations = SequenceMatcher(None, old_md, new_md, autojunk=False).get_opcodes()
    with doc.transaction():
        # From the end: what is changed later in the text never moves what comes before it.
        for operation, old_from, old_to, new_from, new_to in reversed(operations):
            if operation == "equal":
                counts["kept"] += old_to - old_from
                continue
            at = old[old_from][0] if old_from < len(old) else len(body.children)
            for gone in range(old_to - 1, old_from - 1, -1):
                del body.children[old[gone][0]]
                counts["removed"] += 1
            if new_to > new_from:
                write_blocks(body, at, new_blocks[new_from:new_to])
                counts["added"] += new_to - new_from
    return counts


def _paragraph_text(element: XmlElement) -> str:
    parts = []
    for child in element.children:
        if isinstance(child, XmlText):
            parts.extend(chunk for chunk, _attrs in child.diff() if isinstance(chunk, str))
        elif isinstance(child, XmlElement) and child.tag == s.HARD_BREAK:
            parts.append("\n")
    return "".join(parts)


def _task_elements(parent: XmlFragment | XmlElement, depth: int = 0) -> list[tuple[XmlElement, int]]:
    found: list[tuple[XmlElement, int]] = []
    for child in parent.children:
        if not isinstance(child, XmlElement):
            continue
        if child.tag == s.TASK_ITEM:
            found.append((child, depth))
            found.extend(_task_elements(child, depth + 1))
        else:
            found.extend(_task_elements(child, depth))
    return found


def _task_text(item: XmlElement) -> str:
    for child in item.children:
        if isinstance(child, XmlElement) and child.tag == s.PARAGRAPH:
            return _paragraph_text(child)
    return ""


def list_tasks(doc: Doc) -> list[Task]:
    """Every checklist item of the note in reading order."""
    with doc.transaction():
        return [Task(index, _task_text(item), item.attributes.get("checked") is True, depth)
                for index, (item, depth) in enumerate(_task_elements(body_of(doc)))]


def append_task(doc: Doc, text: str, checked: bool = False) -> int:
    """Appends a checklist item: to the checklist at the end of the note, or to a new one. Returns its index."""
    check_format(doc)
    text = str(text or "")[: s.MAX_TASK_TEXT]
    item = {"type": s.TASK_ITEM, "attrs": {"checked": bool(checked)},
            "content": [{"type": s.PARAGRAPH, "content": [{"type": s.TEXT, "text": text}]}]}
    cleaned = clean_doc({"type": s.DOC, "content": [{"type": s.TASK_LIST, "content": [item]}]})["content"][0]
    body = body_of(doc)
    with doc.transaction():
        end = _end(body)
        last = body.children[end - 1] if end else None
        if isinstance(last, XmlElement) and last.tag == s.TASK_LIST:
            new_item = write_blocks(last, len(last.children), cleaned["content"])[0]
        else:
            new_item = write_blocks(body, end, [cleaned])[0].children[0]
        for index, (element, _depth) in enumerate(_task_elements(body)):
            if element == new_item:
                return index
    raise TaskNotFound("The new checklist item is not in the note.")  # pragma: no cover - written just above


def toggle_task(doc: Doc, index: int, checked: bool | None = None, expect: str | None = None) -> bool:
    """Ticks or unticks the checklist item at ``index`` (``list_tasks`` order); ``checked`` sets it, ``None`` flips it.
    With ``expect``, the item's text must still be that text, or begin with it as ``shown_task_text`` shortened it.
    Returns the new state."""
    check_format(doc)
    with doc.transaction():
        items = _task_elements(body_of(doc))
        if not 0 <= index < len(items):
            raise TaskNotFound(f"No checklist item {index}.")
        item = items[index][0]
        if expect is not None and not _same_task(_task_text(item), str(expect)):
            raise TaskNotFound(f"Checklist item {index} is a different one now.")
        current = item.attributes.get("checked") is True
        wanted = (not current) if checked is None else bool(checked)
        if wanted != current:
            item.attributes["checked"] = wanted
        return wanted
