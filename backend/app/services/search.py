"""Search over titles and texts (NOTES-9).

The index is an FTS5 table with the trigram tokenizer: trigrams find any part of a word, so "rechn" finds "Rechnung"
and "Stromrechnung" (AC-2), and every prefix while somebody types. It holds a *folded* copy of each note: case gone
(``casefold``, so ß becomes ss), ä/ö/ü written as ae/oe/ue, other accents dropped, runs of blanks one space. The query
is folded the same way, so "Müller" meets "mueller" and "Straße" meets "strasse" (EC-1).

Nothing the member types reaches ``MATCH`` as syntax: the query is cut into words, phrases in quotes and tags
(``#word``) here, and each piece goes into the expression as a string in double quotes. ``NEAR``, ``*``, ``OR``,
brackets and a quote left open are plain text (EC-5). Words shorter than three characters, which a trigram index cannot
find, are looked for with ``instr`` in the folded columns.

The index follows the note in the same transaction: ``services/notes.py`` calls ``index_note`` wherever it writes a
title or a text (``notes.on_text_written``). Notes in the trash stay in the index and are left out when searching, so
they come back with "Zurückholen" without a new pass. Rows of notes gone for good go in the cleanup round.

Other features dock on here:

- ``SCOPES``: further notes an account may read (sharing, NOTES-13), asked at every search, so a right taken away
  counts at once (EC-7).
- ``register_text_source``: text that is not in the note's body, such as text recognised in pictures and PDFs
  (NOTES-11). A hit only there names the attachment and its page (AC-3); ``reindex`` after a recognition finished
  (EC-3).
- ``set_tag_source``: the tags of a note (NOTES-5). Until that feature brings its own, they are read from the text.
- ``CONTENT_HIDDEN``: notes whose content may not be searched (locked notes, NOTES-16); only their title is indexed.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, bindparam, column, func, literal_column, or_, select, table, text
from sqlalchemy.orm import Session, defer

from ..db import SessionLocal, engine
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note

logger = logging.getLogger("nexnotes.search")

#: Changes whenever the folding or the columns change: the tables carry it in their names, and a start with a new
#: version builds the index anew and drops the old tables.
INDEX_VERSION = 1
INDEX = f"search_index_v{INDEX_VERSION}"
ROWS = f"search_rows_v{INDEX_VERSION}"

#: Hits per page; the list loads the next page when it reaches the end (EC-4).
PAGE = 50
PAGE_MAX = 100
#: The longest query taken; longer ones are refused, not cut.
QUERY_MAX = 500
#: Terms and tags a query holds at most; the rest is ignored.
TERMS_MAX = 16
#: Weights of bm25 per column: title, body, extra, tags.
WEIGHTS = (10.0, 1.0, 0.5, 0.0)
#: Characters of text an excerpt shows before the first hit and in total.
EXCERPT_BEFORE = 60
EXCERPT_CHARS = 220
#: Occurrences of one term marked in one text at most.
MARKS_MAX = 50
#: Notes indexed per transaction when the index is built at the start.
BATCH = 500


# --- Folding ------------------------------------------------------------------------------------------------------

_UMLAUTS = {"ä": "ae", "ö": "oe", "ü": "ue"}
_COMBINING_DIAERESIS = "̈"
_fold_cache: dict[str, str] = {}
_SPACE = re.compile(r"\s+")


def _fold_char(char: str) -> str:
    found = _fold_cache.get(char)
    if found is not None:
        return found
    parts: list[str] = []
    for each in char.casefold():
        if each in _UMLAUTS:
            parts.append(_UMLAUTS[each])
            continue
        decomposed = unicodedata.normalize("NFKD", each)
        parts.append("".join(piece for piece in decomposed if not unicodedata.combining(piece)))
    folded = "".join(parts)
    if len(_fold_cache) < 20000:
        _fold_cache[char] = folded
    return folded


def fold_with_map(value: str) -> tuple[str, list[int]]:
    """The folded text and, for each of its characters, the position in ``value`` it came from: a hit found in the
    folded text is marked in the original (AC-1)."""
    out: list[str] = []
    starts: list[int] = []
    last = ""
    for position, char in enumerate(value):
        if char.isspace():
            if last != " ":
                out.append(" ")
                starts.append(position)
                last = " "
            continue
        if char == _COMBINING_DIAERESIS:
            # "u" followed by a combining diaeresis (text in NFD) is "ü": the "e" of "ue".
            if last in ("a", "o", "u"):
                out.append("e")
                starts.append(position)
                last = "e"
            continue
        folded = char.lower() if char.isascii() else _fold_char(char)
        for piece in folded:
            out.append(piece)
            starts.append(position)
            last = piece
    return "".join(out), starts


def fold(value: str) -> str:
    """``value`` as the index holds it: no case, umlauts as ae/oe/ue, ß as ss, no other accents, one space."""
    if value.isascii():
        return _SPACE.sub(" ", value.lower())
    return fold_with_map(value)[0]


# --- Tags ---------------------------------------------------------------------------------------------------------

#: A ``#`` at the start of the text, after a blank or an opening bracket or quote; a hash inside a word or an address
#: (``page#part``) is no tag.
_TAG = re.compile(r"(?<![^\s(\[{\"'„“‚])#([^\s#]+)")
_TAG_END = ".,;:!?)]}\"'“”‘’»«…"
TAG_MAX = 100


def clean_tag(raw: str) -> str:
    """A tag without its ``#`` and without punctuation at its end; empty when nothing is left or it is only a number
    (``#1``)."""
    tag = raw.lstrip("#").rstrip(_TAG_END)
    if not tag or tag.isdigit():
        return ""
    return tag[:TAG_MAX]


def tags_in_text(value: str) -> list[str]:
    """The tags written in a text, as written (NOTES-5 decides the finer rules; this is the stand-in until then)."""
    found: list[str] = []
    for match in _TAG.finditer(value or ""):
        tag = clean_tag(match.group(1))
        if tag:
            found.append(tag)
    return found


def _tags_from_text(_db: Session, note: Note) -> list[str]:
    return tags_in_text(note.text or "")


TagSource = Callable[[Session, Note], Iterable[str]]
_tag_source: TagSource = _tags_from_text


def set_tag_source(source: TagSource | None) -> None:
    """Where the tags of a note come from (NOTES-5 puts its table here); ``None`` goes back to reading the text. The
    index must be built again afterwards (``reindex_all``) or note by note (``reindex``)."""
    global _tag_source
    _tag_source = source or _tags_from_text


# --- Further text of a note ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TextPart:
    """Text of a note beyond its body: a recognised page of a scan or PDF, the text in a picture (NOTES-11)."""

    text: str
    #: What it is, for the label of the hit: "image", "scan", "pdf", ...
    kind: str = "attachment"
    #: The attachment's name, as the member sees it.
    name: str = ""
    #: The page it is on, from 1; ``None`` for a picture.
    page: int | None = None
    #: What the web page needs to open the view at that place (the attachment's id).
    ref: str = ""


TextSource = Callable[[Session, Note], Iterable[TextPart]]
TEXT_SOURCES: list[TextSource] = []


def register_text_source(source: TextSource) -> None:
    """Text of notes beyond the body (NOTES-11). Called whenever a note is indexed; once only."""
    if source not in TEXT_SOURCES:
        TEXT_SOURCES.append(source)


def _parts(db: Session, note: Note) -> list[TextPart]:
    parts: list[TextPart] = []
    for source in TEXT_SOURCES:
        try:
            parts.extend(part for part in source(db, note) if part.text)
        except Exception:
            logger.exception("A text source failed note=%s", note.id)
    return parts


#: Notes whose content may not be searched (locked notes, NOTES-16): only their title goes into the index.
CONTENT_HIDDEN: list[Callable[[Session, Note], bool]] = []


def _hidden(db: Session, note: Note) -> bool:
    return any(check(db, note) for check in CONTENT_HIDDEN)


# --- Who may find what --------------------------------------------------------------------------------------------

#: Further notes an account may read besides its own (sharing, NOTES-13): each gives a condition on ``Note``.
SCOPES: list[Callable[[Account], ColumnElement[bool]]] = []


def _scope(account: Account) -> ColumnElement[bool]:
    return or_(Note.owner_id == account.id, *(rule(account) for rule in SCOPES))


# --- The index ----------------------------------------------------------------------------------------------------

_ready = False


_INDEX_T = table(INDEX, column("rowid"), column("title"), column("body"), column("extra"), column("tags"))
_ROWS_T = table(ROWS, column("id"), column("note_id"))


def _sql(template: str) -> Any:
    """A statement on the index tables; ``@index`` and ``@rows`` stand for their names (constants, never input)."""
    return text(template.replace("@index", INDEX).replace("@rows", ROWS))


def _create(run: Callable[[Any], Any]) -> None:
    run(_sql("CREATE TABLE IF NOT EXISTS @rows (id INTEGER PRIMARY KEY, note_id TEXT NOT NULL UNIQUE)"))
    run(_sql("CREATE VIRTUAL TABLE IF NOT EXISTS @index USING fts5(title, body, extra, tags, tokenize='trigram')"))


def ensure_schema(db: Session | None = None) -> None:
    """The index tables of this version. Inside a session (a note being written) on its own connection, so a second
    connection never waits for the lock the first one holds; at the start alone, and then the tables of older
    versions go."""
    global _ready
    if db is not None:
        _create(db.execute)
        _ready = True
        return
    with engine.begin() as connection:
        names = [row[0] for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))]
        for name in names:
            if re.fullmatch(r"search_(index|rows)_v\d+", name) and name not in (INDEX, ROWS):
                connection.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
                logger.info("Old search index dropped table=%s", name)
        _create(connection.execute)
    _ready = True


def _row_values(db: Session, note: Note) -> dict[str, str]:
    title = fold(note.title or "")
    if _hidden(db, note):
        return {"title": title, "body": "", "extra": "", "tags": ""}
    tags = sorted({fold(tag) for tag in _tag_source(db, note) if tag})
    extra = " ".join(fold(part.text) for part in _parts(db, note))
    return {"title": title, "body": fold(note.text or ""), "extra": extra,
            "tags": (" " + " ".join(f"#{tag}" for tag in tags) + " ") if tags else ""}


def _write(db: Session, note: Note) -> None:
    values = _row_values(db, note)
    row = db.execute(_sql("SELECT id FROM @rows WHERE note_id = :id"), {"id": note.id}).scalar()
    if row is None:
        row = db.execute(_sql("INSERT INTO @rows (note_id) VALUES (:id) RETURNING id"), {"id": note.id}).scalar()
    else:
        db.execute(_sql("DELETE FROM @index WHERE rowid = :row"), {"row": row})
    db.execute(_sql("INSERT INTO @index (rowid, title, body, extra, tags) VALUES (:row, :title, :body, :extra, :tags)"),
               {"row": row, **values})


def index_note(db: Session, note: Note) -> None:
    """The note into the index, in the caller's transaction (the hook of ``services/notes.py``). A failure is logged
    and never keeps the note from being saved; the next start fills the gap."""
    try:
        if not _ready:
            ensure_schema(db)
        if note.id is None:
            # A note made without an id gets it when written; the index needs it now.
            db.flush()
        _write(db, note)
    except Exception:
        logger.exception("Indexing failed note=%s", note.id)


def reindex(note_id: str) -> None:
    """One note again: after text recognition finished (EC-3), after its tags changed elsewhere."""
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        if note is None:
            return
        index_note(db, note)
        db.commit()


def _forget_gone(db: Session) -> int:
    gone = list(db.execute(_sql("SELECT id FROM @rows WHERE note_id NOT IN (SELECT id FROM notes)")).scalars())
    for start in range(0, len(gone), BATCH):
        chunk = gone[start:start + BATCH]
        marks = {"ids": [int(row) for row in chunk]}
        db.execute(_sql("DELETE FROM @index WHERE rowid IN :ids").bindparams(bindparam("ids", expanding=True)), marks)
        db.execute(_sql("DELETE FROM @rows WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)), marks)
    return len(gone)


def fill(*, everything: bool = False) -> int:
    """Notes missing from the index go in (a database from before the search, a restored backup); with
    ``everything`` every note anew. Returns how many were indexed."""
    ensure_schema()
    with SessionLocal() as db:
        if everything:
            db.execute(_sql("DELETE FROM @index"))
            db.execute(_sql("DELETE FROM @rows"))
            db.commit()
        _forget_gone(db)
        db.commit()
        missing = list(db.execute(_sql("SELECT id FROM notes WHERE id NOT IN (SELECT note_id FROM @rows)")).scalars())
    done = 0
    for start in range(0, len(missing), BATCH):
        with SessionLocal() as db:
            for note in db.scalars(select(Note).where(Note.id.in_(missing[start:start + BATCH]))):
                _write(db, note)
                done += 1
            db.commit()
    if done:
        logger.info("Search index filled notes=%s", done)
    return done


def reindex_all() -> int:
    return fill(everything=True)


def _cleanup() -> None:
    with SessionLocal() as db:
        gone = _forget_gone(db)
        db.commit()
    if gone:
        logger.info("Search index rows of removed notes dropped count=%s", gone)


def register() -> None:
    """At every start: the hook in the notes service, the cleanup job, the tables, and what is missing indexed.
    Looked up rather than remembered, like ``notes.register``."""
    register_hooks()
    fill()


def register_hooks() -> None:
    from . import cleanup, notes

    notes.on_text_written(index_note)
    if all(job is not _cleanup for _, job in cleanup._jobs):
        cleanup.register("search index", _cleanup)


# --- Queries ------------------------------------------------------------------------------------------------------


@dataclass
class Query:
    """What the member typed, cut into pieces and folded."""

    #: Words and phrases (in quotes), each a string that must occur.
    terms: list[str] = field(default_factory=list)
    #: Tags written as ``#word``: notes with a tag that starts so.
    tags: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.terms and not self.tags


_QUOTES = "\"„“”"
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PIECE = re.compile(rf"[{_QUOTES}]([^{_QUOTES}]*)[{_QUOTES}]?|[^\s{_QUOTES}]+")


def parse(raw: str) -> Query:
    """Words in any order, phrases in quotes (also „…“), tags with ``#`` (AC-7, EC-5)."""
    query = Query()
    for match in _PIECE.finditer(_CONTROL.sub(" ", raw or "")):
        quoted = match.group(1)
        if quoted is not None:
            term = fold(quoted).strip()
            if term and term not in query.terms:
                query.terms.append(term)
            continue
        piece = match.group(0)
        if piece.startswith("#") and len(piece) > 1:
            tag = fold(clean_tag(piece))
            if tag and tag not in query.tags:
                query.tags.append(tag)
                continue
        term = fold(piece).strip()
        if term and term not in query.terms:
            query.terms.append(term)
    query.terms = query.terms[:TERMS_MAX]
    query.tags = query.tags[:TERMS_MAX]
    return query


def _quoted(value: str) -> str:
    """A string for ``MATCH``: inside double quotes, quotes doubled; a NUL would end the expression early."""
    return '"' + value.replace("\x00", "").replace('"', '""') + '"'


@dataclass
class Filters:
    folder_ids: list[str] | None = None
    tag: str = ""
    since: datetime | None = None
    until: datetime | None = None
    date_field: str = "updated"

    @property
    def any(self) -> bool:
        return self.folder_ids is not None or bool(self.tag) or self.since is not None or self.until is not None


def _conditions(query: Query, filters: Filters | None) -> tuple[str, list[ColumnElement[bool]]]:
    """The ``MATCH`` expression (empty when nothing long enough) and further conditions."""
    match: list[str] = []
    extra: list[ColumnElement[bool]] = []
    for term in query.terms:
        if len(term) >= 3:
            match.append("{title body extra} : " + _quoted(term))
        else:
            # Too short for trigrams: looked for in the folded columns of the same row.
            extra.append(or_(*(func.instr(_INDEX_T.c[name], term) > 0 for name in ("title", "body", "extra"))))
    for tag in query.tags:
        match.append("tags : " + _quoted(f" #{tag}"))
    if filters is not None:
        if filters.tag:
            match.append("tags : " + _quoted(f" #{filters.tag} "))
        if filters.folder_ids is not None:
            extra.append(Note.folder_id.in_(filters.folder_ids))
        column = Note.created_at if filters.date_field == "created" else Note.updated_at
        if filters.since is not None:
            extra.append(column >= filters.since)
        if filters.until is not None:
            extra.append(column <= filters.until)
    return " AND ".join(match), extra


def _base(account: Account, match: str, extra: Sequence[ColumnElement[bool]], *columns: Any) -> Any:
    statement = (select(*columns)
                 .select_from(_INDEX_T)
                 .join(_ROWS_T, _ROWS_T.c.id == _INDEX_T.c.rowid)
                 .join(Note, Note.id == _ROWS_T.c.note_id)
                 .where(Note.deleted_at.is_(None), _scope(account), *extra))
    if match:
        statement = statement.where(_sql("@index MATCH :match").bindparams(match=match))
    return statement


def _count(db: Session, account: Account, query: Query, filters: Filters | None) -> int:
    match, extra = _conditions(query, filters)
    return int(db.scalar(_base(account, match, extra, func.count())) or 0)


def folder_tree(db: Session, account: Account, folder_id: str) -> list[str]:
    """The folder and all folders below it (AC-4), the account's own and alive; ``not_found`` otherwise."""
    rows = db.execute(select(Folder.id, Folder.parent_id)
                      .where(Folder.owner_id == account.id, Folder.deleted_at.is_(None))).all()
    known = {row.id for row in rows}
    if folder_id not in known:
        raise error("not_found", "Not found.", 404)
    children: dict[str | None, list[str]] = {}
    for row in rows:
        children.setdefault(row.parent_id, []).append(row.id)
    found: list[str] = []
    todo = [folder_id]
    while todo:
        current = todo.pop()
        if current in found:
            continue
        found.append(current)
        todo.extend(children.get(current, []))
    return found


# --- Excerpts -----------------------------------------------------------------------------------------------------

Segment = dict[str, Any]


def _spans(value: str, needles: Sequence[str]) -> tuple[list[tuple[int, int]], str, list[int]]:
    """Where the folded needles stand in ``value``, as (start, end) in the original, sorted and merged."""
    folded, starts = fold_with_map(value)
    spans: list[tuple[int, int]] = []
    for needle in needles:
        if not needle:
            continue
        at = folded.find(needle)
        found = 0
        while at >= 0 and found < MARKS_MAX:
            end = at + len(needle)
            spans.append((starts[at], starts[end - 1] + 1))
            found += 1
            at = folded.find(needle, end)
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged, folded, starts


def _segments(value: str, spans: Sequence[tuple[int, int]], start: int = 0, end: int | None = None) -> list[Segment]:
    end = len(value) if end is None else end
    out: list[Segment] = []
    at = start
    for span_start, span_end in spans:
        if span_end <= start or span_start >= end:
            continue
        span_start, span_end = max(span_start, start), min(span_end, end)
        if span_start > at:
            out.append({"text": value[at:span_start], "hit": False})
        out.append({"text": value[span_start:span_end], "hit": True})
        at = span_end
    if at < end:
        out.append({"text": value[at:end], "hit": False})
    return out


_FLAT = re.compile(r"\s")


def excerpt(value: str, spans: Sequence[tuple[int, int]]) -> list[Segment]:
    """A piece of ``value`` around its first hit, with every hit in it marked; blanks of any kind as spaces."""
    flat = _FLAT.sub(" ", value)
    if not spans:
        end = min(len(flat), EXCERPT_CHARS)
        while end < len(flat) and end < EXCERPT_CHARS + 20 and not flat[end].isspace():
            end += 1
        return _with_ellipsis(_segments(flat, [], 0, end), False, end < len(flat))
    first = spans[0][0]
    start = max(0, first - EXCERPT_BEFORE)
    if start > 0:
        blank = flat.find(" ", start, first)
        start = blank + 1 if blank >= 0 else start
    end = min(len(flat), max(start + EXCERPT_CHARS, spans[0][1]))
    if end < len(flat):
        blank = flat.rfind(" ", spans[0][1], end)
        end = blank if blank > spans[0][1] else end
    return _with_ellipsis(_segments(flat, spans, start, end), start > 0, end < len(flat))


def _with_ellipsis(segments: list[Segment], before: bool, after: bool) -> list[Segment]:
    if segments and before:
        if segments[0]["hit"]:
            segments.insert(0, {"text": "… ", "hit": False})
        else:
            segments[0] = {**segments[0], "text": "… " + segments[0]["text"].lstrip()}
    if segments and after:
        if segments[-1]["hit"]:
            segments.append({"text": " …", "hit": False})
        else:
            segments[-1] = {**segments[-1], "text": segments[-1]["text"].rstrip() + " …"}
    return [segment for segment in segments if segment["text"]]


def _jump(value: str, span: tuple[int, int]) -> dict[str, Any]:
    """What the editor looks for to put the hit in view (AC-5): the text of the hit as written and how many times
    the same text comes before it."""
    needle = value[span[0]:span[1]]
    return {"text": needle, "nth": value.count(needle, 0, span[0]) if needle else 0}


def _hit(db: Session, note: Note, query: Query, folders: dict[str, Folder]) -> dict[str, Any]:
    needles = query.terms + [f"#{tag}" for tag in query.tags]
    title_spans, _, _ = _spans(note.title or "", query.terms)
    hidden = _hidden(db, note)
    body = "" if hidden else (note.text or "")
    body_spans, _, _ = _spans(body, needles) if body else ([], "", [])
    where = "text" if body_spans else ("title" if title_spans else "text")
    attachment: dict[str, Any] | None = None
    shown = excerpt(body, body_spans)
    jump = _jump(body, body_spans[0]) if body_spans else None
    if not body_spans and not title_spans and not hidden and query.terms:
        for part in _parts(db, note):
            part_spans, _, _ = _spans(part.text, query.terms)
            if part_spans:
                where = "attachment"
                attachment = {"kind": part.kind, "name": part.name, "page": part.page, "ref": part.ref}
                shown = excerpt(part.text, part_spans)
                jump = _jump(part.text, part_spans[0])
                break
    folder = folders.get(note.folder_id)
    return {
        "id": note.id,
        "title": note.title,
        "title_parts": _segments(note.title or "", title_spans),
        "excerpt": shown,
        "where": where,
        "attachment": attachment,
        "jump": jump,
        "folder": None if folder is None else {"id": folder.id, "name": folder.name,
                                               "inbox": folder.kind == FOLDER_INBOX},
        "owner_id": note.owner_id,
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }


# --- Searching ----------------------------------------------------------------------------------------------------


@dataclass
class Result:
    total: int
    items: list[dict[str, Any]]
    offset: int
    #: Hits the same query has without any filter; only when the filters left nothing (EC-2).
    unfiltered: int | None
    terms: list[str]
    tags: list[str]


def search(db: Session, account: Account, raw: str, filters: Filters | None = None, *, offset: int = 0,
           limit: int = PAGE) -> Result:
    """One page of hits for what the member typed, best first (AC-1, AC-2, AC-4, AC-7)."""
    if len(raw or "") > QUERY_MAX:
        raise error("invalid_input", "The input is not valid.", 422, fields=["q"])
    if not _ready:
        ensure_schema(db)
    query = parse(raw)
    filters = filters if filters is not None and filters.any else None
    if query.empty and filters is None:
        return Result(total=0, items=[], offset=offset, unfiltered=None, terms=[], tags=[])
    match, extra = _conditions(query, filters)
    total = _count(db, account, query, filters)
    ids: list[str]
    if match and not query.empty:
        weights = ", ".join(str(weight) for weight in WEIGHTS)
        score = literal_column(f"bm25({INDEX}, {weights})")
        statement = _base(account, match, extra, Note.id).order_by(score, Note.updated_at.desc(), Note.id)
    else:
        statement = _base(account, match, extra, Note.id).order_by(Note.updated_at.desc(), Note.id)
    ids = list(db.scalars(statement.offset(offset).limit(limit)))
    # The Yjs document stays in the database: a hit needs the title and the plain text only.
    page = select(Note).options(defer(Note.ydoc)).where(Note.id.in_(ids))
    rows = {note.id: note for note in db.scalars(page)} if ids else {}
    folder_ids = {note.folder_id for note in rows.values()}
    folders = {folder.id: folder for folder in db.scalars(select(Folder).where(Folder.id.in_(folder_ids)))} \
        if folder_ids else {}
    items = [_hit(db, rows[note_id], query, folders) for note_id in ids if note_id in rows]
    unfiltered = None
    if total == 0 and filters is not None and not query.empty:
        unfiltered = _count(db, account, query, None)
    return Result(total=total, items=items, offset=offset, unfiltered=unfiltered, terms=query.terms, tags=query.tags)


def tags(db: Session, account: Account, limit: int = 200) -> list[dict[str, Any]]:
    """The tags of the account's notes for the filter, most used first; shown as most often written."""
    counts: dict[str, int] = {}
    spelled: dict[str, dict[str, int]] = {}
    notes = db.scalars(select(Note).options(defer(Note.ydoc)).where(Note.deleted_at.is_(None), _scope(account)))
    for note in notes:
        if _hidden(db, note):
            continue
        seen: set[str] = set()
        for tag in _tag_source(db, note):
            key = fold(tag)
            spelled.setdefault(key, {})[tag] = spelled.setdefault(key, {}).get(tag, 0) + 1
            if key not in seen:
                counts[key] = counts.get(key, 0) + 1
                seen.add(key)
    ordered = sorted(counts, key=lambda key: (-counts[key], key))[:limit]
    return [{"tag": max(spelled[key], key=lambda name: (spelled[key][name], name)), "key": key, "count": counts[key]}
            for key in ordered]
