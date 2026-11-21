"""Tags (NOTES-5): words with ``#`` in the text of a note.

A tag is text and nothing else: the note format stays as it is, no node and no mark says "tag". The server reads the
tags whenever ``Note.text`` follows the document (made, copied, the summary two seconds after a change, folding) and
keeps them in ``note_tags`` (``models_tags.py``); the editor only paints them.

The rule, the same in ``frontend/src/tags/rules.ts`` (both read ``frontend/src/tags/cases.json`` in their tests):

* a ``#`` at the start of a line or after a blank or an opening bracket or quote; after a letter, a digit or ``/`` it
  belongs to an address or a word (``example.com/#part``, ``C#``) and is no tag (EC-1);
* then letters, digits, marks, ``-``, ``_`` and emoji (EC-3); ``-`` and ``_`` at the end fall away, any other sign ends
  the tag (``#bad.`` is ``bad``);
* at least one letter or emoji: ``#1`` and ``#2026`` are numbers, not tags (EC-1); at most ``MAX_TAG`` characters;
* text in inline code or in a link, and code blocks, hold no tags (EC-1); a heading's ``#`` is no text at all;
* ``#Einkauf`` and ``#einkauf`` are one tag (``key_of``), shown in the spelling used most (EC-2).

Renaming and deleting change the text of the member's own notes through the live room (``notes.change``), so an open
editor sees it at once and someone typing at the same moment loses nothing (EC-7). Notes others shared stay as they
are (AC-4, AC-5).

Sharing (NOTES-13) and locked notes (NOTES-16) come later; they dock on through ``SHARED_NOTES`` and ``HIDDEN_NOTES``.
"""

from __future__ import annotations

import logging
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, and_, delete, distinct, event, func, insert, not_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ..db import SessionLocal, sort_key
from ..errors import error
from ..models import FOLDER_INBOX, Account, Folder, Note, NoteUpdate, Setting
from ..models_tags import NoteTag
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from . import notes

logger = logging.getLogger("nexnotes.tags")

#: The version of the rule. Another version (or none: data from before tags) reads every note again at start.
RULES_VERSION = "1"
RULES_SETTING = "tags_rules"
#: The longest tag, in characters; a longer run after ``#`` is no tag.
MAX_TAG = 64
#: Characters before ``#`` that let a tag begin (besides the start and blanks).
OPENERS = frozenset("([{\"'„“”‚‘’«»‹›")
#: Code points of emoji and what joins them (zero width joiner, variation selector, keycap, tag letters of flags).
EMOJI = ((0x200D, 0x200D), (0x20E3, 0x20E3), (0x2300, 0x23FF), (0x2600, 0x27BF), (0x2B00, 0x2BFF), (0xFE0F, 0xFE0F),
         (0x1F000, 0x1FAFF), (0xE0020, 0xE007F))
#: Joiners: part of an emoji, but no emoji of their own.
JOINERS = frozenset({0x200D, 0x20E3, 0xFE0F})
#: Marks whose text holds no tags.
NO_TAG_MARKS = frozenset({s.CODE, s.LINK})


# --- The rule -----------------------------------------------------------------------------------------------------


def _emoji(char: str) -> bool:
    code = ord(char)
    return any(low <= code <= high for low, high in EMOJI)


def _blank(char: str) -> bool:
    return char in "\t\n\r\v\f" or unicodedata.category(char).startswith("Z")


def _tag_char(char: str) -> bool:
    return unicodedata.category(char)[0] in "LMN" or char in "-_" or _emoji(char)


def _strong(char: str) -> bool:
    """A letter or an emoji: what makes ``#…`` a tag rather than a number."""
    code = ord(char)
    if unicodedata.category(char)[0] == "L":
        return True
    return _emoji(char) and code not in JOINERS and not 0xE0020 <= code <= 0xE007F


@dataclass(frozen=True)
class Found:
    #: Index of the ``#`` in the text.
    start: int
    #: Index after the last character of the tag.
    end: int
    #: The tag as written, without ``#``, in NFC.
    label: str


def find_tags(text: str) -> list[Found]:
    """The tags in a piece of plain text, in order."""
    out: list[Found] = []
    length = len(text)
    index = 0
    while index < length:
        if text[index] != "#" or (index > 0 and not _blank(text[index - 1]) and text[index - 1] not in OPENERS):
            index += 1
            continue
        stop = index + 1
        while stop < length and _tag_char(text[stop]):
            stop += 1
        end = stop
        while end > index + 1 and text[end - 1] in "-_":
            end -= 1
        raw = text[index + 1:end]
        if raw and len(raw) <= MAX_TAG and any(_strong(char) for char in raw):
            out.append(Found(index, end, unicodedata.normalize("NFC", raw)))
        index = max(stop, index + 1)
    return out


def key_of(label: str) -> str:
    """What makes two spellings one tag: case does not count (EC-2)."""
    return unicodedata.normalize("NFC", label).lower()


def clean_name(name: str) -> str:
    """A tag's name as the member typed it, with or without ``#``; empty when it is no tag."""
    value = unicodedata.normalize("NFC", (name or "").strip())
    value = value.removeprefix("#")
    found = find_tags("#" + value)
    if len(found) != 1 or found[0].end != len(value) + 1:
        return ""
    return found[0].label


def _excluded(attributes: dict[str, Any] | None) -> bool:
    return any(value is not None and name.split("--", 1)[0] in NO_TAG_MARKS
               for name, value in (attributes or {}).items())


def _inline_text(content: list[dict[str, Any]]) -> str:
    parts = []
    for node in content:
        if node.get("type") == s.HARD_BREAK:
            parts.append("\n")
        elif node.get("type") == s.TEXT:
            text = str(node.get("text") or "")
            marks = {mark.get("type"): {} for mark in node.get("marks") or []}
            parts.append(" " * len(text) if _excluded(marks) else text)
    return "".join(parts)


def texts_of(document: dict[str, Any]) -> Iterable[str]:
    """The text of every text block in reading order, code blocks left out and code and links blanked."""
    for node in document.get("content") or []:
        kind = node.get("type")
        if kind == s.CODE_BLOCK:
            continue
        if kind in s.TEXTBLOCKS:
            yield _inline_text(node.get("content") or [])
        else:
            yield from texts_of(node)


def tags_in(document: dict[str, Any]) -> Counter[str]:
    """How often each spelling stands in a document (ProseMirror JSON)."""
    found: Counter[str] = Counter()
    for text in texts_of(document):
        if "#" in text:
            found.update(tag.label for tag in find_tags(text))
    return found


# --- Keeping the table in step --------------------------------------------------------------------------------------


def tags_of_note(db: Session, note: Note) -> Counter[str]:
    """The tags of a stored note. Without a ``#`` in its plain text there are none, and nothing needs reading; else the
    stored document (state and the updates since) is read, so that code and links are left out."""
    if "#" not in (note.text or ""):
        return Counter()
    try:
        updates = db.connection().execute(
            select(NoteUpdate.update).where(NoteUpdate.note_id == note.id).order_by(NoteUpdate.id)).scalars().all()
        document = notedoc.to_json(notedoc.load(note.ydoc or None, updates))
    except Exception:  # noqa: BLE001 - a document that cannot be read: the plain text is the best there is
        logger.warning("Reading the tags from the document failed note=%s", note.id)
        return Counter(tag.label for line in (note.text or "").split("\n") for tag in find_tags(line))
    return tags_in(document)


def write_tags(db: Session, note_id: str, found: Counter[str]) -> None:
    connection = db.connection()
    connection.execute(delete(NoteTag).where(NoteTag.note_id == note_id))
    rows = [{"note_id": note_id, "label": label, "key": key_of(label), "count": count}
            for label, count in found.items() if count > 0]
    if rows:
        connection.execute(insert(NoteTag), rows)


_STALE = "_nexnotes_tags_stale"


@event.listens_for(Note.text, "set")
def _text_set(target: Note, _value: Any, _old: Any, _initiator: Any) -> None:
    # Every time the text is written, also when it reads the same: a tag put into code leaves the plain text alone.
    target.__dict__[_STALE] = True


@event.listens_for(Session, "after_flush")
def _follow_text(session: Session, _context: Any) -> None:
    """After the notes are written: the tags of every note whose text was set, in the same transaction."""
    for item in (*session.new, *session.dirty):
        if isinstance(item, Note) and item.__dict__.pop(_STALE, False):
            write_tags(session, item.id, tags_of_note(session, item))


def rebuild_if_needed() -> int:
    """Reads every note again when the rule changed or the tags are new (notes from before NOTES-5). Returns how many
    notes were read."""
    with SessionLocal() as db:
        known = db.get(Setting, RULES_SETTING)
        if known is not None and known.value == RULES_VERSION:
            return 0
        ids = list(db.scalars(select(Note.id)))
    for start in range(0, len(ids), 200):
        with SessionLocal() as db:
            for note in db.scalars(select(Note).where(Note.id.in_(ids[start:start + 200]))):
                write_tags(db, note.id, tags_of_note(db, note))
            db.commit()
    with SessionLocal() as db:
        # A mark of the server's own, not one of the operator's settings (``settings_service.DEFAULTS``).
        db.merge(Setting(key=RULES_SETTING, value=RULES_VERSION))
        db.commit()
    if ids:
        logger.info("Tags read again notes=%s", len(ids))
    return len(ids)


# --- Which notes count ----------------------------------------------------------------------------------------------

#: Further notes an account reads besides its own: each gives a select of note ids for an account id. Sharing
#: (NOTES-13) adds the notes shared with the account here (EC-4).
SHARED_NOTES: list[Callable[[int], Select[Any]]] = []
#: Notes whose tags count nowhere: each gives a condition on ``Note`` that is true for such a note. Locked notes
#: (NOTES-16) add theirs here (EC-6).
HIDDEN_NOTES: list[Callable[[], ColumnElement[bool]]] = []


def visible(account_id: int, *, own_only: bool = False) -> ColumnElement[bool]:
    """The notes whose tags an account sees: its own and those shared with it, not in the trash, not locked."""
    whose: ColumnElement[bool] = Note.owner_id == account_id
    if not own_only and SHARED_NOTES:
        whose = or_(whose, *(Note.id.in_(rule(account_id)) for rule in SHARED_NOTES))
    return and_(Note.deleted_at.is_(None), whose, *(not_(hidden()) for hidden in HIDDEN_NOTES))


# --- Reading -------------------------------------------------------------------------------------------------------


def _shown_label(spellings: dict[str, tuple[int, int]]) -> str:
    """The spelling used most; with equal counts the one in more notes, then the first in order (EC-2)."""
    return min(spellings.items(), key=lambda item: (-item[1][0], -item[1][1], item[0]))[0]


def summary(db: Session, account: Account, keys: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """Per tag the account sees: shown label, number of notes. Limited to ``keys`` when given."""
    where = [visible(account.id)]
    wanted = list(keys) if keys is not None else None
    if wanted is not None:
        where.append(NoteTag.key.in_(wanted))
    spellings: dict[str, dict[str, tuple[int, int]]] = {}
    for key, label, total, count in db.execute(
            select(NoteTag.key, NoteTag.label, func.sum(NoteTag.count), func.count(NoteTag.note_id))
            .join(Note, Note.id == NoteTag.note_id).where(*where).group_by(NoteTag.key, NoteTag.label)):
        spellings.setdefault(key, {})[label] = (int(total or 0), int(count or 0))
    counts = dict(db.execute(select(NoteTag.key, func.count(distinct(NoteTag.note_id)))
                             .join(Note, Note.id == NoteTag.note_id).where(*where).group_by(NoteTag.key)).all())
    return {key: {"key": key, "label": _shown_label(found), "count": int(counts.get(key, 0))}
            for key, found in spellings.items()}


def list_tags(db: Session, account: Account) -> list[dict[str, Any]]:
    """Every tag the account sees, the most frequent first (AC-2, EC-4)."""
    found = summary(db, account).values()
    return sorted(found, key=lambda tag: (-tag["count"], sort_key(tag["label"])))


def with_tags(db: Session, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Adds ``tags`` (labels, sorted) to notes of a list, with one query for all of them."""
    ids = [item["id"] for item in items]
    per_note: dict[str, dict[str, tuple[int, str]]] = {}
    for start in range(0, len(ids), 500):
        for note_id, key, label, count in db.execute(
                select(NoteTag.note_id, NoteTag.key, NoteTag.label, NoteTag.count)
                .where(NoteTag.note_id.in_(ids[start:start + 500]))):
            mine = per_note.setdefault(note_id, {})
            best = mine.get(key)
            if best is None or (count, best[1]) > (best[0], label):
                mine[key] = (count, label)
    for item in items:
        labels = [label for _, label in per_note.get(item["id"], {}).values()]
        item["tags"] = sorted(labels, key=sort_key)
    return items


def _person(db: Session, account_id: int) -> dict[str, Any]:
    row = db.get(Account, account_id)
    return {"id": account_id, "name": (row.display_name or row.name) if row is not None else ""}


def tag_page(db: Session, account: Account, name: str) -> dict[str, Any]:
    """The page of one tag (AC-2, AC-3): its notes, own and shared, with folder and date; how many are whose."""
    label = clean_name(name)
    if not label:
        raise error("tag_name_invalid", "This is not a tag.", 422)
    key = key_of(label)
    shown = summary(db, account, [key]).get(key)
    rows = db.execute(
        select(Note, Folder.name, Folder.kind)
        .join(NoteTag, NoteTag.note_id == Note.id)
        .join(Folder, Folder.id == Note.folder_id, isouter=True)
        .where(visible(account.id), NoteTag.key == key)
        .group_by(Note.id)
        .order_by(Note.updated_at.desc(), Note.id)).all()
    others: dict[int, int] = {}
    out = []
    for note, folder_name, folder_kind in rows:
        mine = note.owner_id == account.id
        if not mine:
            others[note.owner_id] = others.get(note.owner_id, 0) + 1
        out.append({
            "id": note.id,
            "title": note.title,
            "preview": notes.preview(note.text),
            "updated_at": note.updated_at.isoformat() if note.updated_at else None,
            "mine": mine,
            "folder": {"id": note.folder_id, "name": folder_name or "", "inbox": folder_kind == FOLDER_INBOX}
            if mine else None,
            "owner": None if mine else _person(db, note.owner_id),
        })
    return {
        "key": key,
        "label": shown["label"] if shown else label,
        "count": len(out),
        "mine": len(out) - sum(others.values()),
        "others": [{**_person(db, owner), "count": count} for owner, count in sorted(others.items())],
        "notes": out,
    }


# --- Renaming and deleting ----------------------------------------------------------------------------------------


def _u8(text: str) -> int:
    return len(text.encode("utf-8"))


def _rewrite_text(text: Any, key: str, new_label: str | None) -> int:
    """Renames (or with ``None`` removes) every tag ``key`` in one run of text; returns how many."""
    chunks = list(text.diff())
    if any(not isinstance(chunk, str) for chunk, _ in chunks):
        return 0
    original = "".join(chunk for chunk, _ in chunks)
    if "#" not in original:
        return 0
    masked = "".join(" " * len(chunk) if _excluded(attributes) else chunk for chunk, attributes in chunks)
    styles: list[Any] = []
    for chunk, attributes in chunks:
        styles.extend([attributes] * len(chunk))
    hits = [tag for tag in find_tags(masked) if key_of(tag.label) == key]
    for tag in reversed(hits):
        if new_label is None:
            start, end = tag.start, tag.end
            # One blank goes with it, so that no double blank stays behind (AC-5).
            if original[end:end + 1] == " ":
                end += 1
            elif start > 0 and original[start - 1] == " ":
                start -= 1
            del text[_u8(original[:start]):_u8(original[:end])]
            continue
        old = original[tag.start + 1:tag.end]
        wanted = new_label
        # Only what differs changes: a caret of someone typing in the tag keeps its place.
        same_start = 0
        while same_start < min(len(old), len(wanted)) and old[same_start] == wanted[same_start]:
            same_start += 1
        same_end = 0
        while (same_end < min(len(old), len(wanted)) - same_start
               and old[len(old) - 1 - same_end] == wanted[len(wanted) - 1 - same_end]):
            same_end += 1
        first = tag.start + 1 + same_start
        last = tag.end - same_end
        style = styles[first - 1]
        if last > first:
            del text[_u8(original[:first]):_u8(original[:last])]
        middle = wanted[same_start:len(wanted) - same_end]
        if middle:
            text.insert(_u8(original[:first]), middle, dict(style) if style else None)
    return len(hits)


def _rewrite_children(parent: Any, key: str, new_label: str | None) -> int:
    from pycrdt import XmlElement, XmlText

    changed = 0
    for child in list(parent.children):
        if not isinstance(child, XmlElement):
            continue
        if child.tag == s.CODE_BLOCK:
            continue
        if child.tag in s.TEXTBLOCKS:
            for run in list(child.children):
                if isinstance(run, XmlText):
                    changed += _rewrite_text(run, key, new_label)
        else:
            changed += _rewrite_children(child, key, new_label)
    return changed


def rewrite(doc: Any, key: str, new_label: str | None) -> Counter[str]:
    """Renames (``new_label``) or removes (``None``) the tag ``key`` everywhere in a note's document; returns the tags
    the note has afterwards."""
    with doc.transaction():
        _rewrite_children(notedoc.body_of(doc), key, new_label)
    return tags_in(notedoc.to_json(doc))


def _own_notes(db: Session, account: Account, key: str) -> list[str]:
    return list(db.scalars(select(Note.id).join(NoteTag, NoteTag.note_id == Note.id)
                           .where(visible(account.id, own_only=True), NoteTag.key == key).group_by(Note.id)))


def _kept(db: Session, account: Account, key: str) -> int:
    """Notes of others with the tag, which renaming and deleting leave alone."""
    return int(db.scalar(select(func.count(distinct(Note.id))).join(NoteTag, NoteTag.note_id == Note.id)
                         .where(visible(account.id), Note.owner_id != account.id, NoteTag.key == key)) or 0)


async def _apply(account: Account, note_ids: list[str], key: str, new_label: str | None) -> int:
    changed = 0
    for note_id in note_ids:
        try:
            found = await notes.change(note_id, lambda doc: rewrite(doc, key, new_label), account_id=account.id)
        except notedoc.FormatError:
            logger.warning("A note of a newer format keeps its tags note=%s", note_id)
            continue
        # The table follows at once; the summary of the room writes the same a moment later.
        with SessionLocal() as db:
            if db.get(Note, note_id) is not None:
                write_tags(db, note_id, found)
                db.commit()
        changed += 1
    return changed


async def rename(account: Account, name: str, new_name: str, *, merge: bool = False) -> dict[str, Any]:
    """Renames a tag in all of the account's own notes (AC-4). Onto a tag that exists already only with ``merge``
    (AC-7); without it ``tag_exists`` says which, so that the page can ask."""
    label = clean_name(name)
    new_label = clean_name(new_name)
    if not label or not new_label:
        raise error("tag_name_invalid", "This is not a tag.", 422)
    key, new_key = key_of(label), key_of(new_label)
    with SessionLocal() as db:
        own = _own_notes(db, account, key)
        kept = _kept(db, account, key)
        if new_key != key and not merge:
            there = summary(db, account, [new_key]).get(new_key)
            if there is not None:
                raise error("tag_exists", "This tag exists already.", 409, label=there["label"], count=there["count"])
    changed = await _apply(account, own, key, new_label)
    logger.info("Tag renamed notes=%s kept=%s", changed, kept)
    return {"label": new_label, "key": new_key, "changed": changed, "kept": kept}


async def remove(account: Account, name: str) -> dict[str, Any]:
    """Takes a tag out of all of the account's own notes, the rest of the text stays (AC-5)."""
    label = clean_name(name)
    if not label:
        raise error("tag_name_invalid", "This is not a tag.", 422)
    key = key_of(label)
    with SessionLocal() as db:
        own = _own_notes(db, account, key)
        kept = _kept(db, account, key)
    changed = await _apply(account, own, key, None)
    logger.info("Tag deleted notes=%s kept=%s", changed, kept)
    return {"changed": changed, "kept": kept}
