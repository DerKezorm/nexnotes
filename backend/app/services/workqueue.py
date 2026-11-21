"""Work in the background, one piece after the other (NOTES-11; open to other features).

A feature registers a handler for its kind of work (``register("ocr", handler)``) and puts work into the queue with
``enqueue(db, "ocr", ref)``, in the transaction that makes the reason for it (an attachment's row): what is in the
database is never forgotten, also when the server stops right after.

**One at a time** (EC-1 of NOTES-11): a single worker thread takes the next job and hands it to its handler. **In
rounds per account**: the next job is the one that waited longest of the account served longest ago, so thirty
pictures of one account do not keep another waiting thirty turns; an account has at most ``MAX_WAITING`` jobs in the
queue, the rest come in as room frees (``REFILL_HOOKS``, asked when the queue runs dry and after a job of the account
ends). The handler does a part of the work and says whether it is done (``None``) or wants another turn
(``Again``): then the job goes to the back of the line, behind everything that waited meanwhile, so a long job (a PDF
of 300 pages) never holds up the others for long (EC-6).

**Restarts** (EC-4): a job that was running when the server stopped is queued again at the next start (``recover``);
what its handler stored before stays, so it goes on where it was.

**Failures**: a handler that raises gets ``ATTEMPTS`` turns with a growing pause; after the last its ``failed`` is
called and the job goes. ``Permanent`` ends it at once (a file that cannot be read will not be read later either).
``Interrupted`` (the server is going down) puts it back without counting.

The thread starts with the first job when ``AUTO`` is on (the server: unless ``NEXNOTES_DISABLE_BACKGROUND`` without
``NEXNOTES_WORK_QUEUE``). The server's tests run the queue themselves with ``run_pending``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import utcnow
from ..models_ocr import QUEUED, RUNNING, WorkJob

logger = logging.getLogger("nexnotes.work")

#: Failed turns before a job is given up.
ATTEMPTS = 3
#: The pause after the first, second ... failed turn.
BACKOFF = (timedelta(seconds=30), timedelta(minutes=2), timedelta(minutes=10))
#: How often the idle worker looks for jobs whose time has come (a job put in wakes it at once).
POLL_SECONDS = 15.0
#: The worker thread runs by itself; off (until the server's start says otherwise, and in the tests), jobs wait for
#: ``run_pending``.
AUTO = False
#: Jobs one account may have waiting in the queue; more are refused by ``enqueue`` and come later through a refill.
MAX_WAITING = 200


@dataclass(frozen=True)
class Again:
    """A handler did a part: another turn, at the back of the line, not before ``delay``."""

    delay: timedelta = timedelta(0)


class Permanent(Exception):
    """The work cannot be done, now or later (a broken file)."""


class Interrupted(Exception):
    """The server is going down while the work runs: the job waits for the next start."""


Handler = Callable[[str], Again | None]
Failed = Callable[[str, str], None]


@dataclass(frozen=True)
class Kind:
    run: Handler
    #: Called once when the job is given up, with the reason.
    failed: Failed | None = None


HANDLERS: dict[str, Kind] = {}
#: Put work that was refused for a full account into the queue again (each returns how many it put in).
REFILL_HOOKS: list[Callable[[], int]] = []
#: When each account was served last (a counter of turns): the rounds.
_served: dict[int | None, int] = {}
_turns = 0
#: Set while the server goes down: handlers stop what they started (a process) and raise ``Interrupted``.
stopping = threading.Event()
_wake = threading.Event()
_lock = threading.Lock()
_thread: threading.Thread | None = None


def register(kind: str, run: Handler, failed: Failed | None = None) -> None:
    HANDLERS[kind] = Kind(run=run, failed=failed)


def enqueue(db: Session | Connection, kind: str, ref: str, delay: timedelta = timedelta(0),
            account: int | None = None) -> bool:
    """``ref`` into the queue for ``kind`` (in the caller's transaction), unless it is there already or ``account``
    has ``MAX_WAITING`` jobs waiting (``False``: a refill puts it in later). The caller wakes the worker once the
    transaction is committed (``kick``): before, the worker would not see the job."""
    exists = db.execute(select(WorkJob.id).where(WorkJob.kind == kind, WorkJob.ref == ref)).first()
    if exists is not None:
        return True
    if account is not None:
        waiting = db.execute(select(func.count()).select_from(WorkJob)
                             .where(WorkJob.account_id == account)).scalar() or 0
        if waiting >= MAX_WAITING:
            return False
    now = utcnow()
    values = {"kind": kind, "ref": ref, "state": QUEUED, "run_after": now + delay, "attempts": 0, "created_at": now,
              "updated_at": now, "account_id": account}
    db.execute(WorkJob.__table__.insert().values(**values))
    return True


def cancel(db: Session, kind: str, ref: str) -> None:
    """The job goes (the work became unnecessary). A turn already running finishes; its handler must look whether
    there is still something to do."""
    db.execute(delete(WorkJob).where(WorkJob.kind == kind, WorkJob.ref == ref))


def pending(db: Session, kind: str, ref: str) -> bool:
    return db.execute(select(WorkJob.id).where(WorkJob.kind == kind, WorkJob.ref == ref)).first() is not None


def _claim() -> tuple[int, str, str, int] | None:
    """The next job whose time has come, marked as running: of the accounts with such a job the one served longest
    ago, and of its jobs the one that waited longest."""
    global _turns
    from ..db import SessionLocal

    with _lock, SessionLocal() as db:
        due = (WorkJob.state == QUEUED, WorkJob.run_after <= utcnow(), WorkJob.kind.in_(list(HANDLERS)))
        accounts = list(db.scalars(select(WorkJob.account_id).where(*due).distinct()))
        if not accounts:
            return None
        account = min(accounts, key=lambda one: _served.get(one, -1))
        whose = WorkJob.account_id.is_(None) if account is None else WorkJob.account_id == account
        job = db.scalars(select(WorkJob).where(*due, whose).order_by(WorkJob.run_after, WorkJob.id).limit(1)).first()
        if job is None:
            return None
        _turns += 1
        _served[account] = _turns
        job.state = RUNNING
        job.updated_at = utcnow()
        db.commit()
        return job.id, job.kind, job.ref, job.attempts


def _refill() -> int:
    """Work refused for a full account, into the queue as far as there is room."""
    put = 0
    for hook in REFILL_HOOKS:
        try:
            put += hook()
        except Exception:
            logger.exception("Refilling the work queue failed")
    return put


def _settle(job_id: int, *, again: Again | None = None, fail: bool = False) -> None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        job = db.get(WorkJob, job_id)
        if job is None:
            return
        now = utcnow()
        if again is None and not fail:
            db.delete(job)
        elif fail:
            job.attempts += 1
            job.state = QUEUED
            job.run_after = now + BACKOFF[min(job.attempts, len(BACKOFF)) - 1]
            job.updated_at = now
        else:
            job.state = QUEUED
            job.run_after = now + again.delay
            job.updated_at = now
        db.commit()


def _give_up(job_id: int, kind: str, ref: str, reason: str) -> None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        db.execute(delete(WorkJob).where(WorkJob.id == job_id))
        db.commit()
    handler = HANDLERS.get(kind)
    if handler is not None and handler.failed is not None:
        try:
            handler.failed(ref, reason)
        except Exception:
            logger.exception("Giving up a job failed kind=%s", kind)


def run_one() -> bool:
    """One turn of the job that waited longest. Returns whether there was one."""
    claimed = _claim()
    if claimed is None and _refill():
        claimed = _claim()
    if claimed is None:
        return False
    job_id, kind, ref, attempts = claimed
    try:
        result = HANDLERS[kind].run(ref)
    except Interrupted:
        with _lock:
            _requeue(job_id)
        return True
    except Permanent as exc:
        logger.warning("A job cannot be done kind=%s reason=%s", kind, exc)
        _give_up(job_id, kind, ref, str(exc) or "failed")
        return True
    except Exception as exc:
        if attempts + 1 >= ATTEMPTS:
            logger.warning("A job failed for good kind=%s", kind, exc_info=exc)
            _give_up(job_id, kind, ref, "failed")
        else:
            logger.warning("A job failed and comes again kind=%s attempt=%s", kind, attempts + 1, exc_info=exc)
            _settle(job_id, fail=True)
        return True
    _settle(job_id, again=result if isinstance(result, Again) else None)
    return True


def _requeue(job_id: int) -> None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        db.execute(update(WorkJob).where(WorkJob.id == job_id).values(state=QUEUED, updated_at=utcnow()))
        db.commit()


def run_pending(limit: int | None = None) -> int:
    """Turns of the jobs whose time has come, here, one after the other, until none is left (or ``limit`` turns).
    For the tests; the worker thread does the same."""
    done = 0
    while (limit is None or done < limit) and run_one():
        done += 1
    return done


def recover() -> int:
    """At the start: jobs that ran when the server stopped wait for their turn again (EC-4)."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        count = db.execute(update(WorkJob).where(WorkJob.state == RUNNING)
                           .values(state=QUEUED, updated_at=utcnow())).rowcount
        db.commit()
    if count:
        logger.info("Jobs broken off by a restart are queued again count=%s", count)
    return int(count or 0)


# --- The worker thread ------------------------------------------------------------------------------------------------


def kick() -> None:
    """Wakes the worker (a job came in), and starts it when it does not run yet."""
    _wake.set()
    if AUTO and not stopping.is_set():
        start()


def start() -> None:
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        stopping.clear()
        _thread = threading.Thread(target=_work, name="nexnotes-work", daemon=True)
        _thread.start()


def _work() -> None:
    while not stopping.is_set():
        _wake.clear()
        try:
            busy = run_one()
        except IntegrityError:
            busy = False
        except Exception:
            logger.exception("The work queue failed")
            busy = False
        if not busy:
            _wake.wait(POLL_SECONDS)


def stop(timeout: float = 10.0) -> None:
    """The server goes down: the running turn is told to stop, the thread ends."""
    global _thread
    stopping.set()
    _wake.set()
    thread = _thread
    if thread is not None:
        thread.join(timeout)
    _thread = None
