"""NOTES-10 Anhänge: the server's part. Uploading (kind by content, pictures drawn anew, limits, storage), giving out
(rights, headers), where attachments stand (gallery, lists, history, going away), cards of links (switch, no SSRF) and
the hook for the export."""

from __future__ import annotations

import asyncio
import io
import os
import secrets
import shutil
import subprocess
import time
import zipfile
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Note, utcnow
from app.models_attachments import Attachment, AttachmentRef
from app.models_history import NoteVersion
from app.notedoc import doc as notedoc
from app.notedoc.markdown import to_markdown
from app.notedoc.room import Access
from app.services import (
    attachments,
    backups,
    content,
    history,
    linkpreview,
    media,
    notes,
    outbound,
    settings_service,
    trash,
)

from .conftest import MEDIA, make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored_doc, wait_for

MB = 1024 * 1024


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def setup(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)
    attachments.register()
    history.register()
    trash.register()
    history.clock.reset()
    yield
    history.clock.reset()


@pytest.fixture
def shared_with(monkeypatch: pytest.MonkeyPatch):
    """Stands in for sharing (NOTES-13): the accounts given here may read or write every note."""
    rights: dict[int, Access] = {}

    def rule(_db, account, _note):
        return rights.get(account.id)

    monkeypatch.setattr(notes, "ACCESS_RULES", [rule])
    return rights


# --- Files to attach ----------------------------------------------------------------------------------------------


def jpeg_with_secrets(size: tuple[int, int] = (64, 32)) -> bytes:
    """A photo with a camera, a place and "turn it a quarter" in its EXIF."""
    image = Image.new("RGB", size, (200, 30, 30))
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"  # make
    exif[0x0110] = "Model X"  # model
    exif[0x0112] = 6  # orientation: turn right
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2] = "N", (52.0, 31.0, 12.0)
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif, quality=90)
    return out.getvalue()


def png_with_text() -> bytes:
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    info.add_text("Location", "Gartenstrasse 5, secret")
    out = io.BytesIO()
    Image.new("RGBA", (40, 40), (0, 120, 200, 255)).save(out, "PNG", pnginfo=info)
    return out.getvalue()


def heic_with_secrets() -> bytes:
    import pillow_heif

    pillow_heif.register_heif_opener()
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"
    out = io.BytesIO()
    Image.new("RGB", (80, 60), (10, 200, 10)).save(out, "HEIF", exif=exif.tobytes(), quality=80)
    return out.getvalue()


def pdf_of(pages: int) -> bytes:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument.new()
    for _ in range(pages):
        document.new_page(595, 842)
    out = io.BytesIO()
    document.save(out)
    document.close()
    return out.getvalue()


def zip_of() -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("readme.txt", "hello")
    return out.getvalue()


FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg and ffprobe are missing")


def video_of(tmp_path: Path, container: str = "mp4") -> bytes:
    target = tmp_path / f"clip.{container}"
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", "-c:v", "libx264",
                    str(target)], check=True, capture_output=True, timeout=60)
    return target.read_bytes()


def upload(client: TestClient, note_id: str, data: bytes, name: str, attachment_id: str | None = None,
           **extra) -> httpx.Response:
    return client.post("/api/attachments", params={"note_id": note_id, "id": attachment_id or attachments.new_id(),
                                                   "name": name}, content=data, **extra)


def attached(client: TestClient, note_id: str, data: bytes, name: str) -> dict:
    answer = upload(client, note_id, data, name)
    assert answer.status_code == 201, answer.text
    return answer.json()


def run(coroutine):
    return asyncio.run(coroutine)


def add_blocks(note_id: str, account_id: int | None, *blocks: dict) -> None:
    """Blocks appended to the note through the room, the way an editor's change arrives (and the text follows)."""

    def edit(doc):
        body = notedoc.body_of(doc)
        notedoc.write_blocks(body, len(body.children), notedoc.clean_doc({"type": "doc", "content": list(blocks)})
                             ["content"])

    run(notes.change(note_id, edit, account_id=account_id))


def remove_blocks(note_id: str, account_id: int | None, attachment_id: str) -> None:
    def edit(doc):
        body = notedoc.body_of(doc)
        for index in reversed(range(len(body.children))):
            child = body.children[index]
            if getattr(child, "tag", None) in ("image", "attachment") and child.attributes.get("id") == attachment_id:
                del body.children[index]

    run(notes.change(note_id, edit, account_id=account_id))


def block(kind: str, row: dict, **attrs) -> dict:
    return {"type": kind, "attrs": {"id": row["id"], "name": row["name"], **attrs}}


def refs_of(note_id: str) -> list[str]:
    with SessionLocal() as db:
        return list(db.scalars(select(AttachmentRef.attachment_id).where(AttachmentRef.note_id == note_id)
                               .order_by(AttachmentRef.position)))


def row_of(attachment_id: str) -> Attachment | None:
    with SessionLocal() as db:
        found = db.get(Attachment, attachment_id)
        if found is not None:
            db.expunge(found)
        return found


def files_on_disk() -> set[str]:
    return {entry.name for entry in MEDIA.iterdir()} if MEDIA.is_dir() else set()


def age_unreferenced(attachment_id: str, by: timedelta) -> None:
    with SessionLocal() as db:
        found = db.get(Attachment, attachment_id)
        assert found is not None and found.unref_at is not None
        found.unref_at = found.unref_at - by
        db.commit()


# --- AC-1: dropped, pasted or chosen, each stands where it was put -------------------------------------------------


def test_notes10_ac1_every_file_stands_where_it_was_put_and_the_same_upload_twice_is_one(client, operator, tmp_path):
    note = new_note(client, title="Sofa ausmessen")
    picture = attached(client, note["id"], jpeg_with_secrets(), "Wohnzimmer.jpg")
    sheet = attached(client, note["id"], pdf_of(2), "Datenblatt Sofa.pdf")
    archive = attached(client, note["id"], zip_of(), "Grundriss.zip")
    add_blocks(note["id"], operator.id, {"type": "paragraph", "content": [{"type": "text", "text": "Vorher"}]},
               block("image", picture), block("attachment", sheet),
               {"type": "paragraph", "content": [{"type": "text", "text": "Dazwischen"}]}, block("attachment", archive))
    assert refs_of(note["id"]) == [picture["id"], sheet["id"], archive["id"]]
    kinds = [node["type"] for node in notedoc.to_json(stored_doc(note["id"]))["content"]]
    assert kinds[-5:] == ["image", "attachment", "paragraph", "attachment", "paragraph"] or \
        kinds[-4:] == ["image", "attachment", "paragraph", "attachment"]
    listed = client.get(f"/api/notes/{note['id']}/attachments").json()["items"]
    assert {item["id"]: item["kind"] for item in listed} == {picture["id"]: "image", sheet["id"]: "pdf",
                                                             archive["id"]: "file"}
    # Sent again (a retry after a lost answer): the same attachment, nothing new.
    again = upload(client, note["id"], zip_of(), "Grundriss.zip", archive["id"])
    assert again.status_code == 200 and again.json()["id"] == archive["id"]
    with SessionLocal() as db:
        assert db.scalar(select(Attachment.id).where(Attachment.id == archive["id"])) == archive["id"]
        assert len(list(db.scalars(select(Attachment)))) == 3


def test_notes10_ac1_an_id_of_another_note_is_not_found_and_a_bad_id_is_refused(client, operator):
    first = new_note(client, title="eins")
    second = new_note(client, title="zwei")
    row = attached(client, first["id"], zip_of(), "a.zip")
    # Not "taken": that would say the id exists. The same answer as for any attachment one may not see.
    taken = upload(client, second["id"], zip_of(), "a.zip", row["id"])
    assert taken.status_code == 404 and taken.json()["detail"]["code"] == "not_found"
    with new_client(make_account("fremd")) as stranger:
        theirs = new_note(stranger, title="fremd")
        taken = upload(stranger, theirs["id"], zip_of(), "a.zip", row["id"])
        assert taken.status_code == 404 and taken.json()["detail"]["code"] == "not_found"
    for bad in ("../../etc/passwd", "short", "a" * 40, "with space in it here"):
        answer = upload(client, first["id"], zip_of(), "a.zip", bad)
        assert answer.status_code == 422, bad


# --- AC-2, EC-3: pictures, drawn anew ------------------------------------------------------------------------------


def _exif_of(data: bytes) -> dict:
    with Image.open(io.BytesIO(data)) as image:
        return dict(image.getexif())


def test_notes10_ac2_a_picture_is_drawn_anew_upright_and_without_camera_or_place(client, operator):
    note = new_note(client, title="Foto")
    row = attached(client, note["id"], jpeg_with_secrets((64, 32)), "Wohnzimmer.jpg")
    assert row["kind"] == "image" and row["mime"] == "image/jpeg" and row["inline"] is True
    # Turned as the camera said: 64x32 stood on its side.
    assert (row["width"], row["height"]) == (32, 64)
    assert row["name"] == "Wohnzimmer.jpg" and row["size"] > 0
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert _exif_of(data) == {}
    assert b"SecretCam" not in data and b"Model X" not in data
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (32, 64)
    preview = client.get(f"/api/attachments/{row['id']}/thumb")
    assert preview.status_code == 200 and preview.headers["content-type"] == "image/webp"
    assert b"SecretCam" not in preview.content


def test_notes10_ac2_text_hidden_in_a_png_does_not_survive(client, operator):
    note = new_note(client, title="PNG")
    row = attached(client, note["id"], png_with_text(), "plan.png")
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert b"Gartenstrasse" not in data and row["mime"] == "image/png"


def test_notes10_ac2_size_small_medium_full_is_part_of_the_note(client, operator):
    clean = notedoc.clean_doc({"type": "doc", "content": [
        {"type": "image", "attrs": {"id": "Zx3_aB9-cD4eF5gH6iJ7kL", "size": "full", "name": "a.jpg"}},
        {"type": "image", "attrs": {"id": "Zx3_aB9-cD4eF5gH6iJ7kM", "size": "huge"}},
    ]})["content"]
    assert [node["attrs"]["size"] for node in clean] == ["full", "medium"]


def test_notes10_ec3_heic_shows_as_webp_and_stays_heic_to_download(client, operator):
    note = new_note(client, title="HEIC")
    row = attached(client, note["id"], heic_with_secrets(), "Wohnzimmer.heic")
    assert row["kind"] == "image" and row["mime"] == "image/heic" and row["view"] is True and row["inline"] is False
    shown = client.get(f"/api/attachments/{row['id']}/view")
    assert shown.status_code == 200 and shown.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(shown.content)) as image:
        assert image.format == "WEBP" and image.size == (80, 60)
    original = client.get(f"/api/attachments/{row['id']}/file")
    assert original.headers["content-disposition"].startswith("attachment;")
    # Only to download: given out as bytes, never as a type the browser would try to show.
    assert original.headers["content-type"] == "application/octet-stream"
    assert "Wohnzimmer.heic" in original.headers["content-disposition"]
    assert media.kind_of(original.content[:64]) == ("image", "heic")
    assert b"SecretCam" not in original.content


# --- AC-3: PDFs ----------------------------------------------------------------------------------------------------


def test_notes10_ac3_a_pdf_has_its_pages_a_picture_of_the_first_and_opens_in_the_browser(client, operator):
    note = new_note(client, title="PDF")
    row = attached(client, note["id"], pdf_of(12), "Datenblatt Sofa.pdf")
    assert (row["kind"], row["pages"], row["thumb"], row["inline"]) == ("pdf", 12, True, True)
    opened = client.get(f"/api/attachments/{row['id']}/file")
    assert opened.headers["content-type"] == "application/pdf"
    assert opened.headers["content-disposition"].startswith("inline;")
    assert "sandbox" not in opened.headers["content-security-policy"]
    assert "script-src" not in opened.headers["content-security-policy"]
    assert opened.headers["content-security-policy"].startswith("default-src 'none'")
    assert client.get(f"/api/attachments/{row['id']}/thumb").headers["content-type"] == "image/webp"
    download = client.get(f"/api/attachments/{row['id']}/file", params={"download": "true"})
    assert download.headers["content-disposition"].startswith("attachment;")


# --- AC-4, EC-4: any other file, only to download -------------------------------------------------------------------


def test_notes10_ac4_any_other_file_keeps_its_name_and_size_and_downloads(client, operator):
    note = new_note(client, title="Datei")
    data = zip_of()
    row = attached(client, note["id"], data, "Grundriss Bad.zip")
    assert (row["kind"], row["size"], row["inline"], row["thumb"]) == ("file", len(data), False, False)
    answer = client.get(f"/api/attachments/{row['id']}/file")
    assert answer.content == data
    assert answer.headers["content-type"] == "application/octet-stream"
    assert answer.headers["content-disposition"] == (
        "attachment; filename=\"Grundriss Bad.zip\"; filename*=UTF-8''Grundriss%20Bad.zip")


HOSTILE = [
    (b"<!doctype html><html><script>alert(document.cookie)</script></html>", "page.html"),
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "drawing.svg"),
    (b"MZ\x90\x00\x03" + b"\x00" * 200, "setup.exe"),
    (b"<html><body onload=alert(1)>", "harmless.png"),
    (b"\x89PNG\r\n\x1a\n" + b"<script>alert(1)</script>" * 10, "broken.png"),
]


@pytest.mark.parametrize(("data", "name"), HOSTILE, ids=[name for _, name in HOSTILE])
def test_notes10_ec4_scripts_and_programs_are_only_downloaded_never_shown(client, operator, data, name):
    note = new_note(client, title="Gefahr")
    row = attached(client, note["id"], data, name)
    assert row["kind"] == "file" and row["inline"] is False and row["view"] is False and row["thumb"] is False
    answer = client.get(f"/api/attachments/{row['id']}/file")
    assert answer.headers["content-type"] == "application/octet-stream"
    assert answer.headers["content-disposition"].startswith("attachment;")
    assert answer.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in answer.headers["content-security-policy"]
    assert "default-src 'none'" in answer.headers["content-security-policy"]
    for route in ("view", "thumb"):
        assert client.get(f"/api/attachments/{row['id']}/{route}").status_code == 404


def test_notes10_ec4_a_name_with_html_stays_text_and_the_header_ascii(client, operator):
    note = new_note(client, title="Name")
    name = '<img src=x onerror="alert(1)">\r\nSet-Cookie: x=1.svg'
    row = attached(client, note["id"], b"<svg onload=alert(1)>", name)
    assert row["name"] == '<img src=x onerror="alert(1)"> Set-Cookie: x=1.svg'
    header = client.get(f"/api/attachments/{row['id']}/file").headers["content-disposition"]
    assert "<" not in header.split("filename*=")[0] and "\r" not in header and "\n" not in header
    assert header.endswith("filename*=UTF-8''%3Cimg%20src%3Dx%20onerror%3D%22alert%281%29%22%3E%20Set-Cookie%3A%20x%3D1.svg")


# --- AC-6, AC-11, EC-1: the limits --------------------------------------------------------------------------------


def _work_files() -> list[str]:
    return [name for name in files_on_disk() if name.startswith(attachments.WORK_PREFIX)]


def test_notes10_ac6_a_file_over_the_limit_is_refused_with_its_name_size_and_the_limit(client, operator):
    note = new_note(client, title="Drohne")
    # Said by the browser up front: refused before anything is read.
    declared = upload(client, note["id"], b"x" * 10, "Drohnenflug.mp4", headers={"content-length": str(101 * MB)})
    assert declared.status_code == 413
    assert declared.json()["detail"] == {"code": "attachment_too_large", "message": "The file is larger than allowed.",
                                         "name": "Drohnenflug.mp4", "size": 101 * MB, "max_mb": 100}

    def stream(total: int):
        sent = 0
        while sent < total:
            piece = min(MB, total - sent)
            sent += piece
            yield b"\0" * piece

    # Sent without a length (a stream): counted while it comes and stopped right past the limit.
    counted = upload(client, note["id"], stream(101 * MB), "Drohnenflug.mp4")
    assert counted.status_code == 413
    assert counted.json()["detail"]["max_mb"] == 100 and counted.json()["detail"]["size"] > 100 * MB
    # The operator's setting counts at once.
    with SessionLocal() as db:
        settings_service.save(db, {"upload_max_mb": 1})
    lower = upload(client, note["id"], b"\1" * (MB + 1), "zwei.bin")
    assert lower.status_code == 413 and lower.json()["detail"]["max_mb"] == 1
    assert upload(client, note["id"], b"\1" * MB, "eins.bin").status_code == 201
    with SessionLocal() as db:
        assert len(list(db.scalars(select(Attachment)))) == 1
    assert _work_files() == []


def test_notes10_ec1_ac11_a_full_storage_takes_no_attachment_but_writing_goes_on(client, operator):
    note = new_note(client, title="Urlaub")
    first = attached(client, note["id"], zip_of(), "eins.zip")
    taken = client.get("/api/attachments/limits").json()
    assert taken["limit"] is None and taken["full"] is False and taken["max_mb"] == 100
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        row.storage_limit = taken["used"] + 50
        db.commit()
    # Room for 50 bytes: a larger file is refused while it comes, without a length up front too.
    refused = upload(client, note["id"], iter([b"y" * 40, b"y" * 40]), "zwei.bin")
    assert refused.status_code == 507
    detail = refused.json()["detail"]
    assert detail["code"] == "storage_limit_reached" and detail["limit"] == taken["used"] + 50
    with SessionLocal() as db:
        db.get(Account, operator.id).storage_limit = taken["used"]
        db.commit()
    limits = client.get("/api/attachments/limits").json()
    assert limits["full"] is True and limits["used"] == limits["limit"]
    full = upload(client, note["id"], b"z", "drei.bin")
    assert full.status_code == 507 and full.json()["detail"]["used"] == taken["used"]
    # Writing goes on (Briefing): the note takes text, and the attachment that is there still opens.
    add_blocks(note["id"], operator.id, {"type": "paragraph", "content": [{"type": "text", "text": "weiter"}]})
    assert "weiter" in notedoc.to_json(stored_doc(note["id"]))["content"][-1]["content"][0]["text"]
    assert client.get(f"/api/attachments/{first['id']}/file").status_code == 200
    assert _work_files() == []


def test_notes10_attachments_count_towards_the_storage_of_the_note_s_owner(client, operator, shared_with):
    note = new_note(client, title="Speicher")
    before = run_counts(operator.id)
    row = attached(client, note["id"], jpeg_with_secrets((300, 200)), "a.jpg")
    stored_bytes = row_of(row["id"]).stored
    assert stored_bytes > row["size"]  # the file and its preview
    assert run_counts(operator.id) == before + stored_bytes
    # Written in by somebody else: it still counts towards the owner.
    anna = make_account("anna")
    shared_with[anna.id] = Access.WRITE
    with new_client(anna) as other:
        attached(other, note["id"], zip_of(), "von anna.zip")
    assert run_counts(anna.id) == 0


def run_counts(account_id: int) -> int:
    with SessionLocal() as db:
        return content.counts(db, account_id).bytes


# --- EC-2: an upload that breaks off --------------------------------------------------------------------------------


def test_notes10_ec2_an_upload_that_breaks_off_leaves_nothing_and_can_come_again(client, operator):
    from starlette.requests import ClientDisconnect

    note = new_note(client, title="Abbruch")
    attachment_id = attachments.new_id()
    with SessionLocal() as db:
        started = attachments.begin(db, db.get(Account, operator.id), note["id"], attachment_id, "Buchung.pdf", None)

    async def broken():
        yield pdf_of(1)[:200]
        raise ClientDisconnect

    with pytest.raises(ClientDisconnect):
        run(attachments.receive(started, broken()))
    assert row_of(attachment_id) is None and files_on_disk() == set()
    again = upload(client, note["id"], pdf_of(1), "Buchung.pdf", attachment_id)
    assert again.status_code == 201 and again.json()["kind"] == "pdf"


# --- AC-8, EC-7: videos -------------------------------------------------------------------------------------------


@needs_ffmpeg
@pytest.mark.parametrize("container", ["mp4", "mov"])
def test_notes10_ac8_a_phone_video_plays_in_the_note_with_a_still_in_lists_and_tiles(client, operator, tmp_path,
                                                                                      container):
    note = new_note(client, title="Rundgang")
    data = video_of(tmp_path, container)
    row = attached(client, note["id"], data, f"Rundgang Wohnzimmer.{container}")
    assert (row["kind"], row["mime"], row["inline"], row["thumb"]) == ("video", "video/mp4", True, True)
    assert (row["width"], row["height"]) == (320, 240) and 1500 <= row["duration_ms"] <= 2500
    # Played in the page: in pieces (Range), shown inline.
    part = client.get(f"/api/attachments/{row['id']}/file", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100 and part.content == data[:100]
    assert part.headers["content-disposition"].startswith("inline;")
    add_blocks(note["id"], operator.id, block("attachment", row))
    item = next(entry for entry in client.get("/api/note-list").json()["items"] if entry["id"] == note["id"])
    assert item["media"] == {"kind": "video", "count": 1, "url": f"/api/attachments/{row['id']}/thumb"}
    assert client.get(item["media"]["url"]).headers["content-type"] == "image/webp"


def test_notes10_ac8_lists_and_tiles_show_the_first_picture_of_a_note(client, operator):
    note = new_note(client, title="Bilder")
    first = attached(client, note["id"], jpeg_with_secrets(), "eins.jpg")
    second = attached(client, note["id"], png_with_text(), "zwei.png")
    sheet = attached(client, note["id"], pdf_of(1), "doc.pdf")
    add_blocks(note["id"], operator.id, block("attachment", sheet), block("image", second), block("image", first))
    item = next(entry for entry in client.get("/api/note-list").json()["items"] if entry["id"] == note["id"])
    assert item["media"] == {"kind": "image", "count": 2, "url": f"/api/attachments/{second['id']}/thumb"}


def test_notes10_ec7_an_unknown_video_codec_is_still_a_video_with_name_and_download(client, operator):
    # A container the server knows by its brand, a content it cannot read: still a video, given out to play or load.
    note = new_note(client, title="HEVC")
    data = b"\x00\x00\x00\x18ftypqt  \x00\x00\x02\x00qt  " + os.urandom(2000)
    row = attached(client, note["id"], data, "IMG_0042.MOV")
    if FFMPEG:
        # ffprobe finds no video stream in noise: a file to download.
        assert row["kind"] == "file"
    else:
        assert row["kind"] == "video" and row["thumb"] is False
    download = client.get(f"/api/attachments/{row['id']}/file", params={"download": "true"})
    assert download.headers["content-disposition"].startswith("attachment;") and "IMG_0042.MOV" in \
        download.headers["content-disposition"]


# --- EC-8, EC-10: same names, readers ------------------------------------------------------------------------------


def test_notes10_ec8_two_files_of_the_same_name_both_stay(client, operator):
    note = new_note(client, title="Gleich")
    one = attached(client, note["id"], b"erste Fassung", "Notiz.txt")
    two = attached(client, note["id"], b"zweite Fassung", "Notiz.txt")
    add_blocks(note["id"], operator.id, block("attachment", one), block("attachment", two))
    assert one["id"] != two["id"] and refs_of(note["id"]) == [one["id"], two["id"]]
    assert client.get(f"/api/attachments/{one['id']}/file").content == b"erste Fassung"
    assert client.get(f"/api/attachments/{two['id']}/file").content == b"zweite Fassung"


def test_notes10_ec10_a_reader_opens_and_downloads_but_attaches_nothing(client, operator, shared_with):
    note = new_note(client, title="Geteilt")
    row = attached(client, note["id"], pdf_of(1), "Plan.pdf")
    add_blocks(note["id"], operator.id, block("attachment", row))
    reader = make_account("rita")
    stranger = make_account("fremd")
    shared_with[reader.id] = Access.READ
    with new_client(reader) as rita:
        assert rita.get(f"/api/attachments/{row['id']}/file").status_code == 200
        assert rita.get(f"/api/attachments/{row['id']}/file", params={"download": "1"}).status_code == 200
        assert [item["id"] for item in rita.get(f"/api/notes/{note['id']}/attachments").json()["items"]] == [row["id"]]
        refused = upload(rita, note["id"], zip_of(), "neu.zip")
        assert refused.status_code == 404 and refused.json()["detail"]["code"] == "not_found"
        assert rita.post(f"/api/notes/{note['id']}/link-preview", json={"url": "https://example.com"}).status_code \
            == 404
    with new_client(stranger) as other:
        for path in ("", "/file", "/view", "/thumb"):
            answer = other.get(f"/api/attachments/{row['id']}{path}")
            assert answer.status_code == 404 and answer.json()["detail"] == {"code": "not_found",
                                                                             "message": "Not found."}
        assert other.get("/api/attachments/AAAAAAAAAAAAAAAAAAAAAA").json() == \
            other.get(f"/api/attachments/{row['id']}").json()


def test_notes10_an_attachment_of_a_deleted_note_is_not_given_out(client, operator):
    note = new_note(client, title="Weg")
    row = attached(client, note["id"], zip_of(), "a.zip")
    client.delete(f"/api/notes/{note['id']}")
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 404


# --- AC-12, NOTES-15 AC-3/AC-4: removed from the note, kept in the history -------------------------------------------


def _version_now(note_id: str) -> int:
    history.take_now(note_id, force=True)
    with SessionLocal() as db:
        return db.scalar(select(NoteVersion.id).where(NoteVersion.note_id == note_id)
                         .order_by(NoteVersion.id.desc()).limit(1))


def test_notes10_ac12_removed_from_the_note_it_stays_in_the_history_until_its_version_goes(client, operator):
    note = new_note(client, title="Verlauf")
    row = attached(client, note["id"], jpeg_with_secrets(), "Alte Fliesen.jpg")
    add_blocks(note["id"], operator.id, block("image", row))
    version = _version_now(note["id"])
    remove_blocks(note["id"], operator.id, row["id"])
    assert refs_of(note["id"]) == []
    assert "image" not in [node["type"] for node in notedoc.to_json(stored_doc(note["id"]))["content"]]
    assert client.get("/api/attachments").json()["total"] == 0
    # The version still shows it, long after the note let it go.
    age_unreferenced(row["id"], timedelta(days=30))
    with SessionLocal() as db:
        attachments.collect(db)
        db.commit()
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    shown = client.get(f"/api/notes/{note['id']}/history/{version}").json()["content"]["content"]
    assert any(node["type"] == "image" and node["attrs"]["id"] == row["id"] for node in shown)
    # The version thinned away: the attachment goes with it, its files once the change is committed.
    with SessionLocal() as db:
        db.get(NoteVersion, version).created_at = utcnow() - timedelta(days=400)
        db.commit()
    history.thin()
    assert row_of(row["id"]) is None
    assert not any(name.startswith(row["id"]) for name in files_on_disk())


def test_notes15_ac3_ac4_an_old_version_keeps_its_deleted_picture_and_restoring_brings_it_back(client, operator):
    note = new_note(client, title="Fliesen")
    row = attached(client, note["id"], jpeg_with_secrets(), "Fliesen.jpg")
    add_blocks(note["id"], operator.id, block("image", row, size="small"))
    version = _version_now(note["id"])
    remove_blocks(note["id"], operator.id, row["id"])
    age_unreferenced(row["id"], timedelta(days=3))
    with SessionLocal() as db:
        attachments.collect(db)
        db.commit()
    restored = client.post(f"/api/notes/{note['id']}/history/{version}/restore")
    assert restored.status_code == 200, restored.text
    assert wait_for(lambda: refs_of(note["id"]) == [row["id"]])
    assert row_of(row["id"]).unref_at is None
    assert [item["id"] for item in client.get("/api/attachments").json()["items"]] == [row["id"]]
    image = next(node for node in notedoc.to_json(stored_doc(note["id"]))["content"] if node["type"] == "image")
    assert image["attrs"]["size"] == "small"


def test_notes10_an_upload_never_put_into_the_note_goes_after_a_day(client, operator):
    note = new_note(client, title="Liegen geblieben")
    row = attached(client, note["id"], zip_of(), "vergessen.zip")
    with SessionLocal() as db:
        assert attachments.collect(db) == 0  # within the day: undo may still bring it
        db.commit()
    age_unreferenced(row["id"], attachments.GRACE + timedelta(minutes=1))
    with SessionLocal() as db:
        assert attachments.collect(db) == 1
        db.commit()
    assert row_of(row["id"]) is None and files_on_disk() == set()


def test_notes10_a_note_gone_for_good_takes_its_attachments_unless_a_copy_names_them(client, operator):
    note = new_note(client, title="Original")
    row = attached(client, note["id"], jpeg_with_secrets(), "geteilt.jpg")
    alone = attached(client, note["id"], zip_of(), "allein.zip")
    add_blocks(note["id"], operator.id, block("image", row), block("attachment", alone))
    copy = client.post(f"/api/notes/{note['id']}/duplicate").json()
    assert wait_for(lambda: refs_of(copy["id"]) == [row["id"], alone["id"]])
    remove_blocks(copy["id"], operator.id, alone["id"])
    # The copy shows the picture of the original (same owner).
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    client.delete(f"/api/notes/{note['id']}")
    assert client.delete(f"/api/trash/notes/{note['id']}").status_code == 200
    moved = row_of(row["id"])
    assert moved is not None and moved.note_id == copy["id"]
    assert row_of(alone["id"]) is None and not any(name.startswith(alone["id"]) for name in files_on_disk())
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    client.delete(f"/api/notes/{copy['id']}")
    client.delete(f"/api/trash/notes/{copy['id']}")
    assert row_of(row["id"]) is None and files_on_disk() == set()


def test_notes10_files_without_a_row_and_old_work_files_go_in_the_cleanup_round(client, operator):
    note = new_note(client, title="Rest")
    kept = attached(client, note["id"], zip_of(), "bleibt.zip")
    add_blocks(note["id"], operator.id, block("attachment", kept))
    stray = MEDIA / ("S" * 22)
    stray.write_bytes(b"old")
    work = MEDIA / (attachments.WORK_PREFIX + "abc")
    work.write_bytes(b"half")
    fresh = MEDIA / ("F" * 22)
    fresh.write_bytes(b"just now")
    old = time.time() - 2 * 86400
    os.utime(stray, (old, old))
    os.utime(work, (old, old))
    attachments.cleanup()
    assert files_on_disk() == {kept["id"], fresh.name}


def test_notes10_an_empty_looking_note_with_only_a_picture_is_not_discarded(client, operator):
    note = new_note(client)
    row = attached(client, note["id"], jpeg_with_secrets(), "")
    add_blocks(note["id"], operator.id, {"type": "image", "attrs": {"id": row["id"]}})
    assert run(notes.discard_if_empty(note["id"])) is False
    with SessionLocal() as db:
        assert db.get(Note, note["id"]) is not None


def test_notes10_backups_carry_the_attachments(client, operator):
    note = new_note(client, title="Sicherung")
    row = attached(client, note["id"], heic_with_secrets(), "a.heic")
    archive = backups.create(kind=backups.MANUAL)
    with zipfile.ZipFile(archive) as opened:
        names = set(opened.namelist())
    assert {f"attachments/{row['id']}", f"attachments/{row['id']}.view", f"attachments/{row['id']}.thumb"} <= names


# --- AC-7, EC-9: the gallery -----------------------------------------------------------------------------------------


def test_notes10_ec9_an_empty_gallery_says_so(client, operator):
    answer = client.get("/api/attachments").json()
    assert answer == {"total": 0, "all": 0, "bytes": 0, "counts": dict.fromkeys(attachments.GALLERY_KINDS, 0),
                      "items": []}


def test_notes10_ac7_the_gallery_of_400_attachments_filters_counts_sorts_and_names_the_note(client, operator):
    notes_made = [new_note(client, title=f"Notiz {index}") for index in range(4)]
    other = make_account("anna")
    with new_client(other) as anna:
        foreign = new_note(anna, title="fremd")
    kinds = ["image"] * 200 + ["pdf"] * 100 + ["video"] * 50 + ["file"] * 50
    now = utcnow()
    with SessionLocal() as db:
        for index, kind in enumerate(kinds):
            home = notes_made[index % 4]["id"]
            found = f"att{index:05d}xxxxxxxxxxxxxx"[:22]
            db.add(Attachment(id=found, note_id=home, owner_id=operator.id, kind=kind, name=f"{kind}-{index}",
                              mime="application/octet-stream", size=1000 + index, stored=1000 + index,
                              created_at=now - timedelta(minutes=index)))
            db.add(AttachmentRef(note_id=home, attachment_id=found, position=index))
        # Not in the gallery: a link card's picture, an attachment no note names, one in the trash, another's.
        db.add(Attachment(id="link0000000000000000aa", note_id=notes_made[0]["id"], owner_id=operator.id,
                          kind="linkimage", name="x", size=5, stored=5))
        db.add(AttachmentRef(note_id=notes_made[0]["id"], attachment_id="link0000000000000000aa"))
        db.add(Attachment(id="loose000000000000000aa", note_id=notes_made[1]["id"], owner_id=operator.id,
                          kind="image", name="lose", size=5, stored=5, unref_at=now))
        db.add(Attachment(id="anna0000000000000000aa", note_id=foreign["id"], owner_id=other.id, kind="image",
                          name="annas", size=5, stored=5))
        db.add(AttachmentRef(note_id=foreign["id"], attachment_id="anna0000000000000000aa"))
        db.commit()
    trashed = new_note(client, title="Papierkorb")
    with SessionLocal() as db:
        db.add(Attachment(id="trash000000000000000aa", note_id=trashed["id"], owner_id=operator.id, kind="image",
                          name="weg", size=5, stored=5))
        db.add(AttachmentRef(note_id=trashed["id"], attachment_id="trash000000000000000aa"))
        db.commit()
    client.delete(f"/api/notes/{trashed['id']}")

    started = time.perf_counter()
    everything = client.get("/api/attachments", params={"limit": 500}).json()
    assert time.perf_counter() - started < 1.0
    assert everything["all"] == everything["total"] == 400 and len(everything["items"]) == 400
    assert everything["counts"] == {"image": 200, "scan": 0, "pdf": 100, "recording": 0, "drawing": 0, "video": 50,
                                    "file": 50}
    assert everything["bytes"] == sum(1000 + index for index in range(400))
    # Newest first by default; each with its kind, name, note and size.
    first = everything["items"][0]
    assert (first["name"], first["kind"], first["size"], first["note"]) == (
        "image-0", "image", 1000, {"id": notes_made[0]["id"], "title": "Notiz 0"})
    largest = client.get("/api/attachments", params={"sort": "largest", "kind": "pdf"}).json()
    assert largest["total"] == 100 and largest["all"] == 400
    sizes = [item["size"] for item in largest["items"]]
    assert sizes == sorted(sizes, reverse=True) and all(item["kind"] == "pdf" for item in largest["items"])
    page = client.get("/api/attachments", params={"offset": 120, "limit": 120}).json()["items"]
    assert page[0]["name"] == "image-120"
    assert client.get("/api/attachments", params={"kind": "nonsense"}).status_code == 422


# --- AC-5, AC-9, EC-5, EC-11: cards of links -------------------------------------------------------------------------

PAGE = b"""<!doctype html><html><head><meta charset="utf-8">
<title>Fallback title</title>
<meta property="og:title" content="Ecksofa Beispiel, 3-Sitzer">
<meta property="og:description" content="Ma&szlig;e, Bez\xc3\xbcge und Lieferzeit im \xc3\x9cberblick">
<meta property="og:site_name" content="M\xc3\xb6bel Beispiel">
<meta property="og:image" content="/bilder/sofa.jpg">
</head><body><script>alert(1)</script></body></html>"""
PUBLIC = "93.184.216.34"


class Web:
    """The internet as the tests want it: names resolve as given, every request is written down."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.names: dict[str, list[str]] = {"moebel.example.com": [PUBLIC]}
        self.asked_names: list[str] = []
        self.requests: list[httpx.Request] = []
        self.pages: dict[str, httpx.Response] = {}
        monkeypatch.setattr(linkpreview, "RESOLVER", self.resolve)
        monkeypatch.setattr(linkpreview, "TRANSPORT", httpx.MockTransport(self.answer))

    def resolve(self, host: str, _port: int) -> list[str]:
        self.asked_names.append(host)
        if host not in self.names:
            raise outbound.Unreachable(host)
        return self.names[host]

    def answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = request.headers["host"] + request.url.raw_path.decode()
        return self.pages.get(key, httpx.Response(404))


@pytest.fixture
def web(monkeypatch: pytest.MonkeyPatch) -> Web:
    found = Web(monkeypatch)
    found.pages["moebel.example.com/ecksofa"] = httpx.Response(200, headers={"content-type": "text/html"},
                                                               content=PAGE)
    picture = io.BytesIO()
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"
    Image.new("RGB", (1200, 600), (240, 200, 80)).save(picture, "JPEG", exif=exif)
    found.pages["moebel.example.com/bilder/sofa.jpg"] = httpx.Response(200, headers={"content-type": "image/jpeg"},
                                                                       content=picture.getvalue())
    return found


def card(client: TestClient, note_id: str, url: str) -> dict:
    answer = client.post(f"/api/notes/{note_id}/link-preview", json={"url": url})
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_notes10_ac5_a_reachable_page_becomes_a_card_with_title_description_picture_and_address(client, operator,
                                                                                               web):
    note = new_note(client, title="Sofa")
    found = card(client, note["id"], "https://moebel.example.com/ecksofa")
    preview = found["preview"]
    assert (preview["href"], preview["title"], preview["description"], preview["site"]) == (
        "https://moebel.example.com/ecksofa", "Ecksofa Beispiel, 3-Sitzer", "Maße, Bezüge und Lieferzeit im Überblick",
        "Möbel Beispiel")
    # Asked at the address the name gave, with the name in the Host header.
    assert {request.url.host for request in web.requests} == {PUBLIC}
    picture = client.get(f"/api/attachments/{preview['image']}/thumb")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/webp"
    assert b"SecretCam" not in picture.content
    with Image.open(io.BytesIO(picture.content)) as image:
        assert max(image.size) <= linkpreview.PICTURE_EDGE
    # The card in the note: the picture counts as the note's, never in the gallery.
    add_blocks(note["id"], operator.id, {"type": "linkPreview", "attrs": preview})
    assert refs_of(note["id"]) == [preview["image"]]
    assert client.get("/api/attachments").json()["total"] == 0
    # Left a plain link: the card is a block, a link is a mark; both are the note's own choice.
    plain = notedoc.clean_doc({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": preview["href"], "marks": [{"type": "link", "attrs": {"href": preview["href"]}}]}]}]})
    assert plain["content"][0]["content"][0]["marks"][0]["attrs"]["href"] == preview["href"]


def test_notes10_ac5_a_page_without_a_picture_or_with_only_a_title_still_makes_a_card(client, operator, web):
    note = new_note(client, title="Titel")
    web.pages["moebel.example.com/schlicht"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=iso-8859-1"},
        content="<html><head><title>Gr\xfc\xdfe aus Bonn</title></head></html>".encode("latin-1"))
    preview = card(client, note["id"], "http://moebel.example.com/schlicht")["preview"]
    assert (preview["title"], preview["description"], preview["image"], preview["site"]) == (
        "Grüße aus Bonn", None, None, "moebel.example.com")


def test_notes10_ac9_switched_off_the_link_stays_plain_and_nothing_is_asked(client, operator, web):
    note = new_note(client, title="Aus")
    client.put("/api/settings", json={"link_previews": False})
    assert client.get("/api/attachments/limits").json()["link_previews"] is False
    assert card(client, note["id"], "https://moebel.example.com/ecksofa") == {"preview": None, "reason": "off"}
    assert web.asked_names == [] and web.requests == []


REFUSED = [
    "http://192.168.1.10/router",
    "http://10.0.0.1/",
    "http://172.16.5.5/",
    "http://127.0.0.1:8570/api/auth/me",
    "http://localhost/",
    "http://nexnotes.localhost/",
    "http://[::1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://moebel.example.com:8080/",
    "http://user:pass@moebel.example.com/",
    "http://testserver/api/notes",
    "ftp://moebel.example.com/",
    "javascript:alert(1)",
    "file:///etc/passwd",
]


@pytest.mark.parametrize("url", REFUSED)
def test_notes10_ec5_the_home_network_the_server_itself_and_odd_addresses_are_never_asked(client, operator, web, url):
    note = new_note(client, title="SSRF")
    found = card(client, note["id"], url)
    assert found["preview"] is None and found["reason"] == "refused"
    assert web.requests == []


def test_notes10_ec5_a_name_that_points_home_and_a_redirect_into_the_home_network_are_refused(client, operator, web):
    note = new_note(client, title="Umweg")
    web.names["intern.example.com"] = ["93.184.216.35", "192.168.178.1"]
    assert card(client, note["id"], "https://intern.example.com/")["reason"] == "refused"
    web.names["springt.example.com"] = [PUBLIC]
    web.pages["springt.example.com/"] = httpx.Response(302, headers={"location": "http://192.168.178.1/admin"})
    assert card(client, note["id"], "https://springt.example.com/")["reason"] == "refused"
    web.pages["springt.example.com/lokal"] = httpx.Response(302, headers={"location": "http://localhost/"})
    assert card(client, note["id"], "https://springt.example.com/lokal")["reason"] == "refused"
    assert all(request.url.host == PUBLIC for request in web.requests)
    # A redirect to a public page is followed (each step checked).
    web.pages["springt.example.com/weiter"] = httpx.Response(301, headers={"location":
                                                                           "https://moebel.example.com/ecksofa"})
    assert card(client, note["id"], "https://springt.example.com/weiter")["preview"]["title"] == \
        "Ecksofa Beispiel, 3-Sitzer"


def test_notes10_ec5_a_page_that_is_no_page_or_does_not_answer_gives_no_card(client, operator, web):
    note = new_note(client, title="Kaputt")
    web.pages["moebel.example.com/datei.zip"] = httpx.Response(200, headers={"content-type": "application/zip"},
                                                               content=b"PK")
    assert card(client, note["id"], "https://moebel.example.com/datei.zip")["reason"] == "not_html"
    assert card(client, note["id"], "https://moebel.example.com/fehlt")["reason"] == "not_html"
    web.pages["moebel.example.com/riesig"] = httpx.Response(200, headers={"content-type": "text/html"},
                                                            content=b"<html>" + b"x" * (linkpreview.MAX_PAGE + 10))
    assert card(client, note["id"], "https://moebel.example.com/riesig")["preview"] is None


def test_notes10_ec11_without_internet_the_link_stays_plain_at_once(client, operator, monkeypatch):
    note = new_note(client, title="Offline")

    def no_internet(host: str, _port: int) -> list[str]:
        raise outbound.Unreachable(host)

    monkeypatch.setattr(linkpreview, "RESOLVER", no_internet)
    started = time.perf_counter()
    found = card(client, note["id"], "https://moebel.example.com/ecksofa")
    assert found == {"preview": None, "reason": "unreachable"}
    assert time.perf_counter() - started < 1.0


# --- The export's hook ---------------------------------------------------------------------------------------------


def test_notes10_files_of_gives_the_export_every_attachment_in_the_order_of_the_text(client, operator):
    note = new_note(client, title="Export")
    sheet = attached(client, note["id"], pdf_of(1), "Plan.pdf")
    picture = attached(client, note["id"], jpeg_with_secrets(), "Foto.jpg")
    unused = attached(client, note["id"], zip_of(), "nicht drin.zip")
    add_blocks(note["id"], operator.id, block("image", picture), block("attachment", sheet),
               block("image", picture), {"type": "image", "attrs": {"id": "Nobody0000000000000000"}})
    with SessionLocal() as db:
        files = attachments.files_of(db, note["id"])
    assert [(entry.id, entry.name, entry.kind) for entry in files] == [(picture["id"], "Foto.jpg", "image"),
                                                                        (sheet["id"], "Plan.pdf", "pdf")]
    assert all(entry.path.is_file() and entry.path.parent == MEDIA for entry in files)
    assert unused["id"] not in [entry.id for entry in files]
    markdown = to_markdown(stored_doc(note["id"]), attachment_href=lambda found, name: f"files/{name}")
    assert "![Foto.jpg](files/Foto.jpg)" in markdown and "[Plan.pdf](files/Plan.pdf)" in markdown


def test_notes10_the_note_answers_its_attachments_only_to_who_may_read_it(client, operator):
    note = new_note(client, title="Liste")
    secrets_token = secrets.token_hex(4)
    attached(client, note["id"], zip_of(), f"{secrets_token}.zip")
    stranger = make_account("fremd")
    with new_client(stranger) as other:
        assert other.get(f"/api/notes/{note['id']}/attachments").status_code == 404
