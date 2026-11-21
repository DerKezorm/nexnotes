"""A note's document: made, loaded, read as ProseMirror JSON, written from it.

ProseMirror JSON uses the Tiptap names (``{"type": "doc", "content": [...]}``). Reading and writing follow
``y-prosemirror`` exactly: a node is an ``XmlElement`` with its non-``None`` attributes, adjacent text is one
``XmlText`` whose runs carry the marks as formatting attributes (``{"bold": {}}``), a hard break is an element between
two texts.

Everything written passes ``clean_doc`` first, so the server never puts a node into a note that the browser's schema
refuses (the browser would drop it, and with it what is inside).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import urlsplit

from pycrdt import Doc, Map, Text, XmlElement, XmlFragment, XmlText, merge_updates

from . import schema as s


class FormatError(ValueError):
    """The document has a newer format than this server knows; it is read, but not changed."""


# --- Making and loading -------------------------------------------------------------------------------------------


def new_doc(title: str = "", content: dict[str, Any] | None = None, *, client_id: int | None = None) -> Doc:
    """A new note's document: the title, the text (an empty paragraph unless ``content`` is given) and the format."""
    doc = Doc(client_id=client_id) if client_id is not None else Doc()
    body, title_text, meta = shared(doc)
    with doc.transaction():
        meta["format"] = s.FORMAT
        cleaned = clean_title(title)
        if cleaned:
            title_text.insert(0, cleaned)
        write_blocks(body, 0, clean_doc(content)["content"])
    return doc


def load(state: bytes | None, updates: Iterable[bytes] = (), *, client_id: int | None = None) -> Doc:
    """A document from what is stored: the folded state and every update after it, in order. Every loaded document
    writes under a new client id (the default, random) unless one is given."""
    doc = Doc(client_id=client_id) if client_id is not None else Doc()
    shared(doc)
    if state:
        doc.apply_update(state)
    for update in updates:
        doc.apply_update(update)
    return doc


def shared(doc: Doc) -> tuple[XmlFragment, Text, Map]:
    """The three shared types of a note: ``body``, ``title``, ``meta``."""
    return doc.get(s.BODY, type=XmlFragment), doc.get(s.TITLE, type=Text), doc.get(s.META, type=Map)


def body_of(doc: Doc) -> XmlFragment:
    return doc.get(s.BODY, type=XmlFragment)


def format_of(doc: Doc) -> int:
    value = doc.get(s.META, type=Map).get("format")
    return int(value) if isinstance(value, (int, float)) else s.FORMAT


def check_format(doc: Doc) -> None:
    if format_of(doc) > s.FORMAT:
        raise FormatError(f"Note format {format_of(doc)} is newer than {s.FORMAT}.")


@contextmanager
def recording(doc: Doc) -> Iterator[list[bytes]]:
    """Runs the block in one transaction and collects the update it made (empty when it changed nothing)::

        with recording(doc) as made:
            append_paragraph(doc, "Hi")
        update = merged(made)
    """
    made: list[bytes] = []

    def seen(event: Any) -> None:
        if event.before_state != event.after_state or event.delete_set not in (b"", b"\x00"):
            made.append(event.update)

    subscription = doc.observe(seen)
    try:
        with doc.transaction():
            yield made
    finally:
        doc.unobserve(subscription)


def merged(updates: list[bytes]) -> bytes | None:
    if not updates:
        return None
    return updates[0] if len(updates) == 1 else merge_updates(*updates)


def change(doc: Doc, edit: Callable[[Doc], Any]) -> tuple[Any, bytes | None]:
    """Applies ``edit`` in one transaction; returns its result and the update to store and pass on."""
    check_format(doc)
    with recording(doc) as made:
        result = edit(doc)
    return result, merged(made)


def state_tag(doc: Doc) -> str:
    """The state of the document as a short text (the ``etag`` of the API, NOTES-25 AC-9): the same for the same
    content wherever the document was loaded, different after any change. The state vector alone would miss a change
    that only deletes (Yjs counts no new clock for it); the update against the own state vector holds exactly the
    deletions, so both together say everything."""
    vector = doc.get_state()
    return hashlib.sha256(vector + doc.get_update(vector)).hexdigest()[:32]


# --- Title --------------------------------------------------------------------------------------------------------

_SPACES = re.compile(r"[\r\n\t\v\f  ]+")


def clean_title(title: str | None) -> str:
    """One line, no control characters, at most ``MAX_TITLE`` characters; only spaces counts as empty (NOTES-3
    EC-5, EC-7). Right-to-left marks and emoji stay (EC-10)."""
    if not title:
        return ""
    text = _SPACES.sub(" ", unicodedata.normalize("NFC", str(title)))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cc")
    text = text.strip()
    if len(text) > s.MAX_TITLE:
        text = text[: s.MAX_TITLE].rstrip()
    return text


def title_of(doc: Doc) -> str:
    """The title as the server keeps it in its column: cleaned and cut, whatever the live text holds."""
    return clean_title(str(doc.get(s.TITLE, type=Text)))


def set_title(doc: Doc, title: str) -> str:
    """Replaces the title, changing only the part that differs (someone typing in it at the same time keeps their
    place). Returns the cleaned title."""
    check_format(doc)
    wanted = clean_title(title)
    text = doc.get(s.TITLE, type=Text)
    with doc.transaction():
        current = str(text)
        if current == wanted:
            return wanted
        start = 0
        while start < min(len(current), len(wanted)) and current[start] == wanted[start]:
            start += 1
        end = 0
        while (end < min(len(current), len(wanted)) - start
               and current[len(current) - 1 - end] == wanted[len(wanted) - 1 - end]):
            end += 1
        # pycrdt counts positions in UTF-8 bytes.
        at = _u8(current[:start])
        gone = _u8(current[start: len(current) - end])
        if gone:
            del text[at: at + gone]
        new = wanted[start: len(wanted) - end]
        if new:
            text.insert(at, new)
    return wanted


def _u8(text: str) -> int:
    return len(text.encode("utf-8"))


# --- Links --------------------------------------------------------------------------------------------------------


def safe_href(href: Any) -> str | None:
    """The link target when it may be a link (http, https with a host, mailto), else ``None`` (NOTES-3 EC-8)."""
    if not isinstance(href, str):
        return None
    href = href.strip()
    if not href or len(href) > s.MAX_HREF:
        return None
    if any(ord(ch) < 0x21 or ord(ch) == 0x7F or unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") for ch in href):
        return None
    try:
        parts = urlsplit(href)
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in s.LINK_SCHEMES:
        return None
    if scheme in ("http", "https") and not parts.netloc:
        return None
    if scheme == "mailto" and len(href) <= len("mailto:"):
        return None
    return href


# --- Cleaning ProseMirror JSON ------------------------------------------------------------------------------------

_LANGUAGE = re.compile(r"^[A-Za-z0-9_+#.-]{1,40}$")
_ATTACHMENT_ID = re.compile(s.ATTACHMENT_ID)
_ORDER_TYPES = frozenset({"1", "a", "A", "i", "I"})
_ALIGN = frozenset({"left", "center", "right"})


def _number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def _flag(value: Any) -> bool:
    return value is True or value == "true" or value == 1


def _clean_node_attrs(kind: str, attrs: Any) -> dict[str, Any]:
    given = attrs if isinstance(attrs, dict) else {}
    out = dict(s.NODE_ATTRS.get(kind, {}))
    if kind == s.HEADING:
        level = _number(given.get("level"))
        out["level"] = min(max(level if level is not None else 1, 1), 3)
        out["collapsed"] = _flag(given.get("collapsed"))
    elif kind == s.ORDERED_LIST:
        start = _number(given.get("start"))
        out["start"] = start if start is not None and 0 <= start <= 1_000_000 else 1
        out["type"] = given.get("type") if given.get("type") in _ORDER_TYPES else None
    elif kind == s.TASK_LIST:
        out["doneToBottom"] = _flag(given.get("doneToBottom"))
    elif kind == s.TASK_ITEM:
        out["checked"] = _flag(given.get("checked"))
    elif kind in s.CELLS:
        for key in ("colspan", "rowspan"):
            span = _number(given.get(key))
            out[key] = span if span is not None and 1 <= span <= 100 else 1
        widths = given.get("colwidth")
        if isinstance(widths, list) and widths and all(_number(w) is not None and 0 <= _number(w) <= 10_000
                                                         for w in widths):
            out["colwidth"] = [_number(w) for w in widths][: out["colspan"]]
        out["align"] = given.get("align") if given.get("align") in _ALIGN else None
    elif kind == s.CODE_BLOCK:
        language = given.get("language")
        out["language"] = language if isinstance(language, str) and _LANGUAGE.match(language) else None
    return out


def attachment_id(value: Any) -> str | None:
    """An attachment's id as a document may carry it (NOTES-10), else ``None``: never a path, never anything else."""
    return value if isinstance(value, str) and _ATTACHMENT_ID.match(value) else None


def clean_label(value: Any, limit: int) -> str | None:
    """A name or a line of a link card: one line, no control characters, at most ``limit`` characters; empty is
    ``None``."""
    if not isinstance(value, str):
        return None
    text = _SPACES.sub(" ", unicodedata.normalize("NFC", value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cc").strip()
    return text[:limit].rstrip() or None


def _clean_atom(kind: str, attrs: Any) -> dict[str, Any] | None:
    """The attributes of an attachment's block (NOTES-10), or ``None`` when it names nothing it may: a picture or file
    without a valid id, a card without an http(s) target."""
    given = attrs if isinstance(attrs, dict) else {}
    out = dict(s.NODE_ATTRS[kind])
    if kind == s.LINK_PREVIEW:
        href = safe_href(given.get("href"))
        if href is None or urlsplit(href).scheme.lower() not in ("http", "https"):
            return None
        out["href"] = href
        out["title"] = clean_label(given.get("title"), s.MAX_CARD_TITLE)
        out["description"] = clean_label(given.get("description"), s.MAX_CARD_TEXT)
        out["site"] = clean_label(given.get("site"), s.MAX_NAME)
        out["image"] = attachment_id(given.get("image"))
        return out
    found = attachment_id(given.get("id"))
    if found is None:
        return None
    out["id"] = found
    out["name"] = clean_label(given.get("name"), s.MAX_NAME)
    if kind == s.IMAGE:
        out["size"] = given.get("size") if given.get("size") in s.IMAGE_SIZES else s.IMAGE_SIZES[0]
    elif kind == s.DRAWING:
        # The sketch itself (NOTES-18) is a second attachment; without it the sketch is a picture only.
        out["data"] = attachment_id(given.get("data"))
    elif kind == s.RECORDING:
        duration = _number(given.get("duration"))
        out["duration"] = duration if duration is not None and 0 <= duration <= s.MAX_DURATION else None
        out["transcript"] = attachment_id(given.get("transcript"))
    return out


def _named_ids(kind: str, attrs: dict[str, Any]) -> list[Any]:
    """The attributes of a block that name attachments, in this order: a card its picture, a sketch its picture and
    its data, a recording its sound and its transcript, any other block its id."""
    if kind == s.LINK_PREVIEW:
        return [attrs.get("image")]
    if kind == s.DRAWING:
        return [attrs.get("id"), attrs.get("data")]
    if kind == s.RECORDING:
        return [attrs.get("id"), attrs.get("transcript")]
    return [attrs.get("id")]


def clean_marks(marks: Any) -> list[dict[str, Any]]:
    """Known marks only, with known attributes, in the schema's order; a link without a safe target is dropped, and
    ``code`` keeps no other mark (it excludes them in the schema)."""
    found: dict[str, dict[str, Any]] = {}
    for mark in marks if isinstance(marks, list) else []:
        kind = mark.get("type") if isinstance(mark, dict) else None
        if kind not in s.MARK_ATTRS:
            continue
        given = mark.get("attrs") if isinstance(mark.get("attrs"), dict) else {}
        attrs = dict(s.MARK_ATTRS[kind])
        if kind == s.LINK:
            href = safe_href(given.get("href"))
            if href is None:
                continue
            attrs["href"] = href
            title = given.get("title")
            attrs["title"] = title[:500] if isinstance(title, str) and title else None
        elif kind == s.HIGHLIGHT:
            attrs["color"] = given.get("color") if given.get("color") in s.HIGHLIGHT_COLORS else None
        found[kind] = attrs
    if s.CODE in found:
        found = {s.CODE: found[s.CODE]}
    return [{"type": kind, "attrs": found[kind]} if found[kind] else {"type": kind}
            for kind in s.MARKS if kind in found]


def _clean_text(text: Any) -> str:
    if not isinstance(text, str):
        return ""
    return "".join(ch for ch in text if ch in "\t\n" or unicodedata.category(ch) != "Cc")


def _plain_text_of(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    if node.get("type") == s.TEXT:
        return _clean_text(node.get("text"))
    if node.get("type") == s.HARD_BREAK:
        return "\n"
    return "".join(_plain_text_of(child) for child in node.get("content") or [] if isinstance(child, dict))


def _clean_inline(content: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in content if isinstance(content, list) else []:
        if not isinstance(node, dict):
            continue
        kind = node.get("type")
        if kind == s.HARD_BREAK:
            out.append({"type": s.HARD_BREAK})
        elif kind == s.TEXT:
            text = _clean_text(node.get("text"))
            marks = clean_marks(node.get("marks"))
            for index, line in enumerate(text.split("\n")):
                if index:
                    out.append({"type": s.HARD_BREAK})
                if line:
                    out.append({"type": s.TEXT, "text": line, **({"marks": marks} if marks else {})})
        else:
            # Something inline the schema does not know (an image from a later format): keep its words.
            text = _plain_text_of(node)
            if text:
                out.extend(_clean_inline([{"type": s.TEXT, "text": text}]))
    return _join_text(out)


def _join_text(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    joined: list[dict[str, Any]] = []
    for node in nodes:
        if (joined and node.get("type") == s.TEXT and joined[-1].get("type") == s.TEXT
                and joined[-1].get("marks") == node.get("marks")):
            joined[-1] = {**joined[-1], "text": joined[-1]["text"] + node["text"]}
        else:
            joined.append(node)
    return joined


def _paragraph(inline: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"type": s.PARAGRAPH, "content": inline} if inline else {"type": s.PARAGRAPH}


def _clean_blocks(content: Any, depth: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in content if isinstance(content, list) else []:
        out.extend(_clean_block(node, depth))
    return out


def _flat(node: Any) -> list[dict[str, Any]]:
    """Content nested too deep: its words as paragraphs."""
    text = _plain_text_of(node)
    return [_paragraph(_clean_inline([{"type": s.TEXT, "text": line}])) for line in text.split("\n") if line.strip()]


def _with_attrs(kind: str, attrs: dict[str, Any], content: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": kind}
    if attrs:
        node["attrs"] = attrs
    if content:
        node["content"] = content
    return node


def _clean_block(node: Any, depth: int) -> list[dict[str, Any]]:
    if not isinstance(node, dict):
        return []
    kind = node.get("type")
    if depth > s.MAX_DEPTH:
        return _flat(node)
    attrs = _clean_node_attrs(kind, node.get("attrs")) if kind in s.NODE_ATTRS else {}
    content = node.get("content")
    if kind in s.TEXTBLOCKS:
        return [_with_attrs(kind, attrs, _clean_inline(content))]
    if kind in (s.TEXT, s.HARD_BREAK):
        return [_paragraph(_clean_inline([node]))]
    if kind == s.CODE_BLOCK:
        text = _plain_text_of(node)
        return [_with_attrs(kind, attrs, [{"type": s.TEXT, "text": text}] if text else None)]
    if kind == s.HORIZONTAL_RULE:
        return [{"type": s.HORIZONTAL_RULE}]
    if kind in s.ATOMS:
        atom = _clean_atom(kind, node.get("attrs"))
        return [{"type": kind, "attrs": atom}] if atom is not None else []
    if kind == s.BLOCKQUOTE:
        return [_with_attrs(kind, attrs, _clean_blocks(content, depth + 1) or [_paragraph()])]
    if kind in s.LISTS:
        item_kind = s.LISTS[kind]
        items: list[dict[str, Any]] = []
        for child in content if isinstance(content, list) else []:
            if isinstance(child, dict) and child.get("type") in (s.LIST_ITEM, s.TASK_ITEM):
                items.append(_clean_item(item_kind, child, depth + 1))
            else:
                # A stray block in a list becomes an item of its own.
                items.append(_clean_item(item_kind, {"type": item_kind, "content": [child]}, depth + 1))
        return [_with_attrs(kind, attrs, items)] if items else []
    if kind in (s.LIST_ITEM, s.TASK_ITEM):
        # An item outside a list: a list around it.
        outer = s.TASK_LIST if kind == s.TASK_ITEM else s.BULLET_LIST
        return _clean_block({"type": outer, "content": [node]}, depth)
    if kind == s.TABLE:
        rows = []
        for row in content if isinstance(content, list) else []:
            if not isinstance(row, dict) or row.get("type") != s.TABLE_ROW:
                continue
            cells = []
            for cell in row.get("content") or []:
                if isinstance(cell, dict) and cell.get("type") in s.CELLS:
                    cell_kind = cell["type"]
                    cells.append(_with_attrs(cell_kind, _clean_node_attrs(cell_kind, cell.get("attrs")),
                                             _clean_blocks(cell.get("content"), depth + 2) or [_paragraph()]))
            rows.append({"type": s.TABLE_ROW, "content": cells} if cells else {"type": s.TABLE_ROW})
        return [{"type": s.TABLE, "content": rows}] if any(row.get("content") for row in rows) else []
    if kind in (s.TABLE_ROW, *s.CELLS):
        # A row or cell outside a table: its words.
        return _flat(node)
    # A node the schema does not know: what it holds, as blocks if it holds blocks, else as text.
    if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") not in (s.TEXT, s.HARD_BREAK)
                                         for c in content):
        return _clean_blocks(content, depth + 1)
    inline = _clean_inline(content) if isinstance(content, list) else []
    return [_paragraph(inline)] if inline else []


def _clean_item(kind: str, node: dict[str, Any], depth: int) -> dict[str, Any]:
    attrs = _clean_node_attrs(kind, node.get("attrs"))
    if kind == s.TASK_ITEM and node.get("type") == s.LIST_ITEM:
        attrs = dict(s.NODE_ATTRS[s.TASK_ITEM])
    blocks = _clean_blocks(node.get("content"), depth)
    if not blocks or blocks[0].get("type") != s.PARAGRAPH:
        blocks.insert(0, _paragraph())
    return _with_attrs(kind, attrs, blocks)


def clean_doc(document: Any) -> dict[str, Any]:
    """A ProseMirror document the browser's schema accepts: unknown nodes and marks gone (their words kept), unsafe
    links plain, attributes within their range, never empty."""
    content = document.get("content") if isinstance(document, dict) else None
    if isinstance(document, list):
        content = document
    blocks = _clean_blocks(content, 0)
    return {"type": s.DOC, "content": blocks or [_paragraph()]}


# --- Writing into the document ------------------------------------------------------------------------------------


def _element_attrs(kind: str, attrs: dict[str, Any]) -> dict[str, Any]:
    """The element's attributes as ``y-prosemirror`` writes them: every attribute of the schema, ``None`` left out."""
    full = {**s.NODE_ATTRS.get(kind, {}), **(attrs or {})}
    return {key: value for key, value in full.items() if value is not None}


def _mark_attributes(marks: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {mark["type"]: {**s.MARK_ATTRS.get(mark["type"], {}), **(mark.get("attrs") or {})} for mark in marks or []}


def write_blocks(parent: XmlFragment | XmlElement, index: int, blocks: list[dict[str, Any]]) -> list[XmlElement]:
    """Inserts cleaned blocks (``clean_doc(...)["content"]`` or parts of it) at ``index`` of ``parent``."""
    made = []
    for offset, block in enumerate(blocks):
        made.append(_write_node(parent, index + offset, block))
    return made


def _write_node(parent: XmlFragment | XmlElement, index: int, node: dict[str, Any]) -> XmlElement:
    kind = node["type"]
    element = parent.children.insert(index, XmlElement(kind, _element_attrs(kind, node.get("attrs") or {})))
    content = node.get("content") or []
    if kind in s.TEXTBLOCKS or kind == s.CODE_BLOCK:
        write_inline(element, content)
    else:
        for position, child in enumerate(content):
            _write_node(element, position, child)
    return element


def write_inline(element: XmlElement, content: list[dict[str, Any]]) -> None:
    """Appends inline content (text runs and hard breaks) to a text block."""
    text: XmlText | None = None
    at = 0
    for node in content:
        if node.get("type") == s.HARD_BREAK:
            element.children.append(XmlElement(s.HARD_BREAK))
            text = None
            continue
        if node.get("type") != s.TEXT or not node.get("text"):
            continue
        if text is None:
            text = element.children.append(XmlText())
            at = 0
        text.insert(at, node["text"], _mark_attributes(node.get("marks")))
        at += _u8(node["text"])


# --- Repairing the shape ------------------------------------------------------------------------------------------

_NEEDS_BLOCK = frozenset({s.BLOCKQUOTE, s.TABLE_CELL, s.TABLE_HEADER})
_ITEMS = frozenset({s.LIST_ITEM, s.TASK_ITEM})


def repair(doc: Doc, blocks: Iterable[int] | None = None) -> int:
    """Fixes shapes the browser's schema refuses and concurrent changes can leave behind (two people deleting the last
    items of a checklist, a cell emptied from two sides). The browser would drop such a node and what is in it; the
    server adds what is missing instead: an empty item, an empty paragraph. Only a table without rows goes. With
    ``blocks``, only those top-level blocks are looked at (the ones a change touched). Returns the number of fixes;
    call it inside the transaction whose update carries them."""
    body = body_of(doc)
    fixes = 0
    with doc.transaction():
        if blocks is None:
            fixes += _repair_children(body)
        else:
            # From the last to the first, so a table that goes does not move the others.
            for index in sorted(set(blocks), reverse=True):
                if 0 <= index < len(body.children):
                    fixed, _gone = _repair_child(body, index)
                    fixes += fixed
        if len(body.children) == 0:
            body.children.append(XmlElement(s.PARAGRAPH))
            fixes += 1
    return fixes


def _elements(parent: XmlFragment | XmlElement) -> list[XmlElement]:
    return [child for child in parent.children if isinstance(child, XmlElement)]


def _repair_children(parent: XmlFragment | XmlElement) -> int:
    fixes = 0
    index = 0
    while index < len(parent.children):
        fixed, gone = _repair_child(parent, index)
        fixes += fixed
        if not gone:
            index += 1
    return fixes


def _repair_child(parent: XmlFragment | XmlElement, index: int) -> tuple[int, bool]:
    """Mends one child and what is inside it; returns the fixes and whether the child went."""
    child = parent.children[index]
    if not isinstance(child, XmlElement):
        return 0, False
    tag = child.tag or ""
    if tag in s.TEXTBLOCKS or tag in (s.CODE_BLOCK, s.HORIZONTAL_RULE, s.HARD_BREAK) or tag in s.ATOMS:
        return 0, False
    fixes = _repair_children(child)
    if tag in s.LISTS and not _elements(child):
        item = child.children.append(XmlElement(s.LISTS[tag], _element_attrs(s.LISTS[tag], {})))
        item.children.append(XmlElement(s.PARAGRAPH))
        return fixes + 1, False
    if tag in _ITEMS:
        first = _elements(child)
        if not first or first[0].tag != s.PARAGRAPH:
            child.children.insert(0, XmlElement(s.PARAGRAPH))
            return fixes + 1, False
    elif tag in _NEEDS_BLOCK and not _elements(child):
        child.children.append(XmlElement(s.PARAGRAPH))
        return fixes + 1, False
    elif tag == s.TABLE and not any(row.tag == s.TABLE_ROW for row in _elements(child)):
        del parent.children[index]
        return fixes + 1, True
    return fixes, False


# --- Reading the document -----------------------------------------------------------------------------------------


def _plain_value(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_plain_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain_value(v) for k, v in value.items()}
    return value


def _strip_overlap(name: str) -> str:
    # y-prosemirror names a mark that may overlap itself "name--hash".
    return name.split("--", 1)[0]


def _read_text(text: XmlText) -> list[dict[str, Any]]:
    out = []
    for chunk, attributes in text.diff():
        if not isinstance(chunk, str) or not chunk:
            continue
        marks = []
        for name, value in sorted((attributes or {}).items()):
            if value is None:
                continue
            kind = _strip_overlap(name)
            attrs = _plain_value(value) if isinstance(value, dict) else {}
            full = {**s.MARK_ATTRS.get(kind, {}), **attrs}
            marks.append({"type": kind, "attrs": full} if full else {"type": kind})
        marks.sort(key=lambda mark: s.MARKS.index(mark["type"]) if mark["type"] in s.MARKS else len(s.MARKS))
        out.append({"type": s.TEXT, "text": chunk, **({"marks": marks} if marks else {})})
    return out


def _read_element(element: XmlElement) -> dict[str, Any]:
    kind = element.tag or ""
    given = {key: _plain_value(value) for key, value in element.attributes}
    attrs = {**s.NODE_ATTRS[kind], **{k: v for k, v in given.items() if k in s.NODE_ATTRS[kind]}} \
        if kind in s.NODE_ATTRS else given
    node: dict[str, Any] = {"type": kind}
    if attrs:
        node["attrs"] = attrs
    content = _read_children(element)
    if content:
        node["content"] = content
    return node


def _read_children(parent: XmlFragment | XmlElement) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for child in parent.children:
        if isinstance(child, XmlText):
            out.extend(_read_text(child))
        elif isinstance(child, XmlElement):
            out.append(_read_element(child))
    return _join_text(out)


def to_json(doc: Doc) -> dict[str, Any]:
    """The body as ProseMirror JSON, the way the browser reads it (defaults filled in, marks in schema order). Not
    cleaned: pass it through ``clean_doc`` before trusting its shape."""
    with doc.transaction():
        return {"type": s.DOC, "content": _read_children(body_of(doc))}


def attachment_refs(source: Doc | dict[str, Any]) -> list[str]:
    """The ids of the attachments a note names (NOTES-10), in the order of the text, each once: pictures, files, the
    pictures of link cards, sketches with their data and recordings with their transcripts (NOTES-18). Only ids of the
    right shape; the rest is no attachment."""
    document = to_json(source) if isinstance(source, Doc) else source
    found: dict[str, None] = {}
    stack = list(reversed(document.get("content") or [])) if isinstance(document, dict) else []
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        kind = node.get("type")
        if kind in s.ATOMS:
            attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
            for value in _named_ids(kind, attrs):
                found_id = attachment_id(value)
                if found_id:
                    found.setdefault(found_id)
            continue
        stack.extend(reversed(node.get("content") or []))
    return list(found)


def from_json(document: dict[str, Any], title: str = "") -> Doc:
    """A new note's document from ProseMirror JSON (an import, a copy)."""
    return new_doc(title, document)
