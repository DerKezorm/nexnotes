"""Text recognition in pictures, scans and PDFs (NOTES-11).

**What is read**: every attachment of the kinds ``image``, ``scan`` and ``pdf`` (``KINDS``); videos, other files, the
pictures of link cards and sketches are not. An attachment comes into the work queue (``services/workqueue.py``, kind
``ocr``) in the transaction that writes its row (an event on ``Attachment``), so a restart never forgets one; at the
start those without a state yet (attached before NOTES-11) are added, and those that met a server without Tesseract
once it is there.

**How**: in turns of at most ``PAGES_PER_TURN`` pages, each in a process of its own (``app/ocr_worker.py``, the way of
nexpaper: own home folder, one thread, lower priority, time and memory limit). A PDF page with text of its own is read
as it is (AC-2), every other page drawn and read by Tesseract with the languages the operator chose at that moment
(``ocr_languages``, AC-6); a new language counts only for what is read after (EC-5). After each turn the job goes to the
back of the line (EC-6), the pages read so far are stored and the notes naming the attachment indexed again (AC-1,
NOTES-9 EC-3). Words Tesseract is not sure of are dropped, and a page with too little left is a page without text
(EC-3). The language of a page is told from its commonest words (``language_of``).

**Not read**: an attachment whose note is locked (``tags.HIDDEN_NOTES``, NOTES-16; EC-7). **Brought along**: the iOS app
recognises scans itself and sends the text (``take_device_text``, AC-5); uploaded with ``text=device`` the server waits
``DEVICE_WAIT`` for it before reading the file itself.

**For the search**: ``texts_of`` is a text source (``search.register_text_source``): the done pages of the attachments a
note names today, with the attachment's name, kind, page and id.

``ENGINE`` runs one request (the worker's protocol); the tests put a stand-in there.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, event, or_, select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session, object_session

from ..config import get_settings
from ..models import Note, utcnow
from ..models_attachments import Attachment, AttachmentRef
from ..models_ocr import (
    OCR_DEVICE,
    OCR_DONE,
    OCR_FAILED,
    OCR_LOCKED,
    OCR_QUEUED,
    OCR_UNAVAILABLE,
    OCR_WORKING,
    PAGE_DONE,
    PAGE_EMPTY,
    PAGE_FAILED,
    PAGE_PENDING,
    AttachmentOcr,
    AttachmentText,
)
from . import settings_service, workqueue

logger = logging.getLogger("nexnotes.ocr")

#: The kind of work in the queue.
JOB = "ocr"
#: Kinds of attachments whose text is read.
KINDS = ("image", "scan", "pdf")
#: Pages read in one turn before the job goes to the back of the line (EC-6).
PAGES_PER_TURN = 4
#: Pages of a PDF read at most; the rest of a longer one stays without text.
MAX_PAGES = 1000
#: Seconds Tesseract may take for one page; a page that takes longer stays without text.
PAGE_SECONDS = 120
#: The worker's hard memory limit in MB, Tesseract included (a job object under Windows, ``RLIMIT_AS`` elsewhere).
MEMORY_MB = 1536
#: How long the large view waits for the one worker before it says the server is busy.
RENDER_WAIT_SECONDS = 60
#: How long the server waits for the text of an upload from the iOS app before it reads the file itself.
DEVICE_WAIT = timedelta(minutes=10)
#: Characters of text kept per page and per attachment.
MAX_PAGE_CHARS = 100_000
MAX_CHARS = 2_000_000
#: The operator's languages (``settings_service.OCR_LANGUAGES``) as Tesseract names its language packs.
TESSERACT = {"de": "deu", "en": "eng", "fr": "fra", "es": "spa", "it": "ita", "nl": "nld", "pt": "por", "pl": "pol",
             "tr": "tur"}
WORKER = Path(__file__).resolve().parent.parent / "ocr_worker.py"
#: What a worker gets of the server's environment: enough to start and to find Tesseract, nothing more.
KEEP_ENVIRONMENT = ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
                    "TESSDATA_PREFIX", "LD_LIBRARY_PATH")


# --- Hints of an upload -------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Hints:
    """What the iOS app says of an upload: it brings the text itself (``device``), the picture is a scan (``scan``)."""

    device: bool = False
    scan: bool = False


#: Set by the upload route around storing a file; read by the events on ``Attachment``.
HINTS: contextvars.ContextVar[Hints | None] = contextvars.ContextVar("nexnotes_ocr_hints", default=None)


@event.listens_for(Attachment, "before_insert")
def _before_insert(_mapper: Any, _connection: Connection, target: Attachment) -> None:
    hints = HINTS.get()
    if hints is not None and hints.scan and target.kind == "image":
        target.kind = "scan"


@event.listens_for(Attachment, "after_insert")
def _after_insert(_mapper: Any, connection: Connection, target: Attachment) -> None:
    """A new picture, scan or PDF goes into the queue in the transaction of its row."""
    if target.kind not in KINDS:
        return
    hints = HINTS.get()
    device = hints is not None and hints.device
    now = utcnow()
    connection.execute(AttachmentOcr.__table__.insert().values(
        attachment_id=target.id, state=OCR_DEVICE if device else OCR_QUEUED, pages=0, languages="", source="",
        error="", updated_at=now))
    workqueue.enqueue(connection, JOB, target.id, DEVICE_WAIT if device else timedelta(0))
    session = object_session(target)
    if session is not None:
        event.listen(session, "after_commit", lambda _session: workqueue.kick(), once=True)


# --- The engine ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class EngineInfo:
    available: bool
    #: The operator's codes of the language packs that are there.
    languages: tuple[str, ...]


_info: EngineInfo | None = None
_info_lock = threading.Lock()


def tesseract() -> str | None:
    return shutil.which("tesseract")


def engine_info(*, again: bool = False) -> EngineInfo:
    """Whether Tesseract is there and with which of the languages the settings offer; asked once."""
    global _info
    with _info_lock:
        if _info is not None and not again:
            return _info
        binary = tesseract()
        languages: tuple[str, ...] = ()
        if binary:
            try:
                done = subprocess.run([binary, "--list-langs"], capture_output=True, timeout=20, check=False)
                packs = set(done.stdout.decode("utf-8", "replace").split())
                languages = tuple(code for code, pack in TESSERACT.items() if pack in packs)
            except (OSError, subprocess.SubprocessError):
                binary = None
        _info = EngineInfo(available=bool(binary), languages=languages)
        return _info


def forget() -> None:
    global _info
    with _info_lock:
        _info = None


class EngineFailed(Exception):
    def __init__(self, code: str, retry: bool) -> None:
        super().__init__(code)
        self.code = code
        self.retry = retry


def worker_environment(folder: str) -> dict[str, str]:
    """A worker's environment: what it needs, and its own folder as its home (a container under an id without an entry
    in ``/etc/passwd``, as on TrueNAS, still has one; nexpaper issue 5). The server's own home is never handed on."""
    environment = {key: os.environ[key] for key in KEEP_ENVIRONMENT if key in os.environ}
    environment["HOME"] = folder
    if os.name == "nt":
        environment["USERPROFILE"] = folder
    return environment


def _kill(process: subprocess.Popen[bytes]) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, check=False,
                           timeout=15)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.communicate(timeout=10)
    except (subprocess.TimeoutExpired, ValueError, OSError):
        logger.error("A recognition process did not end after it was killed")


#: One worker process at a time in the whole server, for reading and for drawing pages alike.
_one_at_a_time = threading.Lock()


def spawn(request: dict[str, Any], timeout: float, wait: float | None = None) -> dict[str, Any]:
    """One request in a worker process: at most ``timeout`` seconds of wall time and as many of CPU, under a hard
    memory limit, in an empty folder of its own, and never two at once (``wait``: how long to wait for the other one,
    ``None`` for as long as it takes). Returns its answer (with ``results`` read from its text file); ``EngineFailed``
    otherwise."""
    if workqueue.stopping.is_set():
        raise workqueue.Interrupted
    if not _one_at_a_time.acquire(timeout=-1 if wait is None else wait):
        raise EngineFailed("busy", retry=True)
    try:
        return _spawn(request, timeout)
    finally:
        _one_at_a_time.release()


def _spawn(request: dict[str, Any], timeout: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="nexnotes-ocr-", ignore_cleanup_errors=True) as folder:
        out = Path(folder) / "text.json"
        payload: bytes | None = json.dumps({**request, "text_out": str(out), "memory_mb": MEMORY_MB,
                                            "cpu_seconds": int(timeout)}).encode()
        options: dict[str, Any] = {"start_new_session": True} if os.name != "nt" else {}
        process = subprocess.Popen([sys.executable, "-I", str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=worker_environment(folder), cwd=folder, **options)
        deadline = time.monotonic() + timeout
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    _kill(process)
                    raise EngineFailed("timeout", retry=True)
                try:
                    stdout, stderr = process.communicate(payload, timeout=min(1.0, left))
                    break
                except subprocess.TimeoutExpired:
                    payload = None
                    if workqueue.stopping.is_set():
                        _kill(process)
                        raise workqueue.Interrupted from None
        except BaseException:
            if process.poll() is None:
                _kill(process)
            raise
        lines = [line for line in stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        try:
            answer = json.loads(lines[-1]) if lines else None
        except ValueError:
            answer = None
        if process.returncode != 0 or not isinstance(answer, dict):
            tail = stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
            logger.warning("The recognition process ended without an answer code=%s note=%s", process.returncode,
                           tail[0][:120])
            raise EngineFailed("failed", retry=True)
        if not answer.get("ok"):
            raise EngineFailed(str(answer.get("error") or "failed"), retry=bool(answer.get("retry")))
        if out.is_file():
            answer["results"] = json.loads(out.read_text(encoding="utf-8"))
        else:
            answer.setdefault("results", [])
        return answer


def _run_worker(request: dict[str, Any]) -> dict[str, Any]:
    pages = len(request.get("pages") or []) or int(request.get("first") or 1)
    return spawn(request, timeout=pages * (PAGE_SECONDS + 15) + 30)


#: Runs one request of the worker's protocol (``op`` ``recognize`` or ``render``) and returns its answer.
ENGINE: Callable[[dict[str, Any]], dict[str, Any]] = _run_worker


# --- Languages ----------------------------------------------------------------------------------------------------

#: Common short words of each language: what tells the language of a page.
def _common(words: str) -> frozenset[str]:
    return frozenset(words.split())


WORDS: dict[str, frozenset[str]] = {
    "de": _common("der die das und ist nicht mit von zu den des im für auf ein eine einer dem sich auch es bei wir "
                  "sie ich bitte vom zum zur über ihre ihr wird werden nach"),
    "en": _common("the and of to is in for that with on this you are be your from at by not or have it as was we "
                  "our will please"),
    "fr": _common("le la les et des du un une est pour que dans pas sur au aux ce qui avec nous vous votre merci "
                  "sont été"),
    "es": _common("el los las y del que es por para con una un su no se al lo como gracias usted sus está"),
    "it": _common("il lo gli e di del della che per con una un non è sono al alla grazie si nel dei"),
    "nl": _common("het een en van is dat niet op te met voor zijn aan bij ook wij u uw er naar wordt"),
    "pt": _common("o os e do da que em para com um uma não é por no na dos das obrigado você"),
    "pl": _common("i w z na nie to się jest do że od za po jak dla tak ale przez są"),
    "tr": _common("ve bir bu da için ile çok ne mi değil olarak gibi daha ama veya sayın tarafından"),
}
_WORD = re.compile(r"[^\W\d_]+")


def language_of(text: str, chosen: Iterable[str]) -> str:
    """The language of ``text`` among ``chosen`` (the operator's): the one whose common words it holds most of, at
    least two; empty when it cannot be told. On a tie the earlier of ``chosen``."""
    words = [word.casefold() for word in _WORD.findall(text[:20000])]
    best, score = "", 1
    for code in chosen:
        common = WORDS.get(code)
        if not common:
            continue
        count = sum(1 for word in words if word in common)
        if count > score:
            best, score = code, count
    return best


def chosen_languages(db: Session) -> list[str]:
    """The operator's languages (AC-6), in the order of the settings; German and English when none."""
    raw = settings_service.get(db, "ocr_languages")
    found = [code for code in settings_service.OCR_LANGUAGES if isinstance(raw, list) and code in raw]
    return found or ["de", "en"]


# --- One turn -----------------------------------------------------------------------------------------------------


def note_locked(db: Session, note_id: str) -> bool:
    from . import tags

    if not tags.HIDDEN_NOTES:
        return False
    return db.scalar(select(Note.id).where(Note.id == note_id, or_(*(hidden() for hidden in tags.HIDDEN_NOTES)))) \
        is not None


def notes_naming(db: Session, attachment: Attachment) -> list[str]:
    """The notes whose search the attachment's text belongs to: its own and those of the same owner that name it."""
    named = set(db.scalars(select(AttachmentRef.note_id).join(Note, Note.id == AttachmentRef.note_id)
                           .where(AttachmentRef.attachment_id == attachment.id,
                                  Note.owner_id == attachment.owner_id)))
    return sorted(named | {attachment.note_id})


def _reindex(note_ids: Iterable[str]) -> None:
    from . import search

    for note_id in note_ids:
        try:
            search.reindex(note_id)
        except Exception:
            logger.exception("Indexing the recognised text failed note=%s", note_id)


def _state(db: Session, attachment_id: str) -> AttachmentOcr:
    row = db.get(AttachmentOcr, attachment_id)
    if row is None:
        row = AttachmentOcr(attachment_id=attachment_id, state=OCR_QUEUED, updated_at=utcnow())
        db.add(row)
    return row


def _pending_pages(db: Session, attachment_id: str) -> list[int]:
    return list(db.scalars(select(AttachmentText.page).where(AttachmentText.attachment_id == attachment_id,
                                                             AttachmentText.state == PAGE_PENDING)
                           .order_by(AttachmentText.page)))


def _finish(db: Session, row: AttachmentOcr) -> None:
    """The recognition of an attachment is over: done when a page was read, failed when every page failed."""
    states = list(db.scalars(select(AttachmentText.state).where(AttachmentText.attachment_id == row.attachment_id)))
    row.state = OCR_FAILED if states and all(state == PAGE_FAILED for state in states) else OCR_DONE
    row.updated_at = utcnow()


def turn(attachment_id: str) -> workqueue.Again | None:
    """One turn of the recognition of an attachment: a few pages read and stored. ``Again`` while pages are left."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        attachment = db.get(Attachment, attachment_id)
        if attachment is None or attachment.kind not in KINDS:
            return None
        row = _state(db, attachment_id)
        if row.state in (OCR_DONE, OCR_FAILED) or (row.state == OCR_DEVICE and row.source == "device"):
            db.commit()
            return None
        if note_locked(db, attachment.note_id):
            # EC-7: a locked note's attachments are not read; what was read before goes.
            db.execute(delete(AttachmentText).where(AttachmentText.attachment_id == attachment_id))
            row.state, row.updated_at = OCR_LOCKED, utcnow()
            db.commit()
            return None
        chosen = chosen_languages(db)
        info = engine_info()
        packs = [TESSERACT[code] for code in chosen if not info.languages or code in info.languages] or \
            [TESSERACT[code] for code in chosen]
        first_turn = row.pages == 0
        pages = None if first_turn else _pending_pages(db, attachment_id)[:PAGES_PER_TURN]
        if pages == []:
            _finish(db, row)
            db.commit()
            return None
        row.state, row.languages, row.updated_at = OCR_WORKING, "+".join(packs), utcnow()
        kind, path = attachment.kind, _path_of(attachment_id)
        db.commit()
    request = {"op": "recognize", "path": str(path), "kind": "pdf" if kind == "pdf" else "image", "pages": pages,
               "first": PAGES_PER_TURN, "languages": packs, "page_seconds": PAGE_SECONDS, "tesseract": tesseract()}
    try:
        answer = ENGINE(request)
    except EngineFailed as exc:
        if exc.retry:
            raise RuntimeError(exc.code) from exc
        raise workqueue.Permanent(exc.code) from exc
    with SessionLocal() as db:
        attachment = db.get(Attachment, attachment_id)
        row = db.get(AttachmentOcr, attachment_id)
        if attachment is None or row is None or row.source == "device":
            # Gone meanwhile, or the app's text came while the pages were read: that text counts.
            return None
        if first_turn:
            total = min(int(answer.get("pages") or 1), MAX_PAGES)
            row.pages = total
            known = set(db.scalars(select(AttachmentText.page).where(AttachmentText.attachment_id == attachment_id)))
            db.add_all(AttachmentText(attachment_id=attachment_id, page=number, state=PAGE_PENDING, updated_at=utcnow())
                       for number in range(1, total + 1) if number not in known)
            db.flush()
        stored = _store(db, attachment_id, answer.get("results") or [], chosen)
        db.flush()
        if answer.get("unavailable"):
            row.state, row.updated_at = OCR_UNAVAILABLE, utcnow()
            left = []
        else:
            left = _pending_pages(db, attachment_id)
            if not left:
                _finish(db, row)
        if stored:
            sources = set(db.scalars(select(AttachmentText.source).where(
                AttachmentText.attachment_id == attachment_id, AttachmentText.source != "")))
            row.source = sources.pop() if len(sources) == 1 else ("mixed" if sources else "")
        db.commit()
        note_ids = notes_naming(db, attachment)
    if stored:
        _reindex(note_ids)
    if left:
        return workqueue.Again()
    if not answer.get("unavailable"):
        logger.info("Text recognised attachment=%s", attachment_id)
    return None


def _path_of(attachment_id: str) -> Path:
    from . import attachments

    return attachments.path_of(attachment_id)


def _store(db: Session, attachment_id: str, results: list[dict[str, Any]], chosen: list[str]) -> int:
    """The pages a turn read, into their rows; returns how many got text."""
    rows = {row.page: row for row in db.scalars(select(AttachmentText)
                                                .where(AttachmentText.attachment_id == attachment_id))}
    total = sum(len(row.text) for row in rows.values())
    with_text = 0
    for result in results:
        try:
            page = int(result.get("page"))
        except (TypeError, ValueError):
            continue
        row = rows.get(page)
        if row is None or row.state != PAGE_PENDING:
            continue
        state = result.get("state")
        if state == "unavailable":
            continue
        text = str(result.get("text") or "")[:MAX_PAGE_CHARS][: max(0, MAX_CHARS - total)]
        if state == "done" and text.strip():
            row.state, row.text = PAGE_DONE, text
            row.language = language_of(text, chosen)
            total += len(text)
            with_text += 1
        elif state == "failed":
            row.state, row.text = PAGE_FAILED, ""
        else:
            row.state, row.text = PAGE_EMPTY, ""
        row.source = str(result.get("source") or "")[:16]
        row.updated_at = utcnow()
    return with_text


def given_up(attachment_id: str, reason: str) -> None:
    """Every try failed, or the file cannot be read (EC-2): the pages left stay without text."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        row = db.get(AttachmentOcr, attachment_id)
        if row is None or row.source == "device":
            return
        for page in db.scalars(select(AttachmentText).where(AttachmentText.attachment_id == attachment_id,
                                                            AttachmentText.state == PAGE_PENDING)):
            page.state, page.updated_at = PAGE_FAILED, utcnow()
        db.flush()
        has_text = db.scalar(select(AttachmentText.page).where(AttachmentText.attachment_id == attachment_id,
                                                               AttachmentText.state == PAGE_DONE).limit(1))
        row.state = OCR_DONE if has_text is not None else OCR_FAILED
        row.error = reason[:32]
        row.updated_at = utcnow()
        db.commit()
    logger.warning("Text recognition gave up attachment=%s reason=%s", attachment_id, reason)


# --- Text from the iOS app (AC-5) -----------------------------------------------------------------------------------


def take_device_text(db: Session, attachment: Attachment, pages: list[tuple[str, str]]) -> None:
    """The text the app recognised itself, page by page (text, language): it replaces everything read so far, and
    nothing is read any more. The caller checked the right to write the note."""
    chosen = chosen_languages(db)
    workqueue.cancel(db, JOB, attachment.id)
    db.execute(delete(AttachmentText).where(AttachmentText.attachment_id == attachment.id))
    row = _state(db, attachment.id)
    total = 0
    for number, (text, language) in enumerate(pages[:MAX_PAGES], start=1):
        value = text.replace("\x00", "").strip()[:MAX_PAGE_CHARS][: max(0, MAX_CHARS - total)]
        total += len(value)
        known = language if language in settings_service.OCR_LANGUAGES else language_of(value, chosen)
        db.add(AttachmentText(attachment_id=attachment.id, page=number, state=PAGE_DONE if value else PAGE_EMPTY,
                              text=value, language=known if value else "", source="device", updated_at=utcnow()))
    row.state, row.pages, row.source, row.error, row.languages = OCR_DONE, min(len(pages), MAX_PAGES), "device", "", ""
    row.updated_at = utcnow()
    db.commit()
    _reindex(notes_naming(db, attachment))


# --- Reading ------------------------------------------------------------------------------------------------------


def text_out(db: Session, attachment: Attachment) -> dict[str, Any]:
    """The state of an attachment's recognition and the text of each page, as the page shows it."""
    if attachment.kind not in KINDS:
        return {"id": attachment.id, "state": "none", "pages": 0, "items": []}
    if note_locked(db, attachment.note_id):
        return {"id": attachment.id, "state": OCR_LOCKED, "pages": attachment.pages or 1, "items": []}
    row = db.get(AttachmentOcr, attachment.id)
    items = [{"page": page.page, "state": page.state, "text": page.text, "language": page.language,
              "source": page.source}
             for page in db.scalars(select(AttachmentText).where(AttachmentText.attachment_id == attachment.id)
                                    .order_by(AttachmentText.page))]
    state = row.state if row is not None else OCR_QUEUED
    pages = (row.pages if row is not None and row.pages else 0) or attachment.pages or 1
    return {"id": attachment.id, "state": state, "pages": pages, "items": items}


def texts_of(db: Session, note: Note) -> list[Any]:
    """The text source of the search (NOTES-9): the read pages of the attachments the note names today."""
    from .search import TextPart

    if note.id is None:
        return []
    rows = db.execute(
        select(Attachment.id, Attachment.name, Attachment.kind, AttachmentText.page, AttachmentText.text)
        .join(AttachmentRef, AttachmentRef.attachment_id == Attachment.id)
        .join(AttachmentText, AttachmentText.attachment_id == Attachment.id)
        .where(AttachmentRef.note_id == note.id, Attachment.owner_id == note.owner_id,
               AttachmentText.state == PAGE_DONE)
        .order_by(AttachmentRef.position, AttachmentText.page)
    ).all()
    return [TextPart(text=text, kind=kind, name=name, page=page if kind == "pdf" else None, ref=attachment_id)
            for attachment_id, name, kind, page, text in rows]


# --- At the start -------------------------------------------------------------------------------------------------


def catch_up() -> int:
    """At the start: attachments without a state (from before NOTES-11) into the queue, those that met no Tesseract
    once it is there, and any whose job went missing. Returns how many were queued."""
    from ..db import SessionLocal

    available = engine_info(again=True).available
    queued = 0
    with SessionLocal() as db:
        known = select(AttachmentOcr.attachment_id)
        for attachment_id in db.scalars(select(Attachment.id).where(Attachment.kind.in_(KINDS),
                                                                    Attachment.id.not_in(known))):
            db.add(AttachmentOcr(attachment_id=attachment_id, state=OCR_QUEUED, updated_at=utcnow()))
            workqueue.enqueue(db, JOB, attachment_id)
            queued += 1
        waiting = [OCR_QUEUED, OCR_WORKING, OCR_DEVICE] + ([OCR_UNAVAILABLE] if available else [])
        for row in db.scalars(select(AttachmentOcr).where(AttachmentOcr.state.in_(waiting))):
            if row.state == OCR_DEVICE and row.source == "device":
                continue
            if not workqueue.pending(db, JOB, row.attachment_id):
                if row.state == OCR_UNAVAILABLE:
                    row.state = OCR_QUEUED
                workqueue.enqueue(db, JOB, row.attachment_id)
                queued += 1
        db.commit()
    if queued:
        logger.info("Attachments queued for text recognition count=%s", queued)
        workqueue.kick()
    if not available:
        logger.warning("Tesseract is not installed: only the text a PDF carries itself is read")
    return queued


def follow_refs(db: Session, note: Note) -> None:
    """A hook on the text after ``attachments.sync_refs``: the search indexed the note before the attachments it names
    were known (a block pasted from another note, a block removed), so a note with recognised text, before or now, is
    indexed once more. Never raises."""
    from . import search

    try:
        if note.id is None:
            return
        indexed = db.execute(search._sql("SELECT i.extra FROM @rows r JOIN @index i ON i.rowid = r.id "
                                         "WHERE r.note_id = :id"), {"id": note.id}).scalar()
        if indexed or texts_of(db, note):
            search.index_note(db, note)
    except Exception:
        logger.exception("Following the recognised text of a note failed note=%s", note.id)


def register() -> None:
    """Once per start: the handler of the queue, the text source of the search, and the hook that follows a note's
    attachments (after ``attachments.register``, whose hook it follows)."""
    from . import attachments, notes, search

    workqueue.register(JOB, turn, given_up)
    search.register_text_source(texts_of)
    attachments.register()
    notes.on_text_written(follow_refs)


def start() -> None:
    """The server starts: the queue's thread runs unless the background is off (and not asked for)."""
    settings = get_settings()
    workqueue.AUTO = settings.work_queue if settings.work_queue is not None else not settings.disable_background
    register()
    workqueue.recover()
    catch_up()
    if workqueue.AUTO:
        workqueue.start()


def render_page(attachment: Attachment, page: int, width: int) -> bytes:
    """A page of a PDF as WebP, drawn by a worker (the large view)."""
    with tempfile.TemporaryDirectory(prefix="nexnotes-page-", ignore_cleanup_errors=True) as folder:
        out = Path(folder) / "page.webp"
        ENGINE_RENDER({"op": "render", "path": str(_path_of(attachment.id)), "page": page, "width": width,
                       "out": str(out)})
        return out.read_bytes()


def _render(request: dict[str, Any]) -> dict[str, Any]:
    return spawn(request, timeout=30, wait=RENDER_WAIT_SECONDS)


#: Draws one page (the worker's ``render``); the tests put a stand-in there.
ENGINE_RENDER: Callable[[dict[str, Any]], dict[str, Any]] = _render
