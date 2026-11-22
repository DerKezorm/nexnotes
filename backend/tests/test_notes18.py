"""NOTES-18 Skizzen und Aufnahmen im Web: the server's part. The iOS app uploads a sketch (its picture and its data)
and a recording (its sound and its transcript) with a role (``as=``), the way NOTES-24 describes; the content must be
what the role says. The browser then shows and plays them; the words of a recording are found by the search and go
into an export beside the sound."""

from __future__ import annotations

import io
import json
import math
import shutil
import struct
import subprocess
import wave
import zipfile
from pathlib import Path

import pytest
from pypdf import PdfReader
from sqlalchemy import select

from app.db import SessionLocal
from app.models_attachments import Attachment
from app.notedoc import doc as notedoc
from app.services import attachments, media_worker, search, sketches

from .conftest import make_account
from .test_notes3 import new_note
from .test_notes10 import (  # noqa: F401  # noqa: F401
    add_blocks,
    close_connections,
    needs_ffmpeg,
    png_with_text,
    refs_of,
    row_of,
    run,
    setup,
    video_of,
)

FFMPEG = shutil.which("ffmpeg")

TRANSCRIPT = {
    "format": 1,
    "language": "de-DE",
    "text": "Der erste Termin wäre die Woche nach dem Jahreswechsel, der zweite Ende Januar.",
    "words": [{"text": word, "start": index * 400, "end": index * 400 + 350}
              for index, word in enumerate(["Der", "erste", "Termin", "wäre", "die", "Woche", "nach", "dem", "Jahreswechsel", "der", "zweite", "Ende", "Januar"])],
}


# --- Files as the app sends them ----------------------------------------------------------------------------------


def wav_of(seconds: float = 1.0, rate: int = 8000) -> bytes:
    """A short tone, written by hand (no ffmpeg needed)."""
    out = io.BytesIO()
    with wave.open(out, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(rate)
        sound.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(index / 6)))
                                   for index in range(int(seconds * rate))))
    return out.getvalue()


def m4a_of(tmp_path: Path, seconds: int = 3) -> bytes:
    """A recording as AVAudioRecorder writes it: AAC in M4A, the index at the end, with a title and a place."""
    target = tmp_path / "Aufnahme.m4a"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-c:a", "aac", "-b:a", "48k", "-metadata", "title=Geheimer Titel",
                    "-metadata", "location=+52.5200+013.4050/", "-f", "ipod", str(target)],
                   check=True, capture_output=True, timeout=60)
    return target.read_bytes()


def send(client, note_id: str, data: bytes, name: str, role: str | None, attachment_id: str | None = None):
    params = {"note_id": note_id, "id": attachment_id or attachments.new_id(), "name": name}
    if role is not None:
        params["as"] = role
    return client.post("/api/attachments", params=params, content=data)


def sent(client, note_id: str, data: bytes, name: str, role: str) -> dict:
    answer = send(client, note_id, data, name, role)
    assert answer.status_code == 201, answer.text
    return answer.json()


def atoms(data: bytes) -> list[bytes]:
    """The top-level boxes of an ISO media file, in order."""
    found, at = [], 0
    while at + 8 <= len(data):
        size = struct.unpack(">I", data[at: at + 4])[0]
        found.append(data[at + 4: at + 8])
        if size < 8:
            break
        at += size
    return found


def sketch_and_recording(client, operator, *, transcript: dict | None = None) -> dict:
    """A note with a sketch and a recording as the app makes them: the files first, then the blocks."""
    note = new_note(client, title="Besprechung Montag")
    picture = sent(client, note["id"], png_with_text(), "Skizze.png", "drawing")
    data = sent(client, note["id"], b"PKDrawing\x00\x01 binary", "Skizze.drawing", "drawing-data")
    sound = sent(client, note["id"], wav_of(), "Besprechung.wav", "recording")
    words = sent(client, note["id"], json.dumps(transcript or TRANSCRIPT).encode(), "Besprechung.json", "transcript")
    add_blocks(note["id"], operator.id,
               {"type": "drawing", "attrs": {"id": picture["id"], "data": data["id"], "name": "Skizze.png"}},
               {"type": "recording", "attrs": {"id": sound["id"], "name": "Besprechung.wav", "duration": 1000,
                                               "transcript": words["id"]}})
    return {"note": note, "picture": picture, "data": data, "sound": sound, "words": words}


# --- Sketches -----------------------------------------------------------------------------------------------------


def test_notes18_a_sketch_is_its_picture_drawn_anew_and_its_data_only_to_download(client, operator):
    made = sketch_and_recording(client, operator)
    picture, data = made["picture"], made["data"]
    assert (picture["kind"], picture["mime"], picture["inline"], picture["thumb"]) == ("drawing", "image/png", True,
                                                                                     True)
    shown = client.get(f"/api/attachments/{picture['id']}/file")
    assert shown.status_code == 200 and shown.headers["content-disposition"].startswith("inline;")
    assert b"Gartenstrasse" not in shown.content
    assert (data["kind"], data["inline"]) == ("drawingdata", False)
    raw = client.get(f"/api/attachments/{data['id']}/file")
    assert raw.content == b"PKDrawing\x00\x01 binary"
    assert raw.headers["content-type"] == "application/octet-stream"
    assert raw.headers["content-disposition"].startswith("attachment;")
    # The note names both: rights, history and cleanup are those of every attachment.
    assert refs_of(made["note"]["id"]) == [picture["id"], data["id"], made["sound"]["id"], made["words"]["id"]]


def test_notes18_the_gallery_and_the_lists_show_the_sketch_and_the_recording_not_what_stands_behind(client, operator):
    made = sketch_and_recording(client, operator)
    gallery = client.get("/api/attachments").json()
    assert {item["id"] for item in gallery["items"]} == {made["picture"]["id"], made["sound"]["id"]}
    assert gallery["counts"]["drawing"] == 1 and gallery["counts"]["recording"] == 1 and gallery["counts"]["file"] == 0
    item = next(entry for entry in client.get("/api/note-list").json()["items"] if entry["id"] == made["note"]["id"])
    assert item["media"]["kind"] == "drawing"


@pytest.mark.parametrize("role,data", [
    ("drawing", b"just some text, no picture"),
    ("drawing", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    ("recording", b"just some text"),
    ("recording", b"%PDF-1.4 not sound"),
    ("transcript", b"not json"),
    ("transcript", json.dumps({"format": 2, "words": []}).encode()),
    ("transcript", json.dumps({"format": 1, "text": "no words"}).encode()),
    ("transcript", json.dumps([1, 2]).encode()),
], ids=["drawing-text", "drawing-svg", "recording-text", "recording-pdf", "transcript-text", "transcript-format2",
        "transcript-no-words", "transcript-list"])
def test_notes18_a_file_that_is_not_what_its_role_says_is_refused(client, operator, role, data):
    note = new_note(client, title="Falsch")
    answer = send(client, note["id"], data, "x", role)
    assert answer.status_code == 422, answer.text
    assert answer.json()["detail"]["code"] == "attachment_wrong_kind"
    with SessionLocal() as db:
        assert db.scalar(select(Attachment).where(Attachment.note_id == note["id"])) is None


def test_notes18_an_unknown_role_is_refused_before_anything_comes(client, operator):
    note = new_note(client, title="Rolle")
    answer = send(client, note["id"], b"abc", "x", "script")
    assert answer.status_code == 422 and answer.json()["detail"]["fields"] == ["as"]


def test_notes18_without_a_role_a_sound_file_from_the_browser_stays_a_file(client, operator):
    note = new_note(client, title="Ohne Rolle")
    answer = send(client, note["id"], wav_of(), "ton.wav", None)
    assert answer.status_code == 201 and answer.json()["kind"] == "file"


# --- Recordings ---------------------------------------------------------------------------------------------------


@needs_ffmpeg
def test_notes18_ec2_a_recording_from_the_phone_plays_at_once_and_jumps_to_the_end(client, operator, tmp_path):
    note = new_note(client, title="Diktat")
    data = m4a_of(tmp_path)
    assert atoms(data).index(b"moov") > atoms(data).index(b"mdat")
    row = sent(client, note["id"], data, "Diktat.m4a", "recording")
    assert (row["kind"], row["mime"], row["inline"]) == ("recording", "audio/mp4", True)
    assert 2800 <= row["duration_ms"] <= 3300
    stored = client.get(f"/api/attachments/{row['id']}/file").content
    # The index stands before the sound: a browser starts playing (and finds the end) without loading everything.
    assert atoms(stored).index(b"moov") < atoms(stored).index(b"mdat")
    # Neither title nor place survive; the sound is the same sound, not encoded again.
    assert b"Geheimer Titel" in data and b"Geheimer Titel" not in stored and b"+52.5200" not in stored
    probe = json.loads(subprocess.run([shutil.which("ffprobe"), "-v", "error", "-print_format", "json",
                                       "-show_streams", "-show_format", "-"], input=stored, capture_output=True,
                                      check=True).stdout)
    assert probe["streams"][0]["codec_name"] == "aac" and not (probe["format"].get("tags") or {}).get("title")
    # Jumping to the end asks for its last bytes only.
    end = client.get(f"/api/attachments/{row['id']}/file", headers={"Range": f"bytes={len(stored) - 100}-"})
    assert end.status_code == 206 and end.content == stored[-100:]


@pytest.mark.parametrize("name,data,mime", [
    ("a.wav", wav_of(), "audio/wav"),
    ("a.caf", b"caff\x00\x01\x00\x00desc" + b"\x00" * 64, "audio/x-caf"),
    ("a.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64, "audio/mpeg"),
    ("a.ogg", b"OggS\x00\x02" + b"\x00" * 64, "audio/ogg"),
], ids=["wav", "caf", "mp3", "ogg"])
def test_notes18_ec3_every_sound_has_its_type_the_browser_decides_what_it_plays(name, data, mime):
    assert sketches.sound_of(data[:4096]) is not None and sketches.sound_of(data[:4096])[1] == mime


def test_notes18_ec3_a_caf_from_an_iphone_is_taken_and_given_out_as_what_it_is(client, operator, monkeypatch):
    # Without ffprobe the first bytes decide; a CAF is sound only. (Read in this process: the worker would not know.)
    monkeypatch.setattr(media_worker, "INLINE", True)
    monkeypatch.setattr(sketches.shutil, "which", lambda _name: None)
    note = new_note(client, title="CAF")
    row = sent(client, note["id"], b"caff\x00\x01\x00\x00desc" + b"\x00" * 64, "Memo.caf", "recording")
    assert (row["kind"], row["mime"]) == ("recording", "audio/x-caf")
    assert client.get(f"/api/attachments/{row['id']}/file").headers["content-type"] == "audio/x-caf"


@needs_ffmpeg
def test_notes18_a_film_is_no_recording(client, operator, tmp_path):
    note = new_note(client, title="Film")
    # A film with sound: the sound alone does not make it a recording.
    target = tmp_path / "film.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264",
                    "-c:a", "aac", "-shortest", str(target)], check=True, capture_output=True, timeout=60)
    answer = send(client, note["id"], target.read_bytes(), "film.mp4", "recording")
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "attachment_wrong_kind"
    # A film without sound neither.
    answer = send(client, note["id"], video_of(tmp_path), "stumm.mp4", "recording")
    assert answer.status_code == 422


# --- Transcripts --------------------------------------------------------------------------------------------------


def test_notes18_a_transcript_is_checked_and_written_anew_with_what_the_format_has(client, operator):
    note = new_note(client, title="Transkript")
    messy = {"format": 1, "language": "de-DE<script>", "secret": "kept nowhere", "text": "Erst\r\ndann\x00 so",
             "words": [{"text": " dann ", "start": 900.4, "end": 100}, {"text": "Erst", "start": 0, "end": 400},
                       {"text": "", "start": 5}, {"text": "kaputt", "start": -1}, {"text": "x" * 500, "start": 2000},
                       "nonsense", {"text": "spät", "start": 10 ** 12}]}
    row = sent(client, note["id"], json.dumps(messy).encode(), "t.json", "transcript")
    assert (row["kind"], row["inline"]) == ("transcript", False)
    kept = json.loads(client.get(f"/api/attachments/{row['id']}/file").content)
    assert kept == {"format": 1, "language": None, "text": "Erst\ndann so",
                    "words": [{"text": "Erst", "start": 0, "end": 400}, {"text": "dann", "start": 900, "end": 900},
                              {"text": "x" * 200, "start": 2000, "end": 2000}]}


def test_notes18_the_words_of_a_transcript_without_text_are_its_words():
    clean = sketches.clean_transcript(json.dumps({"format": 1, "words": TRANSCRIPT["words"]}).encode())
    assert sketches.transcript_text(clean) == ("Der erste Termin wäre die Woche nach dem Jahreswechsel der zweite "
                                               "Ende Januar")


def test_notes18_a_transcript_too_large_is_refused():
    with pytest.raises(sketches.WrongKind):
        sketches.clean_transcript(b" " * (sketches.MAX_TRANSCRIPT_BYTES + 1))


# --- Search and export --------------------------------------------------------------------------------------------


def test_notes18_the_search_finds_the_words_of_a_recording_and_names_it(client, operator):
    made = sketch_and_recording(client, operator)
    hits = client.get("/api/search", params={"q": "Jahreswechsel"}).json()["items"]
    assert [hit["id"] for hit in hits] == [made["note"]["id"]]
    assert hits[0]["where"] == "attachment"
    assert hits[0]["attachment"] == {"kind": "recording", "name": "Besprechung.wav", "page": None,
                                     "ref": made["sound"]["id"]}


def test_notes18_a_transcript_that_comes_after_its_block_is_found_at_once(client, operator):
    note = new_note(client, title="Später")
    sound = sent(client, note["id"], wav_of(), "Spät.wav", "recording")
    words_id = attachments.new_id()
    add_blocks(note["id"], operator.id, {"type": "recording", "attrs": {"id": sound["id"], "transcript": words_id}})
    assert client.get("/api/search", params={"q": "Lagerfläche"}).json()["items"] == []
    late = {"format": 1, "words": [{"text": "Lagerfläche", "start": 0, "end": 300}]}
    assert send(client, note["id"], json.dumps(late).encode(), "t.json", "transcript", words_id).status_code == 201
    assert [hit["id"] for hit in client.get("/api/search", params={"q": "Lagerfläche"}).json()["items"]] == \
        [note["id"]]


def test_notes18_a_transcript_of_another_owner_is_not_read(client, operator):
    made = sketch_and_recording(client, operator)
    stranger = make_account("stranger")
    with SessionLocal() as db:
        db.get(Attachment, made["words"]["id"]).owner_id = stranger.id
        db.commit()
    search.reindex(made["note"]["id"])
    assert client.get("/api/search", params={"q": "Jahreswechsel"}).json()["items"] == []


def test_notes18_the_export_carries_the_sketch_as_a_picture_and_the_recording_with_its_transcript(client, operator):
    made = sketch_and_recording(client, operator)
    answer = client.get(f"/api/export/notes/{made['note']['id']}/markdown")
    assert answer.status_code == 200, answer.text
    archive = zipfile.ZipFile(io.BytesIO(answer.content))
    folder = "Besprechung Montag (Attachments)"
    assert set(archive.namelist()) == {"Besprechung Montag.md", f"{folder}/", f"{folder}/Skizze.png",
                                       f"{folder}/Besprechung.wav", f"{folder}/Besprechung.txt"}
    assert archive.read(f"{folder}/Besprechung.txt").decode() == TRANSCRIPT["text"]
    text = archive.read("Besprechung Montag.md").decode()
    href = "Besprechung%20Montag%20%28Attachments%29/"
    assert f"![Skizze.png]({href}Skizze.png)" in text
    assert f"[Besprechung.wav]({href}Besprechung.wav) · [Besprechung.txt]({href}Besprechung.txt)" in text
    assert "## Attachments" not in text and "drawing" not in text

    pdf = client.get(f"/api/export/notes/{made['note']['id']}/pdf")
    assert pdf.status_code == 200, pdf.text
    reader = PdfReader(io.BytesIO(pdf.content))
    printed = " ".join((page.extract_text() or "") for page in reader.pages)
    assert len([image for page in reader.pages for image in page.images]) == 1
    assert "Besprechung.wav" in printed and "0:01" in printed and "Jahreswechsel" in " ".join(printed.split())


# --- AC-2: a sketch changed on the iPad ---------------------------------------------------------------------------


def test_notes18_ac2_a_sketch_changed_on_the_ipad_names_its_new_files_and_the_old_stay_for_the_history(client,
                                                                                                       operator):
    made = sketch_and_recording(client, operator)
    note_id = made["note"]["id"]
    picture = sent(client, note_id, png_with_text(), "Skizze.png", "drawing")
    data = sent(client, note_id, b"PKDrawing v2", "Skizze.drawing", "drawing-data")

    def change(doc):
        for child in notedoc.body_of(doc).children:
            if getattr(child, "tag", None) == "drawing":
                child.attributes["id"] = picture["id"]
                child.attributes["data"] = data["id"]

    run(notes_change(note_id, change, operator.id))
    assert refs_of(note_id)[:2] == [picture["id"], data["id"]]
    old = row_of(made["picture"]["id"])
    assert old is not None and old.unref_at is not None


def notes_change(note_id, edit, account_id):
    from app.services import notes

    return notes.change(note_id, edit, account_id=account_id)
