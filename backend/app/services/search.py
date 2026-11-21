"""Search over titles and texts (NOTES-9).

The index is an FTS5 table with the trigram tokenizer: trigrams find any part of a word, so "rechn" finds "Rechnung"
and "Stromrechnung" (AC-2), and every prefix while somebody types. It holds a *folded* copy of each note: case gone
(``casefold``, so ß becomes ss), ä/ö/ü written as ae/oe/ue, other accents dropped, runs of blanks one space. The query
is folded the same way, so "Müller" meets "mueller" and "Straße" meets "strasse" (EC-1).

Nothing the member types reaches ``MATCH`` as syntax: the query is cut into words, phrases in quotes and tags
(``#word``) here, and each piece goes into the expression as a string in double quotes. ``NEAR``, ``*``, ``OR``,
brackets and a quote left open are plain text (EC-5). Words shorter than three characters, which a trigram index cannot
find, are looked for with ``instr`` in the folded columns.

Tags are not in this index: ``#word`` and the tag filter ask the table of the tags (``note_tags``, NOTES-5), which
knows what is a tag and what is not (code, links, addresses, numbers). ``#wo`` while typing finds the tags that start
so, the filter one tag exactly.

The index follows the note in the same transaction: ``services/notes.py`` calls ``index_note`` wherever it writes a
title or a text (``notes.on_text_written``). Notes in the trash stay in the index and are left out when searching, so
they come back with "Zurückholen" without a new pass. Rows of notes gone for good go in the cleanup round.

Other features dock on here, mostly through the hooks the tags already have:

- ``tags.SHARED_NOTES``: further notes an account may read (sharing, NOTES-13), asked at every search, so a right taken
  away counts at once (EC-7).
- ``tags.HIDDEN_NOTES``: locked notes (NOTES-16). Only their title goes into the index; locking and unlocking call
  ``reindex``.
- ``register_text_source``: text that is not in the note's body, such as text recognised in pictures and PDFs
  (NOTES-11). A hit only there names the attachment and its page (AC-3); ``reindex`` after a recognition finished
  (EC-3).
"""

from __future__ import annotations

import functools
import logging
import re
import unicodedata
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import (
    ColumnElement,
    bindparam,
    column,
    func,
    inspect,
    literal,
    literal_column,
    or_,
    select,
    table,
    text,
    union,
    union_all,
)
from sqlalchemy.orm import Session, defer

from ..db import SessionLocal, engine
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note
from ..models_tags import NoteTag
from . import tags

logger = logging.getLogger("nexnotes.search")

#: Changes whenever the folding or the columns change: the tables carry it in their names, and a start with a new
#: version builds the index anew and drops the old tables.
INDEX_VERSION = 3
INDEX = f"search_index_v{INDEX_VERSION}"
ROWS = f"search_rows_v{INDEX_VERSION}"

#: Hits per page; the list loads the next page when it reaches the end (EC-4).
PAGE = 50
PAGE_MAX = 100
#: The longest query taken; longer ones are refused, not cut.
QUERY_MAX = 500
#: Terms and tags a query holds at most; more are refused, not cut (AC-7 asks for all words).
TERMS_MAX = 16
#: The longest word or phrase, in folded characters: a long phrase costs the index a lot and finds nothing a shorter
#: piece of it would not.
TERM_CHARS_MAX = 100
#: Weights of bm25 per column: title, body, extra.
WEIGHTS = (10.0, 1.0, 0.5)
#: Characters of text an excerpt shows before the first hit and in total.
EXCERPT_BEFORE = 60
EXCERPT_CHARS = 220
#: Occurrences of one term marked in one text at most.
MARKS_MAX = 50
#: Notes indexed per transaction when the index is built at the start.
BATCH = 500
#: Characters of text looked through at a time for the first hit; only around it are hits marked and mapped back to
#: the original letters, so a very long note costs no more than a short one.
SCAN_STEP = 8192


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


#: Blanks to join: a run of them, or a single one that is not a plain space (a plain space stays as it is, which keeps
#: the work small in ordinary text).
_BLANKS = re.compile(r"\s{2,}|[^\S ]")
_AFTER_VOWEL = re.compile(r"(?<=[aou])" + _COMBINING_DIAERESIS)


def fold(value: str) -> str:
    """``value`` as the index holds it: no case, umlauts as ae/oe/ue, ß as ss, no other accents, one space. The same
    as ``fold_with_map(value)[0]``, without the map and at the speed of ``str.translate``, so a long note is folded
    quickly."""
    if value.isascii():
        return _BLANKS.sub(" ", value.lower())
    table: dict[int, str] = {}
    for char in set(value):
        if char.isspace():
            table[ord(char)] = " "
        elif char != _COMBINING_DIAERESIS:
            folded = char.lower() if char.isascii() else _fold_char(char)
            if folded != char:
                table[ord(char)] = folded
    out = value.translate(table)
    if _COMBINING_DIAERESIS in out:
        out = _AFTER_VOWEL.sub("e", out).replace(_COMBINING_DIAERESIS, "")
    return _BLANKS.sub(" ", out)


# --- Tags ---------------------------------------------------------------------------------------------------------


def tag_key(raw: str) -> str:
    """The key of a tag as typed (with or without ``#``, a sign after it falls away as in the text: ``#bad,``), the way
    ``note_tags`` compares; empty when it is no tag (``#1``, ``#``, a sign)."""
    value = (raw or "").strip()
    found = tags.find_tags(value if value.startswith("#") else f"#{value}")
    return tags.key_of(found[0].label) if found and found[0].start == 0 else ""


def _tagged(key: str, *, prefix: bool) -> ColumnElement[bool]:
    """Notes with the tag ``key`` (or one that starts so, while typing), among the notes whose tags count."""
    wanted = NoteTag.key.startswith(key, autoescape=True) if prefix else NoteTag.key == key
    return Note.id.in_(select(NoteTag.note_id).where(wanted))


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


def _hidden(db: Session, note: Note) -> bool:
    """A locked note (``tags.HIDDEN_NOTES``, NOTES-16): its content is not searched, its title is."""
    if not tags.HIDDEN_NOTES or note.id is None:
        return False
    found = db.scalar(select(func.count()).select_from(Note)
                      .where(Note.id == note.id, or_(*(hidden() for hidden in tags.HIDDEN_NOTES))))
    return bool(found)


# --- Who may find what --------------------------------------------------------------------------------------------


#: Every account has its own block of row ids in the index: ``owner_id << ROW_BITS`` and up. A search gives the index
#: the block as a range of row ids next to ``MATCH``, so the index skips other accounts' rows instead of handing them on
#: to be filtered out afterwards; how long a search takes then says nothing about words in other accounts' notes.
ROW_BITS = 32


def _block(owner_id: int) -> tuple[int, int]:
    """The first and the last row id of an account's block."""
    first = owner_id << ROW_BITS
    return first, first + (1 << ROW_BITS) - 1


def _shared(account: Account) -> list[Any]:
    """Notes shared with the account (``tags.SHARED_NOTES``, the one hook of NOTES-13), as selects of note ids."""
    return [rule(account.id) for rule in tags.SHARED_NOTES]


# --- The index ----------------------------------------------------------------------------------------------------

_ready = False


_INDEX_T = table(INDEX, column("rowid"), column("title"), column("body"), column("extra"))
_ROWS_T = table(ROWS, column("id"), column("note_id"))


def _sql(template: str) -> Any:
    """A statement on the index tables; ``@index`` and ``@rows`` stand for their names (constants, never input)."""
    return text(template.replace("@index", INDEX).replace("@rows", ROWS))


def _create(run: Callable[[Any], Any]) -> None:
    run(_sql("CREATE TABLE IF NOT EXISTS @rows (id INTEGER PRIMARY KEY, note_id TEXT NOT NULL UNIQUE)"))
    run(_sql("CREATE VIRTUAL TABLE IF NOT EXISTS @index USING fts5(title, body, extra, tokenize='trigram')"))


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
        _secure_delete(connection)
    _ready = True


#: Whether the index overwrites what it deletes (FTS5 ``secure-delete``, SQLite 3.44 and later).
_secure = False


def _secure_delete(connection: Any) -> None:
    """Entries of a deleted or rewritten row are removed from the index at once, not only marked: the content of a
    note locked in the vault (NOTES-16) leaves nothing behind in the index's pages. Older SQLite: merged after each
    lock instead (``forget_deleted``)."""
    global _secure
    try:
        connection.execute(_sql("INSERT INTO @index(@index, rank) VALUES('secure-delete', 1)"))
        _secure = True
    except Exception:  # noqa: BLE001 - an SQLite before 3.44 knows no such option
        _secure = False
        logger.info("The search index cannot overwrite deleted entries; it is merged after each lock instead")


def forget_deleted() -> None:
    """After a note was locked: without ``secure-delete`` the index is merged into one segment, which drops what was
    deleted from it."""
    if _secure:
        return
    with engine.begin() as connection:
        connection.execute(_sql("INSERT INTO @index(@index) VALUES('optimize')"))


def _row_values(db: Session, note: Note) -> dict[str, str]:
    title = fold(note.title or "")
    if _hidden(db, note):
        return {"title": title, "body": "", "extra": ""}
    extra = " ".join(fold(part.text) for part in _parts(db, note))
    return {"title": title, "body": fold(note.text or ""), "extra": extra}


#: A row for the note in the owner's block, unless it has one. A write: it takes the database's write lock first.
_NEW_ROW = ("INSERT INTO @rows (id, note_id) SELECT COALESCE(MAX(id) + 1, :first), :id FROM @rows "
            "WHERE id BETWEEN :first AND :last ON CONFLICT (note_id) DO NOTHING")


def _write(db: Session, note: Note) -> None:
    values = _row_values(db, note)
    first, last = _block(note.owner_id)
    marks = {"id": note.id, "first": first, "last": last}
    # Written before anything is read: two writers of one note (two starts filling the gaps, a recognition finished
    # while the note is indexed elsewhere) would otherwise both read "no row yet" and the second insert fail. The insert
    # takes the write lock, so what follows reads the row as the other writer left it and nobody changes it meanwhile.
    db.execute(_sql(_NEW_ROW), marks)
    row = db.execute(_sql("SELECT id FROM @rows WHERE note_id = :id"), {"id": note.id}).scalar_one()
    if not first <= row <= last:
        # The note has another owner now: its row moves into the owner's block.
        db.execute(_sql("DELETE FROM @index WHERE rowid = :row"), {"row": row})
        db.execute(_sql("DELETE FROM @rows WHERE id = :row"), {"row": row})
        db.execute(_sql(_NEW_ROW), marks)
        row = db.execute(_sql("SELECT id FROM @rows WHERE note_id = :id"), {"id": note.id}).scalar_one()
    # One entry per row: what the index held under it goes before the new one comes.
    db.execute(_sql("DELETE FROM @index WHERE rowid = :row"), {"row": row})
    db.execute(_sql("INSERT INTO @index (rowid, title, body, extra) VALUES (:row, :title, :body, :extra)"),
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
    # The cleaning round starts with the server, beside the search's own start (``register``), which makes the tables
    # and drops the rows of gone notes itself. On a fresh data folder the round can come first: then there is no index
    # to clean yet.
    if not _ready and not inspect(engine).has_table(ROWS):
        return
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
    #: Tags written as ``#word`` (their keys): notes with a tag that starts so.
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
            tag = tag_key(piece)
            if tag and tag not in query.tags:
                query.tags.append(tag)
                continue
        term = fold(piece).strip()
        if term and term not in query.terms:
            query.terms.append(term)
    if len(query.terms) + len(query.tags) > TERMS_MAX:
        raise error("search_too_many_terms", f"A search takes at most {TERMS_MAX} words, phrases and tags.", 422,
                    maximum=TERMS_MAX)
    if any(len(term) > TERM_CHARS_MAX for term in query.terms):
        raise error("search_term_too_long", f"A word or phrase may have at most {TERM_CHARS_MAX} characters.", 422,
                    maximum=TERM_CHARS_MAX)
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


def _conditions(account: Account, query: Query, filters: Filters | None) -> tuple[str, list[ColumnElement[bool]]]:
    """The ``MATCH`` expression (empty when nothing long enough) and further conditions."""
    match: list[str] = []
    extra: list[ColumnElement[bool]] = []
    for term in query.terms:
        if len(term) >= 3:
            match.append("{title body extra} : " + _quoted(term))
        else:
            # Too short for trigrams: looked for in the folded columns of the same row.
            extra.append(or_(*(func.instr(_INDEX_T.c[name], term) > 0 for name in ("title", "body", "extra"))))
    tagged = [_tagged(tag, prefix=True) for tag in query.tags]
    if filters is not None and filters.tag:
        tagged.append(_tagged(filters.tag, prefix=False))
    if tagged:
        # Tags count only where the tags say they count (not in the trash, not in a locked note).
        extra.extend([tags.visible(account.id), *tagged])
    if filters is not None:
        if filters.folder_ids is not None:
            extra.append(Note.folder_id.in_(filters.folder_ids))
        column = Note.created_at if filters.date_field == "created" else Note.updated_at
        if filters.since is not None:
            extra.append(column >= filters.since)
        if filters.until is not None:
            extra.append(column <= filters.until)
    return " AND ".join(match), extra


def _bases(account: Account, match: str, extra: Sequence[ColumnElement[bool]], *columns: Any) -> list[Any]:
    """The statements that find the hits: one over the account's own block of the index, and, once notes are shared
    with it, one over the rows of those notes. Each hands the index the rows it may touch together with ``MATCH``."""
    first, last = _block(account.id)
    parts = [(_INDEX_T.c.rowid.between(first, last), Note.owner_id == account.id)]
    shared = _shared(account)
    if shared:
        ids = shared[0] if len(shared) == 1 else union(*shared)
        rows = select(_ROWS_T.c.id).where(_ROWS_T.c.note_id.in_(ids))
        parts.append((_INDEX_T.c.rowid.in_(rows), Note.owner_id != account.id))
    statements = []
    for rows_wanted, whose in parts:
        statement = (select(*columns)
                     .select_from(_INDEX_T)
                     .join(_ROWS_T, _ROWS_T.c.id == _INDEX_T.c.rowid)
                     .join(Note, Note.id == _ROWS_T.c.note_id)
                     .where(rows_wanted, whose, Note.deleted_at.is_(None), *extra))
        if match:
            statement = statement.where(_sql("@index MATCH :match").bindparams(match=match))
        statements.append(statement)
    return statements


def _total(db: Session, account: Account, match: str, extra: Sequence[ColumnElement[bool]]) -> int:
    return sum(int(db.scalar(statement) or 0) for statement in _bases(account, match, extra, func.count()))


def _count(db: Session, account: Account, query: Query, filters: Filters | None) -> int:
    match, extra = _conditions(account, query, filters)
    return _total(db, account, match, extra)


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


def _spans_in(value: str, needles: Sequence[str], offset: int = 0) -> list[tuple[int, int]]:
    """Where the folded needles stand in ``value``, as (start, end) in the original plus ``offset``, sorted and
    merged."""
    folded, starts = fold_with_map(value)
    spans: list[tuple[int, int]] = []
    for needle in needles:
        at = folded.find(needle)
        found = 0
        while at >= 0 and found < MARKS_MAX:
            end = at + len(needle)
            spans.append((offset + starts[at], offset + starts[end - 1] + 1))
            found += 1
            at = folded.find(needle, end)
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


#: Letters that fold into more than one (ä to ae, ß to ss, ﬁ to fi): a stretch of a needle that one letter of the text
#: may stand for. Filled with ``_letters_of`` on first use.
_MULTI: set[str] = set()
#: For each folded character, the characters of the text whose folding holds it ("a": a, A, á, Ä, ...).
_SOURCES: dict[str, set[str]] = {}
#: Marks that fold to nothing and may follow any letter of the text.
_MARKS = "[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]*"
#: Candidates checked letter by letter before the whole text is folded after all.
CANDIDATES_MAX = 200


def _letters_of() -> dict[str, set[str]]:
    if not _SOURCES:
        ranges = [range(0x20, 0x7F), range(0xA0, 0x2000), range(0x1E00, 0x2000), range(0x2100, 0x2190),
                  range(0xFB00, 0xFB50), range(0xFF00, 0xFF60)]
        for code in (code for each in ranges for code in each):
            char = chr(code)
            folded = char.lower() if char.isascii() else _fold_char(char)
            if len(folded) > 1:
                _MULTI.add(folded)
            for piece in folded:
                _SOURCES.setdefault(piece, set()).add(char)
    return _SOURCES


@functools.lru_cache(maxsize=256)
def _anchor(needle: str) -> re.Pattern[str] | None:
    """A pattern for the raw text that every place holding ``needle`` (after folding) matches: the longest stretch of
    the needle without blanks and without letters one character of the text may fold into together; each letter a
    class of the characters that fold to it. ``None`` when no stretch of three is left."""
    sources = _letters_of()
    free = [char != " " for char in needle]
    for multi in _MULTI:
        at = needle.find(multi)
        while at >= 0:
            for index in range(at, at + len(multi)):
                free[index] = False
            at = needle.find(multi, at + 1)
    best, run = (0, 0), 0
    for index, ok in enumerate([*free, False]):
        if ok:
            run += 1
            continue
        if run > best[1] - best[0]:
            best = (index - run, index)
        run = 0
    if best[1] - best[0] < 3:
        return None
    parts = []
    for char in needle[best[0]:best[1]]:
        chars = sources.get(char, set()) | {char, char.upper()}
        parts.append("[" + "".join(re.escape(each) for each in sorted(chars)) + "]" + _MARKS)
    return re.compile("".join(parts))


def _first_at(value: str, needle: str, reach: int) -> int | None:
    """Where the first place holding ``needle`` starts in ``value``: candidates from ``_anchor`` checked letter by
    letter in a small stretch; the whole text folded only when the needle has no anchor or too many candidates fail."""
    pattern = _anchor(needle)
    after = 0
    if pattern is not None:
        for number, match in enumerate(pattern.finditer(value)):
            if number >= CANDIDATES_MAX:
                after = max(0, match.start() - reach)
                break
            low = max(0, match.start() - reach)
            spans = _spans_in(value[low:match.start() + 2 * reach], [needle], low)
            if spans:
                return spans[0][0]
        else:
            return None
    for start in range(after, len(value), SCAN_STEP):
        piece = value[start:start + SCAN_STEP + reach]
        if needle in fold(piece):
            spans = _spans_in(piece, [needle], start)
            if spans:
                return spans[0][0]
    return None


def _spans(value: str, needles: Sequence[str]) -> list[tuple[int, int]]:
    """The hits around the first one, as (start, end) in ``value``: enough for the excerpt and the jump (AC-1, AC-5).
    Only the stretch of the excerpt is folded letter by letter, wherever the hit is: a long text is first looked
    through with a pattern of the raw letters (``_first_at``), so a note of half a megabyte costs about as much as a
    short one."""
    needles = [needle for needle in needles if needle]
    if not needles or not value:
        return []
    # How far a hit may reach: a folded letter is never shorter than its original, except for blanks run together and
    # marks that fall away.
    reach = max(len(needle) for needle in needles) * 3 + 64
    if len(value) <= SCAN_STEP:
        return _spans_in(value, needles)
    starts = [at for at in (_first_at(value, needle, reach) for needle in needles) if at is not None]
    if not starts:
        return []
    first = min(starts)
    low = max(0, first - EXCERPT_BEFORE - reach)
    return [span for span in _spans_in(value[low:first + EXCERPT_CHARS + reach], needles, low) if span[0] >= first]


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
    """A piece of ``value`` around its first hit, with every hit in it marked; blanks of any kind as spaces. Only the
    stretch around the hit is looked at, however long the text."""
    if not spans:
        flat = _FLAT.sub(" ", value[:EXCERPT_CHARS + 20])
        end = min(len(flat), EXCERPT_CHARS)
        while end < len(flat) and end < EXCERPT_CHARS + 20 and not flat[end].isspace():
            end += 1
        return _with_ellipsis(_segments(flat, [], 0, end), False, end < len(value))
    first, first_end = spans[0]
    low = max(0, first - EXCERPT_BEFORE)
    high = min(len(value), max(first + EXCERPT_CHARS, first_end))
    # Blanks become spaces one for one, so the positions in the stretch stay those of the text.
    flat = _FLAT.sub(" ", value[low:high])
    shifted = [(span_start - low, span_end - low) for span_start, span_end in spans]
    start = 0
    if low > 0:
        blank = flat.find(" ", 0, first - low)
        start = blank + 1 if blank >= 0 else 0
    end = min(len(flat), max(start + EXCERPT_CHARS, first_end - low))
    if high < len(value) or end < len(flat):
        blank = flat.rfind(" ", first_end - low, end)
        end = blank if blank > first_end - low else end
    return _with_ellipsis(_segments(flat, shifted, start, end), low + start > 0, low + end < len(value))


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
    needles = query.terms + [fold(f"#{tag}") for tag in query.tags]
    title_spans = _spans(note.title or "", query.terms)
    hidden = _hidden(db, note)
    body = "" if hidden else (note.text or "")
    body_spans = _spans(body, needles)
    where = "text" if body_spans else ("title" if title_spans else "text")
    attachment: dict[str, Any] | None = None
    shown = excerpt(body, body_spans)
    jump = _jump(body, body_spans[0]) if body_spans else None
    if not body_spans and not title_spans and not hidden and query.terms:
        for part in _parts(db, note):
            part_spans = _spans(part.text, query.terms)
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
        "icon": note.icon or "",
        "color": note.color or "",
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
    match, extra = _conditions(account, query, filters)
    total = _count(db, account, query, filters)
    if match and not query.empty:
        weights = ", ".join(str(weight) for weight in WEIGHTS)
        score: Any = literal_column(f"bm25({INDEX}, {weights})")
    else:
        score = literal(0)
    parts = _bases(account, match, extra, Note.id.label("id"), score.label("score"), Note.updated_at.label("changed"))
    hits = (parts[0] if len(parts) == 1 else union_all(*parts)).subquery()
    statement = select(hits.c.id).order_by(hits.c.score, hits.c.changed.desc(), hits.c.id)
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
