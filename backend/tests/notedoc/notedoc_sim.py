"""Simulated browsers for the live room: a pycrdt document that speaks y-websocket like the browser's provider.

A client keeps its document across connections. While connected, every local change goes to the room as an update;
while disconnected, changes stay local and travel on reconnect through the sync steps (the server's step 1 is answered
with step 2), exactly as ``y-websocket`` does. Messages in flight when a connection breaks are lost.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from pycrdt import (
    Doc,
    YMessageType,
    YSyncMessageType,
    create_sync_message,
    create_update_message,
    read_message,
    write_var_uint,
)

from app.notedoc.room import Access, Folded, Peer, Rooms, var_string

_CLOSED = object()


class Closed(Exception):
    pass


class ServerSocket:
    """The room's end of a connection."""

    def __init__(self, client: SimClient) -> None:
        self.client = client
        self.inbox: asyncio.Queue[Any] = asyncio.Queue()
        self.closed_with: int | None = None
        self.open = True

    async def send_bytes(self, data: bytes) -> None:
        if not self.open:
            raise Closed()
        self.client.log.append(("got", data))
        self.client.world.events.append(("deliver", self.client.name, data))
        self.client.inbox.put_nowait(data)

    async def receive_bytes(self) -> bytes:
        item = await self.inbox.get()
        if item is _CLOSED:
            raise Closed()
        return item

    async def close(self, code: int = 1000) -> None:
        if self.closed_with is None:
            self.closed_with = code
        self.open = False
        self.inbox.put_nowait(_CLOSED)
        if self.client.socket is self:
            self.client.on_closed(code)


class World:
    """Everything a test shares: the rooms, the store, the clients, and a log of what happened in which order."""

    def __init__(self, rooms: Rooms | None = None, store: MemoryStore | None = None, **room_options: Any) -> None:
        self.store = store or MemoryStore()
        self.access: dict[int, Access] = {}
        self.events: list[tuple[Any, ...]] = []
        self.store.events = self.events
        counter = iter(range(9_000_000, 10_000_000))
        options = {"recheck_seconds": 3600.0, "tick": 0.01, "summary_delay": 0.05,
                   "client_ids": lambda: next(counter), **room_options}
        self.rooms = rooms or Rooms(self.store, self.check, **options)
        self.clients: list[SimClient] = []

    async def check(self, peer: Peer) -> Access:
        return self.access.get(peer.account_id, Access.WRITE)

    def client(self, name: str, account_id: int, *, can_write: bool = True, client_id: int | None = None) -> SimClient:
        client = SimClient(self, name, account_id, can_write, client_id)
        self.clients.append(client)
        return client

    async def settle(self, rounds: int = 2000) -> None:
        """Runs until nothing moves any more."""
        quiet = 0
        for _ in range(rounds):
            await asyncio.sleep(0)
            busy = any(not c.inbox.empty() or (c.socket is not None and not c.socket.inbox.empty())
                       for c in self.clients)
            if busy:
                quiet = 0
            else:
                quiet += 1
                if quiet > 20:
                    return

    async def step(self, rounds: int) -> None:
        for _ in range(rounds):
            await asyncio.sleep(0)


class SimClient:
    def __init__(self, world: World, name: str, account_id: int, can_write: bool, client_id: int | None) -> None:
        self.world = world
        self.name = name
        self.account_id = account_id
        self.can_write = can_write
        self.doc = Doc(client_id=client_id) if client_id is not None else Doc()
        self.socket: ServerSocket | None = None
        self.inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self.log: list[tuple[str, bytes]] = []
        self.closed: list[int] = []
        self.awareness: dict[int, bytes] = {}
        self._remote = False
        #: Answers the room's sync step 1 (every y-websocket client does; off to play a client that does not).
        self.answers = True
        self._serve: asyncio.Task[None] | None = None
        self._reader: asyncio.Task[None] | None = None
        self.doc.observe(self._on_change)

    @property
    def connected(self) -> bool:
        return self.socket is not None and self.socket.open

    # --- connection -------------------------------------------------------------------------------------------------

    def connect(self) -> None:
        assert not self.connected
        self.socket = ServerSocket(self)
        self.inbox = asyncio.Queue()
        self._serve = asyncio.create_task(self.world.rooms.serve(
            self.socket, "note", account_id=self.account_id, name=self.name, can_write=self.can_write,
            session=self.name))
        self._reader = asyncio.create_task(self._read(self.socket))
        self._send(create_sync_message(self.doc))

    def disconnect(self) -> None:
        """The connection breaks: what is in flight either way is lost."""
        if self.socket is None:
            return
        socket = self.socket
        socket.open = False
        while not socket.inbox.empty():
            socket.inbox.get_nowait()
        socket.inbox.put_nowait(_CLOSED)
        while not self.inbox.empty():
            self.inbox.get_nowait()
        if self._reader is not None:
            self._reader.cancel()
        self.socket = None

    def on_closed(self, code: int) -> None:
        self.closed.append(code)
        if self._reader is not None:
            self._reader.cancel()
        self.socket = None

    def _send(self, data: bytes) -> None:
        if self.connected:
            assert self.socket is not None
            self.world.events.append(("send", self.name, data))
            self.socket.inbox.put_nowait(data)

    async def _read(self, socket: ServerSocket) -> None:
        while True:
            data = await self.inbox.get()
            if socket is not self.socket:
                return
            self._on_message(data)

    def _on_message(self, data: bytes) -> None:
        if data[0] == YMessageType.SYNC:
            kind = data[1]
            payload = read_message(data[2:])
            if kind == YSyncMessageType.SYNC_STEP1:
                if not self.answers:
                    return
                update = self.doc.get_update(payload)
                self._send(bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP2]) + write_var_uint(len(update))
                           + update)
            else:
                self._remote = True
                try:
                    self.doc.apply_update(payload)
                finally:
                    self._remote = False
        elif data[0] == YMessageType.AWARENESS:
            self.awareness[len(self.awareness)] = data

    def _on_change(self, event: Any) -> None:
        if self._remote:
            return
        if event.before_state == event.after_state and event.delete_set in (b"", b"\x00"):
            return
        self._send(create_update_message(event.update))

    # --- awareness ----------------------------------------------------------------------------------------------------

    def announce(self, state: str, *, client: int | None = None, clock: int = 1) -> None:
        """An awareness update for one client: this one's own unless ``client`` names another."""
        data = (write_var_uint(1) + write_var_uint(self.doc.client_id if client is None else client)
                + write_var_uint(clock) + var_string(state))
        self._send(bytes([YMessageType.AWARENESS]) + write_var_uint(len(data)) + data)

    def send_raw(self, data: bytes) -> None:
        self._send(data)


@dataclass
class MemoryStore:
    """A store in memory with a log, standing in for the database."""

    state: bytes | None = None
    updates: list[tuple[bytes, int | None]] = field(default_factory=list)
    folds: list[Folded] = field(default_factory=list)
    summaries: list[tuple[str, str]] = field(default_factory=list)
    fail_next_save: bool = False
    events: list[tuple[Any, ...]] = field(default_factory=list)

    async def load(self, note_id: str) -> tuple[bytes | None, list[bytes]]:
        return self.state, [update for update, _ in self.updates]

    async def save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
        if self.fail_next_save:
            self.fail_next_save = False
            raise OSError("disk full")
        self.updates.append((update, account_id))
        self.events.append(("save", account_id, update))
        return len(self.updates)

    async def fold(self, note_id: str, folded: Folded) -> None:
        self.state = folded.state
        self.updates = []
        self.folds.append(folded)
        self.events.append(("fold", folded.title))

    async def summary(self, note_id: str, title: str, text: str) -> None:
        self.summaries.append((title, text))


def update_of(message: bytes) -> bytes | None:
    """The update inside a sync message (step 2 or update), else None."""
    if message and message[0] == YMessageType.SYNC and message[1] in (YSyncMessageType.SYNC_STEP2,
                                                                       YSyncMessageType.SYNC_UPDATE):
        return read_message(message[2:])
    return None
