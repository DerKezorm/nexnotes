"""NOTES-11 Texterkennung: the server's part. The queue (in the background, one after the other, in turns, after a
restart), the worker (text a PDF carries, pictures read by Tesseract, only words it is sure of), languages, the text of
the iOS app, locked notes, broken files, and the way into the search.

Most tests put a stand-in in place of the engine (``FakeEngine``): it answers with the text given for an attachment.
The worker itself runs for PDFs with their own text and for drawing pages (no Tesseract needed). Tests that need the
real Tesseract are skipped where it is not installed (a development machine under Windows)."""

from __future__ import annotations

import ctypes
import io
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from sqlalchemy import select, update

from app import ocr_worker
from app.db import SessionLocal
from app.models import Note, utcnow
from app.models_attachments import Attachment
from app.models_ocr import AttachmentOcr, AttachmentText, WorkJob
from app.notedoc.room import Access
from app.services import attachments, notes, ocr, search, settings_service, tags, workqueue

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note
from .test_notes10 import add_blocks, block, pdf_of, upload

FONT = Path(__file__).resolve().parent.parent / "app" / "fonts" / "Inter.ttf"
TESSERACT = shutil.which("tesseract")
needs_tesseract = pytest.mark.skipif(not TESSERACT, reason="Tesseract is not installed on this machine")


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def empty_index() -> None:
    search.ensure_schema()
    with SessionLocal() as db:
        db.execute(search._sql("DELETE FROM @index"))
        db.execute(search._sql("DELETE FROM @rows"))
        db.commit()


@pytest.fixture(autouse=True)
def setup(monkeypatch: pytest.MonkeyPatch):
    attachments.register()
    ocr.register()
    search.register_hooks()
    monkeypatch.setattr(workqueue, "AUTO", False)
    workqueue.stopping.clear()
    yield
    workqueue.stop()
    workqueue.stopping.clear()


class FakeEngine:
    """Stands in for the worker: answers with the pages given per attachment id (``None`` for a page without text)."""

    def __init__(self) -> None:
        self.pages: dict[str, list[str | None]] = {}
        self.requests: list[dict[str, Any]] = []
        self.running = 0
        self.most = 0
        self.pause = 0.0
        self._lock = threading.Lock()

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.running += 1
            self.most = max(self.most, self.running)
        try:
            self.requests.append(request)
            if self.pause:
                time.sleep(self.pause)
            pages = self.pages.get(Path(request["path"]).name, [""])
            wanted = request["pages"] or list(range(1, min(len(pages), request["first"]) + 1))
            results = []
            for number in wanted:
                text = pages[number - 1]
                results.append({"page": number, "state": "done" if text else "empty", "source": "ocr",
                                "text": text or ""})
            return {"ok": True, "pages": len(pages), "read": wanted, "unavailable": False, "results": results}
        finally:
            with self._lock:
                self.running -= 1

    def asked(self, attachment_id: str) -> list[dict[str, Any]]:
        return [request for request in self.requests if Path(request["path"]).name == attachment_id]


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> FakeEngine:
    fake = FakeEngine()
    monkeypatch.setattr(ocr, "ENGINE", fake)
    monkeypatch.setattr(ocr, "engine_info", lambda **_: ocr.EngineInfo(True, tuple(ocr.TESSERACT)))
    return fake


# --- Files --------------------------------------------------------------------------------------------------------


def picture(lines: list[str] | None = None, size: tuple[int, int] = (1400, 900)) -> bytes:
    """A white sheet with ``lines`` in black (a photo of a receipt or a letter, well lit), as PNG."""
    image = Image.new("RGB", size, "white")
    if lines:
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(FONT), 42)
        for number, line in enumerate(lines):
            draw.text((60, 60 + number * 64), line, fill="black", font=font)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def holiday_photo() -> bytes:
    """Sky, sea and a beach: shapes and colour, no letters."""
    image = Image.new("RGB", (1600, 1000), (120, 180, 235))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 560, 1600, 1000), fill=(20, 90, 160))
    draw.polygon([(0, 820), (1600, 700), (1600, 1000), (0, 1000)], fill=(230, 205, 150))
    draw.ellipse((1250, 90, 1420, 260), fill=(255, 230, 120))
    for x in range(0, 1600, 90):
        draw.line((x, 600, x + 60, 640), fill=(240, 240, 255), width=4)
    image = image.filter(ImageFilter.GaussianBlur(1.5))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=88)
    return out.getvalue()


def pdf_with_text(pages: list[str | None]) -> bytes:
    """A PDF whose pages carry the given text of their own (``None``: an empty page, as a scan without a layer)."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as raw

    document = pdfium.PdfDocument.new()
    for text in pages:
        page = document.new_page(595, 842)
        if text:
            font = raw.FPDFText_LoadStandardFont(document.raw, b"Helvetica")
            y = 800
            for line in text.split("\n"):
                item = raw.FPDFText_SetText
                obj = raw.FPDFPageObj_CreateTextObj(document.raw, font, 12.0)
                buffer = ctypes.create_string_buffer((line + "\x00").encode("utf-16-le"))
                item(obj, ctypes.cast(buffer, ctypes.POINTER(raw.FPDF_WCHAR)))
                raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 50, y)
                raw.FPDFPage_InsertObject(page.raw, obj)
                y -= 16
            raw.FPDFPage_GenerateContent(page.raw)
    out = io.BytesIO()
    document.save(out)
    document.close()
    return out.getvalue()


def attach(client: TestClient, note_id: str, data: bytes, name: str, account_id: int | None = None,
           **params: str) -> dict:
    """Uploads the file and puts its block into the note, as the editor does."""
    answer = client.post("/api/attachments", params={"note_id": note_id, "id": attachments.new_id(), "name": name,
                                                     **params}, content=data)
    assert answer.status_code == 201, answer.text
    row = answer.json()
    kind = "image" if row["kind"] in ("image", "scan") else "attachment"
    add_blocks(note_id, account_id, block(kind, row))
    return row


def find(client: TestClient, q: str) -> dict:
    answer = client.get("/api/search", params={"q": q})
    assert answer.status_code == 200, answer.text
    return answer.json()


def text_of(client: TestClient, attachment_id: str) -> dict:
    answer = client.get(f"/api/attachments/{attachment_id}/text")
    assert answer.status_code == 200, answer.text
    return answer.json()


def state_of(attachment_id: str) -> AttachmentOcr | None:
    with SessionLocal() as db:
        row = db.get(AttachmentOcr, attachment_id)
        if row is not None:
            db.expunge(row)
        return row


def jobs() -> list[tuple[str, str, str]]:
    with SessionLocal() as db:
        return [(job.kind, job.ref, job.state) for job in db.scalars(select(WorkJob).order_by(WorkJob.id))]


def due_now() -> None:
    """Every waiting job's time has come (the pause after a failure, the wait for the app's text)."""
    with SessionLocal() as db:
        db.execute(update(WorkJob).values(run_after=utcnow() - timedelta(seconds=1)))
        db.commit()


# --- AC-1: text in a picture or a scanned PDF is found ------------------------------------------------------------


def test_notes11_ac1_text_in_a_photo_is_found_by_the_search_once_read(client, operator, engine):
    note = new_note(client, title="Einkauf")
    photo = picture()
    row = attach(client, note["id"], photo, "Bon.png", operator.id)
    engine.pages[row["id"]] = ["Bäckerei Sonnenschein\nKassenbon Nr. 4711\nSumme 12,40 EUR"]
    assert jobs() == [("ocr", row["id"], "queued")]
    # Not read yet: the search does not know the receipt.
    assert find(client, "kassenbon")["total"] == 0
    assert workqueue.run_pending() == 1
    hit = find(client, "kassenbon")["items"][0]
    assert hit["id"] == note["id"]
    assert hit["where"] == "attachment"
    assert hit["attachment"] == {"kind": "image", "name": "Bon.png", "page": None, "ref": row["id"]}
    assert [part["text"] for part in hit["excerpt"] if part["hit"]] == ["Kassenbon"]
    assert jobs() == []
    assert state_of(row["id"]).state == "done"


def test_notes11_ac1_a_scanned_pdf_is_found_with_the_page_the_text_is_on(client, operator, engine):
    note = new_note(client, title="Post")
    row = attach(client, note["id"], pdf_of(2), "Wasser.pdf", operator.id)
    engine.pages[row["id"]] = ["Deckblatt der Stadtwerke", "Jahresrechnung Wasser 2026"]
    workqueue.run_pending()
    hit = find(client, "jahresrechnung")["items"][0]
    assert hit["attachment"]["page"] == 2
    assert hit["attachment"]["kind"] == "pdf"
    assert hit["jump"] == {"text": "Jahresrechnung", "nth": 0}


def test_notes11_ac1_only_pictures_scans_and_pdfs_are_read(client, operator, engine):
    note = new_note(client, title="Dateien")
    answer = upload(client, note["id"], b"just some text\n", "liesmich.txt")
    assert answer.status_code == 201
    assert jobs() == []
    assert state_of(answer.json()["id"]) is None


# --- AC-2: a PDF with its own text ------------------------------------------------------------------------------------


def test_notes11_ac2_a_pdf_with_text_of_its_own_is_read_without_recognising(client, operator, monkeypatch):
    # The real worker, with a Tesseract that is not there: any page it would recognise could not be read.
    monkeypatch.setattr(ocr, "tesseract", lambda: str(Path(__file__).parent / "no-tesseract-here"))
    note = new_note(client, title="Rechnung")
    letter = pdf_with_text(["Stadtwerke Beispiel\nJahresrechnung Wasser 2026\nKundennummer 12345 bitte angeben",
                            "Seite 2 der Rechnung mit Abschlaegen und Verbrauch laut Zaehler"])
    row = attach(client, note["id"], letter, "Rechnung.pdf", operator.id)
    workqueue.run_pending()
    found = text_of(client, row["id"])
    assert found["state"] == "done"
    assert [(item["page"], item["state"], item["source"]) for item in found["items"]] == \
        [(1, "done", "layer"), (2, "done", "layer")]
    assert "Jahresrechnung Wasser 2026" in found["items"][0]["text"]
    assert find(client, "kundennummer")["items"][0]["attachment"]["page"] == 1


def test_notes11_ac2_only_the_pages_without_text_are_left_for_recognition(client, operator, monkeypatch):
    monkeypatch.setattr(ocr, "tesseract", lambda: str(Path(__file__).parent / "no-tesseract-here"))
    note = new_note(client, title="Gemischt")
    row = attach(client, note["id"], pdf_with_text(["Ein Brief mit genug eigenem Text auf der ersten Seite", None]),
                 "Brief.pdf", operator.id)
    workqueue.run_pending()
    found = text_of(client, row["id"])
    # Page 1 was read as it is; page 2 needed Tesseract, which is missing here.
    assert found["items"][0]["source"] == "layer"
    assert found["items"][1]["state"] == "pending"
    assert found["state"] == "unavailable"


# --- AC-3, AC-7: the text page by page, with its language, and what is still being read -----------------------------


def test_notes11_ac3_ac7_text_page_by_page_with_language_and_pages_still_being_read(client, operator, engine):
    note = new_note(client, title="Scan")
    row = attach(client, note["id"], pdf_of(6), "Scan.pdf", operator.id)
    engine.pages[row["id"]] = ["Die Rechnung ist bitte bis zum Monatsende zu zahlen und wir danken"] + \
        ["Please pay the invoice by the end of the month and thank you for your order"] * 5
    workqueue.run_pending(limit=1)
    first = text_of(client, row["id"])
    assert first["state"] == "working"
    assert first["pages"] == 6
    assert [(item["page"], item["state"]) for item in first["items"]] == \
        [(1, "done"), (2, "done"), (3, "done"), (4, "done"), (5, "pending"), (6, "pending")]
    assert first["items"][0]["language"] == "de"
    assert first["items"][1]["language"] == "en"
    workqueue.run_pending()
    assert text_of(client, row["id"])["state"] == "done"


def test_notes11_ac3_pages_of_a_pdf_come_as_pictures_for_the_large_view(client, operator):
    note = new_note(client, title="PDF")
    row = attach(client, note["id"], pdf_of(2), "Zwei.pdf", operator.id)
    answer = client.get(f"/api/attachments/{row['id']}/pages/2", params={"width": 400})
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "image/webp"
    assert answer.headers["x-content-type-options"] == "nosniff"
    assert abs(Image.open(io.BytesIO(answer.content)).size[0] - 400) <= 1
    assert client.get(f"/api/attachments/{row['id']}/pages/3").status_code == 404


def test_notes11_the_text_goes_only_to_who_may_read_the_note(client, operator, engine):
    note = new_note(client, title="Privat")
    row = attach(client, note["id"], picture(), "Bon.png", operator.id)
    engine.pages[row["id"]] = ["Geheimer Kassenbon"]
    workqueue.run_pending()
    other = make_account("fremd")
    with new_client(other) as stranger:
        assert stranger.get(f"/api/attachments/{row['id']}/text").status_code == 404
        assert stranger.put(f"/api/attachments/{row['id']}/text", json={"pages": [{"text": "x"}]}).status_code == 404
        assert stranger.get(f"/api/attachments/{row['id']}/pages/1").status_code == 404
        assert stranger.get("/api/search", params={"q": "kassenbon"}).json()["total"] == 0


# --- AC-4: real Tesseract on good copies ------------------------------------------------------------------------------

SAMPLES = {
    "Kassenbon.png": ["Baeckerei Sonnenschein", "Kassenbon Nummer 4711", "Vollkornbrot 3,20 EUR",
                      "Summe 12,40 EUR"],
    "Brief.png": ["Sehr geehrte Damen und Herren,", "wir danken Ihnen fuer Ihre Bestellung", "Mit freundlichen Gruessen"],
    "Invoice.png": ["Invoice number 2026-118", "Thank you for your order", "Please pay within fourteen days"],
}


def _words(lines: list[str]) -> set[str]:
    return {word.strip(",.").lower() for line in lines for word in line.split() if len(word.strip(",.")) > 3}


@needs_tesseract
def test_notes11_ac4_receipts_letters_and_invoices_in_german_and_english_are_read_well(client, operator):
    note = new_note(client, title="Belege")
    rows = {name: attach(client, note["id"], picture(lines), name, operator.id) for name, lines in SAMPLES.items()}
    workqueue.run_pending()
    for name, lines in SAMPLES.items():
        found = text_of(client, rows[name]["id"])
        assert found["state"] == "done", found
        read = found["items"][0]["text"].lower()
        wanted = _words(lines)
        missing = [word for word in wanted if word not in read]
        assert len(missing) <= len(wanted) // 5, (name, missing, read)
    assert find(client, "kassenbon")["total"] == 1
    assert text_of(client, rows["Invoice.png"]["id"])["items"][0]["language"] == "en"


# --- EC-3: a picture without text brings no nonsense --------------------------------------------------------------

TSV_HEAD = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"


def _tsv(words: list[tuple[str, float, int]]) -> str:
    rows = [TSV_HEAD]
    for number, (word, confidence, line) in enumerate(words, start=1):
        rows.append(f"5\t1\t1\t1\t{line}\t{number}\t0\t0\t10\t10\t{confidence}\t{word}")
    return "\n".join(rows)


def test_notes11_ec3_scratches_tesseract_is_unsure_of_make_no_text():
    noise = _tsv([("|", 30.0, 1), ("~~", 12.0, 1), ("Wl", 41.0, 2), ("ii", 22.5, 2), ("aa", 58.0, 3), (".", 90.0, 3)])
    text, confidence, characters = ocr_worker.text_from_tsv(noise)
    assert not ocr_worker.worth_keeping(text, confidence, characters)
    # One sure word on a photo (a sign) is not text either.
    sign = _tsv([("STOP", 92.0, 1)])
    assert not ocr_worker.worth_keeping(*ocr_worker.text_from_tsv(sign))
    letter = _tsv([("Sehr", 95.0, 1), ("geehrte", 93.0, 1), ("Damen", 91.0, 1), ("xq", 20.0, 2), ("Gruss", 89.0, 2)])
    text, confidence, characters = ocr_worker.text_from_tsv(letter)
    assert text == "Sehr geehrte Damen\nGruss"
    assert ocr_worker.worth_keeping(text, confidence, characters)


def test_notes11_ec3_a_page_without_text_puts_nothing_into_the_search(client, operator, engine):
    note = new_note(client, title="Urlaub")
    row = attach(client, note["id"], holiday_photo(), "Strand.jpg", operator.id)
    engine.pages[row["id"]] = [None]
    workqueue.run_pending()
    found = text_of(client, row["id"])
    assert found["state"] == "done"
    assert found["items"] == [{"page": 1, "state": "empty", "text": "", "language": "", "source": "ocr"}]
    with SessionLocal() as db:
        note_row = db.get(Note, note["id"])
        assert ocr.texts_of(db, note_row) == []
        extra = db.execute(search._sql("SELECT extra FROM @index")).scalars().all()
    assert extra == [""]


@needs_tesseract
def test_notes11_ec3_a_real_holiday_photo_has_no_text(client, operator):
    note = new_note(client, title="Urlaub")
    row = attach(client, note["id"], holiday_photo(), "Strand.jpg", operator.id)
    workqueue.run_pending()
    assert text_of(client, row["id"])["items"][0]["state"] == "empty"


# --- AC-5: the iOS app brings the text --------------------------------------------------------------------------------


def test_notes11_ac5_a_scan_from_the_app_keeps_its_text_and_is_not_read_again(client, operator, engine):
    note = new_note(client, title="Scan vom iPhone")
    row = attach(client, note["id"], picture(), "Scan.jpg", operator.id, text="device", **{"as": "scan"})
    assert row["kind"] == "scan"
    assert state_of(row["id"]).state == "device"
    # The server waits for the app's text and reads nothing meanwhile.
    assert workqueue.run_pending() == 0
    answer = client.put(f"/api/attachments/{row['id']}/text", json={"pages": [
        {"text": "Mietvertrag Wohnung Gartenstrasse", "language": "de"}]})
    assert answer.status_code == 200, answer.text
    assert answer.json()["items"][0] == {"page": 1, "state": "done", "text": "Mietvertrag Wohnung Gartenstrasse",
                                         "language": "de", "source": "device"}
    assert jobs() == []
    due_now()
    workqueue.run_pending()
    assert engine.requests == []
    assert find(client, "mietvertrag")["items"][0]["attachment"]["kind"] == "scan"


def test_notes11_ac5_without_the_app_s_text_the_server_reads_after_a_while(client, operator, engine):
    note = new_note(client, title="Scan")
    row = attach(client, note["id"], picture(), "Scan.jpg", operator.id, text="device")
    engine.pages[row["id"]] = ["Text aus dem Bild"]
    assert workqueue.run_pending() == 0
    due_now()
    assert workqueue.run_pending() == 1
    assert text_of(client, row["id"])["items"][0]["text"] == "Text aus dem Bild"


def test_notes11_ac5_the_app_s_text_replaces_what_the_server_read(client, operator, engine):
    note = new_note(client, title="Scan")
    row = attach(client, note["id"], pdf_of(3), "Scan.pdf", operator.id)
    engine.pages[row["id"]] = ["alt eins", "alt zwei", "alt drei"]
    workqueue.run_pending()
    answer = client.put(f"/api/attachments/{row['id']}/text", json={"pages": [{"text": "Neu vom Geraet"}]})
    assert answer.status_code == 200
    assert [item["text"] for item in answer.json()["items"]] == ["Neu vom Geraet"]
    assert find(client, "alt")["total"] == 0
    assert find(client, "geraet")["total"] == 1


def test_notes11_ac5_text_only_with_the_right_to_write_and_only_for_what_carries_text(client, operator, engine,
                                                                                       monkeypatch):
    note = new_note(client, title="Dateien")
    photo = attach(client, note["id"], picture(), "Bon.png", operator.id)
    reader = make_account("leser")
    monkeypatch.setattr(notes, "ACCESS_RULES", [lambda _db, account, _note: Access.READ if account.id == reader.id
                                                 else None])
    with new_client(reader) as reading:
        assert reading.get(f"/api/attachments/{photo['id']}/text").status_code == 200
        answer = reading.put(f"/api/attachments/{photo['id']}/text", json={"pages": [{"text": "fremd"}]})
        assert answer.status_code in (403, 404), answer.text
    assert state_of(photo["id"]).state == "queued"
    # Only the roles the app knows.
    refused = client.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(), "name": "a.png",
                                                      "as": "poster"}, content=picture())
    assert refused.status_code == 422
    other = upload(client, note["id"], b"plain\n", "a.txt").json()
    answer = client.put(f"/api/attachments/{other['id']}/text", json={"pages": [{"text": "x"}]})
    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "text_not_possible"
    assert client.put(f"/api/attachments/{other['id']}/text", json={"pages": []}).status_code == 422


# --- AC-6, EC-5: the operator's languages ---------------------------------------------------------------------------


def test_notes11_ac6_languages_the_operator_adds_are_read(client, operator, engine):
    note = new_note(client, title="Briefe")
    first = attach(client, note["id"], picture(), "Brief1.png", operator.id)
    workqueue.run_pending()
    assert engine.asked(first["id"])[0]["languages"] == ["deu", "eng"]
    assert client.put("/api/settings", json={"ocr_languages": ["de", "en", "fr"]}).status_code == 200
    letter = attach(client, note["id"], picture(), "Lettre.png", operator.id)
    engine.pages[letter["id"]] = ["Nous vous remercions pour votre commande et sommes à votre disposition"]
    workqueue.run_pending()
    assert engine.asked(letter["id"])[0]["languages"] == ["deu", "eng", "fra"]
    assert text_of(client, letter["id"])["items"][0]["language"] == "fr"
    assert find(client, "remercions")["total"] == 1


def test_notes11_ac6_a_language_whose_pack_is_missing_is_left_out(client, operator, engine, monkeypatch):
    monkeypatch.setattr(ocr, "engine_info", lambda **_: ocr.EngineInfo(True, ("de", "en")))
    with SessionLocal() as db:
        settings_service.save(db, {"ocr_languages": ["de", "en", "tr"]})
    note = new_note(client, title="Brief")
    row = attach(client, note["id"], picture(), "Mektup.png", operator.id)
    workqueue.run_pending()
    assert engine.asked(row["id"])[0]["languages"] == ["deu", "eng"]


def test_notes11_ec5_a_new_language_does_not_read_existing_attachments_again(client, operator, engine):
    note = new_note(client, title="Alt")
    old = attach(client, note["id"], picture(), "Alt.png", operator.id)
    engine.pages[old["id"]] = ["Ein alter Brief"]
    workqueue.run_pending()
    asked = len(engine.requests)
    assert client.put("/api/settings", json={"ocr_languages": ["de", "en", "fr", "nl"]}).status_code == 200
    assert jobs() == []
    workqueue.run_pending()
    assert ocr.catch_up() == 0
    assert jobs() == []
    workqueue.run_pending()
    assert len(engine.requests) == asked
    assert state_of(old["id"]).languages == "deu+eng"


def test_notes11_the_language_of_a_page_is_told_from_its_common_words():
    chosen = ["de", "en", "fr", "es", "it", "nl", "pt", "pl", "tr"]
    assert ocr.language_of("Sehr geehrte Damen und Herren, wir danken für Ihre Bestellung", chosen) == "de"
    assert ocr.language_of("Thank you for your order, please pay the invoice", chosen) == "en"
    assert ocr.language_of("Nous vous remercions pour votre commande", chosen) == "fr"
    assert ocr.language_of("Gracias por su pedido, usted está en la lista", chosen) == "es"
    assert ocr.language_of("Wij danken u voor uw bestelling en het is naar", chosen) == "nl"
    assert ocr.language_of("Dziękujemy za zamówienie i to jest dla nas", chosen) == "pl"
    assert ocr.language_of("Siparişiniz için çok teşekkür ederiz ve bu", chosen) == "tr"
    # Too little to tell, or a language the operator did not choose.
    assert ocr.language_of("4711 12,40", chosen) == ""
    assert ocr.language_of("Nous vous remercions pour votre commande", ["de", "en"]) == ""


# --- EC-1: in the background, one after the other -------------------------------------------------------------------


@pytest.mark.timing
def test_notes11_ec1_many_attachments_are_read_in_the_background_one_after_the_other(client, operator, engine,
                                                                                    monkeypatch):
    engine.pause = 0.05
    note = new_note(client, title="Viele Belege")
    rows = []
    for number in range(8):
        rows.append(attach(client, note["id"], picture(), f"Bon{number}.png", operator.id))
        engine.pages[rows[-1]["id"]] = [f"Beleg Nummer {number} vom Markt"]
    # Uploading never waited for the recognition.
    assert engine.requests == []
    monkeypatch.setattr(workqueue, "AUTO", True)
    workqueue.kick()
    started = time.monotonic()
    # Writing goes on meanwhile.
    for number in range(5):
        before = time.monotonic()
        assert client.put(f"/api/notes/{note['id']}/title", json={"title": f"Belege {number}"}).status_code == 200
        assert time.monotonic() - before < 1.0
    while time.monotonic() - started < 20 and any(state_of(row["id"]).state != "done" for row in rows):
        time.sleep(0.05)
    assert all(state_of(row["id"]).state == "done" for row in rows)
    assert engine.most == 1
    assert find(client, "markt")["total"] == 1


# --- EC-2: the recognition fails --------------------------------------------------------------------------------------


def test_notes11_ec2_a_broken_picture_stays_usable_without_text(client, operator):
    note = new_note(client, title="Kaputt")
    row = attach(client, note["id"], picture(), "Kaputt.png", operator.id)
    # The file on disk broke after it came in: the worker cannot read it.
    attachments.path_of(row["id"]).write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    workqueue.run_pending()
    found = text_of(client, row["id"])
    assert found["state"] == "failed"
    assert jobs() == []
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    assert client.get(f"/api/notes/{note['id']}/attachments").json()["items"][0]["id"] == row["id"]


def test_notes11_ec2_a_recognition_that_keeps_failing_gives_up_after_three_tries(client, operator, engine,
                                                                                monkeypatch):
    calls = []

    def failing(request):
        calls.append(request)
        raise ocr.EngineFailed("timeout", retry=True)

    monkeypatch.setattr(ocr, "ENGINE", failing)
    note = new_note(client, title="Langsam")
    row = attach(client, note["id"], picture(), "Langsam.png", operator.id)
    for _ in range(workqueue.ATTEMPTS):
        due_now()
        workqueue.run_pending()
    assert len(calls) == workqueue.ATTEMPTS
    assert jobs() == []
    assert text_of(client, row["id"])["state"] == "failed"


# --- EC-4: a restart ------------------------------------------------------------------------------------------------


def test_notes11_ec4_after_a_restart_the_recognition_goes_on_where_it_was(client, operator, engine):
    note = new_note(client, title="Langes PDF")
    row = attach(client, note["id"], pdf_of(10), "Lang.pdf", operator.id)
    engine.pages[row["id"]] = [f"Seite {number} mit Inhalt" for number in range(1, 11)]
    workqueue.run_pending(limit=1)
    # The server stops while the next turn runs: the job stays "running" in the database.
    with SessionLocal() as db:
        db.execute(update(WorkJob).values(state="running"))
        db.commit()
    assert workqueue.run_pending() == 0
    assert workqueue.recover() == 1
    workqueue.run_pending()
    assert [request["pages"] for request in engine.asked(row["id"])] == [None, [5, 6, 7, 8], [9, 10]]
    assert text_of(client, row["id"])["state"] == "done"


def test_notes11_ec4_a_turn_broken_off_by_the_stop_waits_without_counting(client, operator, engine, monkeypatch):
    def stopped(_request):
        raise workqueue.Interrupted

    monkeypatch.setattr(ocr, "ENGINE", stopped)
    note = new_note(client, title="Stopp")
    attach(client, note["id"], picture(), "Stopp.png", operator.id)
    workqueue.run_one()
    with SessionLocal() as db:
        job = db.scalars(select(WorkJob)).one()
        assert (job.state, job.attempts) == ("queued", 0)


def test_notes11_ec4_attachments_from_before_and_from_a_server_without_tesseract_are_caught_up(client, operator,
                                                                                               engine, monkeypatch):
    note = new_note(client, title="Alt")
    old = attach(client, note["id"], picture(), "Alt.png", operator.id)
    missing = attach(client, note["id"], picture(), "Ohne.png", operator.id)
    with SessionLocal() as db:
        db.query(WorkJob).delete()
        db.query(AttachmentOcr).filter_by(attachment_id=old["id"]).delete()
        db.execute(update(AttachmentOcr).where(AttachmentOcr.attachment_id == missing["id"])
                   .values(state="unavailable"))
        db.commit()
    assert ocr.catch_up() == 2
    workqueue.run_pending()
    assert state_of(old["id"]).state == "done"
    assert state_of(missing["id"]).state == "done"


def test_notes11_without_tesseract_a_picture_waits_and_says_so(client, operator, monkeypatch):
    monkeypatch.setattr(ocr, "tesseract", lambda: None)
    monkeypatch.setattr(ocr_worker.shutil, "which", lambda _name: None)
    note = new_note(client, title="Ohne")
    row = attach(client, note["id"], picture(), "Ohne.png", operator.id)
    if TESSERACT:
        pytest.skip("the worker finds Tesseract on the path of this machine")
    workqueue.run_pending()
    found = text_of(client, row["id"])
    assert found["state"] == "unavailable"
    assert found["items"][0]["state"] == "pending"


# --- EC-6: a long PDF does not hold up the others ---------------------------------------------------------------------


def test_notes11_ec6_a_pdf_of_300_pages_does_not_hold_up_the_others(client, operator, engine):
    note = new_note(client, title="Handbuch")
    big = attach(client, note["id"], pdf_of(1), "Handbuch.pdf", operator.id)
    engine.pages[big["id"]] = [f"Kapitel {number}" for number in range(1, 301)]
    workqueue.run_pending(limit=1)
    small = attach(client, note["id"], picture(), "Bon.png", operator.id)
    engine.pages[small["id"]] = ["Kleiner Kassenbon"]
    workqueue.run_pending(limit=2)
    assert state_of(small["id"]).state == "done"
    assert state_of(big["id"]).state == "working"
    workqueue.run_pending()
    assert len(engine.asked(big["id"])) == 75
    found = text_of(client, big["id"])
    assert found["state"] == "done" and len(found["items"]) == 300


# --- EC-7: a locked note ------------------------------------------------------------------------------------------


def test_notes11_ec7_the_attachments_of_a_locked_note_are_not_read(client, operator, engine, monkeypatch):
    note = new_note(client, title="Tresor")
    row = attach(client, note["id"], picture(), "Geheim.png", operator.id)
    engine.pages[row["id"]] = ["Geheimer Text"]
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id == note["id"]])
    workqueue.run_pending()
    assert engine.requests == []
    assert state_of(row["id"]).state == "locked"
    assert text_of(client, row["id"]) == {"id": row["id"], "state": "locked", "pages": 1, "items": []}
    answer = client.put(f"/api/attachments/{row['id']}/text", json={"pages": [{"text": "x"}]})
    assert answer.status_code == 409
    assert find(client, "geheimer")["total"] == 0


# --- The way into the search ----------------------------------------------------------------------------------------


def test_notes11_a_note_finds_the_text_only_of_attachments_it_names(client, operator, engine):
    first = new_note(client, title="Erste")
    second = new_note(client, title="Zweite")
    row = attach(client, first["id"], picture(), "Bon.png", operator.id)
    engine.pages[row["id"]] = ["Gemeinsamer Kassenbon"]
    workqueue.run_pending()
    assert [item["id"] for item in find(client, "gemeinsamer")["items"]] == [first["id"]]
    # Pasted into the second note too: both find it.
    add_blocks(second["id"], operator.id, block("image", row))
    assert sorted(item["id"] for item in find(client, "gemeinsamer")["items"]) == sorted([first["id"], second["id"]])


def test_notes11_the_engine_s_environment_has_its_own_home(tmp_path):
    environment = ocr.worker_environment(str(tmp_path))
    assert environment["HOME"] == str(tmp_path)
    assert not any(key.startswith("NEXNOTES_") for key in environment)


def test_notes11_the_text_goes_when_its_attachment_goes(client, operator, engine):
    note = new_note(client, title="Weg")
    row = attach(client, note["id"], picture(), "Weg.png", operator.id)
    engine.pages[row["id"]] = ["Bald weg"]
    workqueue.run_pending()
    with SessionLocal() as db:
        db.delete(db.get(Attachment, row["id"]))
        db.commit()
        assert db.scalars(select(AttachmentText)).all() == []
        assert db.get(AttachmentOcr, row["id"]) is None


# --- Hard limits of the worker ----------------------------------------------------------------------------------------


def test_notes11_the_worker_has_hard_limits_and_refuses_to_work_without_them(monkeypatch):
    monkeypatch.setattr(ocr, "MEMORY_MB", 200)
    assert ocr.spawn({"op": "probe", "megabytes": 40}, timeout=60)["taken"] == 40 * 1024 * 1024
    with pytest.raises(ocr.EngineFailed) as refused:
        ocr.spawn({"op": "probe", "megabytes": 600}, timeout=60)
    assert refused.value.code == "too_large"
    monkeypatch.setattr(ocr, "MEMORY_MB", 0)
    with pytest.raises(ocr.EngineFailed) as unguarded:
        ocr.spawn({"op": "probe", "megabytes": 1}, timeout=60)
    assert unguarded.value.code == "unguarded"


def test_notes11_never_two_workers_at_once():
    assert ocr._one_at_a_time.acquire(blocking=False)
    try:
        started = time.monotonic()
        with pytest.raises(ocr.EngineFailed) as busy:
            ocr.spawn({"op": "probe", "megabytes": 1}, timeout=30, wait=0.2)
        assert busy.value.code == "busy"
        assert time.monotonic() - started < 5
    finally:
        ocr._one_at_a_time.release()
