"""A note as PDF (NOTES-17 AC-2), set by Typst on the server.

The note's document (ProseMirror JSON, ``notedoc``) is written as Typst source, straight, not through Markdown: what a
note can hold has a fixed form here (headings, lists, checklists with their boxes, tables, quotes, code, rules, links,
the five highlighter colours, and attachments at their place: pictures in their width, files as a line, link cards as
a small box). **Every word of a note goes to Typst as a string, never as markup** (``#"…"``), so
nothing a note says can run as Typst code. Typst's root is a temporary folder that holds the source, the symbol and the
pictures of the attachments, nothing else; it reads no font of the machine and nothing from the net.

The PDF looks like the note in the light look: Inter, the note's symbol in its colour before the title, checked items
with a filled honey box and their text struck through and dimmed, folded sections open, no paper pattern.
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import tempfile
import threading
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from ..errors import error
from ..notedoc import schema as s
from ..notedoc.doc import safe_href
from .folders import FOLDER_COLORS
from .typeset_worker import TypesetFailed, compile_apart, compile_here

if TYPE_CHECKING:
    from .export import ExportFile, NoteData

APP_DIR = Path(__file__).resolve().parent.parent
FONTS = APP_DIR / "fonts"
ICONS = APP_DIR / "export_icons.json"

#: Tests set this: Typst runs in the test's own process (a process for every PDF only costs time there).
INLINE = False
#: PDFs set at the same time in the whole server.
RUNNING = 2
#: PDFs that may wait for one of those places; one more is answered "busy" at once.
WAITING = 8
#: How long a PDF waits for its place before it is answered "busy".
WAIT_SECONDS = 30.0
#: How soon a refused request should ask again.
RETRY_AFTER_SECONDS = 5


class PdfBusy(Exception):
    """No place for this PDF: the account sets one already, or too many wait."""


class Gate:
    """The places for setting PDFs (finding of the NOTES-17 review: waiting PDFs held the threads every request needs).

    Nothing here blocks: ``admit`` lets a request in line or refuses it at once (one PDF per account, at most
    ``RUNNING + WAITING`` in line), ``take`` takes a place to set when one is free and says so. A request in line waits
    for its place outside every thread (``routers/export.py``), and only a request with a place goes into one.
    """

    def __init__(self, running: int, waiting: int) -> None:
        self.running = running
        self.waiting = waiting
        self._lock = threading.Lock()
        self._in_line: set[object] = set()
        self._busy = 0

    def admit(self, key: object) -> None:
        with self._lock:
            if key in self._in_line or len(self._in_line) >= self.running + self.waiting:
                raise PdfBusy
            self._in_line.add(key)

    def take(self) -> bool:
        with self._lock:
            if self._busy >= self.running:
                return False
            self._busy += 1
            return True

    def give_back(self) -> None:
        with self._lock:
            self._busy -= 1

    def leave(self, key: object) -> None:
        with self._lock:
            self._in_line.discard(key)


GATE = Gate(RUNNING, WAITING)
#: A picture larger than this is named, not drawn.
MAX_PICTURE = 40 * 1024 * 1024

TEXT = "#14141a"
MUTED = "#61616f"
#: The highlighter in the light look (``frontend/src/editor/editor.css``), over white.
MARKS = {
    "honey": "rgb(242, 193, 78, 50%)",
    "green": "rgb(74, 222, 128, 42%)",
    "blue": "rgb(96, 165, 250, 40%)",
    "rose": "rgb(251, 113, 133, 36%)",
    "violet": "rgb(167, 139, 250, 40%)",
}

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_LANGUAGE = re.compile(r"^[A-Za-z0-9_+#.-]{1,32}$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def string(value: str) -> str:
    """A Typst string literal; what a note says reaches Typst only this way."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\r", "").replace("\t", "\\t")
    return '"' + _CONTROL.sub(lambda found: f"\\u{{{ord(found.group()):x}}}", escaped) + '"'


def words(value: str) -> str:
    return "#" + string(value) if value else ""


def content(markup: str) -> str:
    return "[" + markup + "]"


@lru_cache(maxsize=1)
def icons() -> dict[str, str]:
    """The symbols as SVG, the drawings the page shows (lucide), written by ``frontend/src/export/icons.test.ts``."""
    try:
        return dict(json.loads(ICONS.read_text("utf-8")))
    except (OSError, ValueError):
        return {}


def note_colour(color: str) -> str | None:
    """The note's colour as ``#rrggbb``: one of the fixed row or the member's own."""
    if color in FOLDER_COLORS:
        return FOLDER_COLORS[color]
    return color if _HEX.match(color or "") else None


#: How wide a picture stands, as in the note (NOTES-10 AC-2).
PICTURE_WIDTHS = {"small": "33%", "medium": "62%", "full": "100%"}


class Writer:
    """The body of one note as Typst. ``files`` are the note's attachments by id with their number (the name of their
    picture under ``root``); a block of the text that names one puts it at its place and marks it ``placed``."""

    def __init__(self, files: dict[str, tuple[ExportFile, int]] | None = None, root: Path | None = None) -> None:
        self.depth = 0
        self.files = files or {}
        self.root = root
        self.placed: set[str] = set()

    def blocks(self, nodes: list[dict[str, Any]]) -> str:
        return "\n\n".join(part for part in (self.block(node) for node in nodes) if part)

    def block(self, node: dict[str, Any]) -> str:
        kind = node.get("type")
        attrs = node.get("attrs") or {}
        inner = node.get("content") or []
        if kind == s.PARAGRAPH:
            if not inner:
                return "#v(0.4em)"
            return "#par" + content(self.inline(inner))
        if kind == s.HEADING:
            level = min(3, max(1, int(attrs.get("level") or 1)))
            # Folded or not, the PDF shows everything (AC-2).
            return f"#heading(level: {level})" + content(self.inline(inner))
        if kind == s.BULLET_LIST:
            return "#list(tight: true, " + ", ".join(content(self.item(item)) for item in inner) + ")"
        if kind == s.ORDERED_LIST:
            start = int(attrs.get("start") or 1)
            return f"#enum(start: {start}, tight: true, " + ", ".join(content(self.item(item)) for item in inner) + ")"
        if kind == s.TASK_LIST:
            return self.tasks(inner, bool(attrs.get("doneToBottom")))
        if kind == s.BLOCKQUOTE:
            return "#nn-quote" + content(self.blocks(inner))
        if kind == s.CODE_BLOCK:
            text = "".join(child.get("text", "") for child in inner)
            language = str(attrs.get("language") or "")
            lang = f", lang: {string(language)}" if _LANGUAGE.match(language) else ""
            return "#raw(" + string(text) + ", block: true" + lang + ")"
        if kind == s.HORIZONTAL_RULE:
            return "#line(length: 100%, stroke: 0.7pt + nn-rule)"
        if kind == s.TABLE:
            return self.table(inner)
        if kind in (s.IMAGE, s.ATTACHMENT):
            return self.attachment(kind, attrs)
        if kind == s.DRAWING:
            # A sketch (NOTES-18) stands over the whole width, as in the note.
            return self.attachment(kind, {**attrs, "size": "full"})
        if kind == s.RECORDING:
            return self.recording(attrs)
        if kind == s.LINK_PREVIEW:
            return self.card(attrs)
        return ""

    def attachment(self, kind: str, attrs: dict[str, Any]) -> str:
        """A picture or file of the note at its place (NOTES-10): the picture in its width with name and size under
        it, any other file (or a picture Typst cannot draw) as a line with name and size; one that is gone by its
        name."""
        found = self.files.get(str(attrs.get("id") or ""))
        if found is None:
            name = str(attrs.get("name") or "")
            return "#nn-file[" + words(name) + "]" if name else ""
        file, number = found
        self.placed.add(file.id)
        label = words(f"{file.name} · {_size_text(file.size)}")
        if file.kind in ("image", "drawing") and self.root is not None:
            shown = _picture(file, self.root, number)
            if shown:
                width = PICTURE_WIDTHS.get(str(attrs.get("size") or ""), PICTURE_WIDTHS["medium"])
                return (f"#nn-sized({string(shown)}, {width})\n\n"
                        "#text(size: 8.5pt, fill: nn-muted)[" + label + "]")
        return "#nn-file[" + label + "]"

    def recording(self, attrs: dict[str, Any]) -> str:
        """A recording (NOTES-18): a line with name, size and length, its transcript under it."""
        found = self.files.get(str(attrs.get("id") or ""))
        length = _length_text(attrs.get("duration"))
        if found is None:
            name = str(attrs.get("name") or "")
            line = "#nn-file[" + words(" · ".join(part for part in (name, length) if part)) + "]" if name else ""
        else:
            file, _number = found
            self.placed.add(file.id)
            line = "#nn-file[" + words(" · ".join(part for part in (file.name, _size_text(file.size), length)
                                                  if part)) + "]"
        transcript = self.files.get(str(attrs.get("transcript") or ""))
        if transcript is None:
            return line
        file, _number = transcript
        self.placed.add(file.id)
        with contextlib.closing(file.open()) as stream:
            text = stream.read(MAX_TRANSCRIPT).decode("utf-8", "replace").strip()
        if not text:
            return line
        return line + "\n\n#text(size: 9.5pt, fill: nn-muted)[" + words(text) + "]"

    def card(self, attrs: dict[str, Any]) -> str:
        """The card of a link: its title as the link, the description and the site under it."""
        href = safe_href(attrs.get("href"))
        if not href:
            return ""
        title = str(attrs.get("title") or href)
        body = "#link(" + string(href) + ")[#strong[" + words(title) + "]]"
        description = str(attrs.get("description") or "")
        if description:
            body += "#linebreak()#text(size: 9pt, fill: nn-muted)[" + words(description) + "]"
        body += "#linebreak()#text(size: 8.5pt, fill: nn-muted)[" + words(str(attrs.get("site") or href)) + "]"
        return "#nn-card[" + body + "]"

    def item(self, item: dict[str, Any]) -> str:
        return self.blocks(item.get("content") or [])

    def tasks(self, items: list[dict[str, Any]], done_to_bottom: bool) -> str:
        """A checklist: a box before every item, checked ones filled, their text dimmed and struck through (as in the
        editor); with "done to the bottom" the checked ones come last, as the note shows them."""
        ordered = sorted(items, key=lambda item: bool((item.get("attrs") or {}).get("checked"))) if done_to_bottom \
            else items
        cells: list[str] = []
        for item in ordered:
            done = bool((item.get("attrs") or {}).get("checked"))
            body = self.item(item)
            cells.append(f"nn-box({'true' if done else 'false'})")
            cells.append(content(f"#nn-done{content(body)}" if done else body))
        if not cells:
            return ""
        return "#grid(columns: (1.15em, 1fr), column-gutter: 0.5em, row-gutter: 0.55em, " + ", ".join(cells) + ")"

    def table(self, rows: list[dict[str, Any]]) -> str:
        width = 0
        lines: list[tuple[bool, list[str], int]] = []
        aligns: list[str] = []
        for index, row in enumerate(rows):
            cells: list[str] = []
            span_total = 0
            header = True
            for cell in row.get("content") or []:
                attrs = cell.get("attrs") or {}
                span = max(1, int(attrs.get("colspan") or 1))
                span_total += span
                header = header and cell.get("type") == s.TABLE_HEADER
                body = content(self.blocks(cell.get("content") or []))
                cells.append(f"table.cell(colspan: {span}){body}" if span > 1 else body)
                if index == 0:
                    align = str(attrs.get("align") or "left")
                    aligns.extend([align if align in ("left", "center", "right") else "left"] * span)
            width = max(width, span_total)
            lines.append((header and bool(cells) and index == 0, cells, span_total))
        if not width:
            return ""
        aligns = (aligns + ["left"] * width)[:width]
        parts = [f"columns: {width}", f"align: ({', '.join(aligns)},)"]
        for header, cells, taken in lines:
            cells = cells + ["[]"] * (width - taken)
            if header:
                parts.append("table.header(" + ", ".join(cells) + ")")
            else:
                parts.extend(cells)
        return "#table(" + ", ".join(parts) + ")"

    def inline(self, nodes: list[dict[str, Any]]) -> str:
        out: list[str] = []
        for node in nodes:
            if node.get("type") == s.HARD_BREAK:
                out.append("#linebreak()")
                continue
            text = node.get("text", "")
            if not text:
                continue
            marks = {mark.get("type"): mark.get("attrs") or {} for mark in node.get("marks") or []}
            if s.CODE in marks:
                piece = "#raw(" + string(text) + ")"
            else:
                piece = words(text)
            if s.BOLD in marks:
                piece = "#strong" + content(piece)
            if s.ITALIC in marks:
                piece = "#emph" + content(piece)
            if s.UNDERLINE in marks:
                piece = "#underline" + content(piece)
            if s.STRIKE in marks:
                piece = "#strike" + content(piece)
            if s.HIGHLIGHT in marks:
                colour = MARKS.get(str(marks[s.HIGHLIGHT].get("color") or "honey"), MARKS["honey"])
                piece = f"#highlight(fill: {colour}, extent: 1pt)" + content(piece)
            if s.LINK in marks:
                href = safe_href(marks[s.LINK].get("href"))
                if href:
                    piece = "#link(" + string(href) + ")" + content(piece)
            out.append(piece)
        return "".join(out)


PREAMBLE = r"""
#let nn-text = rgb("__TEXT__")
#let nn-muted = rgb("__MUTED__")
#let nn-rule = rgb("#dcdce4")
#let nn-link = rgb("#8a6400")
#let nn-honey = rgb("#f2c14e")
#set document(title: __TITLE__)
#set page(paper: "a4", margin: (x: 2.2cm, top: 2.2cm, bottom: 2.4cm), footer: __FOOTER__)
#set text(font: ("Inter", "Noto Emoji"), size: 10.5pt, lang: __LANG__, fill: nn-text)
#set par(leading: 0.72em, spacing: 1em)
#show raw: set text(font: ("JetBrains Mono", "Noto Emoji"), size: 9pt)
#show raw.where(block: true): it => block(width: 100%, fill: rgb("#f3f3f6"), stroke: 0.5pt + nn-rule, inset: 9pt,
  radius: 6pt, it)
#show raw.where(block: false): it => box(fill: rgb("#ececf2"), inset: (x: 3pt), outset: (y: 2.5pt), radius: 3pt, it)
#show link: it => underline(text(fill: nn-link, it))
#show heading: set text(weight: "bold")
#show heading: set block(above: 1.4em, below: 0.65em)
#show heading.where(level: 1): set text(size: 18pt)
#show heading.where(level: 2): set text(size: 15pt)
#show heading.where(level: 3): set text(size: 12.5pt)
#set table(stroke: 0.6pt + nn-rule, inset: 7pt)
#show table.cell.where(y: 0): set text(weight: "semibold")
#set list(marker: ([•], [◦], [▪]))
#let nn-box(done) = box(width: 1.05em, height: 1.05em, baseline: 0.2em, radius: 3pt,
  stroke: 1.1pt + (if done { nn-honey } else { nn-muted }), fill: (if done { nn-honey } else { none }),
  align(center + horizon, text(size: 0.75em, weight: "bold", fill: rgb("#2a1d00"), if done { "✓" } else { "" })))
#let nn-done(body) = { set text(fill: nn-muted); strike(body) }
#let nn-quote(body) = block(width: 100%, inset: (left: 12pt, y: 2pt), stroke: (left: 3pt + nn-rule),
  text(fill: rgb("#3c3c48"), body))
#let nn-picture(name) = block(above: 0.6em, below: 0.4em, image(name, width: auto, fit: "contain") )
#let nn-sized(name, width) = block(above: 0.6em, below: 0.4em, image(name, width: width))
#let nn-card(body) = block(width: 100%, stroke: 0.6pt + nn-rule, inset: 8pt, radius: 6pt, body)
#let nn-file(name) = box(stroke: 0.6pt + nn-rule, inset: (x: 6pt, y: 3pt), radius: 4pt, text(size: 9.5pt, name))
"""


def _footer(title: str, page_text: str) -> str:
    before, _, after = page_text.partition("{page}")
    middle, _, end = after.partition("{pages}")
    return ("context { set text(size: 8pt, fill: nn-muted); " + string(title) + "; h(1fr); " + string(before)
            + "; counter(page).display(); " + string(middle) + "; str(counter(page).final().first()); "
            + string(end) + " }")


#: Bytes of a transcript the PDF prints under its recording (two hours of talk are far below).
MAX_TRANSCRIPT = 1024 * 1024


def _length_text(value: Any) -> str:
    """A recording's length as the note shows it (``m:ss`` or ``h:mm:ss``), empty without one."""
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return ""
    seconds = round(value / 1000)
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def _size_text(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


#: Pixels a picture may have; a larger one (or a "decompression bomb") is named, not drawn.
MAX_PIXELS = 40_000_000


def _checked(data: bytes, kind: str) -> tuple[bytes, str] | None:
    """The picture when Typst can draw it: a picture Typst cannot read stops the whole PDF, so every one is read here
    first. Raster pictures through Pillow (size, a picture that is not one), SVG as XML."""
    if kind == "svg":
        from xml.etree import ElementTree

        try:
            root = ElementTree.fromstring(data)
        except ElementTree.ParseError:
            return None
        return (data, "svg") if root.tag.endswith("svg") else None
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as picture:
            if picture.width * picture.height > MAX_PIXELS:
                return None
            picture.load()
            if picture.format in ("PNG", "JPEG", "GIF", "WEBP"):
                return data, {"PNG": "png", "JPEG": "jpg", "GIF": "gif", "WEBP": "webp"}[picture.format]
            out = io.BytesIO()
            picture.convert("RGBA").save(out, "PNG")
            return out.getvalue(), "png"
    except Exception:  # noqa: BLE001 -- not a picture Pillow can read
        return None


def _picture(file: ExportFile, root: Path, number: int) -> str | None:
    """A picture of an attachment under the root, or None when Typst cannot draw it."""
    try:
        if file.picture is not None:
            data, kind = file.picture()
        else:
            kind = {"png": "png", "jpg": "jpg", "jpeg": "jpg", "gif": "gif", "webp": "webp", "svg": "svg"}.get(
                PurePosixPath(file.name).suffix.lower().lstrip("."), "")
            if not kind or file.size > MAX_PICTURE:
                return None
            with contextlib.closing(file.open()) as source:
                data = source.read(MAX_PICTURE + 1)
        if not kind or len(data) > MAX_PICTURE:
            return None
        checked = _checked(data, kind)
        if checked is None:
            return None
        data, kind = checked
    except Exception:  # noqa: BLE001 -- an attachment that cannot be read is named instead of drawn
        return None
    name = f"a{number}.{'jpg' if kind == 'jpeg' else kind}"
    (root / name).write_bytes(data)
    return name


def document(data: NoteData, labels: dict[str, str], language: str, root: Path) -> str:
    """The whole Typst source of a note's PDF."""
    title = data.title or labels["untitled"]
    note = data.note
    preamble = (
        PREAMBLE.replace("__TEXT__", TEXT).replace("__MUTED__", MUTED)
        .replace("__TITLE__", string(title))
        .replace("__FOOTER__", _footer(title, labels["page"]))
        .replace("__LANG__", string(language))
    )
    parts = [preamble]
    head = ""
    drawing = icons().get(note.icon or "")
    if drawing:
        colour = note_colour(note.color or "") or TEXT
        (root / "icon.svg").write_text(drawing.replace("currentColor", colour), "utf-8")
        head = '#box(baseline: 18%, image("icon.svg", height: 22pt)) #h(7pt)'
    parts.append("#block(below: 0.45em, text(size: 24pt, weight: \"bold\")[" + head + words(title) + "])")
    changed = (note.updated_at or datetime.now(UTC)).astimezone().strftime(labels["date"])
    parts.append("#block(below: 1.4em, text(size: 9pt, fill: nn-muted)["
                 + words(labels["changed"].format(date=changed)) + "])")
    if data.locked:
        parts.append("#text(fill: nn-muted, style: \"italic\")[" + words(labels["locked"]) + "]")
        return "\n\n".join(parts) + "\n"
    numbered = {file.id: (file, number) for number, file in enumerate(data.files, start=1)}
    writer = Writer(numbered, root)
    parts.append(writer.blocks(data.document.get("content") or []))
    # What no block of the text names follows the text.
    rest = [(number, file) for number, file in enumerate(data.files, start=1) if file.id not in writer.placed]
    if rest:
        parts.append("#heading(level: 2)[" + words(labels["attachments"]) + "]")
        for number, file in rest:
            shown = None
            if file.kind in ("image", "drawing"):
                shown = _picture(file, root, number)
            if shown:
                parts.append("#nn-picture(" + string(shown) + ")")
                parts.append("#text(size: 8.5pt, fill: nn-muted)[" + words(f"{file.name} · {_size_text(file.size)}")
                             + "]")
            else:
                parts.append("#nn-file[" + words(f"{file.name} · {_size_text(file.size)}") + "]")
    return "\n\n".join(parts) + "\n"


def build(data: NoteData, labels: dict[str, str], language: str) -> bytes:
    """Sets the PDF of one note. The caller holds a place of ``GATE``."""
    with tempfile.TemporaryDirectory(prefix="nexnotes-pdf-") as temp:
        root = Path(temp)
        main = root / "main.typ"
        main.write_text(document(data, labels, language, root), "utf-8")
        run = compile_here if INLINE else compile_apart
        try:
            output = run(main, fonts=FONTS, packages=root / "packages", fmt="pdf", ppi=144.0)
        except TypesetFailed as exc:
            raise error("typeset_failed", "The PDF could not be set.", 500) from exc
    assert isinstance(output, bytes)
    return output
