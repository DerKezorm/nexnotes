"""What nobody needs any more, a few times a day.

The frame removes accounts deleted more than 30 days ago (with everything they own, ``services/content.py``). The
features that keep a trash or a history add their own jobs with ``register``: they run in the same round, each on its
own, so one that fails does not keep the others from running. Every deadline goes by the server's clock.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from ..db import SessionLocal
from . import accounts

logger = logging.getLogger("nexnotes.cleanup")

INTERVAL_SECONDS = 6 * 3600

#: Jobs of the features (the trash, the history), each called with nothing and expected to open its own session.
_jobs: list[tuple[str, Callable[[], None]]] = []


def register(name: str, job: Callable[[], None]) -> None:
    _jobs.append((name, job))


def _purge_accounts() -> None:
    with SessionLocal() as db:
        accounts.purge_deleted(db)


def run_once() -> None:
    for name, job in [("accounts", _purge_accounts), *_jobs]:
        try:
            job()
        except Exception:
            logger.exception("Cleaning up failed job=%s", name)


async def run_forever(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            logger.exception("Cleaning up failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
            return
        except TimeoutError:
            pass
