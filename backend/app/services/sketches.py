"""Sketches and recordings from the iOS app (NOTES-18): what the server takes, and how they reach search and export.

The app draws and records; the browser only shows and plays. Both arrive as attachments of NOTES-10, uploaded with a
role (``POST /api/attachments?...&as=<role>``) that says what the device means them to be. The role never makes a
file into something its content is not:

* ``drawing``: the picture of a sketch, a PNG the app draws of it. It must be a picture (``media.prepare_here``) and
  is drawn anew like any picture, with its view and preview; its kind is ``drawing`` (gallery, lists, export as a
  picture).
* ``drawing-data``: the sketch itself (PencilKit's data), only for the app to draw on. Nothing is read of it; it is
  only ever downloaded, and neither the gallery, the search nor the export know it (kind ``drawingdata``).
* ``recording``: sound, recognised from its first bytes (M4A/AAC, MP3, WAV, OGG, FLAC, WebM, CAF). Its length comes
  from ffprobe; an MP4/M4A gets its index to the front without being encoded again (playing and jumping to the end
  of two hours start at once, EC-2) and loses its metadata (place, device).
* ``transcript``: the words of a recording with their times, "nexnotes-transcript 1" (``clean_transcript``),
  checked and written anew with only the fields the format has.

The note's document names them by id (``drawing``: ``id``, ``data``; ``recording``: ``id``, ``transcript``;
``notedoc/schema.py``), so rights, history, cleanup and storage are those of every attachment. All of it is read
in a worker with limits of memory and time (``media.prepare``, ``media_worker``).

The words of a transcript are found by the search (``search.register_text_source``: a hit names the recording) and go
into an export as a text file beside the sound (``export.ATTACHMENT_SOURCES``).
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import shutil
import struct
import subprocess
import threading
import unicodedata
from collections import OrderedDict
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Note, NoteUpdate
from ..models_attachments import Attachment
from ..notedoc import doc as notedoc
from ..notedoc import schema as s
from . import media

logger = logging.getLogger("nexnotes.attachments")

DRAWING = "drawing"
DRAWING_DATA = "drawingdata"
RECORDING = "recording"
TRANSCRIPT = "transcript"
#: The roles an upload may name (``as=``) and the kind each gives.
ROLES = {"drawing": DRAWING, "drawing-data": DRAWING_DATA, "recording": RECORDING, "transcript": TRANSCRIPT}
#: Kinds that only stand behind another block: never in the gallery.
HELPER_KINDS = (DRAWING_DATA, TRANSCRIPT)

#: The transcript format.
TRANSCRIPT_FORMAT = 1
#: Limits of a transcript.
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_WORDS = 200_000
MAX_WORD = 200
MAX_TEXT = 2_000_000
#: Seconds ffprobe and ffmpeg may take for one recording (a copy without encoding is fast even for hours).
SOUND_SECONDS = 120


class WrongKind(Exception):
    """The content is not what the role says."""


# --- Sound --------------------------------------------------------------------------------------------------------

#: ISO media brands of sound only.
_SOUND_BRANDS = {b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B "}


def _brands(head: bytes) -> set[bytes]:
    if len(head) < 12 or head[4:8] != b"ftyp":
        return set()
    size = struct.unpack(">I", head[:4])[0]
    return {head[8:12]} | {head[at: at + 4] for at in range(16, min(size, len(head)) - 3, 4)}


def sound_of(head: bytes) -> tuple[str, str] | None:
    """The format of a sound file and its type, from its first bytes; ``None`` for anything else. An ISO media or
    WebM file is sound only when it carries no picture, which ``_has_video`` asks ffprobe."""
    if _brands(head) & _SOUND_BRANDS:
        return "m4a", "audio/mp4"
    if _brands(head):
        return "mp4", "audio/mp4"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav", "audio/wav"
    if head[:4] == b"OggS":
        return "ogg", "audio/ogg"
    if head[:4] == b"fLaC":
        return "flac", "audio/flac"
    if head[:4] == b"caff":
        return "caf", "audio/x-caf"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm", "audio/webm"
    if head[:3] == b"ID3":
        return "mp3", "audio/mpeg"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xF6 == 0xF0:
        return "aac", "audio/aac"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        return "mp3", "audio/mpeg"
    return None


def _probe(path: Path) -> dict[str, Any] | None:
    probe = shutil.which("ffprobe")
    if probe is None:
        return None
    answer = subprocess.run([probe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--",
                             str(path)], capture_output=True, timeout=SOUND_SECONDS, check=False)
    try:
        return json.loads(answer.stdout or b"{}")
    except ValueError:
        return {}


def _faststart(path: Path) -> Path | None:
    """An MP4/M4A with its index at the front, the sound copied as it is, without metadata, written beside ``path``
    (a work file of the upload, never read into memory: a recording may be hours); ``None`` when ffmpeg is missing or
    fails (the file stays as it came)."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None
    target = path.with_name(path.name + ".m4a")
    subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "2", "-i", str(path), "-map", "0:a", "-c",
                    "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4",
                    str(target)], capture_output=True, timeout=SOUND_SECONDS, check=False)
    if not target.is_file() or target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        return None
    return target


def _sound(path: Path) -> media.Prepared:
    with open(path, "rb") as handle:
        head = handle.read(4096)
    found = sound_of(head)
    if found is None:
        raise WrongKind("not sound")
    form, mime = found
    info = _probe(path)
    if info is not None:
        streams = info.get("streams") or []
        if not any(stream.get("codec_type") == "audio" for stream in streams):
            raise WrongKind("no sound in it")
        if any(stream.get("codec_type") == "video" and not (stream.get("disposition") or {}).get("attached_pic")
               for stream in streams):
            raise WrongKind("a film, not a recording")
    elif form in ("mp4", "webm"):
        # Without ffprobe nobody can tell a film from a recording: only the plain sound brands are taken.
        raise WrongKind("cannot tell sound from film")
    prepared = media.Prepared(kind=RECORDING, mime=mime, inline=True)
    if info is not None:
        try:
            seconds = float((info.get("format") or {}).get("duration") or 0)
            prepared.duration_ms = round(seconds * 1000) if math.isfinite(seconds) and seconds > 0 else None
        except ValueError:
            prepared.duration_ms = None
    if form in ("m4a", "mp4"):
        written = _faststart(path)
        prepared.redrawn_file = str(written) if written is not None else None
        prepared.mime = "audio/mp4"
    return prepared


# --- Transcripts ----------------------------------------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def _ms(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    found = round(value)
    return found if 0 <= found <= s.MAX_DURATION else None


def _text(value: Any, limit: int, *, lines: bool) -> str:
    if not isinstance(value, str):
        return ""
    text = _CONTROL.sub("", unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n"))
    if not lines:
        text = " ".join(text.split())
    return text[:limit].strip()


def clean_transcript(data: bytes) -> dict[str, Any]:
    """A transcript as the server keeps it: ``format``, ``language``, ``text`` (as it is to be read, possibly corrected
    by hand) and ``words`` (as recognised, each with ``start`` and ``end`` in milliseconds, sorted by ``start``).
    Raises ``WrongKind`` for anything that is no transcript."""
    if len(data) > MAX_TRANSCRIPT_BYTES:
        raise WrongKind("transcript too large")
    try:
        given = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        # Nested too deep for the parser is no transcript either (422, not a 500).
        raise WrongKind("no JSON") from exc
    if not isinstance(given, dict) or given.get("format") != TRANSCRIPT_FORMAT or not isinstance(given.get("words"),
                                                                                                    list):
        raise WrongKind("no transcript")
    if len(given["words"]) > MAX_WORDS:
        raise WrongKind("too many words")
    words: list[dict[str, Any]] = []
    for word in given["words"]:
        if not isinstance(word, dict):
            continue
        text = _text(word.get("text"), MAX_WORD, lines=False)
        start = _ms(word.get("start"))
        if not text or start is None:
            continue
        end = _ms(word.get("end"))
        words.append({"text": text, "start": start, "end": max(start, end if end is not None else start)})
    words.sort(key=lambda word: word["start"])
    language = given.get("language")
    out: dict[str, Any] = {"format": TRANSCRIPT_FORMAT,
                           "language": language if isinstance(language, str) and re.fullmatch(
                               r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}", language) else None,
                           "text": _text(given.get("text"), MAX_TEXT, lines=True) or None,
                           "words": words}
    return out


def transcript_text(transcript: dict[str, Any]) -> str:
    """The words of a transcript as they are read: its text, or its words with blanks between."""
    return transcript.get("text") or " ".join(word["text"] for word in transcript.get("words") or [])


def _transcript(path: Path) -> media.Prepared:
    clean = clean_transcript(path.read_bytes())
    data = json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode()
    return media.Prepared(kind=TRANSCRIPT, mime="application/json", inline=False, redrawn=data)


# --- Preparing by role --------------------------------------------------------------------------------------------


def prepare(path: Path, role: str) -> media.Prepared:
    """What the server makes of a file uploaded with ``role``; ``WrongKind`` when its content is not that."""
    kind = ROLES.get(role)
    if kind is None:
        raise WrongKind("unknown role")
    if kind == DRAWING:
        prepared = media.prepare_here(path)
        if prepared.kind != media.IMAGE:
            raise WrongKind("a sketch is a picture")
        prepared.kind = DRAWING
        return prepared
    if kind == DRAWING_DATA:
        return media.Prepared(kind=DRAWING_DATA)
    try:
        return _sound(path) if kind == RECORDING else _transcript(path)
    except (OSError, subprocess.SubprocessError) as exc:
        raise WrongKind(type(exc).__name__) from exc


# --- Reading what a note names ------------------------------------------------------------------------------------

#: Transcripts never change under their id: their text is kept here, for the index written again and again while
#: somebody types in the note.
_texts: OrderedDict[str, str] = OrderedDict()
_texts_lock = threading.Lock()
_TEXTS_KEPT = 64


def text_of(attachment_id: str) -> str:
    """The words of the transcript ``attachment_id`` (empty when it cannot be read)."""
    with _texts_lock:
        if attachment_id in _texts:
            _texts.move_to_end(attachment_id)
            return _texts[attachment_id]
    from . import attachments

    try:
        found = transcript_text(json.loads(attachments.path_of(attachment_id).read_bytes()))
    except (OSError, ValueError, AttributeError, TypeError):
        return ""
    with _texts_lock:
        _texts[attachment_id] = found
        while len(_texts) > _TEXTS_KEPT:
            _texts.popitem(last=False)
    return found


def _recordings_of(db: Session, note: Note) -> list[dict[str, Any]]:
    """The attributes of the recordings the note names today, in the order of its text. A note whose stored bytes
    hold no recording is not read."""
    if note.id is None:
        return []
    updates = list(db.scalars(select(NoteUpdate.update).where(NoteUpdate.note_id == note.id).order_by(NoteUpdate.id)))
    name = s.RECORDING.encode()
    if not any(name in part for part in (note.ydoc or b"", *updates)):
        return []
    try:
        document = notedoc.clean_doc(notedoc.to_json(notedoc.load(note.ydoc or None, updates)))
    except Exception:  # noqa: BLE001 - a document that cannot be read has no recordings to tell of
        logger.warning("Reading the recordings of a note failed note=%s", note.id)
        return []
    found: list[dict[str, Any]] = []
    stack = list(reversed(document.get("content") or []))
    while stack:
        node = stack.pop()
        if node.get("type") == s.RECORDING:
            found.append(node["attrs"])
            continue
        stack.extend(reversed(node.get("content") or []))
    return found


def _transcripts_of(db: Session, note: Note) -> list[tuple[dict[str, Any], Attachment, Attachment | None]]:
    """Each recording of the note with its sound and its transcript (attachments of the note's owner only)."""
    recordings = [attrs for attrs in _recordings_of(db, note) if attrs.get("transcript")]
    if not recordings:
        return []
    ids = {attrs["transcript"] for attrs in recordings} | {attrs["id"] for attrs in recordings}
    rows = {row.id: row for row in db.scalars(select(Attachment).where(Attachment.id.in_(ids),
                                                                       Attachment.owner_id == note.owner_id))}
    out = []
    for attrs in recordings:
        transcript = rows.get(attrs["transcript"])
        if transcript is not None and transcript.kind == TRANSCRIPT:
            out.append((attrs, transcript, rows.get(attrs["id"])))
    return out


def search_parts(db: Session, note: Note) -> list[Any]:
    """The words of the note's recordings for the search (``search.register_text_source``): a hit there names the
    recording."""
    from .search import TextPart

    parts = []
    for attrs, transcript, sound in _transcripts_of(db, note):
        text = text_of(transcript.id)
        if text:
            parts.append(TextPart(text=text, kind=RECORDING, name=(sound.name if sound else attrs.get("name")) or "",
                                  ref=attrs["id"]))
    return parts


def _stem(name: str) -> str:
    return re.sub(r"\.[A-Za-z0-9]{1,8}$", "", name or "").strip() or "recording"


def export_files(db: Session, note: Note) -> list[Any]:
    """The transcripts of the note's recordings as text files for the export (``export.ATTACHMENT_SOURCES``), named
    like their sound; the sound and the sketches come with the attachments of NOTES-10."""
    from .export import ExportFile

    found = []
    for attrs, transcript, sound in _transcripts_of(db, note):
        data = text_of(transcript.id).encode()
        if not data:
            continue
        name = _stem(sound.name if sound else attrs.get("name") or "") + ".txt"
        found.append(ExportFile(id=transcript.id, name=name, kind="file", size=len(data),
                                open=(lambda payload=data: io.BytesIO(payload))))
    return found


def _stored(row: Attachment) -> None:
    """After an upload: a transcript makes the search read its note again (the block may stand there already)."""
    if row.kind != TRANSCRIPT:
        return
    from . import search

    try:
        search.reindex(row.note_id)
    except Exception:  # noqa: BLE001 - the next write of the note indexes it anyway
        logger.warning("Indexing a note after its transcript failed note=%s", row.note_id)


def register() -> None:
    """Once per start, each hook once: the search, the export, the hook after an upload."""
    from . import attachments, export, search

    search.register_text_source(search_parts)
    if export_files not in export.ATTACHMENT_SOURCES:
        export.ATTACHMENT_SOURCES.append(export_files)
    if _stored not in attachments.STORED_HOOKS:
        attachments.STORED_HOOKS.append(_stored)


__all__ = ["DRAWING", "DRAWING_DATA", "HELPER_KINDS", "RECORDING", "ROLES", "TRANSCRIPT", "WrongKind",
           "clean_transcript", "export_files", "prepare", "register", "search_parts", "sound_of", "text_of",
           "transcript_text"]
