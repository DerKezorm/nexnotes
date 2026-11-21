"""The rate of one token under ``/api/v1/`` (NOTES-25 AC-23): 600 requests a minute, as the other apps of the family
allow; past that ``slow_down`` with ``Retry-After``. Counted in the memory of the one process nexnotes runs in. MCP
keeps its own, slower bucket (``services/mcp.py``)."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

PER_MINUTE = 600

_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def allow(token_id: int, now: float | None = None) -> bool:
    """True while the token stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _lock:
        seen = _calls[token_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _lock:
        _calls.clear()
