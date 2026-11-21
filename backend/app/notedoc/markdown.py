"""A note as Markdown and as plain text, and Markdown snippets into a note.

Markdown (export, MCP) is CommonMark with the GitHub additions:

* headings ``#`` to ``###``; a folded heading is written like any other (folding is a view, not content);
* lists ``-``, ``1.``; checklists ``- [ ]`` and ``- [x]``; nesting by indentation;
* tables as pipe tables, the first row as the header (``<br>`` for a line break inside a cell);
* quotes ``>``, fenced code with its language, ``---`` for a rule, a hard break as a backslash at the end of a line;
* bold ``**``, italic ``*``, strike ``~~``, code in backticks, links ``[text](href)``.
* attachments (NOTES-10): a picture as ``![name](attachment:<id>)``, any other file as ``[name](attachment:<id>)``, each
  on a line of its own; a link card as the link ``[title](href)``. Whoever writes the files next to the Markdown (the
  export) gives ``attachment_href`` and the address of each file goes there instead. Read back, such a line is the
  picture or file again.
* Underline and highlight have no Markdown of their own; they are written as the HTML most renderers show:
  ``<u>text</u>`` and ``<mark>text</mark>`` (``<mark data-color="green">`` for a colour other than the default). Reading
  Markdown, ``==text==`` (as Obsidian writes it) is a highlight too.

Reading Markdown (``from_markdown``), a single line break inside a paragraph is a line break in the note, not a space:
a snippet from MCP or nexdeck means its lines.

Plain text (search, preview) has the words only: one block per line, table cells separated by a tab, no markers; an
attachment by its name, a link card by its title, description and address.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

from pycrdt import Doc

from . import schema as s
from .doc import clean_doc, clean_title, safe_href, to_json

#: The address of an attachment in Markdown: ``(id, name) -> href``.
AttachmentHref = Callable[[str, str | None], str]
#: The scheme of an attachment's address when nobody gives another one.
ATTACHMENT_SCHEME = "attachment:"
_href_of: ContextVar[AttachmentHref | None] = ContextVar("attachment_href", default=None)

# --- Writing Markdown ---------------------------------------------------------------------------------------------


def _document(source: Doc | dict[str, Any]) -> dict[str, Any]:
    return clean_doc(to_json(source) if isinstance(source, Doc) else source)


def to_markdown(source: Doc | dict[str, Any], *, title: str | None = None,
                attachment_href: AttachmentHref | None = None) -> str:
    """The note as Markdown. With ``title``, it comes first as a level-one heading. ``attachment_href`` gives the
    address of each attachment (``attachment:<id>`` without it)."""
    token = _href_of.set(attachment_href)
    try:
        lines = _blocks_md(_document(source)["content"])
    finally:
        _href_of.reset(token)
    head = clean_title(title) if title else ""
    if head:
        lines = ["# " + _escape(head, line_start=True), "", *lines]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines) + "\n" if lines else ""


def _blocks_md(blocks: list[dict[str, Any]], tight: bool = False) -> list[str]:
    out: list[str] = []
    for index, block in enumerate(blocks):
        lines = _block_md(block)
        if index and not (tight and block["type"] in s.LISTS):
            out.append("")
        out.extend(lines)
    return out


def _block_md(block: dict[str, Any]) -> list[str]:
    kind = block["type"]
    attrs = block.get("attrs") or {}
    content = block.get("content") or []
    if kind == s.PARAGRAPH:
        return _inline_md(content).split("\n")
    if kind == s.HEADING:
        text = _inline_md(content, breaks=" ")
        return ["#" * int(attrs.get("level", 1)) + (" " + text if text else "")]
    if kind == s.BLOCKQUOTE:
        return [("> " + line) if line else ">" for line in _blocks_md(content)]
    if kind == s.CODE_BLOCK:
        text = "".join(node.get("text", "") for node in content)
        longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
        fence = "`" * max(3, longest + 1)
        return [fence + (attrs.get("language") or ""), *(text.split("\n") if text else []), fence]
    if kind == s.HORIZONTAL_RULE:
        return ["---"]
    if kind in s.LISTS:
        return _list_md(kind, attrs, content)
    if kind == s.TABLE:
        return _table_md(content)
    if kind in (s.IMAGE, s.ATTACHMENT):
        name = attrs.get("name") or ""
        made = _href_of.get()
        href = made(attrs["id"], attrs.get("name")) if made else ATTACHMENT_SCHEME + attrs["id"]
        return [("!" if kind == s.IMAGE else "") + "[" + _escape(name) + "](" + _destination(href) + ")"]
    if kind == s.LINK_PREVIEW:
        href = attrs.get("href") or ""
        return ["[" + _escape(attrs.get("title") or href) + "](" + _destination(href) + ")"]
    return []


def _destination(href: str) -> str:
    """A link's target as Markdown reads it back: in angle brackets when it holds spaces."""
    if re.search(r"\s", href):
        return "<" + re.sub(r"([<>\\])", r"\\\1", href) + ">"
    return re.sub(r"([()\\<>])", r"\\\1", href)


def _list_md(kind: str, attrs: dict[str, Any], items: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    number = int(attrs.get("start", 1)) if kind == s.ORDERED_LIST else 0
    for item in items:
        if kind == s.ORDERED_LIST:
            marker = f"{number}. "
            number += 1
        elif kind == s.TASK_LIST:
            marker = "- [x] " if (item.get("attrs") or {}).get("checked") else "- [ ] "
        else:
            marker = "- "
        indent = " " * (2 if kind == s.TASK_LIST else len(marker))
        blocks = item.get("content") or []
        first = _block_md(blocks[0]) if blocks else [""]
        out.append((marker + first[0]).rstrip() if not first[0] else marker + first[0])
        out.extend(indent + line if line else "" for line in first[1:])
        rest = _blocks_md(blocks[1:], tight=True)
        if rest and blocks[1]["type"] not in s.LISTS:
            out.append("")
        out.extend(indent + line if line else "" for line in rest)
    return out


def _table_md(rows: list[dict[str, Any]]) -> list[str]:
    grid: list[list[str]] = []
    aligns: list[str | None] = []
    for row_index, row in enumerate(rows):
        cells: list[str] = []
        for cell in row.get("content") or []:
            parts = []
            for block in cell.get("content") or []:
                if block["type"] in s.TEXTBLOCKS:
                    parts.append(_inline_md(block.get("content") or [], breaks="<br>"))
                else:
                    parts.extend(line for line in _block_md(block) if line.strip())
            # Text is escaped already (a "|" in it is "\|"); a line inside a cell is "<br>".
            cells.append("<br>".join(part for part in parts if part.strip()).replace("\n", "<br>"))
            span = int((cell.get("attrs") or {}).get("colspan", 1))
            cells.extend([""] * (span - 1))
            if row_index == 0:
                aligns.append((cell.get("attrs") or {}).get("align"))
                aligns.extend([None] * (span - 1))
        grid.append(cells)
    width = max((len(cells) for cells in grid), default=0)
    if not width:
        return []
    aligns += [None] * (width - len(aligns))
    rule = {"left": ":---", "center": ":---:", "right": "---:"}
    lines = []
    for index, cells in enumerate(grid):
        cells = cells + [""] * (width - len(cells))
        lines.append("| " + " | ".join(cells) + " |")
        if index == 0:
            lines.append("| " + " | ".join(rule.get(a or "", "---") for a in aligns) + " |")
    return lines


_ESCAPE = re.compile(r"([\\`*_\[\]<~|])")
_LINE_START = re.compile(r"^(\s*)(#|>|-|\+|=|\d+[.)])")
_ENTITY = re.compile(r"&(?=[A-Za-z0-9#]+;)")


def _escape(text: str, line_start: bool = False) -> str:
    text = _ESCAPE.sub(r"\\\1", text)
    text = _ENTITY.sub(r"\\&", text)
    if line_start:
        match = _LINE_START.match(text)
        if match:
            lead, mark = match.group(1), match.group(2)
            if mark[0].isdigit():
                mark = mark[:-1] + "\\" + mark[-1]
            else:
                mark = "\\" + mark
            text = lead + mark + text[match.end():]
    return text


def _same(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a["type"] == b["type"] and (a.get("attrs") or {}) == (b.get("attrs") or {})


def _delimiters(mark: dict[str, Any], before: str) -> tuple[str, str]:
    """Opening and closing text of a mark. After a "*", emphasis is written with "_" so the two runs do not merge."""
    kind = mark["type"]
    if kind == s.LINK:
        href = (mark.get("attrs") or {}).get("href") or ""
        return "[", "](" + re.sub(r"([()\\<>])", r"\\\1", href) + ")"
    if kind == s.HIGHLIGHT:
        color = (mark.get("attrs") or {}).get("color")
        return (f'<mark data-color="{color}">' if color and color != "honey" else "<mark>"), "</mark>"
    if kind == s.UNDERLINE:
        return "<u>", "</u>"
    if kind == s.STRIKE:
        return "~~", "~~"
    if kind in (s.BOLD, s.ITALIC):
        char = "_" if before.endswith("*") else "*"
        delimiter = char * (2 if kind == s.BOLD else 1)
        return delimiter, delimiter
    return "", ""


def _code_span(text: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith(("`", " ")) or text.endswith(("`", " ")) else ""
    return fence + pad + text + pad + fence


def _inline_md(content: list[dict[str, Any]], breaks: str = "\\\n") -> str:
    out: list[str] = []
    opened: list[tuple[dict[str, Any], str]] = []
    pending = ""

    def last() -> str:
        return next((part for part in reversed(out) if part), "")

    def at_line_start() -> bool:
        return last() == "" or last().endswith("\n")

    def close_from(index: int) -> None:
        while len(opened) > index:
            out.append(opened.pop()[1])

    def lasting(mark: dict[str, Any], start: int) -> int:
        count = 0
        for node in content[start:]:
            if not any(_same(mark, other) for other in node.get("marks") or []):
                break
            count += 1
        return count

    for position, node in enumerate(content):
        if node["type"] == s.HARD_BREAK:
            close_from(0)
            out.append(_escape(pending))
            pending = ""
            out.append(breaks)
            continue
        text = node.get("text", "")
        marks = node.get("marks") or []
        if any(mark["type"] == s.CODE for mark in marks):
            close_from(0)
            out.append(_escape(pending, at_line_start()))
            pending = ""
            out.append(_code_span(text))
            continue
        core = text.strip(" \t")
        if not core:
            pending += text
            continue
        lead = text[: len(text) - len(text.lstrip(" \t"))]
        trail = text[len(text.rstrip(" \t")):]
        keep = 0
        while keep < len(opened) and any(_same(opened[keep][0], mark) for mark in marks):
            keep += 1
        close_from(keep)
        out.append(_escape(pending + lead, at_line_start()))
        # Marks that last longer open first, so they close last.
        new = [mark for mark in marks if not any(_same(mark, have) for have, _ in opened)]
        new.sort(key=lambda mark: -lasting(mark, position))
        for mark in new:
            opener, closer = _delimiters(mark, last())
            if opener:
                out.append(opener)
                opened.append((mark, closer))
        out.append(_escape(core, at_line_start()))
        pending = trail
    close_from(0)
    out.append(_escape(pending))
    return "".join(out)


# --- Plain text ---------------------------------------------------------------------------------------------------


def to_plain(source: Doc | dict[str, Any]) -> str:
    """The words of the note for search and preview: one block a line, table cells separated by a tab."""
    lines = _blocks_plain(_document(source)["content"])
    return "\n".join(line.rstrip() for line in lines).strip("\n")


def _inline_plain(content: list[dict[str, Any]], breaks: str = "\n") -> str:
    return "".join(breaks if node["type"] == s.HARD_BREAK else node.get("text", "") for node in content)


def _blocks_plain(blocks: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for block in blocks:
        kind = block["type"]
        content = block.get("content") or []
        if kind in s.TEXTBLOCKS:
            out.extend(_inline_plain(content).split("\n"))
        elif kind == s.CODE_BLOCK:
            out.extend(_inline_plain(content).split("\n"))
        elif kind in (s.BLOCKQUOTE,):
            out.extend(_blocks_plain(content))
        elif kind in s.LISTS:
            for item in content:
                out.extend(_blocks_plain(item.get("content") or []))
        elif kind == s.TABLE:
            for row in content:
                cells = [" ".join(line for line in _blocks_plain(cell.get("content") or []) if line.strip())
                         for cell in row.get("content") or []]
                out.append("\t".join(cells))
        elif kind in (s.IMAGE, s.ATTACHMENT):
            name = (block.get("attrs") or {}).get("name")
            if name:
                out.append(name)
        elif kind == s.LINK_PREVIEW:
            attrs = block.get("attrs") or {}
            out.extend(value for value in (attrs.get("title"), attrs.get("description"), attrs.get("href")) if value)
    return out


# --- Reading Markdown ---------------------------------------------------------------------------------------------

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$")
_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
_RULE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_QUOTE = re.compile(r"^ {0,3}> ?(.*)$")
_ITEM = re.compile(r"^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$")
_TASK = re.compile(r"^\[([ xX])\](?: +|$)(.*)$", re.S)
_TABLE_RULE = re.compile(r"^ *\|? *:?-{1,}:? *(\| *:?-{1,}:? *)*\|? *$")
#: A picture or file of the note on a line of its own (what ``to_markdown`` writes without ``attachment_href``).
_ATTACHMENT_LINE = re.compile(r"^ {0,3}(!?)\[((?:[^\]\\]|\\.)*)\]\(attachment:([A-Za-z0-9_-]{16,32})\)[ \t]*$")


def from_markdown(text: str) -> dict[str, Any]:
    """A Markdown snippet as a cleaned ProseMirror document (``content`` are the blocks to insert)."""
    text = str(text or "")[: s.MAX_MARKDOWN]
    lines = [line.expandtabs(4) for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return clean_doc({"type": s.DOC, "content": _parse_blocks(lines, 0)})


def _starts_block(line: str) -> bool:
    return bool(_ATTACHMENT_LINE.match(line) or _FENCE.match(line) or _HEADING.match(line) or _RULE.match(line)
                or _QUOTE.match(line) or (_ITEM.match(line) and (_ITEM.match(line).group(4) or "").strip() != ""))


def _parse_blocks(lines: list[str], depth: int) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        fence = _FENCE.match(line)
        if fence:
            mark = fence.group(1)
            body: list[str] = []
            i += 1
            while i < len(lines) and not re.match(r"^ {0,3}" + re.escape(mark[0]) + "{" + str(len(mark)) + r",}\s*$",
                                                   lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            node: dict[str, Any] = {"type": s.CODE_BLOCK, "attrs": {"language": fence.group(2) or None}}
            if body:
                node["content"] = [{"type": s.TEXT, "text": "\n".join(body)}]
            blocks.append(node)
            continue
        attached = _ATTACHMENT_LINE.match(line)
        if attached:
            name = re.sub(r"\\(.)", r"\1", attached.group(2)) or None
            blocks.append({"type": s.IMAGE if attached.group(1) else s.ATTACHMENT,
                           "attrs": {"id": attached.group(3), "name": name}})
            i += 1
            continue
        if _RULE.match(line):
            blocks.append({"type": s.HORIZONTAL_RULE})
            i += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            level = min(len(heading.group(1)), 3)
            blocks.append({"type": s.HEADING, "attrs": {"level": level},
                           "content": parse_inline(heading.group(2) or "")})
            i += 1
            continue
        if _QUOTE.match(line):
            inner = []
            while i < len(lines) and lines[i].strip() and (_QUOTE.match(lines[i]) or not _starts_block(lines[i])):
                quoted = _QUOTE.match(lines[i])
                inner.append(quoted.group(1) if quoted else lines[i])
                i += 1
            blocks.append({"type": s.BLOCKQUOTE, "content": _parse_blocks(inner, depth + 1)
                           if depth < s.MAX_DEPTH else []})
            continue
        if "|" in line and i + 1 < len(lines) and _TABLE_RULE.match(lines[i + 1]) and "-" in lines[i + 1]:
            rows = [line]
            i += 2
            while i < len(lines) and lines[i].strip() and "|" in lines[i]:
                rows.append(lines[i])
                i += 1
            blocks.append(_table(rows, lines))
            continue
        item = _ITEM.match(line)
        if item:
            consumed, lists = _parse_list(lines, i, depth)
            blocks.extend(lists)
            i = consumed
            continue
        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not _starts_block(lines[i]) and not (
                "|" in lines[i] and i + 1 < len(lines) and _TABLE_RULE.match(lines[i + 1])):
            para.append(lines[i])
            i += 1
        blocks.append({"type": s.PARAGRAPH, "content": _paragraph_inline(para)})
    return blocks


def _paragraph_inline(lines: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if index < len(lines) - 1 and stripped.endswith("\\") and not stripped.endswith("\\\\"):
            stripped = stripped[:-1].rstrip()
        if index:
            out.append({"type": s.HARD_BREAK})
        out.extend(parse_inline(stripped))
    while out and out[-1]["type"] == s.HARD_BREAK:
        out.pop()
    return out


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells, current, escaped = [], "", False
    for ch in line:
        if escaped:
            current += ("\\" + ch) if ch != "|" else "|"
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == "|":
            cells.append(current.strip())
            current = ""
        else:
            current += ch
    if escaped:
        current += "\\"
    cells.append(current.strip())
    return cells


def _table(rows: list[str], _lines: list[str]) -> dict[str, Any]:
    out_rows = []
    width = len(_split_row(rows[0]))
    for index, row in enumerate(rows):
        cells = (_split_row(row) + [""] * width)[:width]
        kind = s.TABLE_HEADER if index == 0 else s.TABLE_CELL
        out_rows.append({"type": s.TABLE_ROW, "content": [
            {"type": kind, "content": [{"type": s.PARAGRAPH, "content": _cell_inline(cell)}]} for cell in cells]})
    return {"type": s.TABLE, "content": out_rows}


def _cell_inline(cell: str) -> list[dict[str, Any]]:
    parts = re.split(r"<br\s*/?>", cell, flags=re.I)
    out: list[dict[str, Any]] = []
    for index, part in enumerate(parts):
        if index:
            out.append({"type": s.HARD_BREAK})
        out.extend(parse_inline(part.strip()))
    return out


def _parse_list(lines: list[str], i: int, depth: int) -> tuple[int, list[dict[str, Any]]]:
    first = _ITEM.match(lines[i])
    assert first is not None
    base = len(first.group(1))
    ordered = first.group(2)[0].isdigit()
    items: list[tuple[str, dict[str, Any]]] = []
    start = int(first.group(2)[:-1]) if ordered else 1
    while i < len(lines):
        match = _ITEM.match(lines[i])
        if not match or len(match.group(1)) != base or match.group(2)[0].isdigit() != ordered:
            break
        spaces = len(match.group(3) or " ")
        content_indent = base + len(match.group(2)) + (spaces if spaces <= 4 else 1)
        body = [(match.group(4) or "") if spaces <= 4 else " " * (spaces - 1) + (match.group(4) or "")]
        i += 1
        while i < len(lines):
            line = lines[i]
            if not line.strip():
                # A blank line belongs to the item when the item goes on after it.
                j = i
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and len(lines[j]) - len(lines[j].lstrip(" ")) >= content_indent:
                    body.extend([""] * (j - i))
                    i = j
                    continue
                break
            indent = len(line) - len(line.lstrip(" "))
            if indent >= content_indent:
                body.append(line[content_indent:])
                i += 1
                continue
            if _starts_block(line) or _ITEM.match(line):
                break
            body.append(line.strip())  # a lazy continuation of the item's paragraph
            i += 1
        kind = s.LIST_ITEM
        attrs: dict[str, Any] = {}
        task = None if ordered else _TASK.match(body[0])
        if task:
            kind = s.TASK_ITEM
            attrs = {"checked": task.group(1) in "xX"}
            body[0] = task.group(2)
        inner = _parse_blocks(body, depth + 1) if depth < s.MAX_DEPTH else []
        if not inner or inner[0]["type"] != s.PARAGRAPH:
            inner.insert(0, {"type": s.PARAGRAPH})
        items.append((kind, {"type": kind, "attrs": attrs, "content": inner}))
    # Checklist items and plain items do not mix in one list: each run becomes a list of its own.
    lists: list[dict[str, Any]] = []
    for kind, node in items:
        outer = s.TASK_LIST if kind == s.TASK_ITEM else (s.ORDERED_LIST if ordered else s.BULLET_LIST)
        if lists and lists[-1]["type"] == outer:
            lists[-1]["content"].append(node)
        else:
            attrs = {"start": start + sum(len(x["content"]) for x in lists)} if outer == s.ORDERED_LIST else {}
            lists.append({"type": outer, "attrs": attrs, "content": [node]})
    return i, lists


# --- Inline Markdown ----------------------------------------------------------------------------------------------

_PUNCT = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
_TAG = re.compile(r"<(/?)(u|mark|br)(\s[^<>]*)?\s*/?>", re.I)
_AUTOLINK = re.compile(r"<((?:https?|mailto):[^\s<>]+)>", re.I)
_COLOR = re.compile(r"""data-color\s*=\s*["']?([a-z]+)""", re.I)
_DELIMS = {"*": (s.ITALIC, s.BOLD), "_": (s.ITALIC, s.BOLD), "~": (None, s.STRIKE), "=": (None, s.HIGHLIGHT)}


class _Delim:
    def __init__(self, char: str, count: int, can_open: bool, can_close: bool) -> None:
        self.char = char
        self.count = count
        self.left = count
        self.can_open = can_open
        self.can_close = can_close


def parse_inline(text: str) -> list[dict[str, Any]]:
    """Inline Markdown as ProseMirror inline nodes (marks cleaned, unsafe links plain)."""
    tokens = _tokenize(text)
    runs: list[tuple[str, list[dict[str, Any]]]] = []
    active: list[dict[str, Any]] = []
    _flatten(tokens, active, runs)
    out: list[dict[str, Any]] = []
    for value, marks in runs:
        if value == "\n":
            out.append({"type": s.HARD_BREAK})
        elif value:
            out.append({"type": s.TEXT, "text": value, "marks": marks})
    return clean_doc({"content": [{"type": s.PARAGRAPH, "content": out}]})["content"][0].get("content", [])


def _tokenize(text: str) -> list[Any]:
    tokens: list[Any] = []
    buffer = ""
    i = 0

    def flush() -> None:
        nonlocal buffer
        if buffer:
            tokens.append(buffer)
            buffer = ""

    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text) and text[i + 1] in _PUNCT:
            buffer += text[i + 1]
            i += 2
            continue
        if ch == "`":
            run = len(text[i:]) - len(text[i:].lstrip("`"))
            fence = "`" * run
            end = text.find(fence, i + run)
            while end != -1 and end + run < len(text) and text[end + run] == "`":
                end = text.find(fence, end + run + 1)
            if end != -1:
                code = text[i + run: end]
                if len(code) > 1 and code.startswith(" ") and code.endswith(" ") and code.strip():
                    code = code[1:-1]
                flush()
                tokens.append(("code", code))
                i = end + run
                continue
            buffer += fence
            i += run
            continue
        if ch == "<":
            auto = _AUTOLINK.match(text, i)
            if auto:
                flush()
                href = auto.group(1)
                tokens.append(("link", href, [href]))
                i = auto.end()
                continue
            tag = _TAG.match(text, i)
            if tag:
                flush()
                name = tag.group(2).lower()
                if name == "br":
                    tokens.append("\n")
                else:
                    color = _COLOR.search(tag.group(3) or "")
                    tokens.append(("tag", name, tag.group(1) == "/", color.group(1).lower() if color else None))
                i = tag.end()
                continue
        if ch == "!" and text.startswith("[", i + 1):
            link = _link_at(text, i + 1)
            if link:
                flush()
                tokens.extend(_tokenize(link[0]))  # an image: its description only
                i = link[2]
                continue
        if ch == "[":
            link = _link_at(text, i)
            if link:
                flush()
                tokens.append(("link", link[1], _tokenize(link[0])))
                i = link[2]
                continue
        if ch in _DELIMS:
            run = len(text[i:]) - len(text[i:].lstrip(ch))
            before = text[i - 1] if i else " "
            after = text[i + run] if i + run < len(text) else " "
            left = not after.isspace() and not (after in _PUNCT and not (before.isspace() or before in _PUNCT))
            right = not before.isspace() and not (before in _PUNCT and not (after.isspace() or after in _PUNCT))
            if ch == "_":
                can_open = left and (not right or before in _PUNCT)
                can_close = right and (not left or after in _PUNCT)
            else:
                can_open, can_close = left, right
            if (ch in "~=" and run != 2) or not (can_open or can_close):
                buffer += ch * run
            else:
                flush()
                tokens.append(_Delim(ch, run, can_open, can_close))
            i += run
            continue
        buffer += ch
        i += 1
    flush()
    return tokens


def _link_at(text: str, i: int) -> tuple[str, str, int] | None:
    """``[label](href "title")`` at ``i``: the label, the href and where it ends."""
    depth = 0
    j = i
    while j < len(text):
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == "[":
            depth += 1
        elif text[j] == "]":
            depth -= 1
            if depth == 0:
                break
        j += 1
    if j >= len(text) or not text.startswith("(", j + 1):
        return None
    k = j + 2
    level = 1
    while k < len(text) and level:
        if text[k] == "\\":
            k += 2
            continue
        level += {"(": 1, ")": -1}.get(text[k], 0)
        k += 1
    if level:
        return None
    inside = text[j + 2: k - 1].strip()
    href = re.split(r"\s+[\"'(]", inside, maxsplit=1)[0].strip()
    if href.startswith("<") and href.endswith(">"):
        href = href[1:-1]
    href = re.sub(r"\\([!-/:-@\[-`{-~])", r"\1", href)
    return text[i + 1: j], href, k


def _match(tokens: list[Any]) -> list[tuple[int, int, str, str | None]]:
    """Pairs emphasis delimiters (``*``, ``_``, ``~~``, ``==``) and HTML tags: (opener, closer, mark, colour)."""
    pairs: list[tuple[int, int, str, str | None]] = []
    for index, token in enumerate(tokens):
        if isinstance(token, _Delim) and token.can_close:
            j = index - 1
            while j >= 0 and token.left:
                opener = tokens[j]
                if (isinstance(opener, _Delim) and opener.char == token.char and opener.can_open and opener.left
                        and not ((opener.can_close or token.can_open) and (opener.count + token.count) % 3 == 0
                                 and opener.char in "*_" and not (opener.count % 3 == 0 and token.count % 3 == 0))):
                    use = 2 if opener.left >= 2 and token.left >= 2 else 1
                    single, double = _DELIMS[token.char]
                    kind = double if use == 2 else single
                    if kind is None:
                        break
                    opener.left -= use
                    token.left -= use
                    pairs.append((j, index, kind, None))
                    continue
                j -= 1
        elif isinstance(token, tuple) and token[0] == "tag" and token[2]:
            for j in range(index - 1, -1, -1):
                opener = tokens[j]
                if (isinstance(opener, tuple) and opener[0] == "tag" and not opener[2] and opener[1] == token[1]
                        and not any(pair[0] == j for pair in pairs)):
                    pairs.append((j, index, s.UNDERLINE if token[1] == "u" else s.HIGHLIGHT, opener[3]))
                    break
    return pairs


def _flatten(tokens: list[Any], outer: list[dict[str, Any]], runs: list[tuple[str, list[dict[str, Any]]]]) -> None:
    pairs = _match(tokens)
    used = {pair[0] for pair in pairs} | {pair[1] for pair in pairs}
    for index, token in enumerate(tokens):
        marks = list(outer)
        for start, end, kind, color in pairs:
            if start < index < end:
                marks.append({"type": kind, "attrs": {"color": color}} if kind == s.HIGHLIGHT else {"type": kind})
        if isinstance(token, str):
            runs.append((token, marks))
        elif isinstance(token, _Delim):
            if token.left:
                runs.append((token.char * token.left, marks))
        elif token[0] == "code":
            runs.append((token[1], [{"type": s.CODE}]))
        elif token[0] == "link":
            href = safe_href(token[1])
            _flatten(token[2], marks + ([{"type": s.LINK, "attrs": {"href": href}}] if href else []), runs)
        elif token[0] == "tag" and index not in used:
            runs.append(("<" + ("/" if token[2] else "") + token[1] + ">", marks))
