"""NOTES-25 Programmschnittstelle (API), the rights and every route that reads: a token sees what its account sees
and never more, a limit to folders holds everywhere (also at MCP), notes page by page with filters, one note with
Markdown and its state as ``etag``, search, folders, tags, smart folders, shares, attachments, the trash, notes in the
trash and locked notes."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from pycrdt import XmlText

from app.db import SessionLocal
from app.main import app
from app.models import Note, utcnow
from app.notedoc import doc as notedoc
from app.services import apibrake, notes

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note
from .test_notes10 import attached
from .test_notes13 import make_folder, share


@pytest.fixture(autouse=True)
def fresh(client) -> Iterator[None]:
    apibrake.forget()
    yield
    Live.close_all()
    apibrake.forget()


def program() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def token_of(client: TestClient, **body) -> str:
    answer = client.post("/api/tokens", json={"name": "n8n", "level": "read", **body})
    assert answer.status_code == 201, answer.text
    return answer.json()["token"]


def get(token: str, path: str, **params):
    return program().get(path, headers={"Authorization": f"Bearer {token}"}, params=params)


def ok(token: str, path: str, **params) -> dict:
    answer = get(token, path, **params)
    assert answer.status_code == 200, answer.text
    return answer.json()


def tick(token: str, note_id: str, index: int, text: str):
    return program().post(f"/api/v1/notes/{note_id}/items/{index}", json={"text": text},
                          headers={"Authorization": f"Bearer {token}"})


def code(answer) -> str:
    return answer.json()["detail"]["code"]


def lock(note_id: str) -> None:
    with SessionLocal() as db:
        db.get(Note, note_id).locked = True
        db.commit()


def titles(listing: dict) -> list[str]:
    return [item["title"] for item in listing["notes"]]


# --- AC-6, EC-2, EC-8: what the account sees, and never more --------------------------------------------------------


def test_notes25_ac6_ec2_ec8_a_token_sees_what_its_account_sees_never_more(client, operator):
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        private = new_note(as_anna, title="Annas Tagebuch", markdown="geheim")
        to_read = new_note(as_anna, title="Annas Liste", markdown="- [ ] Butter")
        to_write = new_note(as_anna, title="Gemeinsam", markdown="- [ ] Brot")
        folder = make_folder(as_anna, "Annas Ordner")
        share(as_anna, "note", to_read["id"], operator, "read")
        share(as_anna, "note", to_write["id"], operator, "write")
    own = new_note(client, title="Meine Notiz", markdown="- [ ] Milch")
    reads = token_of(client)
    writes = token_of(client, name="w", level="write")
    assert set(titles(ok(reads, "/api/v1/notes"))) == {"Meine Notiz", "Annas Liste", "Gemeinsam"}
    # Somebody else's note, not shared: exactly like one that is not there (EC-2).
    hidden, missing = get(reads, f"/api/v1/notes/{private['id']}"), get(reads, "/api/v1/notes/no-such-note")
    assert hidden.status_code == missing.status_code == 404 and hidden.json() == missing.json()
    assert code(get(reads, f"/api/v1/notes/{private['id']}/attachments")) == "not_found"
    assert code(get(reads, "/api/v1/notes", folder=folder)) == "not_found"
    # Shared to read: readable, with the right; writing is not allowed (EC-8).
    read_only = ok(reads, f"/api/v1/notes/{to_read['id']}")
    assert read_only["access"] == "read" and read_only["owner"] and read_only["can_check"] is False
    refused = tick(writes, to_read["id"], 0, "Butter")
    assert refused.status_code == 403 and code(refused) == "not_allowed"
    assert ok(writes, f"/api/v1/notes/{to_write['id']}")["access"] == "write"
    assert tick(writes, to_write["id"], 0, "Brot").status_code == 200
    # A token that may only read writes nothing, whatever the note (AC-6).
    refused = tick(reads, own["id"], 0, "Milch")
    assert refused.status_code == 403 and code(refused) == "token_reads_only"
    assert ok(writes, f"/api/v1/notes/{own['id']}")["access"] == "owner"


# --- AC-7: the limit to folders -------------------------------------------------------------------------------------


def test_notes25_ac7_a_token_limited_to_folders_sees_them_and_everything_below_and_nothing_else(client, operator):
    home = make_folder(client, "Haushalt")
    shop = make_folder(client, "Einkauf", home)
    work = make_folder(client, "Arbeit")
    inside = new_note(client, title="Milch kaufen", markdown="Milch #einkauf", folder_id=shop)
    outside = new_note(client, title="Milch im Büro", markdown="Milch #arbeit", folder_id=work)
    new_note(client, title="Im Eingang", markdown="Milch")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Annas Milch", markdown="Milch")
        share(as_anna, "note", theirs["id"], operator, "write")
    token = token_of(client, folders=[home])
    assert titles(ok(token, "/api/v1/notes")) == ["Milch kaufen"]
    for note_id in (outside["id"], theirs["id"]):
        assert code(get(token, f"/api/v1/notes/{note_id}")) == "not_found"
    assert code(get(token, "/api/v1/notes", folder=work)) == "not_found"
    assert ok(token, f"/api/v1/notes/{inside['id']}")["title"] == "Milch kaufen"
    # A folder made later below a chosen one counts too.
    later = make_folder(client, "Drogerie", home)
    new_note(client, title="Seife", markdown="Milch", folder_id=later)
    assert set(titles(ok(token, "/api/v1/notes"))) == {"Milch kaufen", "Seife"}
    # Search, tags, smart folders and the numbers count only inside.
    assert {hit["title"] for hit in ok(token, "/api/v1/search", q="Milch")["notes"]} == {"Milch kaufen", "Seife"}
    assert [tag["name"] for tag in ok(token, "/api/v1/tags")["tags"]] == ["einkauf"]
    smart = client.post("/api/smart-folders", json={"name": "Milch", "conditions": [{"kind": "text", "value": "Milch"}]})
    assert smart.status_code == 201, smart.text
    listed = {folder["name"]: folder for folder in ok(token, "/api/v1/smart-folders")["smart_folders"]}
    assert listed["Milch"]["count"] == 2
    assert set(titles(ok(token, f"/api/v1/smart-folders/{smart.json()['id']}/notes"))) == {"Milch kaufen", "Seife"}
    tree = ok(token, "/api/v1/folders")
    assert tree["inbox"] is None and tree["shared_with_me"] == []
    assert [folder["name"] for folder in tree["folders"]] == ["Haushalt"]
    assert {child["name"] for child in tree["folders"][0]["children"]} == {"Einkauf", "Drogerie"}
    assert ok(token, "/api/v1/shares/with-me")["groups"] == []
    # The card's pinned notes too.
    for note_id in (inside["id"], outside["id"]):
        assert client.put(f"/api/notes/{note_id}/pin", json={"pinned": True}).status_code == 200
    assert [item["title"] for item in ok(token, "/api/v1/dashboard")["pinned"]] == ["Milch kaufen"]


def test_notes25_ac7_the_limit_holds_at_mcp_too_and_a_new_note_goes_into_the_first_folder(client, operator):
    home = make_folder(client, "Haushalt")
    work = make_folder(client, "Arbeit")
    inside = new_note(client, title="Milch kaufen", markdown="Milch", folder_id=home)
    outside = new_note(client, title="Milch im Büro", markdown="Milch", folder_id=work)
    token = token_of(client, level="write", mcp=True, folders=[home])

    def call(tool: str, **args) -> dict:
        answer = program().post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                  "params": {"name": tool, "arguments": args}},
                                headers={"Authorization": f"Bearer {token}"})
        assert answer.status_code == 200, answer.text
        return answer.json()["result"]

    found = call("search_notes", query="Milch")["structuredContent"]
    assert [hit["title"] for hit in found["notes"]] == ["Milch kaufen"]
    assert call("read_note", note_id=outside["id"])["isError"] is True
    assert call("read_note", note_id=inside["id"])["isError"] is False
    assert [note["title"] for note in call("list_notes")["structuredContent"]["notes"]] == ["Milch kaufen"]
    folders = call("list_folders")["structuredContent"]
    assert folders["inbox"] is None and [folder["name"] for folder in folders["folders"]] == ["Haushalt"]
    assert call("list_notes", folder_id=work)["isError"] is True
    assert call("move_note", note_id=inside["id"], folder_id=work)["isError"] is True
    assert call("create_folder", name="Oben")["isError"] is True
    made = call("create_note", text="Brot")
    assert made["isError"] is False and made["structuredContent"]["folder"]["id"] == home
    assert call("trash_note", note_id=outside["id"])["isError"] is True


# --- AC-8: notes page by page ---------------------------------------------------------------------------------------


def test_notes25_ac8_notes_with_their_fields_filters_and_pages(client, operator):
    home = make_folder(client, "Haushalt")
    shopping = new_note(client, title="Einkauf", markdown="- [x] Milch\n- [ ] Brot #laden", folder_id=home)
    assert client.put(f"/api/notes/{shopping['id']}/pin", json={"pinned": True}).status_code == 200
    for number in range(4):
        new_note(client, title=f"Notiz {number}", markdown="Text")
    token = token_of(client)
    first = ok(token, "/api/v1/notes", limit=2)
    assert len(first["notes"]) == 2 and first["next_cursor"]
    second = ok(token, "/api/v1/notes", limit=2, cursor=first["next_cursor"])
    third = ok(token, "/api/v1/notes", limit=2, cursor=second["next_cursor"])
    assert third["next_cursor"] is None
    every = first["notes"] + second["notes"] + third["notes"]
    assert len({note["id"] for note in every}) == 5
    # Newest change first.
    assert [note["updated_at"] for note in every] == sorted((note["updated_at"] for note in every), reverse=True)
    item = next(note for note in every if note["id"] == shopping["id"])
    assert item["folder_id"] == home and item["tags"] == ["laden"] and item["pinned"] is True
    assert item["tasks"] == {"done": 1, "total": 2} and item["locked"] is False and item["access"] == "owner"
    assert {"icon", "color", "paper", "created_at", "updated_at"} <= set(item)
    assert titles(ok(token, "/api/v1/notes", folder=home)) == ["Einkauf"]
    assert titles(ok(token, "/api/v1/notes", tag="laden")) == ["Einkauf"]
    assert titles(ok(token, "/api/v1/notes", pinned="true")) == ["Einkauf"]
    assert "Einkauf" not in titles(ok(token, "/api/v1/notes", pinned="false"))
    assert titles(ok(token, "/api/v1/notes", q="einK")) == ["Einkauf"]
    assert len(ok(token, "/api/v1/notes", folder="inbox")["notes"]) == 4
    # changed_since: only what changed after.
    with SessionLocal() as db:
        for note in db.query(Note).all():
            note.updated_at = utcnow() - timedelta(days=10)
        db.get(Note, shopping["id"]).updated_at = utcnow() - timedelta(hours=1)
        db.commit()
    since = (utcnow() - timedelta(days=1)).isoformat()
    assert titles(ok(token, "/api/v1/notes", changed_since=since)) == ["Einkauf"]
    # 50 from the start, 500 at most; a cursor that is not ours is refused.
    assert len(ok(token, "/api/v1/notes", limit=500)["notes"]) == 5
    assert get(token, "/api/v1/notes", limit=501).status_code == 422
    broken = get(token, "/api/v1/notes", cursor="nonsense")
    assert broken.status_code == 422 and broken.json()["detail"]["fields"] == ["cursor"]


# --- AC-9: one note -------------------------------------------------------------------------------------------------


def _drop_one_letter(doc) -> None:
    def walk(node) -> bool:
        for child in node.children:
            if isinstance(child, XmlText):
                if len(str(child)) > 1:
                    del child[0:1]
                    return True
            elif hasattr(child, "children") and walk(child):
                return True
        return False

    assert walk(notedoc.body_of(doc))


def test_notes25_ac9_one_note_with_markdown_numbered_items_and_its_state_as_etag(client, operator):
    note = new_note(client, title="Einkauf", markdown="Für Samstag\n\n- [ ] Milch\n- [x] Brot")
    token = token_of(client)
    answer = get(token, f"/api/v1/notes/{note['id']}")
    assert answer.status_code == 200
    body = answer.json()
    assert "Für Samstag" in body["markdown"] and "- [ ] Milch" in body["markdown"] and body["truncated"] is False
    assert [(item["index"], item["text"], item["checked"]) for item in body["items"]] == [
        (0, "Milch", False), (1, "Brot", True)]
    # The fields the card reads stay.
    assert {"id", "title", "link", "updated_at", "can_check", "tasks", "items", "more_items", "lines", "stamp",
            "as_of"} <= set(body)
    assert len(body["etag"]) == 32 and answer.headers["etag"] == f'"{body["etag"]}"'
    # The same state, the same etag, wherever the document was loaded.
    assert get(token, f"/api/v1/notes/{note['id']}").json()["etag"] == body["etag"]
    # A change that only deletes changes it too.
    asyncio.run(notes.change(note["id"], _drop_one_letter))
    changed = get(token, f"/api/v1/notes/{note['id']}").json()
    assert changed["etag"] != body["etag"] and "ür Samstag" in changed["markdown"]
    assert "markdown" not in get(token, f"/api/v1/notes/{note['id']}", markdown="false").json()


# --- AC-10: search --------------------------------------------------------------------------------------------------


def test_notes25_ac10_search_finds_text_and_tags_with_an_excerpt_page_by_page(client, operator):
    new_note(client, title="Rezept", markdown="Ein Kuchen mit viel Zimt #backen")
    for number in range(3):
        new_note(client, title=f"Zimt {number}", markdown="Zimtsterne")
    new_note(client, title="Anderes", markdown="nichts")
    token = token_of(client)
    found = ok(token, "/api/v1/search", q="Kuchen")
    assert [hit["title"] for hit in found["notes"]] == ["Rezept"]
    hit = found["notes"][0]
    assert "«Kuchen»" in hit["snippet"] and any(part.get("hit") for part in hit["excerpt"])
    assert [hit["title"] for hit in ok(token, "/api/v1/search", q="#backen")["notes"]] == ["Rezept"]
    first = ok(token, "/api/v1/search", q="Zimt", limit=2)
    assert first["total"] == 4 and len(first["notes"]) == 2 and first["next_cursor"]
    rest = ok(token, "/api/v1/search", q="Zimt", limit=2, cursor=first["next_cursor"])
    assert len(rest["notes"]) == 2 and rest["next_cursor"] is None
    assert get(token, "/api/v1/search").status_code == 422


# --- AC-11: folders, tags, smart folders, shares --------------------------------------------------------------------


def test_notes25_ac11_folders_tags_smart_folders_and_what_others_share(client, operator):
    home = make_folder(client, "Haushalt")
    shop = make_folder(client, "Einkauf", home)
    new_note(client, title="A", markdown="Milch #laden #laden2", folder_id=shop)
    new_note(client, title="B", markdown="Brot #laden")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = make_folder(as_anna, "Annas Rezepte")
        shared_note = new_note(as_anna, title="Annas Notiz", markdown="x")
        share(as_anna, "folder", theirs, operator, "write")
        share(as_anna, "note", shared_note["id"], operator, "read")
    smart = client.post("/api/smart-folders", json={"name": "Laden", "conditions": [
        {"kind": "text", "value": "#laden"}]}).json()
    token = token_of(client)
    tree = ok(token, "/api/v1/folders")
    assert tree["inbox"]["count"] == 1
    assert tree["folders"][0]["name"] == "Haushalt" and tree["folders"][0]["children"][0]["name"] == "Einkauf"
    assert tree["folders"][0]["children"][0]["count"] == 1 and "icon" in tree["folders"][0]
    assert [(folder["name"], folder["access"]) for folder in tree["shared_with_me"]] == [("Annas Rezepte", "write")]
    tags = {tag["name"]: tag["count"] for tag in ok(token, "/api/v1/tags")["tags"]}
    assert tags["laden"] == 2 and tags["laden2"] == 1
    smart_list = ok(token, "/api/v1/smart-folders")["smart_folders"]
    mine = next(folder for folder in smart_list if folder["id"] == smart["id"])
    assert mine["count"] == 2 and mine["conditions"][0]["kind"] == "text"
    assert set(titles(ok(token, f"/api/v1/smart-folders/{smart['id']}/notes"))) == {"A", "B"}
    assert code(get(token, "/api/v1/smart-folders/no-such/notes")) == "not_found"
    groups = ok(token, "/api/v1/shares/with-me")["groups"]
    assert [(item["kind"], item["title"], item["access"]) for item in groups[0]["items"]] == [
        ("folder", "Annas Rezepte", "write"), ("note", "Annas Notiz", "read")]


# --- AC-12: attachments ---------------------------------------------------------------------------------------------


def test_notes25_ac12_attachments_are_listed_and_loaded_only_when_the_note_may_be_read(client, operator):
    note = new_note(client, title="Mit Anhang", markdown="x")
    found = attached(client, note["id"], b"hello, attachment", "gruss.txt")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Fremd", markdown="x")
        foreign = attached(as_anna, theirs["id"], b"not yours", "fremd.txt")
    token = token_of(client)
    listed = ok(token, f"/api/v1/notes/{note['id']}/attachments")["attachments"]
    assert [(item["id"], item["name"], item["size"]) for item in listed] == [(found["id"], "gruss.txt", 17)]
    assert {"kind", "mime", "file"} <= set(listed[0])
    loaded = get(token, listed[0]["file"])
    assert loaded.status_code == 200 and loaded.content == b"hello, attachment"
    assert "attachment" in loaded.headers["content-disposition"]
    assert code(get(token, f"/api/v1/attachments/{foreign['id']}/file")) == "not_found"
    # Limited to a folder the note is not in: not there either.
    home = make_folder(client, "Haushalt")
    limited = token_of(client, name="limited", folders=[home])
    assert code(get(limited, f"/api/v1/attachments/{found['id']}/file")) == "not_found"


# --- AC-13, EC-3: the trash -----------------------------------------------------------------------------------------


def test_notes25_ac13_ec3_the_trash_with_the_day_each_goes_and_a_trashed_note_answers_410(client, operator):
    gone = new_note(client, title="Weg", markdown="x")
    folder = make_folder(client, "Alter Ordner")
    new_note(client, title="Im alten Ordner", markdown="y", folder_id=folder)
    assert client.delete(f"/api/notes/{gone['id']}").status_code == 204
    assert client.delete(f"/api/folders/{folder}").status_code == 200
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = new_note(as_anna, title="Annas Müll", markdown="z")
        as_anna.delete(f"/api/notes/{theirs['id']}")
    token = token_of(client)
    trash = ok(token, "/api/v1/trash")
    items = {(item["kind"], item["title"]): item for item in trash["items"]}
    assert set(items) == {("note", "Weg"), ("folder", "Alter Ordner")}
    assert items[("note", "Weg")]["expires_at"] and items[("folder", "Alter Ordner")]["notes"] == 1
    assert trash["trash_days"] == 90
    trashed = get(token, f"/api/v1/notes/{gone['id']}")
    assert trashed.status_code == 410 and code(trashed) == "note_trashed" and "Weg" not in trashed.text
    assert code(get(token, f"/api/v1/notes/{gone['id']}/attachments")) == "note_trashed"
    assert code(get(token, f"/api/v1/notes/{theirs['id']}")) == "not_found"


# --- EC-7: locked notes ---------------------------------------------------------------------------------------------


def test_notes25_ec7_a_locked_note_shows_its_title_only_and_answers_409(client, operator):
    note = new_note(client, title="Tresor", markdown="Geheimnis #privat")
    new_note(client, title="Offen", markdown="Geheimnis")
    lock(note["id"])
    token = token_of(client)
    # The list leaves it out as the card always did, and names it on request: title and locked, nothing more.
    assert titles(ok(token, "/api/v1/notes")) == ["Offen"]
    listed = ok(token, "/api/v1/notes", locked="true")["notes"]
    locked = next(item for item in listed if item["id"] == note["id"])
    assert locked["title"] == "Tresor" and locked["locked"] is True
    assert locked["tags"] == [] and locked["tasks"] is None
    answer = get(token, f"/api/v1/notes/{note['id']}")
    assert answer.status_code == 409 and code(answer) == "note_locked" and "Geheimnis" not in answer.text
    assert code(get(token, f"/api/v1/notes/{note['id']}/attachments")) == "note_locked"
    hit = next(hit for hit in ok(token, "/api/v1/search", q="Tresor")["notes"] if hit["id"] == note["id"])
    assert hit["locked"] is True and hit["excerpt"] == [] and hit["snippet"] == ""
    # An older card key never sees it in the list, also not on request.
    from .test_notes25_tokens import legacy

    card = legacy(operator, "dashboard")
    assert "Tresor" not in titles(ok(card, "/api/v1/notes", locked="true"))


# --- AC-7: an empty limit, shared folders, the trash ----------------------------------------------------------------


def test_notes25_ac7_a_limit_with_no_folder_left_sees_nothing_never_everything(client, operator):
    home = make_folder(client, "Haushalt")
    new_note(client, title="Drin", markdown="Milch #drin", folder_id=home)
    outside = new_note(client, title="Im Eingang", markdown="Milch #draussen")
    assert client.put(f"/api/notes/{outside['id']}/pin", json={"pinned": True}).status_code == 200
    smart = client.post("/api/smart-folders", json={"name": "Milch", "conditions": [{"kind": "text", "value": "Milch"}]})
    assert smart.status_code == 201, smart.text
    reads = token_of(client, folders=[home])
    writes = token_of(client, name="writes", level="write", folders=[home])
    assert titles(ok(reads, "/api/v1/notes")) == ["Drin"]
    # The only chosen folder goes into the trash: the limit holds no folder any more, and that means nothing to see.
    assert client.delete(f"/api/folders/{home}").status_code == 200

    def sees_nothing(token: str) -> None:
        assert ok(token, "/api/v1/notes")["notes"] == []
        assert ok(token, "/api/v1/notes", locked="true")["notes"] == []
        assert ok(token, "/api/v1/notes", pinned="true")["notes"] == []
        assert ok(token, "/api/v1/search", q="Milch")["total"] == 0
        assert ok(token, "/api/v1/tags")["tags"] == []
        smart_folders = ok(token, "/api/v1/smart-folders")["smart_folders"]
        assert smart_folders and all(folder["count"] == 0 for folder in smart_folders)
        assert ok(token, f"/api/v1/smart-folders/{smart.json()['id']}/notes")["notes"] == []
        assert ok(token, "/api/v1/folders") == {"inbox": None, "folders": [], "shared_with_me": []}
        assert ok(token, "/api/v1/dashboard")["pinned"] == []
        assert code(get(token, f"/api/v1/notes/{outside['id']}")) == "not_found"

    sees_nothing(reads)
    made = program().post("/api/v1/notes", json={"markdown": "Neu"}, headers={"Authorization": f"Bearer {writes}"})
    assert made.status_code == 404 and code(made) == "not_found"
    # A limit stored without any folder (never made so) is no "every note" either.
    from app.models import ApiToken

    with SessionLocal() as db:
        for row in db.query(ApiToken).all():
            row.folder_ids = []
        db.commit()
    assert client.post(f"/api/folders/{home}/restore").status_code == 200
    sees_nothing(reads)


def test_notes25_ac7_shared_folders_the_trash_and_restore_stay_within_the_limit(client, operator):
    home = make_folder(client, "Haushalt")
    sub = make_folder(client, "Alte Liste", home)
    old = make_folder(client, "Altes Projekt")
    inside = new_note(client, title="Drin weg", markdown="x", folder_id=home)
    outside = new_note(client, title="Draussen weg", markdown="y")
    for note in (inside, outside):
        assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    for folder in (sub, old):
        assert client.delete(f"/api/folders/{folder}").status_code == 200
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        theirs = make_folder(as_anna, "Annas Rezepte")
        share(as_anna, "folder", theirs, operator, "write")
    every = token_of(client)
    reads = token_of(client, name="limited", folders=[home])
    writes = token_of(client, name="limited-w", level="write", folders=[home])
    # A folder shared with the account lies in none of its folders.
    assert [folder["name"] for folder in ok(every, "/api/v1/folders")["shared_with_me"]] == ["Annas Rezepte"]
    assert ok(reads, "/api/v1/folders")["shared_with_me"] == []
    assert ok(reads, "/api/v1/shares/with-me")["groups"] == []
    assert code(get(reads, "/api/v1/notes", folder=theirs)) == "not_found"
    # The trash: only what lay within the token's folders.
    assert {(item["kind"], item["title"]) for item in ok(every, "/api/v1/trash")["items"]} == {
        ("note", "Drin weg"), ("note", "Draussen weg"), ("folder", "Alte Liste"), ("folder", "Altes Projekt")}
    assert {(item["kind"], item["title"]) for item in ok(reads, "/api/v1/trash")["items"]} == {
        ("note", "Drin weg"), ("folder", "Alte Liste")}

    def restore(kind: str, item_id: str):
        return program().post(f"/api/v1/{kind}/{item_id}/restore", headers={"Authorization": f"Bearer {writes}"})

    # Bringing back: only within, and what lies outside stays in the trash.
    for kind, item_id in (("notes", outside["id"]), ("folders", old)):
        refused = restore(kind, item_id)
        assert refused.status_code == 404 and code(refused) == "not_found", kind
    with SessionLocal() as db:
        assert db.get(Note, outside["id"]).deleted_at is not None
    assert restore("notes", inside["id"]).status_code == 200
    assert restore("folders", sub).status_code == 200
    with SessionLocal() as db:
        assert db.get(Note, inside["id"]).deleted_at is None


# --- AC-12: a file another note shows -------------------------------------------------------------------------------


def test_notes25_ac12_a_file_loads_through_the_note_that_shows_it_by_the_rules_of_the_interface(client, operator):
    from .test_notes3 import wait_for
    from .test_notes10 import add_blocks, block, refs_of

    work = make_folder(client, "Arbeit")
    home = make_folder(client, "Haushalt")
    elsewhere = make_folder(client, "Anderswo")
    origin = new_note(client, title="Ursprung", markdown="x", folder_id=work)
    row = attached(client, origin["id"], b"copied file", "kopie.txt")
    shows = new_note(client, title="Zeigt es", markdown="y", folder_id=home)
    # A block copied from one note into another (the interface loads the file through either).
    add_blocks(shows["id"], operator.id, block("attachment", row))
    assert wait_for(lambda: refs_of(shows["id"]) == [row["id"]])
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    limited = token_of(client, name="home", folders=[home])
    listed = ok(limited, f"/api/v1/notes/{shows['id']}/attachments")["attachments"]
    assert [item["id"] for item in listed] == [row["id"]]
    loaded = get(limited, listed[0]["file"])
    assert loaded.status_code == 200 and loaded.content == b"copied file"
    # A token that may read neither note does not load it.
    other = token_of(client, name="elsewhere", folders=[elsewhere])
    assert code(get(other, f"/api/v1/attachments/{row['id']}/file")) == "not_found"
    # The first note in the trash: the note that still shows it opens it.
    every = token_of(client)
    assert client.delete(f"/api/notes/{origin['id']}").status_code == 204
    assert get(every, f"/api/v1/attachments/{row['id']}/file").status_code == 200
    assert client.get(f"/api/attachments/{row['id']}/file").status_code == 200
    # Shared with the account: what the owner put into the shared note opens, what a member wrote into it does not.
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        hers = new_note(as_anna, title="Annas Fotos", markdown="x")
        put_by_owner = attached(as_anna, hers["id"], b"put there by anna", "anna.txt")
        hidden = new_note(as_anna, title="Annas Geheimes", markdown="x")
        not_put = attached(as_anna, hidden["id"], b"never shared", "geheim.txt")
        shared = new_note(as_anna, title="Gemeinsam", markdown="z")
        share(as_anna, "note", shared["id"], operator, "write")
    add_blocks(shared["id"], anna.id, block("attachment", put_by_owner))
    add_blocks(shared["id"], operator.id, block("attachment", not_put))
    assert wait_for(lambda: set(refs_of(shared["id"])) == {put_by_owner["id"], not_put["id"]})
    assert client.get(f"/api/attachments/{put_by_owner['id']}/file").status_code == 200
    assert client.get(f"/api/attachments/{not_put['id']}/file").status_code == 404
    assert [item["id"] for item in ok(every, f"/api/v1/notes/{shared['id']}/attachments")["attachments"]] == [
        put_by_owner["id"]]
    shown = get(every, f"/api/v1/attachments/{put_by_owner['id']}/file")
    assert shown.status_code == 200 and shown.content == b"put there by anna"
    assert code(get(every, f"/api/v1/attachments/{not_put['id']}/file")) == "not_found"
    # Limited to own folders: the shared note lies in none of them.
    assert code(get(limited, f"/api/v1/attachments/{put_by_owner['id']}/file")) == "not_found"


# --- EC-7: tags and excerpts of locked notes ------------------------------------------------------------------------


def test_notes25_ec7_a_locked_note_gives_no_tags_and_no_excerpt_anywhere(client, operator):
    note = new_note(client, title="Tresor", markdown="Geheimnis im Tresor #privat")
    new_note(client, title="Offen", markdown="Geheimnis offen #offen")
    lock(note["id"])
    token = token_of(client)
    assert [tag["name"] for tag in ok(token, "/api/v1/tags")["tags"]] == ["offen"]
    listed = ok(token, "/api/v1/notes", locked="true")["notes"]
    assert next(item for item in listed if item["id"] == note["id"])["tags"] == []
    assert note["id"] not in {item["id"] for item in ok(token, "/api/v1/notes", tag="privat", locked="true")["notes"]}
    for query in ("Geheimnis", "Tresor"):
        for hit in ok(token, "/api/v1/search", q=query)["notes"]:
            if hit["id"] == note["id"]:
                assert hit["locked"] is True and hit["excerpt"] == [] and hit["snippet"] == "", query
                assert hit["attachment"] is None
    found = get(token, "/api/v1/search", q="Geheimnis")
    assert "im Tresor" not in found.text and "privat" not in found.text


def test_notes25_ec7_the_api_holds_back_tags_and_excerpts_of_locked_notes_on_its_own(client, operator, monkeypatch):
    """The second line: should the tag table or the search ever give something of a locked note, the API still says
    nothing of it."""
    from app.services import apiv1, search

    note = new_note(client, title="Tresor", markdown="Geheimnis im Tresor #privat")
    lock(note["id"])
    token = token_of(client)
    real_labels = apiv1._labels
    monkeypatch.setattr(apiv1, "_labels", lambda db, note_ids: real_labels(db, [*note_ids, note["id"]]))
    monkeypatch.setattr(search, "_hidden", lambda db, found: False)
    listed = ok(token, "/api/v1/notes", locked="true")["notes"]
    assert next(item for item in listed if item["id"] == note["id"])["tags"] == []
    hit = next(hit for hit in ok(token, "/api/v1/search", q="Geheimnis")["notes"] if hit["id"] == note["id"])
    assert hit["locked"] is True and hit["excerpt"] == [] and hit["snippet"] == "" and hit["attachment"] is None
