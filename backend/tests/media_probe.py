"""Tasks for the media worker in tests (``media_worker.TARGETS`` takes them only while a test adds them). Imports
nothing of the app: the worker loads this module by name."""

from __future__ import annotations

import os
import time


def swallow(megabytes: int) -> int:
    """Takes ``megabytes`` of memory, one at a time, as a decoder gone wild would; returns how many it got."""
    held = []
    for _ in range(megabytes):
        held.append(bytearray(1024 * 1024))
    return len(held)


def nap(seconds: float) -> tuple[int, float, float]:
    """Sleeps; returns the worker's process id and when it began and ended."""
    began = time.time()
    time.sleep(seconds)
    return os.getpid(), began, time.time()


def refuse(text: str) -> None:
    raise ValueError(text)


def spin(seconds: float) -> int:
    """Computes for ``seconds`` without a pause."""
    end = time.monotonic() + seconds
    count = 0
    while time.monotonic() < end:
        count += 1
    return count
