"""A browser's live connection to a note, played with pycrdt over the test client's WebSocket.

It speaks y-websocket as the editor's provider does: sync step 1 on connect, the room's step 1 answered at once with
step 2, every local change sent as an update while connected; offline changes travel with the next step 2. The socket
is read in a thread (it blocks); the document is only touched in the test's own thread (``pump``).
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from pycrdt import (
    Doc,
    Text,
    XmlFragment,
    YMessageType,
    YSyncMessageType,
    create_sync_message,
    create_update_message,
    read_message,
    write_var_uint,
)
from starlette.websockets import WebSocketDisconnect

from app.notedoc.markdown import to_plain
from app.security import SESSION_COOKIE

_CLOSED = "closed"


class Live:
    #: Every connection a test opened; closed after the test even when it failed half way (``close_all``), or the
    #: test client would wait for them for ever.
    opened: list[Live] = []

    @classmethod
    def close_all(cls) -> None:
        while cls.opened:
            cls.opened.pop().disconnect(wait=False)

    def __init__(self, client: TestClient, note_id: str, token: str | None = None, *, doc: Doc | None = None) -> None:
        Live.opened.append(self)
        self.client = client
        self.note_id = note_id
        self.token = token
        self.doc = doc or Doc()
        self.doc.get("body", type=XmlFragment)
        self.doc.get("title", type=Text)
        self.closed: int | None = None
        self.synced = False
        self._remote = False
        self._queue: queue.Queue[Any] = queue.Queue()
        self._ws: Any = None
        self._context: Any = None
        self.doc.observe(self._on_change)
        self.connect()

    # --- connection ---------------------------------------------------------------------------------------------

    def connect(self) -> None:
        headers = {"cookie": f"{SESSION_COOKIE}={self.token}"} if self.token else {}
        self.closed = None
        self.synced = False
        self._queue = queue.Queue()
        self._context = self.client.websocket_connect(f"/api/notes/{self.note_id}/live", headers=headers)
        self._ws = self._context.__enter__()
        mine = self._queue
        ws = self._ws

        def read() -> None:
            while True:
                try:
                    message = ws.receive()
                except Exception:  # noqa: BLE001 - the session went
                    mine.put((_CLOSED, 1006))
                    return
                if message["type"] == "websocket.close":
                    mine.put((_CLOSED, message.get("code", 1000)))
                    return
                if message.get("bytes") is not None:
                    mine.put(message["bytes"])

        threading.Thread(target=read, daemon=True).start()
        self._send(create_sync_message(self.doc))

    def disconnect(self, wait: bool = True) -> None:
        """The connection breaks; what is in flight is lost."""
        if self._ws is None:
            return
        ws, context = self._ws, self._context
        self._ws = self._context = None
        # The test client cancels the server's side when the session ends; first let the room see the goodbye, as a
        # real server does, so that what the room does when someone leaves happens.
        before = _peers(self.note_id) if wait else 0
        try:
            ws.close(1000)
        except Exception:  # noqa: BLE001, S110 - closed already
            pass
        deadline = time.monotonic() + 3.0
        while before and time.monotonic() < deadline:
            left = _peers(self.note_id)
            # The last one out: the room folds and goes, and only then is the leaving done.
            if left < before and (left or not _open(self.note_id)):
                break
            time.sleep(0.01)
        try:
            context.__exit__(None, None, None)
        except Exception:  # noqa: BLE001, S110 - closed already
            pass
        del ws

    close = disconnect

    @property
    def connected(self) -> bool:
        return self._ws is not None and self.closed is None

    def _send(self, data: bytes) -> None:
        if self._ws is not None and self.closed is None:
            try:
                self._ws.send_bytes(data)
            except Exception:  # noqa: BLE001 - the server closed meanwhile
                pass

    # --- messages -----------------------------------------------------------------------------------------------

    def pump(self, until: Callable[[], bool] | None = None, timeout: float = 3.0) -> bool:
        """Handles what arrived; with ``until`` waits for it (False when the time ran out)."""
        if until is None:
            while True:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    return True
                self._handle(item)
        deadline = time.monotonic() + timeout
        while True:
            if until():
                return True
            wait = deadline - time.monotonic()
            if wait <= 0:
                return False
            try:
                item = self._queue.get(timeout=min(wait, 0.05))
            except queue.Empty:
                continue
            self._handle(item)

    def settle(self, quiet: float = 0.3, timeout: float = 5.0) -> None:
        """Handles messages until none came for ``quiet`` seconds."""
        deadline = time.monotonic() + timeout
        last = time.monotonic()
        while time.monotonic() < deadline and time.monotonic() - last < quiet:
            try:
                item = self._queue.get(timeout=0.02)
            except queue.Empty:
                continue
            self._handle(item)
            last = time.monotonic()

    def _handle(self, item: Any) -> None:
        if isinstance(item, tuple) and item[0] == _CLOSED:
            self.closed = item[1]
            # A browser answers the server's goodbye by closing its end.
            self.disconnect(wait=False)
            return
        data: bytes = item
        if data[0] != YMessageType.SYNC:
            return
        kind, payload = data[1], read_message(data[2:])
        if kind == YSyncMessageType.SYNC_STEP1:
            update = self.doc.get_update(payload)
            self._send(bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP2]) + write_var_uint(len(update)) + update)
            return
        self._remote = True
        try:
            self.doc.apply_update(payload)
        finally:
            self._remote = False
        if kind == YSyncMessageType.SYNC_STEP2:
            self.synced = True

    def _on_change(self, event: Any) -> None:
        if self._remote:
            return
        if event.before_state == event.after_state and event.delete_set in (b"", b"\x00"):
            return
        self._send(create_update_message(event.update))

    # --- reading ------------------------------------------------------------------------------------------------

    @property
    def text(self) -> str:
        return to_plain(self.doc)

    @property
    def title(self) -> str:
        return str(self.doc.get("title", type=Text))

    def set_title(self, title: str) -> None:
        text = self.doc.get("title", type=Text)
        with self.doc.transaction():
            if len(text):
                del text[0: len(str(text).encode("utf-8"))]
            text.insert(0, title)


def _peers(note_id: str) -> int:
    """Connections the server holds to the note, over every loop (one per test client)."""
    from app.services import notes

    return sum(len(room.peers) for rooms in list(notes._rooms.values())
               if (room := rooms.room_of(note_id)) is not None)


def _open(note_id: str) -> bool:
    from app.services import notes

    return any(rooms.room_of(note_id) is not None for rooms in list(notes._rooms.values()))


def refused(client: TestClient, note_id: str, token: str | None = None) -> int:
    """The close code a connection gets before it is accepted (0 when it was accepted)."""
    # Without a token: no session at all (not the test client's own cookie).
    headers = {"cookie": f"{SESSION_COOKIE}={token}" if token else "nothing=1"}
    try:
        with client.websocket_connect(f"/api/notes/{note_id}/live", headers=headers):
            return 0
    except WebSocketDisconnect as closed:
        return closed.code
