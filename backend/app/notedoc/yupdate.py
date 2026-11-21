"""Reading Yjs updates (encoding v1) and delete sets, as far as the live room needs it.

pycrdt applies updates but does not show what is inside them. The room needs two things from an update: the text it
inserts and the ids it deletes, to find text that a concurrent deletion took away unseen (``rescue.py``). The format is
the one of ``yjs/src/utils/encoding.js`` and ``yrs::update``: a list of structs per client, then the delete set.
Clocks count UTF-16 code units for strings, as in JavaScript.
"""

from __future__ import annotations

import struct as _binary
from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Any

#: Content kinds (``info & 0x1f``).
GC = 0
DELETED = 1
JSON = 2
BINARY = 3
STRING = 4
EMBED = 5
FORMAT = 6
TYPE = 7
ANY = 8
DOC = 9
SKIP = 10
#: Type references of ``ContentType``.
TYPE_XML_ELEMENT = 3
TYPE_XML_HOOK = 5

Id = tuple[int, int]


class DecodeError(ValueError):
    pass


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def byte(self) -> int:
        if self.pos >= len(self.data):
            raise DecodeError("unexpected end of update")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def uint(self) -> int:
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                return value
            shift += 7
            if shift > 70:
                raise DecodeError("varint too long")

    def int(self) -> int:
        byte = self.byte()
        negative = bool(byte & 0x40)
        value = byte & 0x3F
        shift = 6
        while byte & 0x80:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            shift += 7
            if shift > 70:
                raise DecodeError("varint too long")
        return -value if negative else value

    def bytes(self) -> bytes:
        length = self.uint()
        if self.pos + length > len(self.data):
            raise DecodeError("unexpected end of update")
        value = self.data[self.pos: self.pos + length]
        self.pos += length
        return value

    def string(self) -> str:
        return self.bytes().decode("utf-8", errors="replace")

    def fixed(self, length: int) -> bytes:
        if self.pos + length > len(self.data):
            raise DecodeError("unexpected end of update")
        value = self.data[self.pos: self.pos + length]
        self.pos += length
        return value

    def any(self, depth: int = 0) -> Any:
        if depth > 64:
            raise DecodeError("value nested too deep")
        kind = self.byte()
        if kind == 127:
            return None
        if kind == 126:
            return None
        if kind == 125:
            return self.int()
        if kind == 124:
            return _binary.unpack(">f", self.fixed(4))[0]
        if kind == 123:
            return _binary.unpack(">d", self.fixed(8))[0]
        if kind == 122:
            return int.from_bytes(self.fixed(8), "big", signed=True)
        if kind == 121:
            return False
        if kind == 120:
            return True
        if kind == 119:
            return self.string()
        if kind == 118:
            return {self.string(): self.any(depth + 1) for _ in range(self.uint())}
        if kind == 117:
            return [self.any(depth + 1) for _ in range(self.uint())]
        if kind == 116:
            return self.bytes()
        raise DecodeError(f"unknown value kind {kind}")


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def utf16_slice(text: str, start: int, end: int) -> str:
    """Part of a string by UTF-16 offsets (a half of a surrogate pair at an edge is dropped)."""
    data = text.encode("utf-16-le")[start * 2: end * 2]
    return data.decode("utf-16-le", errors="ignore")


@dataclass
class Struct:
    client: int
    clock: int
    length: int
    kind: int
    origin: Id | None = None
    right_origin: Id | None = None
    #: The parent when the update names it: a root type's name or the id of the item holding the type.
    parent: str | Id | None = None
    parent_sub: str | None = None
    #: The string of a ``STRING`` content.
    text: str | None = None
    #: The type of a ``TYPE`` content (an element's name for XML elements).
    type_ref: int | None = None
    name: str | None = None

    def contains(self, clock: int) -> bool:
        return self.clock <= clock < self.clock + self.length


@dataclass
class IdRanges:
    """A set of ids, as ranges per client (a delete set)."""

    ranges: dict[int, list[tuple[int, int]]] = field(default_factory=dict)

    def add(self, client: int, clock: int, length: int) -> None:
        if length > 0:
            self.ranges.setdefault(client, []).append((clock, clock + length))

    def normalized(self) -> IdRanges:
        out = IdRanges()
        for client, spans in self.ranges.items():
            merged: list[tuple[int, int]] = []
            for start, end in sorted(spans):
                if merged and start <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], end))
                else:
                    merged.append((start, end))
            out.ranges[client] = merged
        return out

    def contains(self, client: int, clock: int) -> bool:
        spans = self.ranges.get(client)
        if not spans:
            return False
        return any(start <= clock < end for start, end in spans)

    def minus(self, other: IdRanges) -> IdRanges:
        out = IdRanges()
        mine = self.normalized()
        theirs = other.normalized()
        for client, spans in mine.ranges.items():
            cut = theirs.ranges.get(client, [])
            for start, end in spans:
                pieces = [(start, end)]
                for c_start, c_end in cut:
                    next_pieces = []
                    for p_start, p_end in pieces:
                        if c_end <= p_start or c_start >= p_end:
                            next_pieces.append((p_start, p_end))
                            continue
                        if p_start < c_start:
                            next_pieces.append((p_start, c_start))
                        if c_end < p_end:
                            next_pieces.append((c_end, p_end))
                    pieces = next_pieces
                for p_start, p_end in pieces:
                    out.add(client, p_start, p_end - p_start)
        return out.normalized()

    def overlap(self, client: int, start: int, end: int) -> list[tuple[int, int]]:
        """The parts of ``[start, end)`` of one client that are in the set."""
        out = []
        for s_start, s_end in self.ranges.get(client, []):
            low, high = max(start, s_start), min(end, s_end)
            if low < high:
                out.append((low, high))
        return sorted(out)

    def __bool__(self) -> bool:
        return any(end > start for spans in self.ranges.values() for start, end in spans)

    def ids(self) -> list[Id]:
        return [(client, start) for client, spans in self.ranges.items() for start, _ in spans]


def read_id_ranges(reader: _Reader) -> IdRanges:
    out = IdRanges()
    for _ in range(reader.uint()):
        client = reader.uint()
        for _ in range(reader.uint()):
            clock = reader.uint()
            out.add(client, clock, reader.uint())
    return out


def decode_delete_set(data: bytes) -> IdRanges:
    """A delete set on its own (``TransactionEvent.delete_set``)."""
    if not data:
        return IdRanges()
    return read_id_ranges(_Reader(data))


def decode_state_vector(data: bytes) -> dict[int, int]:
    """A state vector: the next clock of every client the document knows."""
    reader = _Reader(data)
    return {reader.uint(): reader.uint() for _ in range(reader.uint())}


@dataclass
class Update:
    structs: list[Struct]
    deleted: IdRanges

    def index(self) -> StructIndex:
        return StructIndex(self.structs)


def decode_update(data: bytes) -> Update:
    """The structs and the delete set of an update (encoding v1)."""
    reader = _Reader(data)
    structs: list[Struct] = []
    for _ in range(reader.uint()):
        count = reader.uint()
        client = reader.uint()
        clock = reader.uint()
        for _ in range(count):
            struct = _read_struct(reader, client, clock)
            structs.append(struct)
            clock += struct.length
    deleted = read_id_ranges(reader)
    return Update(structs, deleted)


def well_formed(data: bytes) -> bool:
    """True when a whole document as one update reads in Yjs as it does in pycrdt: every client's structs follow each
    other without a gap, a skip or an overlap.

    pycrdt 0.14 (yrs 0.27 and later) can write a state with overlapping blocks after text was typed into a paragraph
    deleted at the same time: a skip of a negative length, which Yjs in the browser reads as a jump far ahead and
    keeps everything after it waiting. The room checks every state it folds with this."""
    try:
        reader = _Reader(data)
        for _ in range(reader.uint()):
            count = reader.uint()
            reader.uint()
            clock = reader.uint()
            if clock != 0:
                return False
            for _ in range(count):
                struct = _read_struct(reader, 0, clock)
                if struct.kind == SKIP or struct.length <= 0:
                    return False
                clock += struct.length
        read_id_ranges(reader)
    except DecodeError:
        return False
    return reader.pos == len(reader.data)


def _read_id(reader: _Reader) -> Id:
    return reader.uint(), reader.uint()


def _read_struct(reader: _Reader, client: int, clock: int) -> Struct:
    info = reader.byte()
    kind = info & 0x1F
    if kind == GC:
        return Struct(client, clock, reader.uint(), GC)
    if kind == SKIP:
        return Struct(client, clock, reader.uint(), SKIP)
    origin = _read_id(reader) if info & 0x80 else None
    right_origin = _read_id(reader) if info & 0x40 else None
    parent: str | Id | None = None
    parent_sub = None
    if not info & 0xC0:
        if reader.uint() == 1:
            parent = reader.string()
        else:
            parent = _read_id(reader)
        if info & 0x20:
            parent_sub = reader.string()
    struct = Struct(client, clock, 1, kind, origin, right_origin, parent, parent_sub)
    if kind == DELETED:
        struct.length = reader.uint()
    elif kind == JSON:
        struct.length = reader.uint()
        for _ in range(struct.length):
            reader.string()
    elif kind == BINARY:
        reader.bytes()
    elif kind == STRING:
        struct.text = reader.string()
        struct.length = utf16_len(struct.text)
    elif kind == EMBED:
        reader.string()
    elif kind == FORMAT:
        reader.string()
        reader.string()
    elif kind == TYPE:
        struct.type_ref = reader.uint()
        if struct.type_ref in (TYPE_XML_ELEMENT, TYPE_XML_HOOK):
            struct.name = reader.string()
    elif kind == ANY:
        struct.length = reader.uint()
        for _ in range(struct.length):
            reader.any()
    elif kind == DOC:
        reader.string()
        reader.any()
    else:
        raise DecodeError(f"unknown content kind {kind}")
    return struct


class StructIndex:
    """Finds the struct holding an id, and the parent of an item (following its origins)."""

    def __init__(self, structs: list[Struct]) -> None:
        self.by_client: dict[int, list[Struct]] = {}
        for struct in structs:
            self.by_client.setdefault(struct.client, []).append(struct)
        self.starts: dict[int, list[int]] = {}
        for client, items in self.by_client.items():
            items.sort(key=lambda item: item.clock)
            self.starts[client] = [item.clock for item in items]

    def add(self, structs: list[Struct]) -> None:
        for struct in structs:
            items = self.by_client.setdefault(struct.client, [])
            if any(item.clock == struct.clock for item in items):
                continue
            items.append(struct)
            items.sort(key=lambda item: item.clock)
            self.starts[struct.client] = [item.clock for item in items]

    def find(self, item_id: Id | None) -> Struct | None:
        if item_id is None:
            return None
        client, clock = item_id
        starts = self.starts.get(client)
        if not starts:
            return None
        at = bisect_right(starts, clock) - 1
        if at < 0:
            return None
        struct = self.by_client[client][at]
        return struct if struct.contains(clock) else None

    def parent_of(self, struct: Struct, limit: int = 100_000) -> str | Id | None:
        """The parent named by the struct or by the first of its origins that names one."""
        seen = 0
        current: Struct | None = struct
        while current is not None and seen < limit:
            if current.parent is not None:
                return current.parent
            if current.kind in (GC, SKIP):
                return None
            current = self.find(current.origin) or self.find(current.right_origin)
            seen += 1
        return None

    def ancestors(self, struct: Struct) -> list[str | Id]:
        """The chain of parents up to a root type, nearest first."""
        chain: list[str | Id] = []
        parent = self.parent_of(struct)
        while parent is not None and len(chain) < 1000:
            chain.append(parent)
            if isinstance(parent, str):
                break
            holder = self.find(parent)
            parent = self.parent_of(holder) if holder is not None else None
        return chain
