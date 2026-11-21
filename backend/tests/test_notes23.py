"""NOTES-23 Handy und installierbare Web-App: the server's part. The start page marked as the one page a service
worker may keep, the worker and the manifest asked anew, the manifest and its symbols as a phone installs them, the
share target's form taken by nobody on the server, and the note "Save to nexnotes" makes through the ordinary API."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.db import SessionLocal
from app.main import SHELL_HEADER, _mount_frontend
from app.models import Note
from app.notedoc import doc as notedoc
from app.services import attachments, settings_service

from .conftest import TAB
from .test_notes3 import stored_doc

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"
MB = 1024 * 1024


def _built(tmp_path: Path) -> TestClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "icons").mkdir()
    (dist / "index.html").write_bytes(b"<!doctype html><title>nexnotes</title>")
    (dist / "assets" / "index-abc.js").write_bytes(b"console.log(1)")
    (dist / "sw.js").write_bytes(b"self.x = 1")
    (dist / "manifest.webmanifest").write_bytes(b"{}")
    (dist / "icons" / "icon-192.png").write_bytes(b"png")
    app = FastAPI()
    _mount_frontend(app, dist)
    return TestClient(app)


def _notes() -> int:
    with SessionLocal() as db:
        return db.query(Note).count()


# --- The shell -----------------------------------------------------------------------------------------------------


def test_notes23_only_the_start_page_carries_the_mark_of_the_shell(tmp_path: Path) -> None:
    client = _built(tmp_path)
    for path in ("/", "/folders", "/notes/abc", "/share", "/index.html"):
        page = client.get(path)
        assert page.status_code == 200 and "<title>nexnotes</title>" in page.text, path
        assert page.headers[SHELL_HEADER] == "1", path
        assert page.headers["cache-control"] == "no-cache", path
    for path in ("/assets/index-abc.js", "/icons/icon-192.png", "/sw.js", "/manifest.webmanifest"):
        assert SHELL_HEADER.lower() not in {name.lower() for name in client.get(path).headers}, path
    for path in ("/api", "/api/notes"):
        answer = client.get(path)
        assert answer.status_code == 404 and SHELL_HEADER not in answer.headers, path


def test_notes23_the_worker_and_the_manifest_are_asked_anew_with_their_types(tmp_path: Path) -> None:
    client = _built(tmp_path)
    worker = client.get("/sw.js")
    assert worker.headers["cache-control"] == "no-cache"
    assert worker.headers["content-type"].startswith("text/javascript")
    manifest = client.get("/manifest.webmanifest")
    assert manifest.headers["cache-control"] == "no-cache"
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    # Built files keep the browser's ordinary caching.
    assert client.get("/assets/index-abc.js").headers.get("cache-control") != "no-cache"


def test_notes23_a_read_link_page_never_carries_the_mark_of_the_shell(client: TestClient, operator) -> None:
    page = client.get("/l/" + "x" * 43)
    assert "text/html" in page.headers["content-type"]
    assert SHELL_HEADER not in page.headers
    assert "no-store" in page.headers.get("cache-control", "")


def test_notes23_answers_of_the_api_carry_no_mark(client: TestClient, operator) -> None:
    for path in ("/api/notes", "/api/folders", "/api/auth/me"):
        assert SHELL_HEADER not in client.get(path).headers, path


# --- The manifest and the symbols ----------------------------------------------------------------------------------


def _manifest() -> dict:
    return json.loads((PUBLIC / "manifest.webmanifest").read_text(encoding="utf-8"))


def _icon(src: str) -> Image.Image:
    path = PUBLIC / src.split("?")[0].lstrip("/")
    assert path.is_file(), src
    return Image.open(path)


def test_notes23_ac3_the_manifest_starts_nexnotes_as_an_app_without_the_browser_bar() -> None:
    manifest = _manifest()
    assert manifest["name"] == manifest["short_name"] == "nexnotes"
    assert manifest["display"] == "standalone"
    assert manifest["scope"] == "/" and manifest["id"] == "/"
    assert manifest["start_url"].startswith("/") and "app=1" in manifest["start_url"]
    assert re.fullmatch(r"#[0-9a-f]{6}", manifest["background_color"]) and re.fullmatch(r"#[0-9a-f]{6}", manifest["theme_color"])
    sizes = {(icon["sizes"], icon["purpose"]) for icon in manifest["icons"]}
    assert {("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable")} <= sizes
    for icon in manifest["icons"]:
        image = _icon(icon["src"])
        width, height = (int(part) for part in icon["sizes"].split("x"))
        assert image.size == (width, height) and image.format == "PNG" and icon["type"] == "image/png", icon["src"]


def test_notes23_ac3_the_symbols_are_the_note_on_a_white_tile_and_the_maskable_ones_keep_a_safe_edge() -> None:
    for name in ("icon-512.png", "maskable-512.png", "apple-touch-icon.png"):
        image = _icon(f"/icons/{name}").convert("RGBA")
        middle = image.getpixel((image.width // 2, image.height // 10))
        # White ground of the tile in the light look (AC-3 "auf weißem Grund").
        assert middle[:3] == (255, 255, 255), name
    any_icon = _icon("/icons/icon-512.png").convert("RGBA")
    assert any_icon.getpixel((0, 0))[3] == 0, "the rounded tile on a clear ground"
    for name in ("maskable-512.png", "maskable-192.png", "apple-touch-icon.png"):
        image = _icon(f"/icons/{name}").convert("RGBA")
        assert image.getpixel((0, 0)) == (255, 255, 255, 255), f"{name}: white to every edge"
        # Everything that is not ground lies inside the safe circle (80 % of the edge).
        size = image.width
        centre, radius = (size - 1) / 2, size * 0.4
        for x in range(0, size, 4):
            for y in range(0, size, 4):
                if image.getpixel((x, y))[:3] != (255, 255, 255):
                    assert (x - centre) ** 2 + (y - centre) ** 2 <= radius**2, f"{name}: mark outside the safe zone at {x},{y}"
    assert _icon("/icons/apple-touch-icon.png").size == (180, 180)
    dark = _icon("/icons/icon-192-dark.png").convert("RGBA")
    assert dark.getpixel((96, 48))[:3] != (255, 255, 255), "the dark look has a dark tile"


def test_notes23_ac3_the_start_page_names_manifest_and_symbols_for_android_and_iphone() -> None:
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert '<link rel="manifest" href="/manifest.webmanifest"' in html
    touch = re.search(r'<link rel="apple-touch-icon" href="([^"]+)"', html)
    assert touch and _icon(touch.group(1)).size == (180, 180)
    assert '<meta name="apple-mobile-web-app-capable" content="yes"' in html
    assert "interactive-widget=resizes-content" in html


def test_notes23_ac5_the_manifest_offers_nexnotes_in_the_share_menu_by_post_only() -> None:
    target = _manifest()["share_target"]
    assert target["action"] == "/share-target"
    assert target["method"] == "POST" and target["enctype"] == "multipart/form-data"
    params = target["params"]
    assert params["title"] == "title" and params["text"] == "text" and params["url"] == "url"
    accepted = params["files"][0]["accept"]
    assert params["files"][0]["name"] == "files" and "image/*" in accepted and "application/pdf" in accepted


# --- The share target --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://evil.example"}, TAB])
def test_notes23_ac5_the_form_of_the_share_target_makes_nothing_on_the_server(client: TestClient, operator, headers) -> None:
    before = _notes()
    answer = client.post(
        "/share-target",
        data={"title": "Kompost", "text": "Lesen", "url": "https://garden.example/k"},
        files={"files": ("photo.jpg", b"\xff\xd8\xff" + b"0" * 100, "image/jpeg")},
        headers=headers,
        follow_redirects=False,
    )
    assert answer.status_code == 303
    assert answer.headers["location"] == "/share?shared=lost"
    assert _notes() == before
    with SessionLocal() as db:
        assert db.query(attachments.Attachment).count() == 0


def test_notes23_ac5_without_the_tab_header_no_note_and_no_file_is_made(client: TestClient, operator) -> None:
    """The wall against a form of another site (`GuardMiddleware`): the share page's requests carry the tab's header,
    a form sent from anywhere else cannot."""
    bare = TestClient(client.app, base_url="http://testserver", cookies=client.cookies)
    refused = bare.post("/api/notes", json={"title": "Fremd", "markdown": "x", "origin": "share:Android"})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "client_required"
    form = bare.post("/api/notes", data={"title": "Fremd"}, headers={"Origin": "https://evil.example"})
    assert form.status_code == 400
    upload = bare.post("/api/attachments", params={"note_id": "x", "id": attachments.new_id(), "name": "a.jpg"}, content=b"x")
    assert upload.status_code == 400
    assert _notes() == 0


def test_notes23_ac5_without_a_session_nothing_is_made(client: TestClient) -> None:
    answer = client.post("/api/notes", json={"title": "Geteilt", "markdown": "x", "origin": "share:Android", "title_suggested": True})
    assert answer.status_code == 401
    assert _notes() == 0


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), (200, 120, 10)).save(out, "JPEG")
    return out.getvalue()


def _nodes(note_id: str) -> list[dict]:
    found: list[dict] = []

    def walk(node: dict) -> None:
        found.append(node)
        for child in node.get("content") or []:
            walk(child)

    walk(notedoc.to_json(stored_doc(note_id)))
    return found


def test_notes23_ac5_the_shared_note_lands_with_link_text_files_origin_and_title_check(client: TestClient, operator) -> None:
    """What the page "Save to nexnotes" sends (`pwa/share/compose.ts`): the link, the text, the member's words and a
    block per file, made from Markdown; then the files with the ids the blocks name, checked like every upload."""
    note_id = "6f1c1f0e-1d2b-4a55-9a7e-3f1d2c3b4a5d"
    photo, plan = attachments.new_id(), attachments.new_id()
    markdown = "\n\n".join([
        "[https://garden.example/kompost](https://garden.example/kompost)",
        "\\# Lesen fürs Frühjahr",
        "Für das Hochbeet",
        f"![photo.jpg](attachment:{photo})",
        f"[Plan.pdf](attachment:{plan})",
    ])
    body = {"id": note_id, "title": "Kompost richtig anlegen", "title_suggested": True, "markdown": markdown,
            "origin": "share:Android"}
    made = client.post("/api/notes", json=body)
    assert made.status_code == 201, made.text
    assert made.json()["title_check"] is True and made.json()["origin"] == "share:Android"
    # Sent again after a broken connection: the same note, not a second one (EC-3).
    again = client.post("/api/notes", json=body)
    assert again.status_code == 200 and again.json()["id"] == note_id
    assert _notes() == 1
    inbox = client.get("/api/folders/inbox").json()
    card = next(item for item in inbox["notes"] if item["id"] == note_id)
    assert card["title_check"] is True and card["origin"] == "share:Android"

    nodes = _nodes(note_id)
    types = [node["type"] for node in nodes]
    assert {"image", "attachment"} <= set(types)
    image = next(node for node in nodes if node["type"] == "image")
    assert image["attrs"]["id"] == photo
    texts = [node for node in nodes if node["type"] == "text"]
    linked = [node for node in texts if any(mark["type"] == "link" for mark in node.get("marks") or [])]
    assert linked and linked[0]["text"] == "https://garden.example/kompost"
    assert any(node["text"] == "# Lesen fürs Frühjahr" for node in texts), "shared text stays text"
    assert "heading" not in types

    # The files under the ids of their blocks; checked by their content like every upload (NOTES-10).
    sent = client.post("/api/attachments", params={"note_id": note_id, "id": photo, "name": "photo.jpg"}, content=_jpeg())
    assert sent.status_code == 201 and sent.json()["kind"] == "image"
    # Sent again: the same file (EC-3).
    assert client.post("/api/attachments", params={"note_id": note_id, "id": photo, "name": "photo.jpg"},
                       content=_jpeg()).status_code in (200, 201)
    fake = client.post("/api/attachments", params={"note_id": note_id, "id": plan, "name": "Plan.pdf"},
                       content=b"<html><script>alert(1)</script></html>")
    assert fake.status_code == 201 and fake.json()["kind"] == "file" and fake.json()["inline"] is False


def test_notes23_ac5_a_title_the_member_typed_gets_no_title_check(client: TestClient, operator) -> None:
    made = client.post("/api/notes", json={"title": "Einkauf Samstag", "title_suggested": False,
                                            "markdown": "Milch, Eier", "origin": "share:Android"})
    assert made.status_code == 201 and made.json()["title_check"] is False


def test_notes23_ec4_a_shared_file_over_the_limit_is_refused_with_its_name(client: TestClient, operator) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"upload_max_mb": 1})
    note = client.post("/api/notes", json={"title": "Video", "origin": "share:Android"}).json()
    big = client.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(), "name": "video.mp4"},
                      content=b"\0" * (MB + 1))
    assert big.status_code == 413
    assert big.json()["detail"]["code"] == "attachment_too_large" and big.json()["detail"]["name"] == "video.mp4"
    assert big.json()["detail"]["max_mb"] == 1
