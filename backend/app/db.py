"""SQLite connection and the addition of new columns at start.

There is no Alembic. New tables come from ``create_all``, new columns from ``_add_missing_columns``.
Renaming or dropping never happens automatically.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections.abc import Iterator
from enum import Enum
from typing import Any

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from . import models_accounts  # noqa: F401  (its tables belong to the schema of every start)
from .config import get_settings
from .models import Base
from .services.storage import check_data_dir, named_data_dir

logger = logging.getLogger("nexnotes.db")

_settings = get_settings()
check_data_dir(_settings.data_dir, named=named_data_dir())

#: How long a write waits for another one to finish. Every writer keeps its transactions short; this is the margin
#: for a slow disk, not a wait anybody should see.
BUSY_SECONDS = 15

# No pool with an upper bound: with the default pool the sixteenth concurrent request would block the event
# loop waiting for a connection. Opening a SQLite connection costs a fraction of a millisecond.
engine = create_engine(
    f"sqlite:///{_settings.database_path}",
    connect_args={"check_same_thread": False, "timeout": BUSY_SECONDS},
    poolclass=NullPool,
    # A failed statement names its values in the exception, and exceptions reach the log: never note texts or hashes.
    hide_parameters=True,
)


@event.listens_for(engine, "connect")
def _pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute(f"PRAGMA busy_timeout={BUSY_SECONDS * 1000}")
    cursor.execute("PRAGMA synchronous=NORMAL")
    # What a row held is overwritten when it goes: a note locked in the vault (NOTES-16) leaves no plain text behind
    # in free pages of the file.
    cursor.execute("PRAGMA secure_delete=ON")
    cursor.close()
    # SQLite's own lower() and LIKE fold only ASCII: "Ä" never met "ä". This folds like ``paths.fold``.
    dbapi_connection.create_function("nx_fold", 1, _fold, deterministic=True)
    dbapi_connection.create_function("nx_sort", 1, _sort, deterministic=True)


def _fold(value: Any) -> str | None:
    return None if value is None else unicodedata.normalize("NFC", str(value)).casefold()


#: A run of digits, compared by its value.
_DIGITS = re.compile(r"\d+")


def sort_key(value: str) -> str:
    """A text as a reader sorts it: case and accents only break ties (`Ärger` with the A, not after `Zodiac`), and
    numbers as numbers (`Topic 2` before `Topic 10`, review P4.15)."""
    folded = unicodedata.normalize("NFKD", value.casefold())
    plain = "".join(char for char in folded if not unicodedata.combining(char)).replace("ß", "ss")
    natural = _DIGITS.sub(lambda found: found.group().zfill(20), plain)
    return f"{natural}\x00{value.casefold()}"


def _sort(value: Any) -> str | None:
    return None if value is None else sort_key(str(value))


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


def init_db() -> None:
    Base.metadata.create_all(engine)
    added = _add_missing_columns()
    # create_all makes the indexes of new tables only; one added to an existing table comes here.
    for table in Base.metadata.sorted_tables:
        for table_index in table.indexes:
            table_index.create(engine, checkfirst=True)
    # The columns added at this start, and those of a start that stopped before their migrations ran (``OWED``).
    owed = sorted(set(added) | set(_owed()))
    # What the shared account module needs of a database of an older version (only adding).
    from .services import konten_wanderung

    konten_wanderung.run(engine, added=owed)
    # MCP access stays on where it was on from the start (module mcp, decision 5); a new installation starts off.
    from .services import mcp_store

    mcp_store.migrate(engine, owed)
    if owed:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM settings WHERE key = :key"), {"key": OWED})


#: The setting that names the columns (``table.column``) whose one-time migrations have not run yet: written in one
#: transaction with the columns, removed once the migrations ran. A start that stops in between (a failed index, a
#: container stopped) runs them at the next start, whose ``added`` is empty by then.
OWED = "migrations_owed"


def _owed() -> list[str]:
    if not inspect(engine).has_table("settings"):
        return []
    with engine.connect() as connection:
        raw = connection.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": OWED}).scalar()
    try:
        found = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return [str(name) for name in found] if isinstance(found, list) else []


def _sql_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, Enum):
        value = value.value
    return "'" + str(value).replace("'", "''") + "'"


def _add_missing_columns() -> list[str]:
    """Adds the columns a newer version brings, with their defaults; answers which (``table.column``), so that a
    migration that belongs to a column runs exactly once, at the start that made it."""
    inspector = inspect(engine)
    missing = [
        column
        for table in Base.metadata.sorted_tables
        if inspector.has_table(table.name)
        for column in table.columns
        if column.name not in {existing["name"] for existing in inspector.get_columns(table.name)}
    ]
    if missing:
        # A schema change is the moment a backup is worth most: the way back if the new version goes wrong.
        from .services import backups

        backups.create(kind=backups.UPDATE, note="before adding columns")
    added: list[str] = []
    with engine.begin() as connection:
        if missing and inspector.has_table("settings"):
            # First, so the transaction starts here (pysqlite opens it before a write, not before ALTER TABLE): the
            # columns and the note of their migrations owed are kept together or not at all.
            owed = sorted({f"{column.table.name}.{column.name}" for column in missing} | set(_owed()))
            connection.execute(text("DELETE FROM settings WHERE key = :key"), {"key": OWED})
            connection.execute(text("INSERT INTO settings (key, value) VALUES (:key, :value)"),
                               {"key": OWED, "value": json.dumps(owed)})
        for table in Base.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                default = None
                if column.default is not None and not callable(column.default.arg):
                    default = column.default.arg
                if not column.nullable and default is None:
                    raise RuntimeError(
                        f"Column {table.name}.{column.name} is required but has no default. "
                        "Give it a default before starting."
                    )
                column_type = column.type.compile(dialect=engine.dialect)
                statement = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column_type}'
                if default is not None:
                    statement += f" DEFAULT {_sql_literal(default)}"
                connection.execute(text(statement))
                logger.info("Added column name=%s", f"{table.name}.{column.name}")
                added.append(f"{table.name}.{column.name}")
    return added
