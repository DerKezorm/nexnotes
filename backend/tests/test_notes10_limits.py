"""NOTES-10 Anhänge, the server's limits: files that ask a decoder for gigabytes or minutes are read in a worker with
limits (``media_worker``), animations are counted before they are decoded, uploads at once share the storage, and what
the history of a second note shows stays (AC-12, NOTES-15 AC-3).

**The bombs here are real.** They run only in the worker, and this process puts itself under a hard limit of its own
first (``guard``, Windows), so that a mistake in the worker ends the test run, never the machine."""

from __future__ import annotations

import asyncio
import io
import os
import sys
import threading
import time
import zlib
from datetime import timedelta
from typing import Self

import pytest
from PIL import Image
from sqlalchemy import select

from app import worker_limits
from app.db import SessionLocal
from app.models import Account
from app.models_attachments import AttachmentMention
from app.notedoc import doc as notedoc
from app.services import attachments, history, media, media_worker, outbound

from .conftest import make_account, new_client
from .test_notes3 import new_note, stored_doc, wait_for
from .test_notes10 import (
    _version_now,
    add_blocks,
    age_unreferenced,
    attached,
    block,
    files_on_disk,
    heic_with_secrets,
    pdf_of,
    refs_of,
    remove_blocks,
    row_of,
    upload,
    zip_of,
)

MB = 1024 * 1024


# --- A hard limit for this process, and its memory -------------------------------------------------------------------

_guarded = False


@pytest.fixture
def guard():
    """Windows: this process (and what it starts) under 3 GB from here on, whatever a test does wrong."""
    global _guarded
    if sys.platform == "win32" and not _guarded:
        media_worker.limit_self(3 * 1024 * MB)
        _guarded = True
    yield


def private_mb() -> float:
    """The memory this process holds, in MB."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes as wt

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        process = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(process), ctypes.byref(counters), counters.cb)
        return counters.PagefileUsage / MB
    with open("/proc/self/statm") as handle:
        return int(handle.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / MB


class Watch:
    """The highest memory of this process while the block runs."""

    def __enter__(self) -> Self:
        self.before = private_mb()
        self.highest = self.before
        self._stop = threading.Event()

        def sample() -> None:
            while not self._stop.is_set():
                self.highest = max(self.highest, private_mb())
                time.sleep(0.05)

        self._thread = threading.Thread(target=sample, daemon=True)
        self._thread.start()
        self.started = time.monotonic()
        return self

    def __exit__(self, *_exc) -> None:
        self.seconds = time.monotonic() - self.started
        self._stop.set()
        self._thread.join()

    @property
    def grew(self) -> float:
        return self.highest - self.before


@pytest.fixture
def probes(monkeypatch: pytest.MonkeyPatch):
    """The test tasks of ``tests/media_probe.py`` allowed in the worker; fresh workers before and after."""
    media_worker.shutdown()
    monkeypatch.setattr(media_worker, "TARGETS",
                        media_worker.TARGETS | {f"tests.media_probe:{name}" for name in ("swallow", "nap", "refuse")})
    yield
    media_worker.shutdown()


# --- Bombs -----------------------------------------------------------------------------------------------------------


def _pdf(objects: list[bytes]) -> bytes:
    out = b"%PDF-1.7\n"
    offsets = []
    for index, body in enumerate(objects):
        offsets.append(len(out))
        out += f"{index + 1} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def _stream(head: bytes, data: bytes) -> bytes:
    return b"<< " + head + f" /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"


def pdf_drawing_itself() -> bytes:
    """633 bytes: a form that draws itself twice, without end."""
    return _pdf([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                 (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /F 5 0 R >> >>"
                  b" /Contents 4 0 R >>"),
                 _stream(b"", b"/F Do"),
                 _stream(b"/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /XObject << /F 5 0 R >> >>",
                         b"/F Do /F Do")])


def pdf_of_two_million_lines() -> bytes:
    """88 KB: a page of two million lines (600 MB and a minute of pdfium)."""
    return _pdf([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                 b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
                 _stream(b"/Filter /FlateDecode", zlib.compress(b"0 0 m 595 842 l S\n" * 2_000_000, 9))])


def gif_of(edge: int, frames: int) -> bytes:
    """A GIF whose canvas is ``edge`` pixels square and whose ``frames`` frames are one pixel each: tiny on disk, a
    full canvas each once decoded."""
    one = io.BytesIO()
    Image.new("P", (1, 1), 1).save(one, "GIF")
    data = one.getvalue()
    start = data.index(b"\x2c")
    picture = data[start:-1]
    head = bytearray(data[:start])
    head[6:8] = edge.to_bytes(2, "little")
    head[8:10] = edge.to_bytes(2, "little")
    loop = b"\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00"
    return bytes(head) + loop + (b"\x21\xf9\x04\x00\x01\x00\x00\x00" + picture) * frames + b";"


# --- 1: PDFs, pictures and videos in a worker with limits ------------------------------------------------------------


@pytest.mark.parametrize("bomb", [pdf_drawing_itself, pdf_of_two_million_lines], ids=["draws-itself", "2M-lines"])
def test_notes10_ac3_a_pdf_bomb_is_answered_in_time_as_a_file_without_preview_and_the_server_stays(
        client, operator, guard, bomb):
    note = new_note(client, title="Bombe")
    with Watch() as watch:
        answer = upload(client, note["id"], bomb(), "plan.pdf")
    assert answer.status_code == 201, answer.text
    row = answer.json()
    assert (row["kind"], row["inline"], row["thumb"], row["preview_failed"]) == ("file", False, False, True)
    assert watch.seconds < 15, watch.seconds
    assert watch.grew < 300, watch.grew
    # Kept to download, as a file, never shown.
    got = client.get(f"/api/attachments/{row['id']}/file")
    assert got.status_code == 200 and got.headers["content-disposition"].startswith("attachment;")
    # The next PDF is read as ever: the worker that gave up was replaced.
    fine = attached(client, note["id"], pdf_of(2), "gut.pdf")
    assert (fine["kind"], fine["pages"], fine["thumb"], fine["preview_failed"]) == ("pdf", 2, True, False)


def test_notes10_the_media_worker_ends_past_its_memory_and_the_next_one_works(guard, probes, monkeypatch):
    monkeypatch.setattr(media_worker, "MEMORY_MB", 300)
    started = time.monotonic()
    with pytest.raises(media_worker.MediaFailed) as failed:
        media_worker.run("tests.media_probe:swallow", 600, seconds=60)
    assert failed.value.reason == "ended"
    assert time.monotonic() - started < 30
    assert media_worker.run("tests.media_probe:swallow", 50, seconds=60) == 50


def test_notes10_the_media_worker_stops_a_task_past_its_seconds(probes):
    started = time.monotonic()
    with pytest.raises(media_worker.MediaFailed) as failed:
        media_worker.run("tests.media_probe:nap", 30, seconds=2)
    assert failed.value.reason == "timeout"
    assert time.monotonic() - started < 15
    # What the task raises itself comes back as it is.
    with pytest.raises(ValueError, match="kein Bild"):
        media_worker.run("tests.media_probe:refuse", "kein Bild", seconds=30)
    with pytest.raises(ValueError):
        media_worker.run("os:system", "echo nein", seconds=5)


def test_notes10_ec6_at_most_two_workers_at_once_previews_and_recognition_together(probes):
    answers: list[tuple[int, float, float]] = []

    def one() -> None:
        answers.append(media_worker.run("tests.media_probe:nap", 1.0, seconds=60))

    threads = [threading.Thread(target=one) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(answers) == 5
    at_once = max(sum(1 for _, began, ended in answers if began <= moment < ended) for _, moment, _ in answers)
    assert at_once <= worker_limits.WORKERS == 2
    assert len({pid for pid, _, _ in answers}) <= 2


# --- 2: animations are counted before they are decoded ---------------------------------------------------------------


def test_notes10_ac2_a_gif_of_too_many_frames_stays_a_file_before_it_is_decoded(client, operator, guard, tmp_path):
    # 1000 x 1000 x 150 frames: 150 million pixels, 600 MB once decoded, 3 KB on disk.
    path = tmp_path / "probe.gif"
    path.write_bytes(gif_of(1000, 150))
    started = time.monotonic()
    prepared = media.prepare_here(path)
    assert (prepared.kind, prepared.preview_failed) == ("file", True)
    assert time.monotonic() - started < 3
    # The bomb of the report through the server: 5 KB, a canvas of 2000 x 2000 and 200 frames.
    note = new_note(client, title="GIF")
    with Watch() as watch:
        row = attached(client, note["id"], gif_of(2000, 200), "lustig.gif")
    assert (row["kind"], row["preview_failed"]) == ("file", True)
    assert watch.seconds < 15 and watch.grew < 300


def test_notes10_ac2_a_small_animation_is_drawn_anew_with_its_frames_and_without_its_comment(client, operator):
    frames = [Image.new("RGB", (40, 30), color) for color in ("red", "green", "blue", "white")]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=80, loop=0,
                   comment=b"Gartenstrasse 5")
    assert b"Gartenstrasse" in out.getvalue()
    note = new_note(client, title="Animation")
    row = attached(client, note["id"], out.getvalue(), "tanz.gif")
    assert (row["kind"], row["mime"], row["preview_failed"]) == ("image", "image/gif", False)
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert b"Gartenstrasse" not in data
    with Image.open(io.BytesIO(data)) as image:
        assert image.n_frames == 4


# --- 3: AC-12 and NOTES-15 AC-3, the history of a second note ---------------------------------------------------------


def _collect() -> None:
    with SessionLocal() as db:
        attachments.collect(db)
        db.commit()


def test_notes10_ac12_notes15_ac3_a_second_note_s_version_keeps_the_picture_after_a_day(client, operator):
    home = new_note(client, title="Heimat")
    row = attached(client, home["id"], heic_with_secrets(), "Fliesen.heic")
    add_blocks(home["id"], operator.id, block("image", row))
    other = new_note(client, title="Kopie")
    add_blocks(other["id"], operator.id, block("image", row))
    version = _version_now(other["id"])
    remove_blocks(other["id"], operator.id, row["id"])
    remove_blocks(home["id"], operator.id, row["id"])
    assert refs_of(home["id"]) == refs_of(other["id"]) == []
    age_unreferenced(row["id"], timedelta(days=30))
    _collect()
    assert row_of(row["id"]) is not None
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    # What the version of the second note draws: its attachments come with the note's.
    assert row["id"] in [item["id"] for item in client.get(f"/api/notes/{other['id']}/attachments").json()["items"]]
    shown = client.get(f"/api/notes/{other['id']}/history/{version}").json()["content"]["content"]
    assert any(node["type"] == "image" and node["attrs"]["id"] == row["id"] for node in shown)
    # Restoring the version brings it back into the note.
    assert client.post(f"/api/notes/{other['id']}/history/{version}/restore").status_code == 200
    assert wait_for(lambda: refs_of(other["id"]) == [row["id"]])
    assert row_of(row["id"]).unref_at is None


def test_notes10_ac12_notes15_ac3_the_home_note_gone_for_good_leaves_the_picture_to_the_second_note_s_history(
        client, operator):
    home = new_note(client, title="Original")
    row = attached(client, home["id"], heic_with_secrets(), "Fliesen.heic")
    add_blocks(home["id"], operator.id, block("image", row))
    copy = client.post(f"/api/notes/{home['id']}/duplicate").json()
    assert wait_for(lambda: refs_of(copy["id"]) == [row["id"]])
    version = _version_now(copy["id"])
    remove_blocks(copy["id"], operator.id, row["id"])
    client.delete(f"/api/notes/{home['id']}")
    assert client.delete(f"/api/trash/notes/{home['id']}").status_code == 200
    moved = row_of(row["id"])
    assert moved is not None and moved.note_id == copy["id"]
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    # Kept as long as the copy's version names it, then gone with it.
    age_unreferenced(row["id"], timedelta(days=30))
    _collect()
    assert row_of(row["id"]) is not None
    with SessionLocal() as db:
        from app.models_history import NoteVersion

        db.get(NoteVersion, version).created_at = db.get(NoteVersion, version).created_at - timedelta(days=400)
        db.commit()
    history.thin()
    assert row_of(row["id"]) is None
    assert not any(name.startswith(row["id"]) for name in files_on_disk())


def test_notes10_ac12_a_note_that_named_a_picture_is_remembered_until_it_goes_for_good(client, operator):
    note = new_note(client, title="Erinnert")
    row = attached(client, note["id"], zip_of(), "a.zip")
    other = new_note(client, title="Zweite")
    add_blocks(other["id"], operator.id, block("attachment", row))
    remove_blocks(other["id"], operator.id, row["id"])
    with SessionLocal() as db:
        assert set(db.scalars(select(AttachmentMention.note_id))) == {other["id"]}
    client.delete(f"/api/notes/{other['id']}")
    client.delete(f"/api/trash/notes/{other['id']}")
    with SessionLocal() as db:
        assert list(db.scalars(select(AttachmentMention.note_id))) == []


# --- 4: uploads at once share the storage -----------------------------------------------------------------------------


async def _chunks(data: bytes):
    for start in range(0, len(data), 64 * 1024):
        yield data[start: start + 64 * 1024]
        await asyncio.sleep(0)


def _limit(account_id: int, size: int) -> None:
    with SessionLocal() as db:
        db.get(Account, account_id).storage_limit = size
        db.commit()


def _begin(account: Account, note_id: str, declared: int | None):
    with SessionLocal() as db:
        return attachments.begin(db, account, note_id, attachments.new_id(), "teil.zip", declared)


def _stored(account_id: int) -> int:
    with SessionLocal() as db:
        return attachments.used(db, account_id)


def _random_zip(size: int) -> bytes:
    return b"PK\x03\x04" + os.urandom(size - 4)


@pytest.mark.parametrize("declared", [True, False], ids=["length-given", "length-unknown"])
def test_notes10_ec1_eight_uploads_at_once_never_take_more_than_the_storage_has(client, operator, declared):
    note = new_note(client, title="Voll")
    _limit(operator.id, 2 * MB)
    data = _random_zip(int(1.5 * MB))
    started = []
    refused = 0
    for _ in range(8):
        try:
            started.append(_begin(operator, note["id"], len(data) if declared else None))
        except attachments.AttachmentError as exc:
            assert exc.status == 507
            refused += 1

    async def receive_all():
        return await asyncio.gather(*(attachments.receive(one, _chunks(data)) for one in started),
                                    return_exceptions=True)

    works = asyncio.run(receive_all())
    stored = 0
    for one, work in zip(started, works, strict=True):
        try:
            if isinstance(work, BaseException):
                raise work
            attachments.finish(one, work)
            stored += 1
        except attachments.AttachmentError as exc:
            assert exc.status == 507
        finally:
            attachments.release(one)
    assert stored == 1
    assert _stored(operator.id) <= 2 * MB
    assert attachments._claimed == {}
    assert not [name for name in files_on_disk() if name.startswith(attachments.WORK_PREFIX)]


def test_notes10_ec1_finish_checks_the_storage_again_under_its_lock(client, operator):
    note = new_note(client, title="Knapp")
    _limit(operator.id, 2 * MB)
    data = _random_zip(int(1.5 * MB))
    first = _begin(operator, note["id"], None)
    second = _begin(operator, note["id"], None)
    work_first = asyncio.run(attachments.receive(first, _chunks(data)))
    # The first one's claim is gone before the second comes (a race the claims cannot see): finish still says no.
    attachments.release(first)
    work_second = asyncio.run(attachments.receive(second, _chunks(data)))
    attachments.finish(first, work_first)
    with pytest.raises(attachments.AttachmentError) as full:
        attachments.finish(second, work_second)
    attachments.release(second)
    assert full.value.code == "storage_limit_reached"
    assert _stored(operator.id) <= 2 * MB
    assert not work_second.exists()


def test_notes10_ec1_an_upload_that_breaks_off_gives_its_claim_back(client, operator, monkeypatch):
    from starlette.requests import ClientDisconnect

    note = new_note(client, title="Abgebrochen")
    _limit(operator.id, 2 * MB)
    # A claim stands while an upload runs: a second one finds no room.
    first = _begin(operator, note["id"], int(1.5 * MB))
    with pytest.raises(attachments.AttachmentError):
        _begin(operator, note["id"], int(1.5 * MB))
    attachments.release(first)

    async def broken(*_args):
        raise ClientDisconnect

    monkeypatch.setattr(attachments, "receive", broken)
    answer = upload(client, note["id"], _random_zip(int(1.8 * MB)), "halb.zip")
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "upload_broken"
    assert attachments._claimed == {}
    monkeypatch.undo()
    # The whole storage is there for the next one.
    assert upload(client, note["id"], _random_zip(int(1.8 * MB)), "ganz.zip").status_code == 201


# --- 5: small things -------------------------------------------------------------------------------------------------


def test_notes10_ec1_a_full_storage_takes_no_picture_of_a_link_card(client, operator, monkeypatch):
    from app.services import linkpreview

    note = new_note(client, title="Links")
    card = linkpreview.Card(href="https://example.org/", title="Beispiel", description=None, site="example.org",
                            picture=b"RIFF" + b"\0" * 2000)
    monkeypatch.setattr(linkpreview, "fetch", lambda *_args, **_kw: card)
    with SessionLocal() as db:
        taken = attachments.used(db, operator.id)
    _limit(operator.id, taken + 1000)
    answer = client.post(f"/api/notes/{note['id']}/link-preview", json={"url": "https://example.org/"}).json()
    assert answer["preview"]["title"] == "Beispiel" and answer["preview"]["image"] is None
    assert files_on_disk() == set()
    _limit(operator.id, taken + 10_000)
    answer = client.post(f"/api/notes/{note['id']}/link-preview", json={"url": "https://example.org/"}).json()
    assert answer["preview"]["image"] is not None


def _jpeg(orientation: int, comment: bytes) -> bytes:
    image = Image.effect_noise((96, 64), 60).convert("RGB")
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"
    exif[0x0112] = orientation
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2] = "N", (52.0, 31.0, 12.0)
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif, quality=85, comment=comment)
    # A second picture after the first (what phones put there), and an XMP packet.
    return out.getvalue() + b"\xff\xd8 trailing second picture Gartenstrasse \xff\xd9"


@pytest.mark.parametrize("orientation", [1, 6], ids=["upright", "turned"])
def test_notes10_ac2_a_jpeg_comment_and_what_follows_the_picture_do_not_survive(client, operator, orientation):
    note = new_note(client, title="Kommentar")
    row = attached(client, note["id"], _jpeg(orientation, b"Gartenstrasse 5"), "foto.jpg")
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert b"Gartenstrasse" not in data and b"SecretCam" not in data
    with Image.open(io.BytesIO(data)) as image:
        assert dict(image.getexif()) == {} and "comment" not in image.info
        assert image.size == ((96, 64) if orientation == 1 else (64, 96))


# --- 7: the original to download, without encoding it again ----------------------------------------------------------


def _pixels(data: bytes) -> bytes:
    with Image.open(io.BytesIO(data)) as image:
        return image.convert("RGB").tobytes()


def test_notes10_ac2_ec3_an_upright_jpeg_keeps_its_picture_bytes_and_loses_only_its_metadata(client, operator):
    original = _jpeg(1, b"Gartenstrasse 5")
    note = new_note(client, title="Original")
    row = attached(client, note["id"], original, "foto.jpg")
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert _pixels(data) == _pixels(original)
    # The picture itself is the same bytes: from the start of the scan to its end.
    scan = original.index(b"\xff\xda")
    assert original[scan: original.index(b"\xff\xd9", scan) + 2] in data
    assert len(data) < len(original)


def test_notes10_ec3_a_heic_keeps_its_pictures_and_loses_its_exif_and_xmp_where_they_lie(client, operator):
    import pillow_heif

    pillow_heif.register_heif_opener()
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2] = "N", (52.0, 31.0, 12.0)
    out = io.BytesIO()
    Image.effect_noise((128, 96), 50).convert("RGB").save(
        out, "HEIF", exif=exif.tobytes(), quality=70,
        xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>Gartenstrasse 5</rdf:RDF></x:xmpmeta>')
    original = out.getvalue()
    assert b"SecretCam" in original and b"Gartenstrasse" in original
    note = new_note(client, title="HEIC")
    started = time.monotonic()
    row = attached(client, note["id"], original, "foto.heic")
    assert time.monotonic() - started < 10
    data = client.get(f"/api/attachments/{row['id']}/file").content
    assert b"SecretCam" not in data and b"Gartenstrasse" not in data
    # Not encoded again: the same size, the same pixels.
    assert len(data) == len(original)
    assert _pixels(data) == _pixels(original)
    with Image.open(io.BytesIO(data)) as image:
        assert 0x8825 not in image.getexif() and 0x010F not in image.getexif()


def test_notes10_a_jpeg_or_heic_that_does_not_read_is_drawn_anew_instead():
    assert media.strip_jpeg(b"\xff\xd8\xff\xe1\x00") is None
    assert media.strip_jpeg(b"not a jpeg") is None
    assert media.blank_heif(b"\x00\x00\x00\x10ftypheic") is None
    assert media.blank_heif(heic_with_secrets()[:200]) is None


# --- 5: addresses that are never asked -------------------------------------------------------------------------------


def _special_networks():
    import ipaddress

    found = []
    for constants in (ipaddress._IPv4Constants, ipaddress._IPv6Constants):
        for name, value in vars(constants).items():
            if name.startswith("_") and "exception" not in name:
                for network in value if isinstance(value, list) else [value]:
                    if isinstance(network, (ipaddress.IPv4Network, ipaddress.IPv6Network)):
                        found.append(network)
    found.append(ipaddress.ip_network("fec0::/10"))
    return found


def test_notes10_ec5_no_address_of_a_special_network_counts_as_public():
    import ipaddress

    exceptions = [network for constants in (ipaddress._IPv4Constants, ipaddress._IPv6Constants)
                  for network in getattr(constants, "_private_networks_exceptions", [])]
    for network in _special_networks():
        for address in (network.network_address, network.network_address + min(1, network.num_addresses - 1),
                        network.broadcast_address):
            if any(address in allowed for allowed in exceptions):
                continue
            assert not outbound.public(str(address)), (network, address)
    assert not outbound.public("fec0::1") and not outbound.public("feff:ffff::1")
    assert outbound.public("8.8.8.8") and outbound.public("2606:4700:4700::1111")


# --- 6: an id of another owner in one's own note ----------------------------------------------------------------------


def test_notes10_an_id_of_another_owner_in_one_s_own_note_stays_not_found_and_out_of_its_list(client, operator):
    note = new_note(client, title="Anna")
    row = attached(client, note["id"], zip_of(), "anna.zip")
    add_blocks(note["id"], operator.id, block("attachment", row))
    thief = make_account("fremd")
    with new_client(thief) as other:
        own = new_note(other, title="Meine")
        add_blocks(own["id"], thief.id, block("attachment", row))
        assert wait_for(lambda: refs_of(own["id"]) == [row["id"]])
        assert row["id"] in str(notedoc.to_json(stored_doc(own["id"])))
        assert other.get(f"/api/attachments/{row['id']}").status_code == 404
        assert other.get(f"/api/attachments/{row['id']}/file").status_code == 404
        assert other.get(f"/api/notes/{own['id']}/attachments").json()["items"] == []


def test_notes10_previews_and_recognition_share_their_two_worker_places():
    from app.services import ocr

    with worker_limits.slot(), worker_limits.slot():
        started = time.monotonic()
        with pytest.raises(ocr.EngineFailed) as busy:
            ocr.spawn({"op": "probe", "megabytes": 1}, timeout=30, wait=0.2)
        assert busy.value.code == "busy" and time.monotonic() - started < 5
        with pytest.raises(TimeoutError), worker_limits.slot(0.1):
            pass
    assert ocr.spawn({"op": "probe", "megabytes": 1}, timeout=30)["taken"] == MB
