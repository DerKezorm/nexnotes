"""NOTES-17 Export: one note as Markdown or PDF, a folder or everything as a ZIP in the background.

Attachments (NOTES-10), sketches and recordings (NOTES-18), sharing (NOTES-13) and the vault (NOTES-16) are not built
yet; they dock on through ``export.ATTACHMENT_SOURCES``, ``tags.SHARED_NOTES`` with ``notes.ACCESS_RULES`` and
``tags.HIDDEN_NOTES``. The tests stand in for them there.
"""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Callable
from datetime import timedelta

import pytest
from pypdf import PdfReader
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Note, NoteUpdate, utcnow
from app.models_export import FAILED, QUEUED, READY, RUNNING, ExportJob
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import from_markdown, to_markdown
from app.notedoc.room import Access
from app.services import cleanup, content, export, export_pdf, notes, tags

from .conftest import make_account, new_client

RICH = """## Plan **B**

Text with *italic*, ~~strike~~, <u>under</u>, `code`, a [link](https://example.com/a?b=1) and <mark>marked</mark> \
and <mark data-color="green">green</mark>.

- one
- two
  - nested

1. first
2. second

- [ ] open task
- [x] done task

| Name | Count |
| --- | --- |
| Milk | 2 |
| Bread | 1 |

> quoted

```python
print("hi")
```

---

### Folded below
#einkauf at the start, and #haushalt in the middle.
"""


@pytest.fixture(autouse=True)
def quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    # Typst in this process: a process of its own for every PDF only costs time in tests.
    monkeypatch.setattr(export_pdf, "INLINE", True)
    # The jobs run when the test says so (``run_pending``), not in a thread of their own.
    monkeypatch.setattr(export, "AUTO", False)
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


@pytest.fixture
def sharing(monkeypatch: pytest.MonkeyPatch):
    """Stands in for sharing (NOTES-13): ``sharing[account_id] = {note id: right}``."""
    shared: dict[int, dict[str, Access]] = {}

    def rule(_db, account, note):
        return shared.get(account.id, {}).get(note.id)

    monkeypatch.setattr(notes, "ACCESS_RULES", [rule])
    monkeypatch.setattr(tags, "SHARED_NOTES", [lambda account_id: select(Note.id).where(
        Note.id.in_(sorted(shared.get(account_id, {}))))])
    return shared


@pytest.fixture
def locking(monkeypatch: pytest.MonkeyPatch):
    """Stands in for the vault (NOTES-16): notes whose ids are in the set are locked."""
    locked: set[str] = set()
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id.in_(sorted(locked))])
    return locked


@pytest.fixture
def attachments(monkeypatch: pytest.MonkeyPatch):
    """Stands in for attachments (NOTES-10), sketches and recordings (NOTES-18): ``attachments[note_id]`` is a list
    of ``(name, kind, bytes)``; ``attachments.opened`` counts the streams that were opened and closed."""

    class Files(dict):
        opened = 0
        closed = 0

    files = Files()

    class Stream(io.BytesIO):
        def close(self) -> None:
            files.closed += 1
            super().close()

    def opener(data: bytes) -> Callable[[], io.BytesIO]:
        def open_it() -> io.BytesIO:
            files.opened += 1
            return Stream(data)
        return open_it

    def source(_db, note):
        return [export.ExportFile(id=f"{note.id}-{index}", name=name, kind=kind, size=len(data), open=opener(data))
                for index, (name, kind, data) in enumerate(files.get(note.id, []))]

    def total(_db, note_ids):
        return sum(len(data) for note_id in note_ids for _name, _kind, data in files.get(note_id, []))

    monkeypatch.setattr(export, "ATTACHMENT_SOURCES", [source])
    monkeypatch.setattr(export, "ATTACHMENT_TOTALS", [total])
    return files


def png(colour: str = "red") -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (40, 20), colour).save(out, "PNG")
    return out.getvalue()


def make_folder(client, name: str, parent: str | None = None) -> str:
    answer = client.post("/api/folders", json={"name": name, "parent_id": parent})
    assert answer.status_code in (200, 201), answer.text
    return answer.json()["id"]


def new_note(client, title: str, markdown: str = "", folder: str | None = None) -> str:
    answer = client.post("/api/notes", json={"title": title, "markdown": markdown, "folder_id": folder})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def front_and_body(text: str) -> tuple[dict[str, str], str]:
    assert text.startswith("---\n"), text[:80]
    head, _, body = text[4:].partition("\n---\n")
    values = {}
    for line in head.splitlines():
        key, _, value = line.partition(": ")
        values[key] = value
    return values, body.lstrip("\n")


def markdown_of(client, note_id: str) -> str:
    answer = client.get(f"/api/export/notes/{note_id}/markdown")
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"].startswith("text/markdown")
    return answer.text


def pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def zip_of(client, folder: str | None = None) -> zipfile.ZipFile:
    """Starts an export, runs it, fetches the ZIP."""
    answer = client.post("/api/export/jobs", json={"folder_id": folder})
    assert answer.status_code == 202, answer.text
    job = answer.json()
    assert job["status"] == QUEUED
    export.run_pending()
    jobs = {item["id"]: item for item in client.get("/api/export/jobs").json()}
    assert jobs[job["id"]]["status"] == READY, jobs[job["id"]]
    download = client.get(f"/api/export/jobs/{job['id']}/download")
    assert download.status_code == 200, download.text
    return zipfile.ZipFile(io.BytesIO(download.content))


def assert_inside(names: list[str]) -> None:
    """Every entry stays inside the ZIP: relative, no ``..``, no backslash, no drive."""
    for name in names:
        assert not name.startswith("/") and "\\" not in name and ":" not in name, name
        assert all(part not in ("", ".", "..") for part in name.rstrip("/").split("/")), name


# --- AC-1: one note as Markdown ---------------------------------------------------------------------------------------


def test_notes17_ac1_a_note_as_markdown_keeps_title_headings_lists_tables_links_highlights(client, operator):
    note_id = new_note(client, "Wochenplan", RICH)
    answer = client.get(f"/api/export/notes/{note_id}/markdown")
    assert answer.status_code == 200
    assert "filename*=UTF-8''Wochenplan.md" in answer.headers["content-disposition"]
    front, body = front_and_body(answer.text)
    assert front["title"] == '"Wochenplan"'
    assert body.startswith("# Wochenplan\n\n## Plan **B**\n")
    for piece in ("*italic*", "~~strike~~", "<u>under</u>", "`code`", "[link](https://example.com/a?b=1)",
                  "<mark>marked</mark>", '<mark data-color="green">green</mark>', "- one", "  - nested",
                  "1. first", "- [ ] open task", "- [x] done task", "| Name | Count |", "| --- | --- |",
                  "| Milk | 2 |", "> quoted", '```python\nprint("hi")\n```', "---", "### Folded below"):
        assert piece in body, piece
    # Read back, the Markdown is the note again: nothing lost on the way out.
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        document = notedoc.clean_doc(notedoc.to_json(export.current_doc(db, note.id)))
    assert from_markdown(body.split("\n", 2)[2]) == document


def test_notes17_ac1_the_markdown_is_the_note_as_it_is_now(client, operator):
    """What the editor wrote a moment ago is stored as an update, not folded yet: the export has it."""
    note_id = new_note(client, "Live", "first")
    with SessionLocal() as db:
        doc = export.current_doc(db, note_id)
        _done, update = notedoc.change(doc, lambda d: edit.append_paragraph(d, "typed just now"))
        db.add(NoteUpdate(note_id=note_id, update=update, account_id=operator.id))
        db.commit()
    assert "typed just now" in markdown_of(client, note_id)


def test_notes17_ac1_with_attachments_a_zip_of_the_file_and_a_folder_of_them(client, operator, attachments):
    note_id = new_note(client, "Sofa (Maße)", "Breite 2,10 m")
    picture = png()
    attachments[note_id] = [("foto.png", "image", picture), ("Rechnung März.pdf", "pdf", b"%PDF-1.4 fake"),
                            ("foto.png", "image", png("blue"))]
    answer = client.get(f"/api/export/notes/{note_id}/markdown")
    assert answer.status_code == 200 and answer.headers["content-type"] == "application/zip"
    assert "filename*=UTF-8''Sofa%20%28Ma%C3%9Fe%29.zip" in answer.headers["content-disposition"]
    archive = zipfile.ZipFile(io.BytesIO(answer.content))
    names = archive.namelist()
    assert_inside(names)
    folder = "Sofa (Maße) (Attachments)"
    assert set(names) == {"Sofa (Maße).md", f"{folder}/", f"{folder}/foto.png", f"{folder}/Rechnung März.pdf",
                          f"{folder}/foto (2).png"}
    assert archive.read(f"{folder}/foto.png") == picture
    text = archive.read("Sofa (Maße).md").decode("utf-8")
    # Linked, and every link leads to a file in the ZIP.
    links = re.findall(r"\]\(([^)]+)\)", text)
    assert len(links) == 3
    from urllib.parse import unquote
    assert {unquote(link) for link in links} == {f"{folder}/foto.png", f"{folder}/Rechnung März.pdf",
                                                 f"{folder}/foto (2).png"}
    assert "![foto.png](Sofa%20%28Ma%C3%9Fe%29%20%28Attachments%29/foto.png)" in text
    assert "- [Rechnung März.pdf](" in text
    # The temporary file is gone once it was sent, every stream closed.
    assert not list(export.export_dir().glob("*.tmp"))
    assert attachments.opened == attachments.closed == 3


# --- AC-2: one note as PDF --------------------------------------------------------------------------------------------


def test_notes17_ac2_the_pdf_shows_the_note_with_symbol_boxes_tables_code_and_links(client, operator, monkeypatch):
    note_id = new_note(client, "Einkauf", RICH)
    assert client.put(f"/api/notes/{note_id}/icon", json={"icon": "shopping-cart"}).status_code == 200
    assert client.put(f"/api/notes/{note_id}/color", json={"color": "green"}).status_code == 200
    sources: list[str] = []
    real = export_pdf.document

    def keep(*args, **kwargs):
        sources.append(real(*args, **kwargs))
        return sources[-1]

    monkeypatch.setattr(export_pdf, "document", keep)
    answer = client.get(f"/api/export/notes/{note_id}/pdf")
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "application/pdf"
    assert "filename*=UTF-8''Einkauf.pdf" in answer.headers["content-disposition"]
    text = pdf_text(answer.content)
    for piece in ("Einkauf", "Plan B", "italic", "open task", "done task", "Name", "Count", "Milk", "Bread",
                  "quoted", 'print("hi")', "Folded below", "#einkauf", "link", "marked", "nested", "first"):
        assert piece in text, piece
    reader = PdfReader(io.BytesIO(answer.content))
    uris = [annotation.get_object()["/A"]["/URI"] for page in reader.pages for annotation in page.get("/Annots", [])]
    assert "https://example.com/a?b=1" in uris
    source = sources[0]
    # The symbol before the title, in the note's colour; the boxes of the checklist, one checked.
    assert 'image("icon.svg"' in source
    assert "nn-box(false)" in source and "nn-box(true)" in source and "#nn-done" in source
    assert "#table(columns: 2, align: (left, left,)" in source and "table.header(" in source
    assert 'fill: rgb(74, 222, 128, 42%)' in source and 'fill: rgb(242, 193, 78, 50%)' in source
    assert "Inter" in source


def test_notes17_ac2_words_of_a_note_never_run_as_typst(client, operator):
    title = 'Evil"); #panic("boom") //'
    note_id = new_note(client, title, '#set page(fill: red)\n\n`"); #panic("x")` and \\ and "quotes"')
    answer = client.get(f"/api/export/notes/{note_id}/pdf")
    assert answer.status_code == 200, answer.text
    text = pdf_text(answer.content)
    assert "#panic" in text and "#set page(fill: red)" in text


def test_notes17_ac2_the_pdf_draws_pictures_and_sketches_and_names_other_files(client, operator, attachments):
    note_id = new_note(client, "Mit Bildern", "Text")
    attachments[note_id] = [("foto.png", "image", png()), ("Vertrag.pdf", "pdf", b"%PDF-1.4"),
                            ("kaputt.png", "image", b"not a picture")]
    answer = client.get(f"/api/export/notes/{note_id}/pdf")
    assert answer.status_code == 200, answer.text
    reader = PdfReader(io.BytesIO(answer.content))
    pictures = [image for page in reader.pages for image in page.images]
    assert len(pictures) >= 1
    text = pdf_text(answer.content)
    assert "Attachments" in text and "Vertrag.pdf" in text and "foto.png" in text


def test_notes17_ac2_the_pdf_comes_from_a_process_of_its_own(client, operator, monkeypatch):
    monkeypatch.setattr(export_pdf, "INLINE", False)
    note_id = new_note(client, "Getrennt", "Hallo")
    answer = client.get(f"/api/export/notes/{note_id}/pdf")
    assert answer.status_code == 200
    assert "Hallo" in pdf_text(answer.content)


# --- AC-3, AC-4: everything and a folder as ZIP ----------------------------------------------------------------------


def test_notes17_ac3_everything_in_its_folders_with_shared_notes_per_owner(client, operator, sharing):
    house = make_folder(client, "Haushalt")
    garden = make_folder(client, "Garten", house)
    make_folder(client, "Leer")
    new_note(client, "Einkauf", "Milch", house)
    new_note(client, "Beet", "Tomaten", garden)
    new_note(client, "Schnell", "aus dem Eingang")
    gone = new_note(client, "Weg", "im Papierkorb", house)
    assert client.delete(f"/api/notes/{gone}").status_code == 204
    anna = make_account("anna")
    bert = make_account("bert")
    with new_client(anna) as theirs:
        shared_a = new_note(theirs, "Rezept", "Teig")
        new_note(theirs, "Privat", "nicht geteilt")
    with new_client(bert) as theirs:
        shared_b = new_note(theirs, "Urlaub", "Strand")
    sharing[operator.id] = {shared_a: Access.READ, shared_b: Access.WRITE}
    archive = zip_of(client)
    names = archive.namelist()
    assert_inside(names)
    assert {name for name in names if name.endswith(".md")} == {
        "Haushalt/Einkauf.md", "Haushalt/Garten/Beet.md", "Inbox/Schnell.md",
        "Shared with me/Anna/Rezept.md", "Shared with me/Bert/Urlaub.md"}
    assert "Leer/" in names and "Haushalt/Garten/" in names
    assert "Teig" in archive.read("Shared with me/Anna/Rezept.md").decode()
    assert not any("Privat" in name or "Weg" in name for name in names)


def test_notes17_ac3_the_words_follow_the_account_language(client, operator, sharing):
    with SessionLocal() as db:
        db.get(Account, operator.id).language = "de"
        db.commit()
    new_note(client, "Schnell", "x")
    anna = make_account("anna")
    with new_client(anna) as theirs:
        sharing[operator.id] = {new_note(theirs, "Rezept", "y"): Access.READ}
    names = zip_of(client).namelist()
    assert "Eingang/Schnell.md" in names and "Mit mir geteilt/Anna/Rezept.md" in names


def test_notes17_ac4_a_folder_with_all_subfolders_and_attachments(client, operator, attachments):
    house = make_folder(client, "Haushalt")
    garden = make_folder(client, "Garten", house)
    deep = make_folder(client, "Beete", garden)
    make_folder(client, "Arbeit")
    first = new_note(client, "Einkauf", "Milch", house)
    new_note(client, "Plan", "Erde", deep)
    new_note(client, "Fremd", "nicht dabei")
    attachments[first] = [("liste.txt", "file", b"Milch, Brot")]
    archive = zip_of(client, house)
    names = archive.namelist()
    assert_inside(names)
    assert set(names) == {"Haushalt/", "Haushalt/Garten/", "Haushalt/Garten/Beete/", "Haushalt/Einkauf.md",
                          "Haushalt/Einkauf (Attachments)/", "Haushalt/Einkauf (Attachments)/liste.txt",
                          "Haushalt/Garten/Beete/Plan.md"}
    assert archive.read("Haushalt/Einkauf (Attachments)/liste.txt") == b"Milch, Brot"
    jobs = client.get("/api/export/jobs").json()
    assert jobs[0]["filename"] == "Haushalt.zip" and jobs[0]["label"] == "Haushalt" and jobs[0]["notes"] == 2


def test_notes17_ac4_a_folder_of_somebody_else_is_not_there(client, operator):
    anna = make_account("anna")
    with new_client(anna) as theirs:
        folder = make_folder(theirs, "Geheim")
        new_note(theirs, "Notiz", "x", folder)
    assert client.post("/api/export/jobs", json={"folder_id": folder}).status_code == 404
    assert client.get("/api/export/estimate", params={"folder_id": folder}).status_code == 404


# --- AC-5: tags and properties ------------------------------------------------------------------------------------------


def test_notes17_ac5_tags_keep_their_hash_and_the_properties_stand_at_the_top(client, operator):
    note_id = new_note(client, "Markt", "#einkauf am Anfang\n\nMilch für #haushalt und (#bio)")
    assert client.put(f"/api/notes/{note_id}/pin", json={"pinned": True}).status_code == 200
    assert client.put(f"/api/notes/{note_id}/color", json={"color": "green"}).status_code == 200
    assert client.put(f"/api/notes/{note_id}/icon", json={"icon": "basket"}).status_code == 200
    front, body = front_and_body(markdown_of(client, note_id))
    stored_note = notes_of(note_id)
    assert front["title"] == '"Markt"'
    assert front["pinned"] == "true" and front["color"] == '"green"' and front["icon"] == '"basket"'
    assert front["created"] == stored_note.created_at.isoformat(timespec="seconds")
    assert front["updated"] == stored_note.updated_at.isoformat(timespec="seconds")
    assert "pinned_at" in front
    # At the start of a line too: "#einkauf" is a tag, not a heading, so it stays as it is (Obsidian reads it).
    assert "\n#einkauf am Anfang\n" in body
    assert "#haushalt" in body and "(#bio)" in body
    assert "\\#" not in body


def test_notes17_ac5_a_note_without_pin_or_colour_says_so(client, operator):
    front, _body = front_and_body(markdown_of(client, new_note(client, "Schlicht", "x")))
    assert front["pinned"] == "false" and "color" not in front and "icon" not in front


def notes_of(note_id: str) -> Note:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        db.expunge(note)
        return note


# --- AC-6, EC-4: recordings and sketches ------------------------------------------------------------------------------


def test_notes17_ac6_a_kept_recording_lies_beside_its_text(client, operator, attachments):
    note_id = new_note(client, "Diktat", "Was ich gesagt habe")
    attachments[note_id] = [("Aufnahme 1.m4a", "recording", b"\x00\x00\x00 ftypM4A audio")]
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/export/notes/{note_id}/markdown").content))
    assert archive.read("Diktat (Attachments)/Aufnahme 1.m4a") == b"\x00\x00\x00 ftypM4A audio"
    # Packed already: stored, not packed again.
    assert archive.getinfo("Diktat (Attachments)/Aufnahme 1.m4a").compress_type == zipfile.ZIP_STORED
    text = archive.read("Diktat.md").decode()
    assert "Was ich gesagt habe" in text and "- [Aufnahme 1.m4a](Diktat%20%28Attachments%29/Aufnahme%201.m4a)" in text


def test_notes17_ec4_a_sketch_lies_beside_it_as_a_picture(client, operator, attachments):
    note_id = new_note(client, "Grundriss", "Wohnzimmer")
    drawing = png("black")
    attachments[note_id] = [("Skizze.png", "drawing", drawing)]
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/export/notes/{note_id}/markdown").content))
    assert archive.read("Grundriss (Attachments)/Skizze.png") == drawing
    assert "![Skizze.png](Grundriss%20%28Attachments%29/Skizze.png)" in archive.read("Grundriss.md").decode()


# --- AC-7: the size before, in the background, a notice when ready ---------------------------------------------------


def test_notes17_ac7_the_size_before_and_the_export_in_the_background(client, operator, attachments):
    folder = make_folder(client, "Fotos")
    note_id = new_note(client, "Urlaub", "x" * 5000, folder)
    attachments[note_id] = [("strand.jpg", "image", b"j" * 200_000)]
    answer = client.get("/api/export/estimate", params={"folder_id": folder})
    assert answer.status_code == 200
    size = answer.json()
    assert size["notes"] == 1 and 205_000 <= size["bytes"] <= 210_000
    everything = client.get("/api/export/estimate").json()
    assert everything["notes"] == 1
    # Started, it waits for the worker; the answer comes at once.
    job = client.post("/api/export/jobs", json={"folder_id": folder}).json()
    assert job["status"] == QUEUED and job["estimate"] == size["bytes"] and job["seen"] is False
    export.run_pending()
    ready = client.get("/api/export/jobs").json()[0]
    assert ready["status"] == READY and ready["size"] > 0 and ready["seen"] is False
    assert ready["expires_at"] is not None
    # The notice was shown: it does not come again.
    assert client.post(f"/api/export/jobs/{job['id']}/seen").json()["seen"] is True


def test_notes17_ac7_jobs_are_the_accounts_own(client, operator):
    new_note(client, "x", "y")
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    anna = make_account("anna")
    with new_client(anna) as theirs:
        assert theirs.get("/api/export/jobs").json() == []
        assert theirs.get(f"/api/export/jobs/{job['id']}/download").status_code == 404
        assert theirs.post(f"/api/export/jobs/{job['id']}/seen").status_code == 404


def test_notes17_ac7_the_worker_runs_beside_the_requests(client, operator, monkeypatch):
    """With background work allowed, the job runs in a thread of its own while the request has long answered."""
    import threading

    monkeypatch.setattr(export, "AUTO", True)
    gate = threading.Event()
    real = export.write_plan

    def slow(*args, **kwargs):
        gate.wait(5)
        return real(*args, **kwargs)

    monkeypatch.setattr(export, "write_plan", slow)
    new_note(client, "Hintergrund", "x")
    job = client.post("/api/export/jobs", json={}).json()
    # The request answered; the export is still writing, and nexnotes answers meanwhile.
    assert client.get("/api/export/jobs").json()[0]["status"] in (QUEUED, RUNNING)
    assert client.get("/api/health").status_code == 200
    gate.set()
    deadline = utcnow() + timedelta(seconds=10)
    while utcnow() < deadline and client.get("/api/export/jobs").json()[0]["status"] != READY:
        pass
    assert client.get("/api/export/jobs").json()[0]["status"] == READY
    assert client.get(f"/api/export/jobs/{job['id']}/download").status_code == 200


# --- AC-8: 24 hours, as often as asked, then gone ----------------------------------------------------------------------


def test_notes17_ac8_the_zip_stays_24_hours_then_goes_and_counts_nowhere(client, operator):
    new_note(client, "Bleibt", "kurz")
    with SessionLocal() as db:
        before = content.counts(db, operator.id)
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    first = client.get(f"/api/export/jobs/{job['id']}/download")
    second = client.get(f"/api/export/jobs/{job['id']}/download")
    assert first.status_code == second.status_code == 200 and first.content == second.content
    file = export.export_dir() / f"{job['id']}.zip"
    assert file.is_file()
    # It counts towards no account and goes into no backup.
    with SessionLocal() as db:
        assert content.counts(db, operator.id) == before
    assert "exports" not in content.backup_folders
    with SessionLocal() as db:
        row = db.get(ExportJob, job["id"])
        assert row.expires_at - row.finished_at == timedelta(hours=24)
        row.expires_at = utcnow() - timedelta(seconds=1)
        row.created_at = utcnow() - timedelta(hours=25)
        db.commit()
    assert client.get(f"/api/export/jobs/{job['id']}/download").status_code == 410
    assert client.get(f"/api/export/jobs/{job['id']}/download").json()["detail"]["code"] == "export_expired"
    # The cleaning round of the frame takes it away.
    export.register()
    assert any(name == "exports" for name, _job in cleanup._jobs)
    cleanup.run_once()
    assert not file.exists()
    with SessionLocal() as db:
        assert db.get(ExportJob, job["id"]) is None


def test_notes17_ac8_a_zip_nobody_owns_any_more_goes(client, operator):
    stray = export.export_dir() / "0123-left-behind.zip"
    stray.write_bytes(b"PK")
    export.purge_expired()
    assert not stray.exists()


def test_notes17_ac8_not_ready_is_no_download(client, operator):
    job = client.post("/api/export/jobs", json={}).json()
    answer = client.get(f"/api/export/jobs/{job['id']}/download")
    assert answer.status_code == 409 and answer.json()["detail"]["code"] == "export_not_ready"


# --- EC-1: locked notes -----------------------------------------------------------------------------------------------


def test_notes17_ec1_a_locked_note_is_there_with_title_and_hint_only(client, operator, locking, attachments):
    new_note(client, "Offen", "lesbar")
    locked_id = new_note(client, "Tresor", "Geheimnis 1234")
    attachments[locked_id] = [("pass.png", "image", png())]
    locking.add(locked_id)
    text = markdown_of(client, locked_id)
    assert "Geheimnis" not in text and "# Tresor" in text and "*locked, not exported*" in text
    assert "created" not in text
    archive = zip_of(client)
    names = archive.namelist()
    assert "Inbox/Tresor.md" in names and "Inbox/Offen.md" in names
    assert not any("pass.png" in name or "Attachments" in name for name in names)
    inside = archive.read("Inbox/Tresor.md").decode()
    assert "Geheimnis" not in inside and "locked, not exported" in inside
    pdf = client.get(f"/api/export/notes/{locked_id}/pdf")
    assert pdf.status_code == 200
    shown = pdf_text(pdf.content)
    assert "Tresor" in shown and "locked, not exported" in shown and "Geheimnis" not in shown
    assert "lesbar" in archive.read("Inbox/Offen.md").decode()


# --- EC-2: big exports do not block, a second waits --------------------------------------------------------------------


def test_notes17_ec2_a_second_export_of_the_same_member_waits_for_the_first(client, operator):
    new_note(client, "a", "b")
    first = client.post("/api/export/jobs", json={}).json()
    second = client.post("/api/export/jobs", json={}).json()
    anna = make_account("anna")
    with new_client(anna) as theirs:
        new_note(theirs, "c", "d")
        other = theirs.post("/api/export/jobs", json={}).json()
    assert export._claim() == first["id"]
    # The member's second waits while the first runs; another member's goes ahead.
    assert export._claim() == other["id"]
    assert export._claim() is None
    with SessionLocal() as db:
        assert db.get(ExportJob, second["id"]).status == QUEUED
    export.run_job(first["id"])
    export.run_job(other["id"])
    assert export._claim() == second["id"]


def test_notes17_ec2_at_most_two_run_in_the_whole_server(client, operator):
    ids = []
    for name in ("anna", "bert", "carl"):
        person = make_account(name)
        with new_client(person) as theirs:
            new_note(theirs, "n", "x")
            ids.append(theirs.post("/api/export/jobs", json={}).json()["id"])
    assert export._claim() == ids[0] and export._claim() == ids[1]
    assert export._claim() is None


def test_notes17_ec2_attachments_go_through_in_pieces_never_whole(client, operator, monkeypatch):
    """A big attachment is copied piece by piece into the ZIP, not read whole into memory."""
    reads: list[int] = []

    class Big(io.RawIOBase):
        left = 30 * 1024 * 1024

        def readable(self) -> bool:
            return True

        def read(self, size: int = -1) -> bytes:
            reads.append(size)
            assert 0 < size <= 1024 * 1024
            piece = min(size, self.left)
            self.left -= piece
            return b"v" * piece

    note_id = new_note(client, "Video", "groß")
    monkeypatch.setattr(export, "ATTACHMENT_SOURCES", [lambda _db, note: [export.ExportFile(
        "v", "film.mp4", "video", 30 * 1024 * 1024, Big)] if note.id == note_id else []])
    archive = zip_of(client)
    assert archive.getinfo("Inbox/Video (Attachments)/film.mp4").file_size == 30 * 1024 * 1024
    assert len(reads) >= 30


# --- EC-3, EC-5: names --------------------------------------------------------------------------------------------------


def test_notes17_ec3_forbidden_characters_are_replaced_in_the_name_the_title_stays(client, operator):
    title = 'Termin 10:30 / Plan? *A* "B" <C> |D| \\E'
    note_id = new_note(client, title, "x")
    answer = client.get(f"/api/export/notes/{note_id}/markdown")
    assert "Termin%2010_30%20_%20Plan_%20_A_%20_B_%20_C_%20_D_%20_E.md" in answer.headers["content-disposition"]
    front, body = front_and_body(answer.text)
    assert front["title"] == '"Termin 10:30 / Plan? *A* \\"B\\" <C> |D| \\\\E"'
    assert body.startswith("# Termin 10:30 / Plan? \\*A\\* \"B\" \\<C> \\|D\\| \\\\E\n")
    names = zip_of(client).namelist()
    assert "Inbox/Termin 10_30 _ Plan_ _A_ _B_ _C_ _D_ _E.md" in names


@pytest.mark.parametrize(("title", "name"), [
    ("Einkauf", "Einkauf"),
    ("Ärger über Öl", "Ärger über Öl"),
    ("A\u0308rger", "Ärger"),  # decomposed umlaut, written composed
    ("..", "Untitled"),
    ("../../etc/passwd", "_.._etc_passwd"),
    ("C:\\Windows\\x", "C__Windows_x"),
    ("  .versteckt. ", "versteckt"),
    ("CON", "CON_"),
    ("nul.txt", "nul_.txt"),
    ("com1", "com1_"),
    ("Console", "Console"),
    ("Zeile\neins\tzwei", "Zeile_eins_zwei"),
    ("", "Untitled"),
    ("🛒 Einkauf", "🛒 Einkauf"),
])
def test_notes17_ec3_safe_names(title, name):
    assert export.safe_name(title, "Untitled") == name


def test_notes17_ec3_long_names_are_cut_by_characters_and_bytes():
    assert len(export.safe_name("a" * 300, "x")) == export.MAX_NAME_CHARS
    cut = export.safe_name("ü" * 300, "x")
    assert len(cut.encode("utf-8")) <= export.MAX_NAME_BYTES and cut == "ü" * 90
    emoji = export.safe_name("👨‍👩‍👧" * 40, "x")
    assert len(emoji.encode("utf-8")) <= export.MAX_NAME_BYTES and not emoji.endswith("\u200d")


def test_notes17_ec3_no_path_leads_out_of_the_zip(client, operator, attachments):
    evil = ["../../../evil", "/etc/passwd", "C:\\boot.ini", "..", ".", "\\\\server\\share", "a/../../b", "~/.ssh/x"]
    folder = make_folder(client, "Ordner")
    for title in evil:
        note_id = new_note(client, title, "x", folder)
        attachments[note_id] = [("../../../../escape.txt", "file", b"x"), ("..\\..\\win.txt", "file", b"y")]
    names = zip_of(client).namelist()
    assert_inside(names)
    assert all(name.startswith(("Ordner/", "Inbox/")) for name in names), names
    for part in ("..", ".", "", "a/b", "a\\b", "C:", " lead", "trail "):
        with pytest.raises(export.UnsafePath):
            export.zip_path("ok", part)


def test_notes17_ec5_two_notes_with_the_same_title_in_one_folder(client, operator):
    folder = make_folder(client, "Ordner")
    new_note(client, "Einkauf", "erste", folder)
    new_note(client, "einkauf", "zweite", folder)
    new_note(client, "Einkauf", "dritte", folder)
    make_folder(client, "Einkauf", folder)
    archive = zip_of(client, folder)
    assert {"Ordner/Einkauf.md", "Ordner/einkauf (2).md", "Ordner/Einkauf (3).md", "Ordner/Einkauf/"} <= set(
        archive.namelist())
    assert "erste" in archive.read("Ordner/Einkauf.md").decode()
    assert "zweite" in archive.read("Ordner/einkauf (2).md").decode()
    assert "dritte" in archive.read("Ordner/Einkauf (3).md").decode()


def test_notes17_ec5_a_folder_called_like_the_shared_one(client, operator, sharing):
    make_folder(client, "Shared with me")
    anna = make_account("anna")
    with new_client(anna) as theirs:
        sharing[operator.id] = {new_note(theirs, "Rezept", "y"): Access.READ}
    names = zip_of(client).namelist()
    assert "Shared with me/Anna/Rezept.md" in names and "Shared with me (2)/" in names


# --- EC-6: a restart breaks a running export off ----------------------------------------------------------------------


def test_notes17_ec6_a_restart_breaks_the_running_export_off_and_offers_to_start_again(client, operator):
    new_note(client, "a", "b")
    job = client.post("/api/export/jobs", json={}).json()
    assert export._claim() == job["id"]
    half = export.export_dir() / f"{job['id']}.part"
    half.write_bytes(b"PK half")
    waiting = client.post("/api/export/jobs", json={}).json()
    export.recover()
    jobs = {item["id"]: item for item in client.get("/api/export/jobs").json()}
    assert jobs[job["id"]]["status"] == FAILED and jobs[job["id"]]["problem"] == "interrupted"
    assert jobs[job["id"]]["seen"] is False
    assert not half.exists()
    # The one that waited still waits and runs.
    assert jobs[waiting["id"]]["status"] == QUEUED
    again = client.post(f"/api/export/jobs/{job['id']}/restart")
    assert again.status_code == 202 and again.json()["status"] == QUEUED and again.json()["id"] != job["id"]
    export.run_pending()
    assert {item["status"] for item in client.get("/api/export/jobs").json()} == {FAILED, READY}
    assert client.post(f"/api/export/jobs/{waiting['id']}/restart").status_code == 409


# --- EC-7: never fills the disk ----------------------------------------------------------------------------------------


def test_notes17_ec7_too_little_room_ends_the_export_before_it_starts(client, operator, monkeypatch):
    new_note(client, "a", "b" * 1000)
    monkeypatch.setattr(export, "free_bytes", lambda: export.RESERVE + 100)
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    done = client.get("/api/export/jobs").json()[0]
    assert done["status"] == FAILED and done["problem"] == "disk_full"
    assert not list(export.export_dir().glob(f"{job['id']}*"))


def test_notes17_ec7_a_disk_getting_full_on_the_way_stops_it_and_leaves_nothing(client, operator, monkeypatch):
    for number in range(5):
        new_note(client, f"Notiz {number}", "x" * 100)
    calls = {"count": 0}

    def shrinking() -> int:
        calls["count"] += 1
        return 10 * 1024**3 if calls["count"] < 4 else export.RESERVE - 1

    monkeypatch.setattr(export, "free_bytes", shrinking)
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    done = client.get("/api/export/jobs").json()[0]
    assert done["status"] == FAILED and done["problem"] == "disk_full"
    assert not list(export.export_dir().glob(f"{job['id']}*"))


def test_notes17_ec7_the_system_saying_full_stops_it_too(client, operator, monkeypatch):
    import errno

    new_note(client, "a", "b")

    def full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(export, "write_plan", full)
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    assert client.get("/api/export/jobs").json()[0]["problem"] == "disk_full"
    assert not list(export.export_dir().glob(f"{job['id']}*"))


# --- EC-8, rights --------------------------------------------------------------------------------------------------------


def test_notes17_ec8_a_note_shared_to_read_may_be_exported(client, operator, sharing):
    anna = make_account("anna")
    with new_client(anna) as theirs:
        note_id = new_note(theirs, "Gelesen", "darf raus")
        hidden = new_note(theirs, "Nicht geteilt", "bleibt")
    sharing[operator.id] = {note_id: Access.READ}
    assert "darf raus" in markdown_of(client, note_id)
    assert client.get(f"/api/export/notes/{note_id}/pdf").status_code == 200
    for kind in ("markdown", "pdf"):
        assert client.get(f"/api/export/notes/{hidden}/{kind}").status_code == 404


def test_notes17_only_what_the_account_may_read(client, operator):
    note_id = new_note(client, "Mein", "x")
    assert client.delete(f"/api/notes/{note_id}").status_code == 204
    assert client.get(f"/api/export/notes/{note_id}/markdown").status_code == 404
    assert client.get("/api/export/notes/nope/markdown").status_code == 404
    with new_client() as stranger:
        assert stranger.get("/api/export/estimate").status_code == 401
        assert stranger.get(f"/api/export/notes/{note_id}/pdf").status_code == 401


def test_notes17_a_right_taken_while_the_export_waits_takes_the_note_out(client, operator, sharing):
    anna = make_account("anna")
    with new_client(anna) as theirs:
        note_id = new_note(theirs, "Kurz geteilt", "x")
    sharing[operator.id] = {note_id: Access.READ}
    job = client.post("/api/export/jobs", json={}).json()
    sharing[operator.id] = {}
    export.run_pending()
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/export/jobs/{job['id']}/download").content))
    assert not any("Kurz geteilt" in name for name in archive.namelist())


def test_notes17_the_exports_folder_holds_nothing_after_a_single_note(client, operator):
    note_id = new_note(client, "x", "y")
    markdown_of(client, note_id)
    assert not [path for path in export.export_dir().iterdir() if path.suffix in (".tmp", ".part")]


def test_notes17_to_markdown_escapes_a_heading_mark_but_not_a_tag():
    document = from_markdown("\\# not a heading\n\n#tag at the start\n\n\\## two")
    text = to_markdown(document)
    assert text == "\\# not a heading\n\n#tag at the start\n\n\\## two\n"


def test_notes17_ac8_a_zip_stays_listed_as_long_as_it_can_be_fetched(client, operator):
    """Started 25 hours ago, ready an hour later: the 24 hours count from ready, the list still offers it."""
    new_note(client, "Lang", "x")
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    with SessionLocal() as db:
        row = db.get(ExportJob, job["id"])
        row.created_at = utcnow() - timedelta(hours=25)
        row.expires_at = utcnow() + timedelta(minutes=30)
        db.commit()
    assert [item["id"] for item in client.get("/api/export/jobs").json()] == [job["id"]]
    assert client.get(f"/api/export/jobs/{job['id']}/download").status_code == 200


def test_notes17_ac8_the_file_goes_when_its_time_is_up_even_while_the_job_is_listed(client, operator):
    new_note(client, "Kurz", "x")
    job = client.post("/api/export/jobs", json={}).json()
    export.run_pending()
    file = export.export_dir() / f"{job['id']}.zip"
    with SessionLocal() as db:
        db.get(ExportJob, job["id"]).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    export.purge_expired()
    assert not file.exists()


def test_notes17_ec8_every_note_is_asked_once_more_whatever_the_lists_say(client, operator, sharing, monkeypatch):
    """A note a list names (shared with the account, or lying in its folder) goes out only when the rights say so."""
    anna = make_account("anna")
    folder = make_folder(client, "Gemeinsam")
    with new_client(anna) as theirs:
        listed_only = new_note(theirs, "Nur gelistet", "nein")
        in_my_folder = new_note(theirs, "In meinem Ordner", "nein")
        readable = new_note(theirs, "Lesbar im Ordner", "ja")
    with SessionLocal() as db:
        for note_id in (in_my_folder, readable):
            db.get(Note, note_id).folder_id = folder
        db.commit()
    # The list of shared notes names one the rules do not let it read (a share that just ended).
    monkeypatch.setattr(tags, "SHARED_NOTES", [lambda account_id: select(Note.id).where(Note.id == listed_only)])
    sharing[operator.id] = {readable: Access.READ}
    # Neither counts in the size before ...
    assert client.get("/api/export/estimate").json()["notes"] == 1
    # ... nor goes into the ZIP.
    names = zip_of(client).namelist()
    assert "Gemeinsam/Lesbar im Ordner.md" in names
    assert not any("Nur gelistet" in name or "In meinem Ordner" in name for name in names)
