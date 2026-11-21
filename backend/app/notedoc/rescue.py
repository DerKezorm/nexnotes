"""Text a concurrent deletion would take away unseen stays in the note (NOTES-12 EC-1).

In Yjs, deleting a paragraph deletes everything inside it, also what someone else was typing into it at the same time
and the deleting side never saw. And text typed into a paragraph that is gone already disappears with it. Both happen
when two people work on the same paragraph: one removes it (or turns it into a heading, or joins it with the one
before, which ``y-prosemirror`` writes as delete and insert), the other keeps typing.

The room catches this when it applies an update: everything the transaction deleted, minus what the update itself
deletes, was deleted *because of* the concurrency. Of that, the text (string items) is put back into the note as a new
paragraph where the deleted block was, written by the server and passed to everybody like any change. Later keystrokes
that land in the same deleted paragraph go to the end of that new paragraph, so a word typed in five updates comes
back as one word.

What comes back is plain text: its formatting went with the deleted paragraph.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from pycrdt import Doc, Text, XmlElement, XmlFragment, XmlText

from . import schema as s
from .doc import body_of
from .yupdate import (
    STRING,
    DecodeError,
    IdRanges,
    Struct,
    StructIndex,
    Update,
    decode_delete_set,
    decode_state_vector,
    decode_update,
    utf16_len,
    utf16_slice,
)

logger = logging.getLogger("nexnotes.live")


@dataclass
class Applied:
    """What applying one update did."""

    #: Something became visible or was deleted.
    changed: bool
    #: Every id the transaction deleted (the update's own deletions and what went with them).
    deleted: IdRanges
    #: Where in ``body`` a block was deleted, or after which top-level block something inside was deleted.
    at: int | None
    #: An element lost a child (not only text): the shape may need ``doc.repair``.
    structural: bool = False
    #: The top-level blocks inside which an element lost a child (where ``doc.repair`` has to look).
    touched: list[int] = field(default_factory=list)
    #: The state vector before the update: which items the document had already.
    known: dict[int, int] = field(default_factory=dict)


def _text_length(value: Any) -> int:
    """UTF-16 length of the text in something inserted (a string, or an element with everything inside it)."""
    if isinstance(value, str):
        return utf16_len(value)
    if isinstance(value, list):
        return sum(_text_length(item) for item in value)
    if isinstance(value, XmlText):
        return sum(utf16_len(chunk) for chunk, _ in value.diff() if isinstance(chunk, str))
    if isinstance(value, (XmlElement, XmlFragment)):
        return sum(_text_length(child) for child in value.children)
    return 0


def _new_text(decoded: Update, state_before: dict[int, int]) -> list[tuple[int, int, int]]:
    """The text an update brings that the document did not have: (client, start, end) in clocks, minus what the update
    deletes itself."""
    out = []
    for struct in decoded.structs:
        if struct.kind != STRING:
            continue
        start = max(struct.clock, state_before.get(struct.client, 0))
        end = struct.clock + struct.length
        if start >= end:
            continue
        kept = IdRanges()
        kept.add(struct.client, start, end - start)
        for client, spans in kept.minus(decoded.deleted).ranges.items():
            out.extend((client, low, high) for low, high in spans)
    return out


def apply(doc: Doc, update: bytes) -> Applied:
    """Applies an update and watches what it did."""
    seen: dict[str, Any] = {}
    positions: list[int] = []
    structural: list[int] = []
    shown = [0]

    def on_transaction(event: Any) -> None:
        seen["before"] = event.before_state
        seen["after"] = event.after_state
        seen["deleted"] = event.delete_set

    def count(delta: Any) -> None:
        for step in delta or []:
            if isinstance(step, dict) and "insert" in step:
                shown[0] += _text_length(step["insert"])

    def on_title(event: Any) -> None:
        count(event.delta)

    def on_body(events: Any) -> None:
        for event in events:
            path = list(event.path or [])
            delta = event.delta or []
            count(delta)
            if not any("delete" in step for step in delta if isinstance(step, dict)):
                continue
            if not isinstance(event.target, XmlText):
                structural.append(int(path[0]) if path else -1)
            if path:
                positions.append(int(path[0]) + 1)
                continue
            index = 0
            for step in delta:
                if "retain" in step:
                    index += int(step["retain"])
                elif "insert" in step:
                    index += len(step["insert"]) if isinstance(step["insert"], list) else 1
                elif "delete" in step:
                    positions.append(index)
                    break

    body = body_of(doc)
    title = doc.get(s.TITLE, type=Text)
    before_state = doc.get_state()
    subscription = doc.observe(on_transaction)
    deep = body.observe_deep(on_body)
    titled = title.observe(on_title)
    try:
        doc.apply_update(update)
    finally:
        doc.unobserve(subscription)
        body.unobserve(deep)
        title.unobserve(titled)
    deleted = decode_delete_set(seen.get("deleted", b""))
    changed = bool(deleted) or seen.get("before", before_state) != seen.get("after", before_state)
    # Text typed into a paragraph that is gone already never shows. Newer pycrdt names it in the transaction's delete
    # set, older ones do not: when less text showed than the update brought, the document's delete set tells which.
    known = decode_state_vector(before_state)
    try:
        new = _new_text(decode_update(update), known)
    except DecodeError:
        new = []
    if new and shown[0] < sum(end - start for _, start, end in new):
        everything = decode_update(doc.get_update(doc.get_state())).deleted
        late = IdRanges()
        for client, start, end in new:
            for low, high in everything.overlap(client, start, end):
                late.add(client, low, high - low)
        if late:
            deleted = _union(deleted, late)
            changed = True
    return Applied(changed=changed, deleted=deleted, at=min(positions) if positions else None,
                   structural=bool(structural), touched=sorted({index for index in structural if index >= 0}),
                   known=known)


def redundant(update: bytes, state_before: bytes) -> bool:
    """True when the update holds nothing the document did not have (a browser re-sending on reconnect). An update
    that only waits for a missing part (pending) is not redundant: it must be stored."""
    try:
        known = decode_state_vector(state_before)
        decoded = decode_update(update)
    except DecodeError:
        return False
    for struct in decoded.structs:
        if struct.clock + struct.length > known.get(struct.client, 0):
            return False
    for client, spans in decoded.deleted.ranges.items():
        if any(end > known.get(client, 0) for _, end in spans):
            return False
    return True


@dataclass(eq=False)
class _Deletion:
    """One transaction that deleted something: the ids, where it happened, and the paragraphs that took back text.

    Places are kept as values (a position and the text of the block that followed), never as pycrdt objects: a
    branch of the document can be freed once it is deleted, and touching it later crashes the process."""

    ids: IdRanges
    #: Top-level position of the deletion (the length of the body when it was at the end).
    at: int
    #: The words of the block that followed the deleted one, to find the place again after other changes.
    anchor: str | None
    #: The words of each paragraph that took back text for this deletion, as they are now.
    rescued: list[str] = field(default_factory=list)


class Rescuer:
    """Keeps the recent deletions of one room and puts back text they took unseen."""

    #: Deletions remembered for keystrokes that arrive late (an update typed before its author saw the deletion).
    KEEP = 64

    def __init__(self) -> None:
        self.deletions: deque[_Deletion] = deque(maxlen=self.KEEP)

    def after(self, doc: Doc, update: bytes, applied: Applied, before_whole: bytes | None) -> int:
        """Called right after ``apply``, inside a transaction of the caller (whose update is the rescue). Returns how
        many characters (UTF-16) came back."""
        if not applied.deleted:
            return 0
        try:
            decoded = decode_update(update)
        except DecodeError:
            logger.warning("An update could not be read for concurrent deletions")
            return 0
        body = body_of(doc)
        count = len(body.children)
        at = count if applied.at is None else min(applied.at, count)
        record = _Deletion(ids=applied.deleted, at=at, anchor=_words(body.children[at]) if at < count else None)
        collateral = applied.deleted.minus(decoded.deleted)
        if not collateral:
            self.deletions.append(record)
            return 0
        # Items new with this update that went because their paragraph was gone (typed late): their text is in the
        # update. Items the document had, taken with a paragraph this update deleted: their text is in the state
        # before (an item deleted before has no text there any more, so it never comes back twice).
        index = StructIndex(decoded.structs)
        before: StructIndex | None = None
        late: list[tuple[Struct, str]] = []
        taken: list[tuple[Struct, str]] = []
        for client, spans in collateral.ranges.items():
            known = applied.known.get(client, 0)
            for start, end in spans:
                if end > known:
                    late.extend(_strings_in(index, client, max(start, known), end))
                if start < known and before_whole:
                    if before is None:
                        try:
                            before = decode_update(before_whole).index()
                        except DecodeError:
                            logger.warning("The document could not be read for concurrent deletions")
                            before = StructIndex([])
                    taken.extend(_strings_in(before, client, start, min(end, known)))
        if not late and not taken:
            self.deletions.append(record)
            return 0
        late.sort(key=lambda piece: (piece[0].client, piece[0].clock))
        taken.sort(key=lambda piece: (piece[0].client, piece[0].clock))
        restored = 0
        # A deletion of the update itself is remembered, so text typed late into what it deleted finds its place.
        if taken or applied.deleted.minus(collateral):
            self.deletions.append(record)
        if taken:
            # This update deleted a paragraph with someone else's unseen text in it.
            groups: dict[Any, list[str]] = {}
            for struct, text in taken:
                chain = before.ancestors(struct) if before is not None else []
                groups.setdefault(chain[0] if chain else None, []).append(text)
            for texts in groups.values():
                restored += _put_back(doc, record, "".join(texts))
        for struct, text in late:
            target = self._deletion_of(struct)
            if target is None:
                target = record
                self.deletions.append(record)
            target.ids = _union(target.ids, collateral)
            restored += _put_back(doc, target, text, append=True)
        return restored

    def _deletion_of(self, struct: Struct) -> _Deletion | None:
        """The deletion that took the paragraph this late text was typed into: the newest one that deleted what the
        text was typed next to (or the text typed just before it)."""
        candidates = [struct.origin, struct.right_origin, struct.parent if isinstance(struct.parent, tuple) else None,
                      (struct.client, struct.clock - 1) if struct.clock else None]
        for deletion in reversed(self.deletions):
            if any(c is not None and deletion.ids.contains(c[0], c[1]) for c in candidates):
                return deletion
        return None


def _union(a: IdRanges, b: IdRanges) -> IdRanges:
    out = IdRanges()
    for source in (a, b):
        for client, spans in source.ranges.items():
            for start, end in spans:
                out.add(client, start, end - start)
    return out.normalized()


def _strings_in(index: StructIndex, client: int, start: int, end: int) -> list[tuple[Struct, str]]:
    out = []
    for struct in index.by_client.get(client, []):
        if struct.kind != STRING or not struct.text:
            continue
        low, high = max(start, struct.clock), min(end, struct.clock + struct.length)
        if low < high:
            piece = Struct(struct.client, low, high - low, STRING, struct.origin, struct.right_origin, struct.parent)
            out.append((piece, utf16_slice(struct.text, low - struct.clock, high - struct.clock)))
    return out


def _words(node: Any) -> str:
    """The text of a block, to recognise it again."""
    if isinstance(node, XmlText):
        return "".join(chunk for chunk, _ in node.diff() if isinstance(chunk, str))
    if isinstance(node, (XmlElement, XmlFragment)):
        return "⁣".join(_words(child) for child in node.children)
    return ""


def _find(body: XmlFragment, words: str, near: int, paragraph: bool = False) -> int | None:
    """The top-level block with these words closest to ``near``."""
    best: int | None = None
    for position, child in enumerate(body.children):
        if not isinstance(child, XmlElement) or (paragraph and child.tag != s.PARAGRAPH):
            continue
        if _words(child) == words and (best is None or abs(position - near) < abs(best - near)):
            best = position
    return best


def _put_back(doc: Doc, deletion: _Deletion, text: str, append: bool = False) -> int:
    if not text:
        return 0
    body = body_of(doc)
    if append and deletion.rescued:
        position = _find(body, deletion.rescued[-1], deletion.at, paragraph=True)
        if position is not None:
            paragraph = body.children[position]
            runs = [child for child in paragraph.children if isinstance(child, XmlText)]
            run = runs[-1] if runs else paragraph.children.append(XmlText())
            run.insert(len(run), text)
            deletion.rescued[-1] += text
            return utf16_len(text)
    position = _find(body, deletion.anchor, deletion.at) if deletion.anchor is not None else None
    if position is None:
        position = min(deletion.at, len(body.children)) if deletion.anchor is not None else len(body.children)
    paragraph = body.children.insert(position, XmlElement(s.PARAGRAPH))
    paragraph.children.append(XmlText()).insert(0, text)
    deletion.rescued.append(text)
    return utf16_len(text)
