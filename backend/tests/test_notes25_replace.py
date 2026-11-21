"""NOTES-25 Programmschnittstelle (API), replacing the whole text (AC-17, EC-4): only with the state it was read in,
block by block, so that paragraphs that stay the same keep everything Markdown cannot say; strict when the note
changed meanwhile; open editors follow."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.main import app
from app.models import Note
from app.notedoc import doc as notedoc
from app.services import apibrake, notes

from .notes_live import Live
from .test_notes3 import new_note, stored_doc, token_for
from .test_notes10 import attached


@pytest.fixture(autouse=True)
def fresh(client) -> Iterator[None]:
    apibrake.forget()
    yield
    Live.close_all()
    apibrake.forget()


def program() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def token_of(client: TestClient, level: str = "write") -> str:
    answer = client.post("/api/tokens", json={"name": "Skript", "level": level})
    assert answer.status_code == 201, answer.text
    return answer.json()["token"]


def call(token: str, method: str, path: str, via: TestClient | None = None, **kwargs):
    headers = {"Authorization": f"Bearer {token}", **kwargs.pop("headers", {})}
    return (via or program()).request(method, path, headers=headers, **kwargs)


def read(token: str, note_id: str, via: TestClient | None = None) -> dict:
    answer = call(token, "GET", f"/api/v1/notes/{note_id}", via=via)
    assert answer.status_code == 200, answer.text
    return answer.json()


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def set_body(note_id: str, blocks: list[dict]) -> None:
    """The note's text as the browser would have written it, with what Markdown cannot say."""

    def write(doc) -> None:
        body = notedoc.body_of(doc)
        with doc.transaction():
            while len(body.children):
                del body.children[0]
            notedoc.write_blocks(body, 0, notedoc.clean_doc({"type": "doc", "content": blocks})["content"])

    asyncio.run(notes.change(note_id, write))


def text(value: str, *marks: dict) -> dict:
    return {"type": "text", "text": value, **({"marks": list(marks)} if marks else {})}


def paragraph(*content: dict) -> dict:
    return {"type": "paragraph", "content": list(content)}


def test_notes25_ac17_replacing_keeps_unchanged_blocks_exactly_and_answers_the_new_etag(client, operator):
    token = token_of(client)
    note = new_note(client, title="Plan", markdown="x")
    file = attached(client, note["id"], b"Anhang", "plan.txt")
    set_body(note["id"], [
        paragraph(text("Markiert", {"type": "highlight", "attrs": {"color": "green"}}), text(" und normal")),
        paragraph(text("Wird geändert")),
        {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableHeader", "attrs": {"colwidth": [240]}, "content": [paragraph(text("Spalte"))]}]}]},
        {"type": "attachment", "attrs": {"id": file["id"], "name": "plan.txt"}},
        {"type": "details", "content": [{"type": "detailsSummary", "content": [text("Mehr")]},
                                        {"type": "detailsContent", "content": [paragraph(text("Innen"))]}]},
    ])
    before = read(token, note["id"])
    markdown = before["markdown"].replace("Wird geändert", "Ist geändert") + "\nNeu am Ende\n"
    answer = call(token, "PUT", f"/api/v1/notes/{note['id']}/content", headers={"If-Match": f'"{before["etag"]}"'},
                  json={"markdown": markdown})
    assert answer.status_code == 200, answer.text
    after = answer.json()
    assert after["etag"] != before["etag"] and answer.headers["etag"] == f'"{after["etag"]}"'
    assert after["title"] == "Plan"
    blocks = notedoc.to_json(stored_doc(note["id"]))["content"]
    first = blocks[0]["content"][0]
    assert first["text"] == "Markiert" and first["marks"][0]["type"] == "highlight"
    assert first["marks"][0]["attrs"]["color"] == "green"
    assert blocks[1]["content"][0]["text"] == "Ist geändert"
    table = next(block for block in blocks if block["type"] == "table")
    assert table["content"][0]["content"][0]["attrs"]["colwidth"] == [240]
    assert any(block["type"] == "attachment" and block["attrs"]["id"] == file["id"] for block in blocks)
    assert blocks[-1]["content"][0]["text"] == "Neu am Ende"
    # ``base`` in the body does the same as If-Match.
    again = call(token, "PUT", f"/api/v1/notes/{note['id']}/content",
                 json={"markdown": after["markdown"] + "\nNoch eins\n", "base": after["etag"]})
    assert again.status_code == 200 and "Noch eins" in again.json()["markdown"]


def test_notes25_ec4_an_older_state_answers_412_with_the_new_etag_and_changes_nothing(client, operator):
    token = token_of(client)
    note = new_note(client, markdown="Eins\n\nZwei")
    old = read(token, note["id"])
    # Somebody changes it meanwhile, if only by deleting.
    set_body(note["id"], [paragraph(text("Eins"))])
    current = read(token, note["id"])
    refused = call(token, "PUT", f"/api/v1/notes/{note['id']}/content",
                   json={"markdown": "Ganz anders", "base": old["etag"]})
    assert refused.status_code == 412 and code(refused) == "note_changed"
    assert refused.json()["detail"]["etag"] == current["etag"] and refused.headers["etag"] == f'"{current["etag"]}"'
    assert read(token, note["id"])["markdown"].strip() == "Eins"
    with SessionLocal() as db:
        # No copy of the note for the conflict.
        assert db.scalar(select(func.count()).select_from(Note)) == 1
    # Without a state: nothing at all.
    missing = call(token, "PUT", f"/api/v1/notes/{note['id']}/content", json={"markdown": "Ganz anders"})
    assert missing.status_code == 428 and code(missing) == "precondition_required"
    # Appending needs no state (EC-5 of NOTES-21 holds).
    appended = call(token, "POST", f"/api/v1/notes/{note['id']}/append", json={"markdown": "Drei"})
    assert appended.status_code == 200
    reads = token_of(client, "read")
    assert code(call(reads, "PUT", f"/api/v1/notes/{note['id']}/content",
                     json={"markdown": "x", "base": current["etag"]})) == "token_reads_only"


def test_notes25_ac17_ec4_with_the_note_open_the_editor_follows_and_typing_since_reading_is_never_overwritten(
        client, operator):
    token = token_of(client)
    note = new_note(client, markdown="Anfang\n\nMitte")
    browser = Live(client, note["id"], token_for(operator))
    assert browser.pump(lambda: browser.synced)
    state = read(token, note["id"], via=client)
    replaced = call(token, "PUT", f"/api/v1/notes/{note['id']}/content", via=client,
                    json={"markdown": "Anfang\n\nNeue Mitte", "base": state["etag"]})
    assert replaced.status_code == 200, replaced.text
    assert browser.pump(lambda: "Neue Mitte" in browser.text and "Anfang" in browser.text)
    # The browser types after the program read: the program's next replace is refused, the typing stays.
    stale = replaced.json()["etag"]
    from app.notedoc import edit

    edit.append_paragraph(browser.doc, "gerade getippt")
    assert browser.pump(lambda: "gerade getippt" in read(token, note["id"], via=client)["markdown"])
    refused = call(token, "PUT", f"/api/v1/notes/{note['id']}/content", via=client,
                   json={"markdown": "Alles weg", "base": stale})
    assert refused.status_code == 412
    browser.close()
    assert "gerade getippt" in read(token, note["id"])["markdown"]


def test_notes25_ac17_a_locked_or_trashed_note_is_not_replaced(client, operator):
    token = token_of(client)
    note = new_note(client, markdown="x")
    etag = read(token, note["id"])["etag"]
    with SessionLocal() as db:
        db.get(Note, note["id"]).locked = True
        db.commit()
    locked = call(token, "PUT", f"/api/v1/notes/{note['id']}/content", json={"markdown": "y", "base": etag})
    assert locked.status_code == 409 and code(locked) == "note_locked"
    other = new_note(client, markdown="x")
    etag = read(token, other["id"])["etag"]
    assert client.delete(f"/api/notes/{other['id']}").status_code == 204
    trashed = call(token, "PUT", f"/api/v1/notes/{other['id']}/content", json={"markdown": "y", "base": etag})
    assert trashed.status_code == 410 and code(trashed) == "note_trashed"
