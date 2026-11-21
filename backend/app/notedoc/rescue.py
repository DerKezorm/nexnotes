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

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

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
    decode_update,
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
    #: The update decoded, when it was needed.
    decoded: Update | None = None


def _state_vector(data: bytes) -> dict[int, int]:
    from .yupdate import _Reader

    reader = _Reader(data)
    return {reader.uint(): reader.uint() for _ in range(reader.uint())}


def apply(doc: Doc, update: bytes) -> Applied:
    """Applies an update and watches what it did."""
    seen: dict[str, Any] = {}
    positions: list[int] = []
    structural: list[bool] = []

    def on_transaction(event: Any) -> None:
        seen["before"] = event.before_state
        seen["after"] = event.after_state
        seen["deleted"] = event.delete_set

    def on_body(events: Any) -> None:
        for event in events:
            path = list(event.path or [])
            delta = event.delta or []
            if not any("delete" in step for step in delta if isinstance(step, dict)):
                continue
            if not isinstance(event.target, XmlText):
                structural.append(True)
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
    before_state = doc.get_state()
    subscription = doc.observe(on_transaction)
    deep = body.observe_deep(on_body)
    try:
        doc.apply_update(update)
    finally:
        doc.unobserve(subscription)
        body.unobserve(deep)
    deleted = decode_delete_set(seen.get("deleted", b""))
    changed = bool(deleted) or seen.get("before", before_state) != seen.get("after", before_state)
    return Applied(changed=changed, deleted=deleted, at=min(positions) if positions else None,
                   structural=bool(structural))


def redundant(update: bytes, state_before: bytes) -> bool:
    """True when the update holds nothing the document did not have (a browser re-sending on reconnect). An update
    that only waits for a missing part (pending) is not redundant: it must be stored."""
    try:
        known = _state_vector(state_before)
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
    """One transaction that deleted something: the ids, where it happened, and the paragraphs that took back text."""

    ids: IdRanges
    anchor: XmlElement | None
    at_end: bool
    rescues: list[XmlText] = field(default_factory=list)


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
            decoded = applied.decoded or decode_update(update)
        except DecodeError:
            logger.warning("An update could not be read for concurrent deletions")
            return 0
        record = _Deletion(ids=applied.deleted, anchor=None, at_end=True)
        body = body_of(doc)
        if applied.at is not None:
            record.at_end = applied.at >= len(body.children)
            record.anchor = None if record.at_end else body.children[applied.at]
        collateral = applied.deleted.minus(decoded.deleted)
        if not collateral:
            self.deletions.append(record)
            return 0
        # The update's own new items that went because their paragraph was gone (typed late): their text is in the
        # update. Items of others that this update took with a paragraph: their text is in the state before.
        index = StructIndex(decoded.structs)
        before: StructIndex | None = None
        pieces: list[tuple[Struct, str]] = []
        for client, spans in collateral.ranges.items():
            for start, end in spans:
                found = _strings_in(index, client, start, end)
                if not found and before_whole:
                    if before is None:
                        try:
                            before = decode_update(before_whole).index()
                        except DecodeError:
                            logger.warning("The document could not be read for concurrent deletions")
                            before = StructIndex([])
                    found = _strings_in(before, client, start, end)
                pieces.extend(found)
        if not pieces:
            self.deletions.append(record)
            return 0
        pieces.sort(key=lambda piece: (piece[0].client, piece[0].clock))
        late = [piece for piece in pieces if index.find((piece[0].client, piece[0].clock)) is not None]
        taken = [piece for piece in pieces if index.find((piece[0].client, piece[0].clock)) is None]
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


def _alive(body: XmlFragment, element: XmlElement | None) -> int | None:
    if element is None:
        return None
    for position, child in enumerate(body.children):
        if child == element:
            return position
    return None


def _put_back(doc: Doc, deletion: _Deletion, text: str, append: bool = False) -> int:
    if not text:
        return 0
    body = body_of(doc)
    if append and deletion.rescues:
        last = deletion.rescues[-1]
        holder = last.parent
        if isinstance(holder, XmlElement) and _alive(body, holder) is not None:
            last.insert(len(last), text)
            return len(text.encode("utf-16-le")) // 2
    position = _alive(body, deletion.anchor)
    if position is None:
        position = len(body.children)
    paragraph = body.children.insert(position, XmlElement(s.PARAGRAPH))
    run = paragraph.children.append(XmlText())
    run.insert(0, text)
    deletion.rescues.append(run)
    return len(text.encode("utf-16-le")) // 2
