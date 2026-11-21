"""NOTES-5 Schlagwörter: the server's part (the rule, the table that follows the text, the list, the page of a tag,
renaming, merging and deleting through the live room)."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from pycrdt import XmlElement, XmlFragment, XmlText
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import Account, Note, Setting
from app.models_tags import NoteTag
from app.notedoc import doc as notedoc
from app.notedoc import edit
from app.notedoc.markdown import to_plain
from app.notedoc.room import Access
from app.services import notes, tags

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import folder, new_note, stored, stored_doc, token_for, wait_for

CASES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "tags" / "cases.json"


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def quick_rooms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)


@pytest.fixture
def sharing(monkeypatch: pytest.MonkeyPatch):
    """Stands in for sharing (NOTES-13): ``sharing[account_id] = {note ids}`` lets the account read those notes."""
    shared: dict[int, set[str]] = {}

    def rule(_db, account, note):
        return Access.WRITE if note.id in shared.get(account.id, set()) else None

    monkeypatch.setattr(notes, "ACCESS_RULES", [rule])
    monkeypatch.setattr(tags, "SHARED_NOTES", [lambda account_id: select(Note.id).where(
        Note.id.in_(sorted(shared.get(account_id, set()))))])
    return shared


@pytest.fixture
def locking(monkeypatch: pytest.MonkeyPatch):
    """Stands in for the vault (NOTES-16): notes whose ids are in the set are locked."""
    locked: set[str] = set()
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id.in_(sorted(locked))])
    return locked


def tag_rows(note_id: str) -> dict[str, int]:
    with SessionLocal() as db:
        return {row.label: row.count for row in db.scalars(select(NoteTag).where(NoteTag.note_id == note_id))}


def listed(client) -> list[tuple[str, int]]:
    answer = client.get("/api/tags")
    assert answer.status_code == 200, answer.text
    return [(tag["label"], tag["count"]) for tag in answer.json()["tags"]]


def account_row(account_id: int) -> Account:
    with SessionLocal() as db:
        row = db.get(Account, account_id)
        assert row is not None
        db.expunge(row)
        return row


# --- The rule: AC-1, EC-1, EC-2, EC-3 ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", json.loads(CASES.read_text(encoding="utf-8"))["cases"], ids=lambda case: case["id"])
def test_notes5_ac1_ec1_ec2_ec3_the_rule_reads_every_shared_case(case):
    """The same cases the editor's rule reads (``src/tags/rules.test.ts``): addresses, numbers, headings, punctuation,
    case, umlauts, emoji."""
    assert [tag.label for tag in tags.find_tags(case["text"])] == case["tags"]


def test_notes5_ec1_code_links_code_blocks_and_addresses_hold_no_tags(client, account):
    note = new_note(client, title="Bath", markdown=(
        "Text `#code` and [#link](https://example.com) and https://example.com/#part\n\n```\n#block\n```\n\n"
        "# Heading #inheading\n\n**#bold** #real #1"))
    assert tag_rows(note["id"]) == {"inheading": 1, "bold": 1, "real": 1}


def test_notes5_ec2_ec3_case_is_one_tag_shown_in_the_spelling_used_most(client, account):
    new_note(client, title="A", markdown="#Einkauf und #einkauf")
    new_note(client, title="B", markdown="#einkauf, #Gemüse-Garten_ und #🏖.")
    new_note(client, title="C", markdown="#gemüse-garten")
    found = {tag["key"]: (tag["label"], tag["count"]) for tag in client.get("/api/tags").json()["tags"]}
    assert found == {"einkauf": ("einkauf", 2), "gemüse-garten": ("Gemüse-Garten", 2), "🏖": ("🏖", 1)}
    page = client.get("/api/tags/EINKAUF").json()
    assert page["label"] == "einkauf" and page["count"] == 2


# --- AC-1: the table follows the text --------------------------------------------------------------------------


def test_notes5_ac1_tags_follow_the_text_as_it_is_typed(client, account):
    note = new_note(client, title="Shopping")
    live = Live(client, note["id"], token_for(account))
    assert live.pump(lambda: live.synced)
    edit.append_paragraph(live.doc, "Milk #einkauf")
    assert wait_for(lambda: tag_rows(note["id"]) == {"einkauf": 1}, timeout=4.0)
    # A tag put into code is no tag any more, though the plain text stays the same.
    body = live.doc.get("body", type=XmlFragment)
    run = next(text for child in body.children if isinstance(child, XmlElement) and child.tag == "paragraph"
               for text in child.children if isinstance(text, XmlText) and "Milk" in str(text))
    run.format(len(b"Milk "), len(b"Milk #einkauf"), {"code": {}})
    assert wait_for(lambda: tag_rows(note["id"]) == {}, timeout=4.0)
    live.close()
    assert stored(note["id"]).text == "Milk #einkauf"
    assert tag_rows(note["id"]) == {}


def test_notes5_ac1_the_note_list_carries_the_tags_of_every_note(client, account):
    first = new_note(client, title="One", markdown="#bad #Küche #bad")
    second = new_note(client, title="Two", markdown="nothing")
    items = {item["id"]: item for item in client.get("/api/notes").json()}
    assert items[first["id"]]["tags"] == ["bad", "Küche"]
    assert items[second["id"]]["tags"] == []


def test_notes5_ac1_a_copy_and_a_note_from_before_tags_have_their_tags(client, account):
    note = new_note(client, title="Bath", markdown="#bad")
    copy = client.post(f"/api/notes/{note['id']}/duplicate").json()
    assert tag_rows(copy["id"]) == {"bad": 1}
    # Data from before NOTES-5: no rows, no rule version. The start reads every note again.
    with SessionLocal() as db:
        db.execute(delete(NoteTag))
        db.execute(delete(Setting).where(Setting.key == tags.RULES_SETTING))
        db.commit()
    assert tag_rows(note["id"]) == {}
    assert tags.rebuild_if_needed() == 2
    assert tag_rows(note["id"]) == {"bad": 1} and tag_rows(copy["id"]) == {"bad": 1}
    assert tags.rebuild_if_needed() == 0


# --- AC-2, AC-3, EC-4, EC-5, EC-6 ------------------------------------------------------------------------------


def test_notes5_ac2_the_list_is_ordered_by_frequency_and_the_page_counts(client, account):
    for index in range(3):
        new_note(client, title=f"Shop {index}", markdown="#einkauf")
    new_note(client, title="Bath", markdown="#bad #einkauf")
    new_note(client, title="Bath 2", markdown="#bad")
    new_note(client, title="Holiday", markdown="#urlaub")
    assert listed(client) == [("einkauf", 4), ("bad", 2), ("urlaub", 1)]
    page = client.get("/api/tags/%23bad").json()
    assert (page["label"], page["count"], page["mine"], page["others"]) == ("bad", 2, 2, [])
    # Only one's own tags: another account sees nothing of them.
    with new_client(make_account("other")) as other:
        assert listed(other) == []
        assert other.get("/api/tags/bad").json()["count"] == 0


def test_notes5_ac3_ec4_the_page_shows_own_and_shared_notes_with_folder_and_date(client, account, sharing):
    lena = make_account("lena")
    kitchen = folder(account, "Kitchen")
    mine = new_note(client, title="Saturday", markdown="Milk #einkauf", folder_id=kitchen)
    inbox_note = new_note(client, title="Inbox one", markdown="#einkauf")
    with new_client(lena) as theirs_client:
        theirs = new_note(theirs_client, title="Barbecue", markdown="#Einkauf #grill")
        only_lena = new_note(theirs_client, title="Not shared", markdown="#einkauf")
    sharing[account.id] = {theirs["id"]}
    page = client.get("/api/tags/einkauf").json()
    assert page["count"] == 3 and page["mine"] == 2
    assert page["others"] == [{"id": lena.id, "name": "Lena", "count": 1}]
    rows = {row["id"]: row for row in page["notes"]}
    assert set(rows) == {mine["id"], inbox_note["id"], theirs["id"]}
    assert only_lena["id"] not in rows
    assert rows[mine["id"]]["folder"] == {"id": kitchen, "name": "Kitchen", "inbox": False}
    assert rows[inbox_note["id"]]["folder"]["inbox"] is True
    assert rows[theirs["id"]]["folder"] is None and rows[theirs["id"]]["owner"] == {"id": lena.id, "name": "Lena"}
    assert all(row["updated_at"] for row in page["notes"])
    assert rows[mine["id"]]["preview"] == "Milk #einkauf" and rows[mine["id"]]["mine"] is True
    # EC-4: a tag only in a shared note is in the recipient's list too.
    assert ("grill", 1) in listed(client)
    # The shared note opens for the recipient.
    assert client.get(f"/api/notes/{theirs['id']}").status_code == 200


@pytest.mark.timing
def test_notes5_ec5_five_hundred_tags_come_in_one_quick_answer(client, account):
    words = [f"tag{index:03d}x" for index in range(500)]
    # tag000x stands in 20 notes, tag001x in 19 … so that the order is known; the rest once.
    for repeat in range(20):
        new_note(client, title=f"Many {repeat}", markdown=" ".join(f"#{word}" for word in words[:20 - repeat]))
    new_note(client, title="Rest", markdown=" ".join(f"#{word}" for word in words[20:]))
    started = time.monotonic()
    answer = client.get("/api/tags").json()
    took = time.monotonic() - started
    assert answer["total"] == 500 and len(answer["tags"]) == 500
    assert [tag["label"] for tag in answer["tags"][:20]] == words[:20]
    assert [tag["count"] for tag in answer["tags"][:3]] == [20, 19, 18]
    assert took < 1.0


def test_notes5_ec6_a_locked_note_counts_nowhere(client, account, locking):
    open_note = new_note(client, title="Open", markdown="#bad")
    secret = new_note(client, title="Secret", markdown="#bad #geheim")
    locking.add(secret["id"])
    assert listed(client) == [("bad", 1)]
    page = client.get("/api/tags/geheim").json()
    assert page["count"] == 0 and page["notes"] == []
    assert [row["id"] for row in client.get("/api/tags/bad").json()["notes"]] == [open_note["id"]]
    # Renaming leaves the locked note alone.
    client.put("/api/tags/bad", json={"name": "badezimmer"})
    assert to_plain(stored_doc(secret["id"])) == "#bad #geheim"


def test_notes5_ac2_notes_in_the_trash_count_until_they_come_back(client, account):
    note = new_note(client, title="Bath", markdown="#bad")
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert listed(client) == []
    client.post(f"/api/notes/{note['id']}/restore")
    assert listed(client) == [("bad", 1)]


# --- AC-4, AC-5, AC-7, EC-7 ------------------------------------------------------------------------------------


def test_notes5_ac4_renaming_changes_own_notes_and_leaves_shared_ones(client, account, sharing):
    lena = make_account("lena")
    first = new_note(client, title="One", markdown="Milk #einkauf and **#Einkauf** today")
    second = new_note(client, title="Two", markdown="#einkauf")
    code = new_note(client, title="Three", markdown="`#einkauf` stays code, #einkaufsliste is another")
    with new_client(lena) as theirs_client:
        theirs = new_note(theirs_client, title="Lena's", markdown="#einkauf")
    sharing[account.id] = {theirs["id"]}
    # The dialog says beforehand: two own notes change, one of Lena's stays.
    page = client.get("/api/tags/einkauf").json()
    assert (page["mine"], page["others"][0]["count"]) == (2, 1)
    answer = client.put("/api/tags/einkauf", json={"name": "#einkaufen"})
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"label": "einkaufen", "key": "einkaufen", "changed": 2, "kept": 1}
    assert to_plain(stored_doc(first["id"])) == "Milk #einkaufen and #einkaufen today"
    assert to_plain(stored_doc(second["id"])) == "#einkaufen"
    assert to_plain(stored_doc(code["id"])) == "#einkauf stays code, #einkaufsliste is another"
    assert to_plain(stored_doc(theirs["id"])) == "#einkauf"
    # The bold one stays bold.
    runs = notedoc.to_json(stored_doc(first["id"]))["content"][0]["content"]
    assert [(run["text"], run.get("marks")) for run in runs] == [
        ("Milk #einkaufen and ", None), ("#einkaufen", [{"type": "bold"}]), (" today", None)]
    assert dict(listed(client)) == {"einkaufen": 2, "einkauf": 1, "einkaufsliste": 1}
    # The column the lists read follows.
    assert wait_for(lambda: stored(first["id"]).text == "Milk #einkaufen and #einkaufen today")


def test_notes5_ac4_an_open_editor_sees_the_rename_at_once(client, account):
    note = new_note(client, title="Bath", markdown="Tiles #bad")
    live = Live(client, note["id"], token_for(account))
    assert live.pump(lambda: live.synced)
    assert client.put("/api/tags/bad", json={"name": "badezimmer"}).json()["changed"] == 1
    assert live.pump(lambda: live.text == "Tiles #badezimmer"), live.text
    assert tag_rows(note["id"]) == {"badezimmer": 1}
    live.close()


def test_notes5_ac4_a_name_that_is_no_tag_is_refused(client, account):
    new_note(client, title="Bath", markdown="#bad")
    for name in ("", "#", "two words", "123", "bad.", "a" * 65):
        answer = client.put("/api/tags/bad", json={"name": name})
        assert answer.status_code == 422, name
        assert answer.json()["detail"]["code"] == "tag_name_invalid"
    assert client.get("/api/tags/no%20tag").status_code == 422
    assert to_plain(stored_doc(client.get("/api/notes").json()[0]["id"])) == "#bad"


def test_notes5_ac4_only_the_case_changes(client, account):
    note = new_note(client, title="Shop", markdown="#einkauf #Einkauf")
    assert client.put("/api/tags/einkauf", json={"name": "Einkauf"}).status_code == 200
    assert to_plain(stored_doc(note["id"])) == "#Einkauf #Einkauf"


def test_notes5_ac5_deleting_takes_the_tag_out_and_the_rest_stays(client, account, sharing):
    lena = make_account("lena")
    note = new_note(client, title="Shop", markdown="Milk #einkauf bread\n\n#Einkauf Eggs\n\nCheese #einkauf.\n\n#einkaufsliste")
    with new_client(lena) as theirs_client:
        theirs = new_note(theirs_client, title="Lena's", markdown="#einkauf")
    sharing[account.id] = {theirs["id"]}
    answer = client.delete("/api/tags/einkauf")
    assert answer.status_code == 200 and answer.json() == {"changed": 1, "kept": 1}
    assert to_plain(stored_doc(note["id"])) == "Milk bread\nEggs\nCheese.\n#einkaufsliste"
    assert to_plain(stored_doc(theirs["id"])) == "#einkauf"
    assert dict(listed(client)) == {"einkauf": 1, "einkaufsliste": 1}


def test_notes5_ac7_renaming_onto_an_existing_tag_asks_then_merges(client, account):
    a = new_note(client, title="A", markdown="#einkauf")
    b = new_note(client, title="B", markdown="#Shopping #shopping")
    refused = client.put("/api/tags/einkauf", json={"name": "shopping"})
    assert refused.status_code == 409
    assert refused.json()["detail"] | {"message": ""} == {"code": "tag_exists", "message": "", "label": "Shopping",
                                                           "count": 1}
    assert to_plain(stored_doc(a["id"])) == "#einkauf"
    merged = client.put("/api/tags/einkauf", json={"name": "shopping", "merge": True})
    assert merged.status_code == 200 and merged.json()["changed"] == 1
    assert listed(client) == [("shopping", 2)]
    assert to_plain(stored_doc(a["id"])) == "#shopping"
    assert to_plain(stored_doc(b["id"])) == "#Shopping #shopping"


def test_notes5_ec7_two_renames_and_typing_at_the_same_moment_lose_nothing(client, account, sharing):
    anna = make_account("anna")
    note = new_note(client, title="Shared", markdown="Tiles #bad\n\nmore text")
    sharing[anna.id] = {note["id"]}
    typing = Live(client, note["id"], token_for(anna))
    mine = Live(client, note["id"], token_for(account))
    assert typing.pump(lambda: typing.synced) and mine.pump(lambda: mine.synced)
    owner = account_row(account.id)
    # Anna types while two windows of the owner rename the same tag at once.
    edit.append_paragraph(typing.doc, "Anna was here")

    async def both() -> list[object]:
        return await asyncio.gather(tags.rename(owner, "bad", "badezimmer"), tags.rename(owner, "bad", "bath"),
                                    return_exceptions=True)

    results = client.portal.call(both)
    assert all(isinstance(result, dict) for result in results), results
    for live in (typing, mine, typing, mine):
        live.settle(0.3)
    final = to_plain(stored_doc(note["id"]))
    assert typing.text == mine.text == final
    assert "Anna was here" in final and "more text" in final
    # One of the two names won; the old one is gone, nothing doubled.
    assert final.startswith(("Tiles #badezimmer\n", "Tiles #bath\n")), final
    assert "#bad\n" not in final and final.count("#") == 1
    typing.close()
    mine.close()


def test_notes5_renaming_is_for_signed_in_members_only(client):
    assert client.get("/api/tags").status_code == 401
    assert client.put("/api/tags/bad", json={"name": "x"}).status_code in (401, 403)


# --- Findings of the review: the trash, a trailing ``_``, the list and locked notes --------------------------------


def test_notes5_ac4_ac5_notes_in_the_trash_change_too(client, account):
    """AC-4 and AC-5 say "all of its own notes": a note in the trash comes back with the new name, or without the tag.
    The count the dialog shows stays with the notes the member sees."""
    living = new_note(client, title="Living", markdown="#trashtag here")
    binned = new_note(client, title="Binned", markdown="#trashtag there")
    assert client.delete(f"/api/notes/{binned['id']}").status_code == 204
    assert client.get("/api/tags/trashtag").json()["mine"] == 1
    renamed = client.put("/api/tags/trashtag", json={"name": "renamed"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["changed"] == 2
    assert to_plain(stored_doc(binned["id"])) == "#renamed there"
    assert client.post(f"/api/notes/{binned['id']}/restore").status_code == 200
    assert dict(listed(client)) == {"renamed": 2}
    assert client.delete(f"/api/notes/{living['id']}").status_code == 204
    assert client.delete("/api/tags/renamed").json()["changed"] == 2
    assert to_plain(stored_doc(living["id"])) == "here"
    assert to_plain(stored_doc(binned["id"])) == "there"


def test_notes5_ac5_a_dash_or_underscore_right_after_the_tag_goes_with_it(client, account):
    note = new_note(client, title="Garden", markdown="#Gemüse-Garten_ und #gemüse-garten-- dort `#gemüse-garten_` #gemüse-garten`_x`")
    assert client.delete("/api/tags/gemüse-garten").json()["changed"] == 1
    assert to_plain(stored_doc(note["id"])) == "und dort #gemüse-garten__x"


def test_notes5_ec6_the_note_list_shows_no_tags_of_a_locked_note(client, account, locking):
    """Prepared for the vault (NOTES-16): the list of notes reads ``note_tags`` through the same docking point."""
    secret = new_note(client, title="Secret", markdown="#geheim")
    open_note = new_note(client, title="Open", markdown="#offen")
    locking.add(secret["id"])
    items = {item["id"]: item for item in client.get("/api/notes").json()}
    assert items[secret["id"]]["tags"] == []
    assert items[open_note["id"]]["tags"] == ["offen"]
