"""Writing a note together, live: one room per open note, the y-websocket protocol over pycrdt.

The room knows nothing of FastAPI or the database. It gets a socket, a store and a check:

* ``Socket`` (``send_bytes``, ``receive_bytes``, ``close``) is a Starlette ``WebSocket`` after ``accept()``.
* ``NoteStore`` loads a note's document, keeps every update, folds and refreshes the text for search.
* ``check(peer)`` answers whether a connection may still write, only read, not even read (``Access.NONE``), or whether
  the note went (``Access.GONE``).

What the room does:

* **Who may read follows along, who may write changes.** An update from a reader is dropped, never applied or stored.
* **Every update is stored before it is passed on** (``NoteStore.save_update``), so nothing anyone saw is lost by a
  crash. If storing fails, the room goes back to what is stored and the sender is closed (``CLOSE_ERROR``); its browser
  reconnects and sends the change again.
* **Rights are checked again** while a connection is open: every ``recheck_seconds``, at once after ``nudge()`` (a
  share removed, a session ended, an account blocked), and before an update is stored when there was a nudge since the
  last check, so an update that arrives after its right was taken is not stored (NOTES-12 EC-5). Closing codes:
  ``CLOSE_FORBIDDEN`` (no right left), ``CLOSE_GONE`` (note deleted, EC-2), ``CLOSE_RIGHTS`` (write became read or the
  other way round: reconnect), ``CLOSE_TOO_LARGE`` (update or document over the limit), ``CLOSE_BAD`` (not the
  protocol).
* **Folding:** after ``fold_after`` stored updates and when the last one leaves, the document is folded into one state
  (``NoteStore.fold`` with the state, the title and the plain text).
* **Text for search** is refreshed ``summary_delay`` seconds after a change (``NoteStore.summary``).
* **Awareness** (who is here, where the caret is) is passed on and remembered; when a connection goes, the others are
  told its clients left. It is bound to the connection: ``user.accountId`` and ``user.name`` are replaced by the
  connection's own, and a client id another connection announced is not taken (only another connection of the same
  account may take it over, the same window coming back), so nobody appears as someone else or removes someone else's
  presence. At most ``MAX_AWARENESS_CLIENTS`` client ids per connection.
* **Concurrent deletion:** text typed into a paragraph that someone else deleted at the same time comes back as a
  paragraph of its own (``rescue.py``, EC-1), and shapes the schema refuses after concurrent deletions (a checklist
  without items) are mended (``doc.repair``), both as a change of the server after the update.
* **A browser gets the document only after its own changes are in:** its sync step 1 is answered once its sync step 2
  (the answer to the room's step 1) has arrived, and changes of others reach it only from then on. Text it wrote
  offline into a paragraph someone deleted meanwhile is therefore sent before the browser learns of the deletion
  (which would take that text away in the browser itself). Every y-websocket client sends that step 2 at once; one
  that never does gets the document after ``sync_timeout`` seconds.
* **pycrdt stays at 0.13.1** (``requirements-notedoc.txt``): 0.14 writes states with overlapping blocks after such
  concurrent edits, which Yjs in the browser cannot read (``tests/notedoc/fixtures/concurrent``). The room does not
  fold a state that does not encode cleanly (``yupdate.well_formed``).
* **Changes from the server** (MCP, nexdeck, the REST API) go through ``Rooms.change``: applied to the open room or to
  the stored document, stored, passed to everyone.

Hooking it into the app (one ``Rooms`` per process, nexnotes runs one worker)::

    rooms = Rooms(store=SqlNoteStore(SessionLocal), check=check_access)   # at startup, e.g. app.state.rooms

    @router.websocket("/api/notes/{note_id}/live")
    async def live(socket: WebSocket, note_id: str):
        account, session = authenticate(socket)          # cookie session, like the REST API
        access = right_for(account, note_id)             # "write" / "read" / none
        await socket.accept()                            # first: a close before it reaches a browser as 1006
        if access is None:
            await socket.close(CLOSE_FORBIDDEN); return
        await rooms.serve(socket, note_id, account_id=account.id, name=account.name,
                          can_write=access == "write", session=session)

    # after every commit that may take a right or a session: rooms.nudge()
    # deleting a note: await rooms.close_note(note_id)
    # MCP / REST: await rooms.change(note_id, lambda doc: edit.append_markdown(doc, text), account_id=...)
    # at shutdown: await rooms.shutdown(); at startup: fold what waits (``fold_stored``)

``SqlNoteStore`` keeps ``notes.ydoc`` (the folded state) and ``note_updates`` (note_id, update, account_id,
created_at); ``save_update`` gets ``account_id=None`` for the server's own changes (text put back, shapes mended),
which should not count as "changed by" anyone (AC-9). ``fold`` writes the state and ``notes.text`` (the title the app
takes as it decides: the document's title is what people typed, the column follows the app's title rules) and deletes
every update stored before the call (the room holds its lock, nothing is stored meanwhile). The store's methods are
coroutines; synchronous database code runs in ``asyncio.to_thread``. They get bytes and strings, never the pycrdt
document (it must stay in its thread).
"""

from __future__ import annotations

import asyncio
import enum
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar

from pycrdt import (
    Decoder,
    Doc,
    YMessageType,
    YSyncMessageType,
    create_sync_message,
    create_update_message,
    read_message,
    write_var_uint,
)

from . import schema as s
from .doc import change as change_doc
from .doc import load, merged, recording, repair, title_of
from .markdown import to_plain
from .rescue import Rescuer, apply, redundant
from .yupdate import well_formed

logger = logging.getLogger("nexnotes.live")

T = TypeVar("T")

#: Close codes the browser understands.
CLOSE_ERROR = 1011
CLOSE_RESTART = 1012
CLOSE_BAD = 4400
CLOSE_FORBIDDEN = 4403
CLOSE_GONE = 4404
CLOSE_RIGHTS = 4409
CLOSE_TOO_LARGE = 4413
#: The note is locked in the vault, or being locked (NOTES-16): it has no live room; the browser opens it locked.
CLOSE_LOCKED = 4423

#: y-websocket message types beyond sync and awareness.
MESSAGE_AUTH = 2
MESSAGE_QUERY_AWARENESS = 3


class Access(enum.Enum):
    WRITE = "write"
    READ = "read"
    #: No right left (share removed, session ended, account blocked).
    NONE = "none"
    #: The note was deleted or moved to the bin.
    GONE = "gone"


class Socket(Protocol):
    async def send_bytes(self, data: bytes) -> None: ...

    async def receive_bytes(self) -> bytes: ...

    async def close(self, code: int = 1000) -> None: ...


@dataclass
class Folded:
    """A note folded into one state, with what the server keeps beside it."""

    state: bytes
    title: str
    text: str


class NoteStore(Protocol):
    async def load(self, note_id: str) -> tuple[bytes | None, list[bytes]]:
        """The folded state (None for a note without one) and every update stored after it, in order."""
        ...

    async def save_update(self, note_id: str, update: bytes, account_id: int | None) -> int:
        """Keeps one update for good (and ``updated_by``/``updated_at``); returns how many wait to be folded."""
        ...

    async def fold(self, note_id: str, folded: Folded) -> None:
        """Replaces the stored state, title and text, and drops every update stored before the call."""
        ...

    async def summary(self, note_id: str, title: str, text: str) -> None:
        """Title and plain text anew (search, preview), shortly after a change."""
        ...


@dataclass(eq=False)
class Peer:
    socket: Socket
    account_id: int
    name: str
    can_write: bool
    #: Whatever the check needs to look at the connection again (the browser session).
    session: Any = None
    checked: float = field(default_factory=time.monotonic)
    #: The nudge count when the connection was last checked.
    epoch: int = 0
    #: Awareness client ids this connection announced.
    clients: set[int] = field(default_factory=set)
    #: Closed: gets nothing more, its messages are ignored.
    gone: bool = False
    #: The browser's own changes (its sync step 2) have arrived; until then it gets no changes of others.
    ready: bool = False
    #: The browser's sync step 1 (its state vector), answered once it is ready.
    asked: bytes | None = None
    joined: float = field(default_factory=time.monotonic)


class Room:
    def __init__(self, note_id: str, doc: Doc) -> None:
        self.note_id = note_id
        self.doc = doc
        #: The connections, in the order they came (a dict keeps the order, a set would not).
        self.peers: dict[Peer, None] = {}
        self.lock = asyncio.Lock()
        self.waiting = 0
        self.awareness: dict[int, bytes] = {}
        self.whole = doc.get_update()
        self.rescuer = Rescuer()
        self.summary_task: asyncio.Task[None] | None = None
        self.dirty = False

    async def send(self, data: bytes, skip: Peer | None = None, *, ready_only: bool = False) -> None:
        for peer in list(self.peers):
            if peer is skip or peer.gone or (ready_only and not peer.ready):
                continue
            try:
                await peer.socket.send_bytes(data)
            except Exception:  # noqa: BLE001 - a connection that broke off fails in its own way
                self.peers.pop(peer, None)


Check = Callable[[Peer], Awaitable[Access]]


class _Gone(Exception):
    """The connection broke while the room was writing to it."""


async def _send(peer: Peer, data: bytes) -> None:
    try:
        await peer.socket.send_bytes(data)
    except Exception as error:
        raise _Gone() from error


class _Close(Exception):
    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


class Rooms:
    """Every open note of this process."""

    def __init__(self, store: NoteStore, check: Check, *, recheck_seconds: float = 5.0, tick: float = 0.5,
                 fold_after: int = s.FOLD_AFTER, summary_delay: float = 2.0, sync_timeout: float = 10.0,
                 client_ids: Callable[[], int] | None = None) -> None:
        self.store = store
        self.check = check
        self.recheck_seconds = recheck_seconds
        self.tick = tick
        self.fold_after = fold_after
        self.summary_delay = summary_delay
        self.sync_timeout = sync_timeout
        #: Where the client id of a loaded document comes from (random unless a test needs it fixed). The server
        #: writes under it (its own changes, text it puts back), so two documents alive at once must not share one.
        self.client_ids = client_ids
        self.rooms: dict[str, Room] = {}
        #: One lock per note while its room is opened or closed, or its stored document changed without a room:
        #: loading and storing one note never holds up another (NOTES-24, ``apply`` of up to 50 notes), and no room
        #: opens on a document that a change is still storing. ``[lock, users]``, dropped when nobody holds it.
        self.note_locks: dict[str, list[Any]] = {}
        self.epoch = 0

    # --- outside calls --------------------------------------------------------------------------------------------

    def _client_id(self) -> int | None:
        return self.client_ids() if self.client_ids is not None else None

    def nudge(self) -> None:
        """Something that can take a right or a session changed: every connection is checked again at once."""
        self.epoch += 1

    def room_of(self, note_id: str) -> Room | None:
        return self.rooms.get(note_id)

    async def close_note(self, note_id: str, code: int = CLOSE_GONE) -> None:
        """Everyone out of a note that was deleted (EC-2)."""
        room = self.rooms.get(note_id)
        if room is None:
            return
        for peer in list(room.peers):
            await self._drop(room, peer, code)

    async def change(self, note_id: str, edit: Callable[[Doc], T], *, account_id: int | None = None,
                     rescue: Callable[[Rescuer, T], None] | None = None) -> T:
        """A change by the server: applied in one transaction to the live document (or the stored one when nobody has
        the note open), stored, passed to everyone. Returns what ``edit`` returned. ``rescue`` tells the open room's
        rescuer, under the same lock, where text typed into what the change deleted should go."""
        room = self.rooms.get(note_id)
        if room is None:
            async with self._held(note_id):
                room = self.rooms.get(note_id)
                if room is None:
                    state, updates = await self.store.load(note_id)
                    doc = load(state, updates, client_id=self._client_id())
                    result, update = change_doc(doc, edit)
                    if update is not None:
                        waiting = await self.store.save_update(note_id, update, account_id)
                        if waiting < self.fold_after or not await self._fold_doc(note_id, doc):
                            await self.store.summary(note_id, title_of(doc), to_plain(doc))
                    return result
        async with room.lock:
            result, update = change_doc(room.doc, edit)
            if update is not None and rescue is not None:
                rescue(room.rescuer, result)
            if update is not None:
                await self._keep(room, update, account_id)
        if update is not None:
            await room.send(create_update_message(update), ready_only=True)
        return result

    async def apply(self, note_id: str, update: bytes | None, *, account_id: int,
                    state_vector: bytes) -> tuple[bytes, bytes, str]:
        """An update of a device without a live connection (the app's ``sync``, NOTES-24 AC-3), taken as if a writer
        had sent it in the room: stored before anyone gets it, text put back and shapes mended the same way, passed
        to every open browser. The same update twice changes nothing and is stored once (EC-6). Returns the state
        vector after it, what the device lacks against ``state_vector``, and the title. ``update`` None only reads.
        Raises ``Refused`` (``invalid_update``, ``too_large``); a note locked meanwhile fails in the store."""
        room = self.rooms.get(note_id)
        if room is None:
            async with self._held(note_id):
                room = self.rooms.get(note_id)
                if room is None:
                    state, updates = await self.store.load(note_id)
                    doc = load(state, updates, client_id=self._client_id())
                    rescue: bytes | None = None
                    taken = False
                    if update:
                        taken, rescue, _whole = _take_in(doc, update, Rescuer(), doc.get_update())
                    if taken:
                        waiting = await self.store.save_update(note_id, update, account_id)
                        if rescue is not None:
                            waiting = await self.store.save_update(note_id, rescue, None)
                        if waiting < self.fold_after or not await self._fold_doc(note_id, doc):
                            await self.store.summary(note_id, title_of(doc), to_plain(doc))
                    return _answer_for(doc, state_vector)
        rescue = None
        taken = False
        async with room.lock:
            if update:
                try:
                    taken, rescue, whole = _take_in(room.doc, update, room.rescuer, room.whole)
                except Refused:
                    await self._reload(room)
                    raise
                if taken:
                    try:
                        await self._keep(room, update, account_id, also=rescue, whole=whole if rescue is None else None)
                    except Exception:
                        logger.exception("Storing an update of a device failed note=%s", room.note_id)
                        await self._reload(room)
                        raise
            answer = _answer_for(room.doc, state_vector)
        if taken:
            assert update is not None
            await room.send(create_update_message(update), ready_only=True)
            if rescue is not None:
                await room.send(create_update_message(rescue), ready_only=True)
        return answer

    async def shutdown(self) -> None:
        """At a server stop: every room folded, every connection closed so browsers reconnect (EC-7)."""
        for room in list(self.rooms.values()):
            async with room.lock:
                await self._fold(room)
            for peer in list(room.peers):
                await self._drop(room, peer, CLOSE_RESTART)
        self.rooms.clear()

    async def serve(self, socket: Socket, note_id: str, *, account_id: int, name: str, can_write: bool,
                    session: Any = None) -> None:
        """One connection from its first message to its last. The socket is accepted already."""
        room = await self._open(note_id)
        peer = Peer(socket=socket, account_id=account_id, name=name, can_write=can_write, session=session,
                    epoch=self.epoch)
        room.peers[peer] = None
        watcher = asyncio.create_task(self._watch(room, peer))
        logger.debug("Joined note=%s account=%s write=%s peers=%s", note_id, account_id, can_write, len(room.peers))
        try:
            async with room.lock:
                first = create_sync_message(room.doc)
            await _send(peer, first)
            for data in list(room.awareness.values()):
                await _send(peer, data)
            while not peer.gone:
                try:
                    message = await socket.receive_bytes()
                except Exception:  # noqa: BLE001 - the connection ended, however the server reports it
                    break
                if peer.gone:
                    break
                if message:
                    await self._on_message(room, peer, message)
        except _Close as close:
            await self._drop(room, peer, close.code)
        except _Gone:
            pass  # the connection broke while the room was writing to it
        except Exception:
            logger.exception("Live connection failed note=%s account=%s", note_id, account_id)
            await self._drop(room, peer, CLOSE_ERROR)
        finally:
            watcher.cancel()
            await self._leave(room, peer)
            logger.debug("Left note=%s account=%s peers=%s", note_id, account_id, len(room.peers))

    # --- the room's life ------------------------------------------------------------------------------------------

    @asynccontextmanager
    async def _held(self, note_id: str) -> AsyncIterator[None]:
        entry = self.note_locks.setdefault(note_id, [asyncio.Lock(), 0])
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self.note_locks.get(note_id) is entry:
                del self.note_locks[note_id]

    async def _open(self, note_id: str) -> Room:
        async with self._held(note_id):
            room = self.rooms.get(note_id)
            if room is None:
                state, updates = await self.store.load(note_id)
                room = Room(note_id, load(state, updates, client_id=self._client_id()))
                self.rooms[note_id] = room
            return room

    async def _leave(self, room: Room, peer: Peer) -> None:
        room.peers.pop(peer, None)
        peer.gone = True
        for client in peer.clients:
            last = room.awareness.pop(client, None)
            clock = _awareness_clock(last[1:], client) if last else 0
            await room.send(_awareness_gone(client, clock + 1))
        if room.peers:
            return
        async with self._held(room.note_id):
            if room.peers or self.rooms.get(room.note_id) is not room:
                return
            async with room.lock:
                await self._fold(room)
            del self.rooms[room.note_id]

    async def _fold(self, room: Room) -> None:
        """Call with the room's lock held."""
        if room.summary_task is not None:
            room.summary_task.cancel()
            room.summary_task = None
        if (room.waiting or room.dirty) and await self._fold_doc(room.note_id, room.doc):
            room.waiting = 0
            room.dirty = False

    async def _fold_doc(self, note_id: str, doc: Doc) -> bool:
        folded = _folded(doc)
        if not well_formed(folded.state):
            # Every update stays stored as it came; the browser reads those. Folding waits for a fixed pycrdt.
            logger.error("The document of a note does not encode cleanly; not folded note=%s", note_id)
            return False
        await self.store.fold(note_id, folded)
        return True

    async def _drop(self, room: Room, peer: Peer, code: int) -> None:
        peer.gone = True
        peer.can_write = False
        room.peers.pop(peer, None)
        try:
            await peer.socket.close(code)
        except Exception:  # noqa: BLE001, S110 - closed already
            pass

    # --- rights ---------------------------------------------------------------------------------------------------

    async def _recheck(self, room: Room, peer: Peer) -> bool:
        """Looks at the connection again; closes it when it may not stay as it is. True when it stays."""
        peer.epoch = self.epoch
        peer.checked = time.monotonic()
        access = await self.check(peer)
        if peer.gone:
            return False
        if access == Access.GONE:
            await self._drop(room, peer, CLOSE_GONE)
            return False
        if access not in (Access.WRITE, Access.READ):
            await self._drop(room, peer, CLOSE_FORBIDDEN)
            return False
        if (access == Access.WRITE) != peer.can_write:
            # Writing became reading or the other way round: the browser starts again with the right it has now.
            await self._drop(room, peer, CLOSE_RIGHTS)
            return False
        return True

    async def _watch(self, room: Room, peer: Peer) -> None:
        while not peer.gone:
            await asyncio.sleep(self.tick)
            if not peer.ready and time.monotonic() - peer.joined >= self.sync_timeout:
                # A client that never sends its own state still gets the document.
                await self._ready(room, peer)
            if peer.epoch == self.epoch and time.monotonic() - peer.checked < self.recheck_seconds:
                continue
            try:
                if not await self._recheck(room, peer):
                    return
            except Exception:
                logger.exception("Checking a live connection failed note=%s", room.note_id)
                await self._drop(room, peer, CLOSE_ERROR)
                return

    # --- messages -------------------------------------------------------------------------------------------------

    async def _on_message(self, room: Room, peer: Peer, message: bytes) -> None:
        kind = message[0]
        if kind == YMessageType.SYNC:
            await self._on_sync(room, peer, message[1:])
        elif kind == YMessageType.AWARENESS:
            if len(message) > s.MAX_AWARENESS:
                raise _Close(CLOSE_TOO_LARGE)
            entries = _awareness_entries(message[1:])
            if entries is None:
                raise _Close(CLOSE_BAD)
            kept = _own_awareness(room, peer, entries)
            if len(peer.clients | {client for client, _, _ in kept}) > s.MAX_AWARENESS_CLIENTS:
                raise _Close(CLOSE_BAD)
            if not kept:
                return
            for client, clock, state in kept:
                peer.clients.add(client)
                room.awareness[client] = _awareness_message([(client, clock, state)])
            await room.send(_awareness_message(kept), skip=peer)
        elif kind == MESSAGE_QUERY_AWARENESS:
            for data in list(room.awareness.values()):
                await _send(peer, data)
        elif kind == MESSAGE_AUTH:
            return
        else:
            raise _Close(CLOSE_BAD)

    async def _on_sync(self, room: Room, peer: Peer, message: bytes) -> None:
        if not message:
            raise _Close(CLOSE_BAD)
        kind = message[0]
        try:
            payload = read_message(message[1:])
        except Exception as error:
            raise _Close(CLOSE_BAD) from error
        if kind == YSyncMessageType.SYNC_STEP1:
            peer.asked = payload
            if peer.ready:
                await self._answer(room, peer)
            return
        if kind == YSyncMessageType.SYNC_STEP2:
            await self._on_update(room, peer, payload)
            await self._ready(room, peer)
            return
        if kind == YSyncMessageType.SYNC_UPDATE:
            await self._on_update(room, peer, payload)
            return
        raise _Close(CLOSE_BAD)

    async def _ready(self, room: Room, peer: Peer) -> None:
        """The browser's own changes are in (or it took too long): from now on it gets the document and every change.

        Answering its sync step 1 only now keeps text it wrote offline into a paragraph someone deleted meanwhile:
        had it learned of the deletion first, its own copy of that text would be gone before it was ever sent."""
        if peer.ready or peer.gone:
            return
        peer.ready = True
        if peer.asked is not None:
            await self._answer(room, peer)

    async def _answer(self, room: Room, peer: Peer) -> None:
        asked, peer.asked = peer.asked, None
        async with room.lock:
            try:
                update = room.doc.get_update(asked)
            except Exception as error:
                raise _Close(CLOSE_BAD) from error
        await _send(peer, _step2(update))

    async def _on_update(self, room: Room, peer: Peer, payload: bytes) -> None:
        if payload == b"\x00\x00" or not peer.can_write:
            return
        if len(payload) > s.MAX_UPDATE:
            raise _Close(CLOSE_TOO_LARGE)
        if peer.epoch != self.epoch and not await self._recheck(room, peer):
            return  # the right went before this update arrived: it is not stored (EC-5)
        rescue: bytes | None = None
        async with room.lock:
            if peer.gone:
                return
            state_before = room.doc.get_state()
            whole_before = room.whole
            try:
                applied = apply(room.doc, payload)
                if not applied.changed and redundant(payload, state_before):
                    return
            except Exception as error:
                await self._reload(room)
                raise _Close(CLOSE_BAD) from error
            whole = room.doc.get_update()
            if len(whole) > s.MAX_DOC:
                await self._reload(room)
                raise _Close(CLOSE_TOO_LARGE)
            if applied.changed and applied.deleted:
                # Text a concurrent deletion took unseen comes back, a shape the schema refuses is mended; both in
                # one change of the server that goes to everyone after the update.
                with recording(room.doc) as made:
                    # Mending first: the positions the update reported are still right before text comes back.
                    mended = repair(room.doc, applied.touched) if applied.structural else 0
                    restored = room.rescuer.after(room.doc, payload, applied, whole_before)
                if restored or mended:
                    rescue = merged(made)
                if restored:
                    logger.info("Kept %s characters of a deleted paragraph note=%s", restored, room.note_id)
            try:
                await self._keep(room, payload, peer.account_id, also=rescue, whole=whole if rescue is None else None)
            except Exception as error:
                logger.exception("Storing an update failed note=%s", room.note_id)
                await self._reload(room)
                raise _Close(CLOSE_ERROR) from error
        await room.send(create_update_message(payload), skip=peer, ready_only=True)
        if rescue is not None:
            await room.send(create_update_message(rescue), ready_only=True)

    async def _keep(self, room: Room, update: bytes, account_id: int | None, also: bytes | None = None,
                    whole: bytes | None = None) -> None:
        """Stores an update (and the server's change that came with it), folds when due. ``whole`` is the document
        as one update when the caller has it already. Call with the lock held."""
        room.waiting = await self.store.save_update(room.note_id, update, account_id)
        if also is not None:
            room.waiting = await self.store.save_update(room.note_id, also, None)
        room.dirty = True
        room.whole = whole if whole is not None else room.doc.get_update()
        if room.waiting >= self.fold_after:
            await self._fold(room)
        elif room.summary_task is None:
            room.summary_task = asyncio.create_task(self._summary_later(room))

    async def _summary_later(self, room: Room) -> None:
        await asyncio.sleep(self.summary_delay)
        async with room.lock:
            room.summary_task = None
            title, text = title_of(room.doc), to_plain(room.doc)
        try:
            await self.store.summary(room.note_id, title, text)
        except Exception:
            logger.exception("Refreshing the text of a note failed note=%s", room.note_id)

    async def _reload(self, room: Room) -> None:
        """Back to what is stored (an update that could not be kept). Call with the lock held."""
        state, updates = await self.store.load(room.note_id)
        room.doc = load(state, updates, client_id=self._client_id())
        room.whole = room.doc.get_update()
        room.rescuer = Rescuer()


class Refused(Exception):
    """An update of a device the room does not take: ``invalid_update`` (not one pycrdt can read) or ``too_large``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _take_in(doc: Doc, update: bytes, rescuer: Rescuer, whole_before: bytes) -> tuple[bool, bytes | None, bytes]:
    """Applies a device's update as ``_on_update`` does a browser's: whether it is to be stored, the server's change
    that came with it (text put back, shapes mended), and the whole document after it. Raises ``Refused``; the
    caller loads the document again then."""
    if len(update) > s.MAX_UPDATE:
        raise Refused("too_large")
    state_before = doc.get_state()
    try:
        applied = apply(doc, update)
    except Exception as error:  # not an update pycrdt can read
        raise Refused("invalid_update") from error
    if not applied.changed and redundant(update, state_before):
        return False, None, whole_before
    whole = doc.get_update()
    if len(whole) > s.MAX_DOC:
        raise Refused("too_large")
    rescue: bytes | None = None
    if applied.changed and applied.deleted:
        with recording(doc) as made:
            mended = repair(doc, applied.touched) if applied.structural else 0
            restored = rescuer.after(doc, update, applied, whole_before)
        if restored or mended:
            rescue = merged(made)
    return True, rescue, whole


def _answer_for(doc: Doc, state_vector: bytes) -> tuple[bytes, bytes, str]:
    try:
        lacking = doc.get_update(state_vector) if state_vector else doc.get_update()
    except Exception as error:  # not a state vector pycrdt can read
        raise Refused("invalid_state_vector") from error
    return doc.get_state(), lacking, title_of(doc)


def _step2(update: bytes) -> bytes:
    return bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP2]) + write_var_uint(len(update)) + update


def _folded(doc: Doc) -> Folded:
    return Folded(state=doc.get_update(), title=title_of(doc), text=to_plain(doc))


def fold_stored(state: bytes | None, updates: list[bytes]) -> Folded:
    """A stored note folded without a room (at startup, for updates left by a stop)."""
    return _folded(load(state, updates))


# --- awareness ----------------------------------------------------------------------------------------------------


#: One client's entry of an awareness update: client id, clock, state (a JSON object, or ``None`` when it left).
AwarenessEntry = tuple[int, int, "dict[str, Any] | None"]


def _awareness_entries(message: bytes) -> list[AwarenessEntry] | None:
    """The entries of an awareness update (count, then id, clock, state as JSON per client); None when broken or when a
    state is neither an object nor ``null``."""
    try:
        decoder = Decoder(read_message(message))
        entries: list[AwarenessEntry] = []
        for _ in range(decoder.read_var_uint()):
            client = decoder.read_var_uint()
            clock = decoder.read_var_uint()
            state = json.loads(decoder.read_var_string())
            if state is not None and not isinstance(state, dict):
                return None
            entries.append((client, clock, state))
        return entries
    except Exception:  # noqa: BLE001 - a malformed awareness message
        return None


def _own_awareness(room: Room, peer: Peer, entries: list[AwarenessEntry]) -> list[AwarenessEntry]:
    """What a connection may say about who is here: only its own clients, and only as the account it is.

    * ``user.accountId`` and ``user.name`` are the connection's own, whatever the browser wrote: nobody shows up as
      someone else, or as "du, anderes Fenster" of the one looking (NOTES-12 AC-5, EC-8).
    * A client id another connection announced is not this one's: its entries are dropped, so nobody moves or removes
      the presence of another person. Another connection of the same account may take it over: that is the same
      window coming back before the room noticed its old connection broke."""
    kept: list[AwarenessEntry] = []
    for client, clock, state in entries:
        owner = next((other for other in room.peers if other is not peer and client in other.clients), None)
        if owner is not None:
            if owner.account_id != peer.account_id:
                logger.warning("Awareness for a client of another connection dropped note=%s account=%s",
                               room.note_id, peer.account_id)
                continue
            owner.clients.discard(client)
        if state is not None:
            user = state.get("user")
            state = {**state, "user": {**(user if isinstance(user, dict) else {}),
                                       "accountId": peer.account_id, "name": peer.name}}
        kept.append((client, clock, state))
    return kept


def var_string(text: str) -> bytes:
    """A string as lib0 writes it: the number of its UTF-8 bytes, then the bytes. (pycrdt's
    ``Encoder.write_var_string`` writes the number of characters instead, which cuts every name with an umlaut or an
    emoji short in the browser.)"""
    data = text.encode("utf-8")
    return write_var_uint(len(data)) + data


def _awareness_message(entries: list[AwarenessEntry]) -> bytes:
    parts = [write_var_uint(len(entries))]
    for client, clock, state in entries:
        parts += [write_var_uint(client), write_var_uint(clock),
                  var_string(json.dumps(state, ensure_ascii=False, separators=(",", ":")))]
    data = b"".join(parts)
    return bytes([YMessageType.AWARENESS]) + write_var_uint(len(data)) + data


def _awareness_clock(message: bytes, wanted: int) -> int:
    try:
        decoder = Decoder(read_message(message))
        for _ in range(decoder.read_var_uint()):
            client = decoder.read_var_uint()
            clock = decoder.read_var_uint()
            decoder.read_var_string()
            if client == wanted:
                return clock
    except Exception:  # noqa: BLE001, S110 - a malformed message: start the clock again
        pass
    return 0


def _awareness_gone(client: int, clock: int) -> bytes:
    return _awareness_message([(client, clock, None)])
