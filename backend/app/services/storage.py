"""The data folder: is it there and writable, how full is it, where does it lie.

* At the start ``check_data_dir`` makes sure nexnotes can write there. A folder that was named on purpose
  (``NEXNOTES_DATA_DIR``) but is missing, or one nexnotes may not write to, stops the start with a clear line in the log
  instead of a server that runs halfway and fails at the first note.
* ``usage`` is the used and free space of the disk under the data folder, for the server settings.
* ``FULL_CODES`` are the errors a full disk shows: the request answers ``storage_full`` and nothing existing is touched
  (SQLite rolls the transaction back, a backup in progress is thrown away).
"""

from __future__ import annotations

import errno
import logging
import os
import secrets
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from ..config import StartupError

logger = logging.getLogger("nexnotes.storage")

FULL_CODES = frozenset({errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)})


def check_data_dir(path: Path, *, named: bool) -> None:
    """The start goes on only when nexnotes can write into ``path``. ``named``: the operator set the folder; a missing
    one is a mistake (a volume not mounted), not something to create silently."""
    if not path.exists():
        if named:
            logger.critical("The data folder %s does not exist. Mount a folder there or set NEXNOTES_DATA_DIR.", path)
            raise StartupError(3)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            logger.critical("The data folder %s cannot be created: %s", path, error.strerror or error)
            raise StartupError(3) from error
    if not path.is_dir():
        logger.critical("The data folder %s is not a folder.", path)
        raise StartupError(3)
    probe = path / f".write-check-{secrets.token_hex(4)}"
    try:
        with open(probe, "wb") as handle:
            handle.write(b"ok")
    except OSError as error:
        logger.critical(
            "nexnotes may not write to the data folder %s (%s). Give the user with PUID/PGID write access.",
            path, error.strerror or error,
        )
        raise StartupError(3) from error
    finally:
        try:
            probe.unlink()
        except OSError:
            pass


@dataclass(frozen=True)
class Usage:
    total: int
    used: int
    free: int


def usage(path: Path) -> Usage:
    found = shutil.disk_usage(path)
    return Usage(total=found.total, used=found.used, free=found.free)


def disk_full(error: BaseException) -> bool:
    """A full disk or quota, however deep in the chain of causes: SQLite says "database or disk is full"."""
    seen: BaseException | None = error
    while seen is not None:
        if isinstance(seen, OSError) and seen.errno in FULL_CODES:
            return True
        if isinstance(seen, sqlite3.OperationalError) and "full" in str(seen):
            return True
        seen = getattr(seen, "orig", None) or seen.__cause__ or seen.__context__
    return False


def named_data_dir() -> bool:
    return bool(os.environ.get("NEXNOTES_DATA_DIR", "").strip())
