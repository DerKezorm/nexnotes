"""NOTES-7 Intelligente Ordner: the server's part (conditions, all or at least one, the list, the clock and the zone,
locked notes, saving from the search and a tag's page, changing and deleting, the two every account gets, conditions
pointing nowhere, the same name twice, speed). The real tests of NOTES-5 AC-6 and NOTES-9 AC-6, which waited for
smart folders, are here too."""

from __future__ import annotations

import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, insert, select

from app.db import SessionLocal
from app.models import FOLDER_NORMAL, Account, Folder, Note, NoteListView, Setting
from app.models_attachments import Attachment, AttachmentMention, AttachmentRef
from app.models_smart import SmartFolder
from app.services import search, smart_folders
from app.services.inbox import inbox_for

from .conftest import make_account, new_client
from .test_notes13 import share, unshare

# --- Helpers ------------------------------------------------------------------------------------------------------


def note(client, title: str, markdown: str = "", folder_id: str | None = None) -> str:
    answer = client.post("/api/notes", json={"title": title, "markdown": markdown,
                                             **({"folder_id": folder_id} if folder_id else {})})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def folder(client, name: str, parent: str | None = None) -> str:
    answer = client.post("/api/folders", json={"name": name, "parent_id": parent})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def preview(client, *conditions: dict, match: str = "all", tz: str = "Europe/Berlin") -> dict:
    answer = client.post("/api/smart-folders/preview", json={"match": match, "conditions": list(conditions), "tz": tz})
    assert answer.status_code == 200, answer.text
    return answer.json()


def found(client, *conditions: dict, match: str = "all", tz: str = "Europe/Berlin") -> list[str]:
    return sorted(item["title"] for item in preview(client, *conditions, match=match, tz=tz)["items"])


def make(client, name: str, *conditions: dict, match: str = "all") -> dict:
    answer = client.post("/api/smart-folders", json={"name": name, "match": match, "conditions": list(conditions)})
    assert answer.status_code == 201, answer.text
    return answer.json()


def shown(client, folder_id: str, tz: str = "Europe/Berlin") -> dict:
    answer = client.get(f"/api/smart-folders/{folder_id}/notes", params={"tz": tz})
    assert answer.status_code == 200, answer.text
    return answer.json()


def titles(listing: dict) -> list[str]:
    return sorted(item["title"] for item in listing["items"])


def set_times(note_id: str, *, updated: datetime | None = None, created: datetime | None = None) -> None:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        assert row is not None
        if updated is not None:
            row.updated_at = updated
        if created is not None:
            row.created_at = created
        db.commit()


def set_fields(note_id: str, **fields) -> None:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        assert row is not None
        for name, value in fields.items():
            setattr(row, name, value)
        db.commit()


def attach(note_id: str, kind: str) -> None:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        assert row is not None
        attachment_id = secrets.token_urlsafe(16)[:22]
        db.add(Attachment(id=attachment_id, note_id=note_id, owner_id=row.owner_id, kind=kind, name=f"{kind}.bin"))
        db.flush()
        db.add(AttachmentRef(note_id=note_id, attachment_id=attachment_id, position=0))
        db.commit()


def smart_rows(owner: Account) -> list[SmartFolder]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(SmartFolder).where(SmartFolder.owner_id == owner.id)
                               .order_by(SmartFolder.position)))
        for row in rows:
            db.expunge(row)
        return rows


def remove_presets(client) -> None:
    for item in client.get("/api/smart-folders").json()["items"]:
        assert client.delete(f"/api/smart-folders/{item['id']}").status_code == 204


TASKS = {"kind": "tasks", "op": "open"}


# --- AC-1: every condition alone, and together ----------------------------------------------------------------------


def test_notes7_ac1_every_condition_alone(client, operator):
    anna = make_account("anna")
    kitchen = folder(client, "Küche")
    recipes = folder(client, "Rezepte", kitchen)
    soup = note(client, "Linsensuppe", "Zutaten #rezept\n\n- [ ] Linsen\n- [x] Brühe", recipes)
    shakshuka = note(client, "Shakshuka", "Tomaten und Eier #rezept #ausprobieren", kitchen)
    bill = note(client, "Stromrechnung", "Zählerstand prüfen #haushalt")
    done = note(client, "Erledigt", "- [x] alles")
    photo = note(client, "Urlaubsbild")
    attach(photo, "image")
    paper = note(client, "Vertrag")
    attach(paper, "pdf")
    for title, kind in (("Scan", "scan"), ("Aufnahme", "recording"), ("Skizze", "drawing"), ("Film", "video"),
                        ("Datei", "file")):
        attach(note(client, title), kind)
    set_fields(bill, color="orange", pinned_at=datetime.now(UTC))
    share(client, "note", shakshuka, anna)
    with new_client(anna) as theirs:
        from_anna = note(theirs, "Grillabend", "Würstchen #rezept")
        share(theirs, "note", from_anna, operator)
    old = datetime.now(UTC) - timedelta(days=20)
    for note_id in (soup, shakshuka, bill, done, photo, paper):
        set_times(note_id, updated=old, created=old - timedelta(days=200))
    set_times(soup, updated=datetime.now(UTC))

    assert found(client, {"kind": "text", "value": "zähler"}) == ["Stromrechnung"]
    assert found(client, {"kind": "text", "value": "eier"}) == ["Shakshuka"]
    assert found(client, {"kind": "tag", "op": "has", "key": "rezept", "label": "rezept"}) == \
        ["Grillabend", "Linsensuppe", "Shakshuka"]
    without = found(client, {"kind": "tag", "op": "not", "key": "rezept", "label": "rezept"})
    assert "Linsensuppe" not in without and "Stromrechnung" in without and "Grillabend" not in without
    assert found(client, {"kind": "folder", "op": "in", "id": kitchen}) == ["Shakshuka"]
    assert found(client, {"kind": "folder", "op": "tree", "id": kitchen}) == ["Linsensuppe", "Shakshuka"]
    assert found(client, {"kind": "tasks", "op": "open"}) == ["Linsensuppe"]
    assert found(client, {"kind": "attachment", "type": "image"}) == ["Urlaubsbild"]
    assert found(client, {"kind": "attachment", "type": "pdf"}) == ["Vertrag"]
    assert found(client, {"kind": "attachment", "type": "scan"}) == ["Scan"]
    assert found(client, {"kind": "attachment", "type": "recording"}) == ["Aufnahme"]
    assert found(client, {"kind": "attachment", "type": "sketch"}) == ["Skizze"]
    assert found(client, {"kind": "attachment", "type": "video"}) == ["Film"]
    assert found(client, {"kind": "attachment", "type": "file"}) == ["Datei"]
    assert len(found(client, {"kind": "attachment", "type": "any"})) == 7
    assert found(client, {"kind": "shared", "op": "by_me"}) == ["Shakshuka"]
    assert found(client, {"kind": "shared", "op": "with_me"}) == ["Grillabend"]
    assert found(client, {"kind": "pinned"}) == ["Stromrechnung"]
    assert found(client, {"kind": "color", "color": "orange"}) == ["Stromrechnung"]
    # Changed or made: today, the last 7 or 30 days, a period of one's own.
    changed_today = found(client, {"kind": "date", "field": "updated", "period": "today"})
    assert "Linsensuppe" in changed_today and "Stromrechnung" not in changed_today
    assert "Stromrechnung" not in found(client, {"kind": "date", "field": "updated", "period": "week"})
    assert "Stromrechnung" in found(client, {"kind": "date", "field": "updated", "period": "month"})
    assert "Stromrechnung" not in found(client, {"kind": "date", "field": "created", "period": "month"})
    day = (old - timedelta(days=200)).date().isoformat()
    assert found(client, {"kind": "date", "field": "created", "period": "custom", "from": day, "to": day}) == \
        sorted(["Linsensuppe", "Shakshuka", "Stromrechnung", "Erledigt", "Urlaubsbild", "Vertrag"])


def test_notes7_ac1_conditions_combine_and_a_shared_note_counts_as_its_own(client, operator):
    anna = make_account("anna")
    recipes = folder(client, "Rezepte")
    note(client, "Linsensuppe", "#rezept\n\n- [ ] Linsen", recipes)
    note(client, "Shakshuka", "#rezept\n\n- [x] Eier", recipes)
    note(client, "Einkauf", "- [ ] Milch")
    with new_client(anna) as theirs:
        grill = note(theirs, "Grillabend", "#rezept\n\n- [ ] Kohle")
        share(theirs, "note", grill, operator)
    tag = {"kind": "tag", "op": "has", "key": "rezept", "label": "rezept"}
    month = {"kind": "date", "field": "updated", "period": "month"}
    assert found(client, tag, TASKS, month) == ["Grillabend", "Linsensuppe"]
    assert found(client, tag, TASKS, {"kind": "folder", "op": "tree", "id": recipes}) == ["Linsensuppe"]
    listing = preview(client, tag, TASKS)
    grill_item = next(item for item in listing["items"] if item["title"] == "Grillabend")
    assert grill_item["owner"]["name"] == "Anna"
    # A right taken away counts at once.
    with new_client(anna) as theirs:
        unshare(theirs, "note", grill, operator)
    assert found(client, tag, TASKS) == ["Linsensuppe"]


def test_notes7_ac1_invalid_conditions_are_refused(client, operator):
    bad = [
        [],
        [{"kind": "nonsense"}],
        [{"kind": "text", "value": "   "}],
        [{"kind": "tag", "op": "has", "key": "1"}],
        [{"kind": "tag", "op": "maybe", "key": "rezept"}],
        [{"kind": "folder", "op": "in"}],
        [{"kind": "date", "field": "updated", "period": "fortnight"}],
        [{"kind": "date", "field": "updated", "period": "custom"}],
        [{"kind": "date", "field": "updated", "period": "custom", "from": "2026-13-01"}],
        [{"kind": "date", "field": "updated", "period": "custom", "from": "2026-03-02", "to": "2026-03-01"}],
        [{"kind": "attachment", "type": "hologram"}],
        [{"kind": "shared", "op": "with_them"}],
        [{"kind": "color", "color": "#ff0000"}],
        [TASKS] * (search.CONDITIONS_MAX + 1),
        ["text"],
    ]
    for conditions in bad:
        answer = client.post("/api/smart-folders/preview", json={"conditions": conditions})
        assert answer.status_code == 422, conditions
        answer = client.post("/api/smart-folders", json={"name": "X", "conditions": conditions})
        assert answer.status_code == 422, conditions
    assert client.post("/api/smart-folders/preview", json={"match": "some", "conditions": [TASKS]}).status_code == 422


# --- AC-2: all or at least one ---------------------------------------------------------------------------------------


def test_notes7_ac2_all_or_at_least_one(client, operator):
    note(client, "Beides", "#rezept\n\n- [ ] offen")
    note(client, "Nur Rezept", "#rezept")
    note(client, "Nur offen", "- [ ] offen")
    note(client, "Keins", "Text")
    tag = {"kind": "tag", "op": "has", "key": "rezept", "label": "rezept"}
    assert found(client, tag, TASKS, match="all") == ["Beides"]
    assert found(client, tag, TASKS, match="any") == sorted(["Beides", "Nur offen", "Nur Rezept"])
    # The text of the search goes with "at least one" as well.
    assert found(client, {"kind": "text", "value": "keins"}, TASKS, match="any") == sorted(["Beides", "Keins", "Nur offen"])
    # Two texts in one smart folder: each asks the index on its own.
    assert found(client, {"kind": "text", "value": "keins"}, {"kind": "text", "value": "text"}) == ["Keins"]
    assert found(client, {"kind": "text", "value": "keins"}, {"kind": "text", "value": "offen"}, match="any") == \
        sorted(["Beides", "Keins", "Nur offen"])
    made = make(client, "Rezept oder offen", tag, TASKS, match="any")
    assert titles(shown(client, made["id"])) == sorted(["Beides", "Nur offen", "Nur Rezept"])


# --- AC-3: the preview counts ---------------------------------------------------------------------------------------


def test_notes7_ac3_preview_shows_what_fits_now_with_its_count(client, operator):
    for number in range(smart_folders.PREVIEW + 5):
        note(client, f"Liste {number}", "- [ ] offen")
    result = preview(client, TASKS)
    assert result["total"] == smart_folders.PREVIEW + 5
    assert len(result["items"]) == smart_folders.PREVIEW


# --- AC-4: always the state of now, like a folder --------------------------------------------------------------------


def test_notes7_ac4_opened_it_shows_the_state_of_now_like_a_folder(client, operator):
    made = make(client, "Offen", TASKS)
    first = note(client, "Einkauf", "- [ ] Milch")
    listing = shown(client, made["id"])
    assert titles(listing) == ["Einkauf"]
    assert listing["key"] == f"s:{made['id']}" and listing["counts"] == {"own": 1, "shared": 0}
    # The same items as a folder's list gives (rows and tiles show them alike).
    folder_items = client.get("/api/note-list").json()["items"]
    assert listing["items"][0] == next(item for item in folder_items if item["id"] == first)
    stamp = client.get(f"/api/smart-folders/{made['id']}/stamp", params={"tz": "Europe/Berlin"}).json()["stamp"]
    note(client, "Packliste", "- [ ] Zelt")
    assert titles(shown(client, made["id"])) == ["Einkauf", "Packliste"]
    again = client.get(f"/api/smart-folders/{made['id']}/stamp", params={"tz": "Europe/Berlin"}).json()["stamp"]
    assert again != stamp
    # Checked off: out of "open checklists"; in the trash: out as well.
    set_fields(first, tasks_done=1)
    assert titles(shown(client, made["id"])) == ["Packliste"]
    # The sort is kept per smart folder, on every device; how notes look is the account's (no tiles per folder).
    saved = client.put(f"/api/smart-folders/{made['id']}/view", json={"sort": "title"})
    assert saved.status_code == 200 and saved.json()["mode"] == "list" and saved.json()["sort"] == "title"
    with new_client(operator) as other_device:
        assert shown(other_device, made["id"])["view"]["sort"] == "title"
    assert client.get("/api/note-list").json()["view"]["sort"] == "updated"
    assert client.put(f"/api/smart-folders/{made['id']}/view", json={"mode": "tiles"}).status_code == 422


def test_notes7_ac4_only_its_owner_sees_or_changes_it(client, operator):
    made = make(client, "Meins", TASKS)
    note(client, "Geheim", "- [ ] offen")
    anna = make_account("anna")
    with new_client(anna) as theirs:
        for answer in (theirs.get(f"/api/smart-folders/{made['id']}"),
                       theirs.get(f"/api/smart-folders/{made['id']}/notes"),
                       theirs.get(f"/api/smart-folders/{made['id']}/stamp"),
                       theirs.put(f"/api/smart-folders/{made['id']}", json={"name": "Weg"}),
                       theirs.put(f"/api/smart-folders/{made['id']}/view", json={"mode": "list"}),
                       theirs.delete(f"/api/smart-folders/{made['id']}")):
            assert answer.status_code == 404
            assert answer.json()["detail"]["code"] == "smart_folder_not_found"
        assert all(item["id"] != made["id"] for item in theirs.get("/api/smart-folders").json()["items"])
        # Its own "open checklists" finds nothing of the operator.
        assert found(theirs, TASKS) == []
    assert client.get(f"/api/smart-folders/{made['id']}").status_code == 200


# --- EC-3: from today, in the device's zone ---------------------------------------------------------------------------


def test_notes7_ec3_a_period_counts_from_today_in_the_device_time_zone(client, operator, monkeypatch):
    early = note(client, "Kurz nach Mitternacht in Berlin")
    late = note(client, "Am Abend davor")
    week_old = note(client, "Vor acht Tagen")
    # 21 Nov 2026, 00:30 in Berlin is 20 Nov, 23:30 UTC.
    set_times(early, updated=datetime(2026, 11, 20, 23, 30, tzinfo=UTC))
    set_times(late, updated=datetime(2026, 11, 20, 22, 0, tzinfo=UTC))
    set_times(week_old, updated=datetime(2026, 11, 13, 12, 0, tzinfo=UTC))
    today = {"kind": "date", "field": "updated", "period": "today"}
    week = {"kind": "date", "field": "updated", "period": "week"}
    made = make(client, "Heute", today)
    monkeypatch.setattr(smart_folders, "now", lambda: datetime(2026, 11, 21, 9, 0, tzinfo=UTC))
    assert titles(shown(client, made["id"], tz="Europe/Berlin")) == ["Kurz nach Mitternacht in Berlin"]
    # In UTC both were yesterday; in New York (UTC-5) it is still 21 Nov there from 05:00 UTC: neither.
    assert titles(shown(client, made["id"], tz="UTC")) == []
    assert titles(shown(client, made["id"], tz="America/New_York")) == []
    # A zone nobody knows counts in UTC.
    assert titles(shown(client, made["id"], tz="Mars/Olympus")) == []
    assert found(client, week) == ["Am Abend davor", "Kurz nach Mitternacht in Berlin"]
    # The clock moves on: opened two days later, "today" is another day and nothing of the 20th/21st stays.
    monkeypatch.setattr(smart_folders, "now", lambda: datetime(2026, 11, 23, 9, 0, tzinfo=UTC))
    assert titles(shown(client, made["id"], tz="Europe/Berlin")) == []
    # Seven days back from the 23rd start on the 17th: the 13th is out, the 20th and 21st in.
    assert found(client, week) == ["Am Abend davor", "Kurz nach Mitternacht in Berlin"]
    monkeypatch.setattr(smart_folders, "now", lambda: datetime(2026, 11, 27, 9, 0, tzinfo=UTC))
    assert found(client, week) == ["Kurz nach Mitternacht in Berlin"]


def test_notes7_ec3_a_period_across_the_change_of_clocks_keeps_local_midnights():
    tz = search.zone("Europe/Berlin")
    # Summer time ended on 25 Oct 2026: seven days back from 28 Oct start at local midnight of 22 Oct (UTC+2).
    since, until = search.period_range({"period": "week"}, tz, datetime(2026, 10, 28, 12, 0, tzinfo=UTC))
    assert since == datetime(2026, 10, 21, 22, 0, tzinfo=UTC) and until is None
    since, until = search.period_range({"period": "custom", "from": "2026-10-25", "to": "2026-10-25"}, tz,
                                       datetime(2026, 11, 1, tzinfo=UTC))
    assert since == datetime(2026, 10, 24, 22, 0, tzinfo=UTC)
    assert until == datetime(2026, 10, 25, 23, 0, tzinfo=UTC)
    since, _ = search.period_range({"period": "year"}, tz, datetime(2028, 2, 29, 12, 0, tzinfo=UTC))
    assert since == datetime(2027, 2, 28, 23, 0, tzinfo=UTC)


# --- EC-5: a locked note only by its title ----------------------------------------------------------------------------


def test_notes7_ec5_a_locked_note_fits_a_text_condition_only_by_its_title(client, operator):
    locked = note(client, "Tresor PIN", "Geheimzahl 4711 #privat\n\n- [ ] Tür")
    note(client, "Offen", "Notiz 4711 #privat")
    assert found(client, {"kind": "text", "value": "4711"}) == ["Offen", "Tresor PIN"]
    # Locked the way the vault (NOTES-16) marks a note; its text stays here only to show that nobody reads it.
    set_fields(locked, locked=True)
    search.reindex(locked)
    assert found(client, {"kind": "text", "value": "4711"}) == ["Offen"]
    assert found(client, {"kind": "text", "value": "tresor"}) == ["Tresor PIN"]
    # Conditions on what is inside never hold for it: not its tags, not its checklist.
    assert found(client, {"kind": "tag", "op": "has", "key": "privat", "label": "privat"}) == ["Offen"]
    assert "Tresor PIN" not in found(client, {"kind": "tag", "op": "not", "key": "privat", "label": "privat"})
    assert found(client, TASKS) == []
    item = preview(client, {"kind": "text", "value": "tresor"})["items"][0]
    assert item["locked"] is True and item["preview"] == ""


# --- AC-5: from the search and from a tag's page (NOTES-9 AC-6, NOTES-5 AC-6) -----------------------------------------


def test_notes7_ac5_notes9_ac6_saved_from_the_search_it_finds_what_the_search_finds(client, operator):
    work = folder(client, "Arbeit")
    sub = folder(client, "Projekte", work)
    note(client, "Rechnung Bad", "Fliesen #bad", sub)
    note(client, "Rechnung Küche", "Fliesen #küche", work)
    note(client, "Rechnung privat", "Fliesen #bad")
    old = note(client, "Rechnung alt", "Fliesen #bad", work)
    set_times(old, updated=datetime.now(UTC) - timedelta(days=40))
    # What the search page sends for `?q=rechn&folder=<Arbeit>&tag=bad&period=month`.
    since = (datetime.now(UTC) - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
    searched = client.get("/api/search", params={"q": "rechn", "folder_id": work, "tag": "bad",
                                                 "since": since.isoformat()}).json()
    # What "Als intelligenten Ordner sichern" makes of it (`smart/conditions.ts`, fromSearch).
    made = make(client, "Rechnungen Bad",
                {"kind": "text", "value": "rechn"},
                {"kind": "folder", "op": "tree", "id": work, "name": "Arbeit"},
                {"kind": "tag", "op": "has", "key": "bad", "label": "bad"},
                {"kind": "date", "field": "updated", "period": "month"})
    assert [condition["kind"] for condition in made["conditions"]] == ["text", "folder", "tag", "date"]
    listing = shown(client, made["id"], tz="UTC")
    assert sorted(item["id"] for item in listing["items"]) == sorted(item["id"] for item in searched["items"])
    assert titles(listing) == ["Rechnung Bad"]
    # Words, phrases and tags in the field mean the same as in the search.
    for typed in ('"rechnung bad"', "fliesen #bad", "rech ba"):
        searched = sorted(item["id"] for item in client.get("/api/search", params={"q": typed}).json()["items"])
        assert sorted(item["id"] for item in preview(client, {"kind": "text", "value": typed})["items"]) == searched


def test_notes7_ac5_notes5_ac6_saved_from_a_tag_page_it_holds_that_tag(client, operator):
    anna = make_account("anna")
    note(client, "Bad Fliesen", "#Bad neu")
    note(client, "Bad Armatur", "#bad")
    note(client, "Küche", "#küche")
    with new_client(anna) as theirs:
        shared = note(theirs, "Badplanung Anna", "#BAD")
        share(theirs, "note", shared, operator)
    page = client.get("/api/tags/bad").json()
    # What the tag's page hands over: {kind: 'tag', op: 'has', key, label} and "#label" as the name.
    made = make(client, f"#{page['label']}", {"kind": "tag", "op": "has", "key": page["key"], "label": page["label"]})
    assert made["name"] == "#bad" or made["name"] == f"#{page['label']}"
    assert made["conditions"] == [{"kind": "tag", "op": "has", "key": "bad", "label": page["label"]}]
    listing = shown(client, made["id"])
    assert sorted(item["id"] for item in listing["items"]) == sorted(item["id"] for item in page["notes"])
    assert len(listing["items"]) == 3
    # Saved twice: nexnotes says the name is taken (EC-6).
    again = client.post("/api/smart-folders", json={"name": f"#{page['label']}", "conditions": made["conditions"]})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "smart_folder_exists"


# --- AC-6: changing, renaming, deleting leaves the notes alone ---------------------------------------------------------


def _notes_now(owner: Account) -> list[tuple]:
    with SessionLocal() as db:
        return [tuple(row) for row in db.execute(
            select(Note.id, Note.title, Note.text, Note.folder_id, Note.updated_at, Note.deleted_at, Note.pinned_at)
            .where(Note.owner_id == owner.id).order_by(Note.id))]


def test_notes7_ac6_changing_renaming_and_deleting_leave_the_notes_as_they_are(client, operator):
    note(client, "Einkauf", "- [ ] Milch #liste")
    note(client, "Packliste", "#liste")
    made = make(client, "Listen", {"kind": "tag", "op": "has", "key": "liste", "label": "liste"})
    assert client.put(f"/api/smart-folders/{made['id']}/view", json={"sort": "title"}).status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NoteListView)
                         .where(NoteListView.key == f"s:{made['id']}")) == 1
    before = _notes_now(operator)
    changed = client.put(f"/api/smart-folders/{made['id']}", json={"name": "Offene Listen", "match": "all",
                                                                   "conditions": [made["conditions"][0], TASKS]})
    assert changed.status_code == 200
    assert changed.json()["name"] == "Offene Listen" and len(changed.json()["conditions"]) == 2
    assert titles(shown(client, made["id"])) == ["Einkauf"]
    assert client.put(f"/api/smart-folders/{made['id']}", json={"match": "any"}).json()["match"] == "any"
    assert _notes_now(operator) == before
    # Deleted for good, without the trash: gone with its view; every note stays.
    assert client.delete(f"/api/smart-folders/{made['id']}").status_code == 204
    assert client.get(f"/api/smart-folders/{made['id']}").status_code == 404
    assert client.delete(f"/api/smart-folders/{made['id']}").status_code == 404
    assert _notes_now(operator) == before
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(NoteListView)
                         .where(NoteListView.key == f"s:{made['id']}")) == 0
    assert all(item["kind"] != "smart" for item in client.get("/api/trash").json().get("items", []))


def test_notes7_ac6_names_are_checked(client, operator):
    made = make(client, "Gut", TASKS)
    for name in ("", "   ", "x" * (smart_folders.NAME_MAX + 1), "Zeile\nzwei"):
        answer = client.post("/api/smart-folders", json={"name": name, "conditions": [TASKS]})
        assert answer.status_code == 422, name
        assert answer.json()["detail"]["code"] == "smart_folder_name_invalid"
        assert client.put(f"/api/smart-folders/{made['id']}", json={"name": name}).status_code == 422
    assert make(client, " Nur Leerzeichen außen ", TASKS)["name"] == "Nur Leerzeichen außen"


# --- AC-7: the ones every new account gets ----------------------------------------------------------------------------

PRESETS = ["open_tasks", "recent", "shared_with_me", "attachments"]


def test_notes7_ac7_a_new_account_gets_open_checklists_and_recently_edited(client, operator):
    lena = make_account("lena")
    rows = smart_rows(lena)
    assert [(row.preset, row.name, row.match, row.conditions) for row in rows] == [
        ("open_tasks", "", "all", [{"kind": "tasks", "op": "open"}]),
        ("recent", "", "all", [{"kind": "date", "field": "updated", "period": "week"}]),
        ("shared_with_me", "", "all", [{"kind": "shared", "op": "with_me"}]),
        ("attachments", "", "all", [{"kind": "attachment", "type": "any"}]),
    ]
    with new_client(lena) as theirs:
        open_tasks, recent, *_ = theirs.get("/api/smart-folders").json()["items"]
        note(theirs, "Einkauf", "- [ ] Milch")
        old = note(theirs, "Alt")
        set_times(old, updated=datetime.now(UTC) - timedelta(days=9))
        assert titles(shown(theirs, open_tasks["id"])) == ["Einkauf"]
        assert titles(shown(theirs, recent["id"])) == ["Einkauf"]
        # Changed and deleted like one's own.
        renamed = theirs.put(f"/api/smart-folders/{recent['id']}", json={
            "name": "Letzte 30 Tage", "conditions": [{"kind": "date", "field": "updated", "period": "month"}]})
        assert renamed.status_code == 200 and renamed.json()["name"] == "Letzte 30 Tage"
        assert titles(shown(theirs, recent["id"])) == ["Alt", "Einkauf"]
        assert theirs.delete(f"/api/smart-folders/{open_tasks['id']}").status_code == 204
        left = theirs.get("/api/smart-folders").json()["items"]
        assert [item["preset"] for item in left] == ["recent", "shared_with_me", "attachments"]
        assert left[0]["id"] == recent["id"]


def test_notes7_ac7_an_invited_account_gets_them_too(client, operator):
    link = client.post("/api/invites", json={}).json()["link"]
    with new_client() as stranger:
        made = stranger.post(f"/api/invite/{link.rsplit('/', 1)[1]}",
                             json={"display_name": "Paula", "password": "correct horse battery"})
        assert made.status_code in (200, 201), made.text
    with SessionLocal() as db:
        paula = db.scalar(select(Account).where(Account.display_name == "Paula"))
        assert paula is not None
        db.expunge(paula)
    assert [row.preset for row in smart_rows(paula)] == PRESETS


def test_notes7_ac7_accounts_from_before_get_them_once_and_not_again(client, operator):
    with SessionLocal() as db:
        # A database from before smart folders: none of them, and not yet given.
        db.execute(SmartFolder.__table__.delete())
        db.execute(Setting.__table__.delete().where(Setting.key == smart_folders.SEEDED))
        db.commit()
        assert smart_folders.seed_existing(db) == 1
        assert smart_folders.seed_existing(db) == 0
    assert [row.preset for row in smart_rows(operator)] == PRESETS
    remove_presets(client)
    with SessionLocal() as db:
        assert smart_folders.seed_existing(db) == 0
    assert smart_rows(operator) == []


def test_notes7_ac7_accounts_from_before_get_shared_with_me_and_attachments_once(client, operator):
    """The sidebar's fixed entries became presets: accounts that had the first two get the other two once, at the
    end of their own list; whoever deletes them does not get them again; a name of one's own is not taken twice."""
    anna = make_account("anna-seed")
    with SessionLocal() as db:
        # A database from before: the first two presets, but neither of the new ones. (Straight into the database:
        # a client starting the app would give them at once.)
        db.execute(SmartFolder.__table__.delete().where(SmartFolder.preset.in_(smart_folders.PLACES)))
        db.execute(Setting.__table__.delete().where(Setting.key == smart_folders.SEEDED_PLACES))
        db.commit()
        smart_folders.create(db, db.get(Account, anna.id), "Shared with me", "all", [TASKS])
    own = make(client, "Mein Ordner", TASKS)
    with SessionLocal() as db:
        assert smart_folders.seed_existing(db) == 2
        assert smart_folders.seed_existing(db) == 0
    rows = smart_rows(operator)
    assert [row.preset for row in rows] == ["open_tasks", "recent", "", "shared_with_me", "attachments"]
    assert [row.position for row in rows] == [0, 1, 2, 3, 4] and rows[2].id == own["id"]
    # Anna named one "Shared with me" herself: only "Anhänge" comes.
    assert [row.preset for row in smart_rows(anna)] == ["open_tasks", "recent", "", "attachments"]
    # Deleted, not given again (not even after the next start).
    for item in client.get("/api/smart-folders").json()["items"]:
        if item["preset"] in smart_folders.PLACES:
            assert client.delete(f"/api/smart-folders/{item['id']}").status_code == 204
    with SessionLocal() as db:
        assert smart_folders.seed_existing(db) == 0
    assert [row.preset for row in smart_rows(operator)] == ["open_tasks", "recent", ""]


def test_notes7_ac7_shared_with_me_shows_what_the_shared_page_shows(client, operator):
    """"Mit mir geteilt" as a smart folder: the notes of "Mit mir geteilt" (directly and through folders), with the
    same rights: never a note of somebody else not shared, never one in the trash, never a locked one, never one of a
    share that ended."""
    anna = make_account("anna-share")
    mine = note(client, "Meine Notiz")
    share(client, "note", mine, anna)
    folders = {item["preset"]: item for item in client.get("/api/smart-folders").json()["items"]}
    with new_client(anna) as theirs:
        direct = note(theirs, "Direkt geteilt")
        trip = folder(theirs, "Reise")
        inner = folder(theirs, "Packliste", trip)
        note(theirs, "Im Ordner", "", inner)
        note(theirs, "Nicht geteilt")
        gone = note(theirs, "Im Papierkorb")
        locked = note(theirs, "Gesperrt")
        ended = note(theirs, "Nicht mehr geteilt")
        for item_id in (direct, gone, locked, ended):
            share(theirs, "note", item_id, operator)
        share(theirs, "folder", trip, operator)
        unshare(theirs, "note", ended, operator)
        assert theirs.delete(f"/api/notes/{gone}").status_code == 204
    set_fields(locked, locked=True)
    listing = shown(client, folders["shared_with_me"]["id"])
    assert titles(listing) == ["Direkt geteilt", "Im Ordner"]
    assert listing["counts"] == {"own": 0, "shared": 2}
    page = client.get("/api/shares/with-me").json()
    assert {item["title"] for group in page["groups"] for item in group["items"]} == {"Direkt geteilt", "Reise"}
    # Anna's side: what she shares is no "shared with me" for her; the operator's note is.
    with new_client(anna) as theirs:
        assert found(theirs, {"kind": "shared", "op": "with_me"}) == ["Meine Notiz"]


def test_notes7_ac7_attachments_opens_as_the_gallery_of_its_notes(client, operator):
    """"Anhänge" as a smart folder: the notes with any attachment, shown as the gallery until the member picks another
    view; the gallery holds the attachments of those notes only, of shared ones what their owner put there, never of
    a locked note, a note in the trash or a note of somebody else not shared."""
    anna = make_account("anna-gallery")
    folders = {item["preset"]: item for item in client.get("/api/smart-folders").json()["items"]}
    attachments_id = folders["attachments"]["id"]
    photo = note(client, "Urlaub")
    attach(photo, "image")
    paper = note(client, "Vertrag")
    attach(paper, "pdf")
    note(client, "Ohne Anhang")
    locked = note(client, "Gesperrt")
    attach(locked, "image")
    gone = note(client, "Weg")
    attach(gone, "file")
    assert client.delete(f"/api/notes/{gone}").status_code == 204
    set_fields(locked, locked=True)
    with new_client(anna) as theirs:
        shared = note(theirs, "Annas Rezept")
        attach(shared, "recording")
        hidden = note(theirs, "Annas Geheimnis")
        attach(hidden, "image")
        share(theirs, "note", shared, operator)
    listing = shown(client, attachments_id)
    assert titles(listing) == ["Annas Rezept", "Urlaub", "Vertrag"]
    assert listing["view"]["mode"] == "gallery"
    answer = client.get(f"/api/smart-folders/{attachments_id}/attachments")
    assert answer.status_code == 200, answer.text
    gallery = answer.json()
    assert sorted(item["note"]["title"] for item in gallery["items"]) == ["Annas Rezept", "Urlaub", "Vertrag"]
    assert gallery["all"] == 3 and gallery["counts"]["image"] == 1 and gallery["counts"]["recording"] == 1
    only = client.get(f"/api/smart-folders/{attachments_id}/attachments", params={"kind": "pdf"}).json()
    assert [item["note"]["title"] for item in only["items"]] == ["Vertrag"] and only["total"] == 1
    # The account's own gallery stays its own: nothing of Anna's.
    own = client.get("/api/attachments").json()
    assert not {item["note"]["title"] for item in own["items"]} & {"Annas Rezept", "Annas Geheimnis"}
    # A view saved without a mode keeps the gallery; the notes chosen instead are kept, per folder.
    kept = client.put(f"/api/smart-folders/{attachments_id}/view", json={"sort": "title"}).json()
    assert kept["mode"] == "gallery" and kept["sort"] == "title"
    assert client.put(f"/api/smart-folders/{attachments_id}/view", json={"mode": "list"}).json()["mode"] == "list"
    assert shown(client, attachments_id)["view"]["mode"] == "list"
    # The account's look does not touch it: cards for every list, the gallery stays a choice of this folder.
    assert client.put("/api/me/list-look", json={"style": "cards"}).status_code == 200
    client.put(f"/api/smart-folders/{attachments_id}/view", json={"mode": "gallery"})
    assert shown(client, attachments_id)["view"]["mode"] == "gallery"
    assert client.get("/api/auth/me").json()["list_style"] == "cards"
    # Somebody else's smart folder is nobody's gallery.
    with new_client(anna) as theirs:
        assert theirs.get(f"/api/smart-folders/{attachments_id}/attachments").status_code == 404
    # Any other smart folder may be looked at as a gallery, but starts as a list.
    mine = make(client, "Bilder", {"kind": "attachment", "type": "image"})
    assert shown(client, mine["id"])["view"]["mode"] == "list"
    pictures = client.get(f"/api/smart-folders/{mine['id']}/attachments").json()
    assert [item["note"]["title"] for item in pictures["items"]] == ["Urlaub"]
    # A locked note found by its title shows in the list, but nothing of it in the gallery.
    titled = make(client, "Mit Titel", {"kind": "text", "value": "Gesperrt"}, {"kind": "attachment", "type": "pdf"},
                  match="any")
    assert titles(shown(client, titled["id"])) == ["Gesperrt", "Vertrag"]
    pictures = client.get(f"/api/smart-folders/{titled['id']}/attachments").json()
    assert [item["note"]["title"] for item in pictures["items"]] == ["Vertrag"] and pictures["all"] == 1


def test_notes7_ac7_a_shared_note_shows_in_the_gallery_only_what_its_owner_put_there(client, operator):
    """NOTES-13: an attachment of the owner that the member it is shared with wrote into the note (the owner never
    did) stays out of the member's smart-folder gallery, as it stays out of every other view of it."""
    anna = make_account("anna-vouch")
    folders = {item["preset"]: item for item in client.get("/api/smart-folders").json()["items"]}
    with new_client(anna) as theirs:
        home = note(theirs, "Annas Fotos")
        attach(home, "image")
        other = note(theirs, "Annas Liste")
        attach(other, "pdf")
        share(theirs, "note", other, operator)
    with SessionLocal() as db:
        picture = db.scalar(select(Attachment).where(Attachment.note_id == home))
        assert picture is not None
        db.add(AttachmentRef(note_id=other, attachment_id=picture.id, position=1))
        db.add(AttachmentMention(note_id=other, attachment_id=picture.id, vouched=False))
        db.commit()
    gallery = client.get(f"/api/smart-folders/{folders['attachments']['id']}/attachments").json()
    assert [item["kind"] for item in gallery["items"]] == ["pdf"]
    with SessionLocal() as db:
        db.execute(AttachmentMention.__table__.update().where(AttachmentMention.note_id == other)
                   .values(vouched=True))
        db.commit()
    gallery = client.get(f"/api/smart-folders/{folders['attachments']['id']}/attachments").json()
    assert sorted(item["kind"] for item in gallery["items"]) == ["image", "pdf"]


def _gallery_kinds(client, folder_id: str) -> list[str]:
    answer = client.get(f"/api/smart-folders/{folder_id}/attachments")
    assert answer.status_code == 200, answer.text
    return sorted(f"{item['note']['title']}:{item['kind']}" for item in answer.json()["items"])


def test_notes7_ac1_an_attachment_counts_only_in_a_note_of_its_owner(client, operator):
    """NOTES-10/13: an attachment belongs to the owner of the note it was put in. A note of Anna's that names an
    attachment of a third account holds no attachment of its own: neither the condition "Anhang" nor the gallery
    counts it, for the account it is shared with or for Anna."""
    anna = make_account("anna-third")
    bert = make_account("bert-third")
    with new_client(bert) as theirs:
        berts = note(theirs, "Berts Bild")
        attach(berts, "image")
    with new_client(anna) as theirs:
        listing = note(theirs, "Annas Liste")
        attach(listing, "pdf")
        share(theirs, "note", listing, operator)
    with SessionLocal() as db:
        picture = db.scalar(select(Attachment).where(Attachment.note_id == berts))
        assert picture is not None
        db.add(AttachmentRef(note_id=listing, attachment_id=picture.id, position=0))
        db.commit()
    pictures = make(client, "Bilder", {"kind": "attachment", "type": "image"})
    every = make(client, "Alles", {"kind": "attachment", "type": "any"})
    assert found(client, {"kind": "attachment", "type": "image"}) == []
    assert titles(shown(client, pictures["id"])) == []
    assert _gallery_kinds(client, pictures["id"]) == []
    # The note fits by its own PDF; Bert's picture stays out of its gallery.
    assert titles(shown(client, every["id"])) == ["Annas Liste"]
    assert _gallery_kinds(client, every["id"]) == ["Annas Liste:pdf"]
    with new_client(anna) as theirs:
        assert found(theirs, {"kind": "attachment", "type": "image"}) == []
        hers = make(theirs, "Alles", {"kind": "attachment", "type": "any"})
        assert _gallery_kinds(theirs, hers["id"]) == ["Annas Liste:pdf"]
    # Bert's own note still has it, in his list and his gallery.
    with new_client(bert) as theirs:
        assert found(theirs, {"kind": "attachment", "type": "image"}) == ["Berts Bild"]
        his = make(theirs, "Bilder", {"kind": "attachment", "type": "image"})
        assert _gallery_kinds(theirs, his["id"]) == ["Berts Bild:image"]


def test_notes7_ac1_has_attachments_and_the_gallery_give_the_same_notes(client, operator):
    """NOTES-13: in a note shared to write, an attachment of the owner's other note that a member wrote in (the owner
    never did) is no attachment of that note for the member: "Hat Anhänge" leaves the note out as the gallery leaves
    the attachment out. For the owner, whose attachment it is, both count it; once the owner puts it there, both
    count it for the member too."""
    anna = make_account("anna-agree")
    with new_client(anna) as theirs:
        home = note(theirs, "Annas Fotos")
        attach(home, "image")
        listing = note(theirs, "Annas Liste")
        attach(listing, "pdf")
        share(theirs, "note", listing, operator, "write")
    with SessionLocal() as db:
        picture = db.scalar(select(Attachment).where(Attachment.note_id == home))
        assert picture is not None
        db.add(AttachmentRef(note_id=listing, attachment_id=picture.id, position=1))
        db.add(AttachmentMention(note_id=listing, attachment_id=picture.id, vouched=False))
        db.commit()
    pictures = make(client, "Bilder", {"kind": "attachment", "type": "image"})
    papers = make(client, "Papiere", {"kind": "attachment", "type": "pdf"})
    assert titles(shown(client, pictures["id"])) == []
    assert _gallery_kinds(client, pictures["id"]) == []
    assert titles(shown(client, papers["id"])) == ["Annas Liste"]
    assert _gallery_kinds(client, papers["id"]) == ["Annas Liste:pdf"]
    with new_client(anna) as theirs:
        hers = make(theirs, "Bilder", {"kind": "attachment", "type": "image"})
        assert titles(shown(theirs, hers["id"])) == ["Annas Fotos", "Annas Liste"]
        # The gallery shows the attachments of the notes that fit, each once, at its own note.
        assert _gallery_kinds(theirs, hers["id"]) == ["Annas Fotos:image", "Annas Liste:pdf"]
    with SessionLocal() as db:
        db.execute(AttachmentMention.__table__.update().where(AttachmentMention.note_id == listing)
                   .values(vouched=True))
        db.commit()
    assert titles(shown(client, pictures["id"])) == ["Annas Liste"]
    assert _gallery_kinds(client, pictures["id"]) == ["Annas Liste:image", "Annas Liste:pdf"]


def test_notes7_ac1_shared_by_me_counts_only_accounts_that_are_there(client, operator):
    anna = make_account("anna-closed")
    bert = make_account("bert-open")
    to_anna = note(client, "Für Anna")
    to_bert = note(client, "Für Bert")
    note(client, "Für niemanden")
    share(client, "note", to_anna, anna)
    share(client, "note", to_bert, bert)
    assert found(client, {"kind": "shared", "op": "by_me"}) == ["Für Anna", "Für Bert"]
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        row.deleted_at = datetime.now(UTC)
        db.commit()
    assert found(client, {"kind": "shared", "op": "by_me"}) == ["Für Bert"]


def test_notes7_ac1_the_colour_condition_takes_its_colour_only(client, operator):
    orange = note(client, "Orange")
    blue = note(client, "Blau")
    note(client, "Ohne Farbe")
    set_fields(orange, color="orange")
    set_fields(blue, color="blue")
    assert found(client, {"kind": "color", "color": "orange"}) == ["Orange"]
    assert found(client, {"kind": "color", "color": "blue"}) == ["Blau"]


def test_notes7_ac7_a_preset_keeps_its_name_in_the_interface_language_until_renamed(client, operator):
    items = client.get("/api/smart-folders").json()["items"]
    preset = items[0]
    assert preset["name"] == "" and preset["preset"] == "open_tasks"
    changed = client.put(f"/api/smart-folders/{preset['id']}", json={"name": "", "match": "any"})
    assert changed.status_code == 200 and changed.json()["name"] == "" and changed.json()["preset"] == "open_tasks"


# --- AC-8: the order in the sidebar ------------------------------------------------------------------------------------


def test_notes7_ac8_the_order_is_the_one_dragged(client, operator):
    remove_presets(client)
    first, second, third = (make(client, name, TASKS) for name in ("Eins", "Zwei", "Drei"))
    assert [item["name"] for item in client.get("/api/smart-folders").json()["items"]] == ["Eins", "Zwei", "Drei"]
    answer = client.put("/api/smart-folders/order", json={"ids": [third["id"], first["id"]]})
    assert answer.status_code == 200
    assert [item["name"] for item in client.get("/api/smart-folders").json()["items"]] == ["Drei", "Eins", "Zwei"]
    twice = client.put("/api/smart-folders/order", json={"ids": [first["id"], first["id"]]})
    assert twice.status_code == 422 and twice.json()["detail"]["code"] == "smart_folder_order_invalid"
    assert client.put("/api/smart-folders/order", json={"ids": [str(uuid.uuid4())]}).status_code == 404
    assert second["id"]


# --- EC-1: a condition that points nowhere ------------------------------------------------------------------------------


def test_notes7_ec1_a_deleted_folder_or_tag_is_named_on_opening(client, operator):
    kitchen = folder(client, "Küche")
    tagged = note(client, "Suppe", "#rezept", kitchen)
    made = make(client, "Küchenrezepte",
                {"kind": "folder", "op": "tree", "id": kitchen, "name": "Küche"},
                {"kind": "tag", "op": "has", "key": "rezept", "label": "rezept"})
    assert shown(client, made["id"])["broken"] == []
    # The tag goes from every note, the folder into the trash.
    assert client.delete("/api/tags/rezept").status_code == 200
    assert client.delete(f"/api/folders/{kitchen}").status_code in (200, 204)
    listing = shown(client, made["id"])
    assert listing["items"] == []
    assert listing["broken"] == [{"index": 0, "kind": "folder", "name": "Küche"},
                                 {"index": 1, "kind": "tag", "name": "rezept"}]
    assert tagged
    # Mended through "Bearbeiten": nothing points nowhere any more.
    client.put(f"/api/smart-folders/{made['id']}", json={"conditions": [TASKS]})
    assert shown(client, made["id"])["broken"] == []


def test_notes7_ec1_a_folder_gone_for_good_or_of_another_account_points_nowhere(client, operator):
    anna = make_account("anna")
    with new_client(anna) as theirs:
        theirs_folder = folder(theirs, "Annas")
        note(theirs, "Annas Notiz", "", theirs_folder)
    made = make(client, "Fremd", {"kind": "folder", "op": "in", "id": theirs_folder, "name": "?"})
    listing = shown(client, made["id"])
    assert listing["items"] == [] and listing["broken"][0]["kind"] == "folder"
    gone = make(client, "Weg", {"kind": "folder", "op": "in", "id": str(uuid.uuid4()), "name": "Alt"})
    assert shown(client, gone["id"])["broken"] == [{"index": 0, "kind": "folder", "name": "Alt"}]


# --- EC-2: nothing fits -------------------------------------------------------------------------------------------------


def test_notes7_ec2_nothing_fits_gives_an_empty_list_with_its_conditions(client, operator):
    note(client, "Einkauf", "Milch")
    made = make(client, "Leer", {"kind": "text", "value": "zebrafisch"}, {"kind": "pinned"})
    listing = shown(client, made["id"])
    assert listing["items"] == [] and listing["counts"] == {"own": 0, "shared": 0}
    assert listing["folder"]["conditions"] == [{"kind": "text", "value": "zebrafisch"}, {"kind": "pinned"}]
    assert listing["broken"] == []


# --- EC-6: the same name twice ------------------------------------------------------------------------------------------


def test_notes7_ec6_the_same_name_twice_is_said(client, operator):
    made = make(client, "Rezepte", TASKS)
    for name in ("Rezepte", "rezepte", " REZEPTE "):
        answer = client.post("/api/smart-folders", json={"name": name, "conditions": [TASKS]})
        assert answer.status_code == 409, name
        assert answer.json()["detail"]["code"] == "smart_folder_exists"
        assert answer.json()["detail"]["name"] == "Rezepte"
    other = make(client, "Andere", TASKS)
    assert client.put(f"/api/smart-folders/{other['id']}", json={"name": "REZEPTE"}).status_code == 409
    # Renaming onto its own name (other case) is no clash.
    assert client.put(f"/api/smart-folders/{made['id']}", json={"name": "REZEPTE"}).status_code == 200
    # The two that came with the account hold their names in both languages.
    for name in ("Offene Checklisten", "open checklists", "Zuletzt bearbeitet", "Recently edited"):
        assert client.post("/api/smart-folders", json={"name": name, "conditions": [TASKS]}).status_code == 409
    # Another account may use the same name.
    with new_client(make_account("anna")) as theirs:
        assert theirs.post("/api/smart-folders", json={"name": "Rezepte", "conditions": [TASKS]}).status_code == 201


def test_notes7_ec6_a_name_like_the_inner_key_of_a_preset_is_free(client, operator):
    """The presets' keys lie where no name reaches: a folder of one's own may be called "preset:recent"."""
    for name in ("preset:recent", "preset:open_tasks", "PRESET:attachments"):
        made = make(client, name, TASKS)
        assert made["name"] == name
    presets = [item for item in client.get("/api/smart-folders").json()["items"] if item["preset"]]
    assert len(presets) == 4 and all(item["name"] == "" for item in presets)
    # Renamed back to its language's name, a preset takes its key again without a clash.
    recent = next(item for item in presets if item["preset"] == "recent")
    assert client.put(f"/api/smart-folders/{recent['id']}", json={"name": "Neu"}).status_code == 200
    assert client.put(f"/api/smart-folders/{recent['id']}", json={"name": ""}).status_code == 200


def test_notes7_ec6_presets_from_before_get_their_key_moved_once(client, operator):
    with SessionLocal() as db:
        db.execute(SmartFolder.__table__.update().where(SmartFolder.owner_id == operator.id,
                                                        SmartFolder.preset != "")
                   .values(name_key="preset:" + SmartFolder.preset))
        db.execute(SmartFolder.__table__.delete().where(SmartFolder.owner_id == operator.id,
                                                        SmartFolder.preset == ""))
        setting = db.get(Setting, smart_folders.SEEDED_KEYS)
        if setting is not None:
            db.delete(setting)
        db.commit()
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    keys = {row.preset: row.name_key for row in smart_rows(operator)}
    assert keys == {preset: f"\x1fpreset:{preset}" for preset in PRESETS}
    assert make(client, "preset:recent", TASKS)["name"] == "preset:recent"
    # Once: a key set later is left alone.
    with SessionLocal() as db:
        db.execute(SmartFolder.__table__.update().where(SmartFolder.owner_id == operator.id,
                                                        SmartFolder.preset == "open_tasks")
                   .values(name_key="preset:open_tasks"))
        db.commit()
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    assert {row.preset: row.name_key for row in smart_rows(operator)}["open_tasks"] == "preset:open_tasks"


# --- EC-4: 10,000 notes ----------------------------------------------------------------------------------------------


@pytest.mark.timing
def test_notes7_ec4_ten_thousand_notes_several_conditions_under_a_second(client, operator):
    with SessionLocal() as db:
        inbox = inbox_for(db, operator.id).id
        work = Folder(owner_id=operator.id, name="Arbeit", kind=FOLDER_NORMAL)
        db.add(work)
        db.commit()
        work_id = work.id
    now = datetime.now(UTC)
    rows = []
    for number in range(10_000):
        hit = number % 5 == 0
        rows.append({
            "id": str(uuid.uuid4()), "owner_id": operator.id, "folder_id": work_id if number % 2 == 0 else inbox,
            "title": f"Notiz {number}" + (" Rechnung" if hit else ""),
            "text": (f"Eintrag {number} über die Stromrechnung. " if hit else f"Eintrag {number} Garten. ") * 6,
            "ydoc": b"", "created_at": now - timedelta(hours=number), "updated_at": now - timedelta(hours=number),
            "tasks_done": 0, "tasks_total": 2 if number % 3 == 0 else 0, "color": "orange" if number % 7 == 0 else "",
        })
    with SessionLocal() as db:
        db.execute(insert(Note), rows)
        db.commit()
    assert search.fill() == 10_000
    made = make(client, "Viel",
                {"kind": "text", "value": "rechn"},
                {"kind": "folder", "op": "tree", "id": work_id, "name": "Arbeit"},
                TASKS,
                {"kind": "date", "field": "updated", "period": "year"})
    shown(client, made["id"])
    started = time.perf_counter()
    listing = shown(client, made["id"])
    took = time.perf_counter() - started
    expected = sum(1 for number in range(10_000)
                   if number % 5 == 0 and number % 2 == 0 and number % 3 == 0 and number < 365 * 24)
    assert len(listing["items"]) == expected
    assert took < 1.0, took
    wide = make(client, "Breit", TASKS, {"kind": "color", "color": "orange"}, {"kind": "text", "value": "garten"},
                match="any")
    started = time.perf_counter()
    listing = shown(client, wide["id"])
    took_wide = time.perf_counter() - started
    assert len(listing["items"]) > 5000
    assert took_wide < 1.0, took_wide
    started = time.perf_counter()
    client.get(f"/api/smart-folders/{wide['id']}/stamp")
    took_stamp = time.perf_counter() - started
    assert took_stamp < 0.5, took_stamp
    print(f"EC-4: four conditions {took:.3f} s, wide (any, {len(listing['items'])} notes) {took_wide:.3f} s, "
          f"stamp {took_stamp:.3f} s")


# --- Symbol and colour, as a folder's (fifth review) ------------------------------------------------------------------


def test_notes7_look_a_new_smart_folder_has_the_filter_and_no_colour(client, operator):
    made = make(client, "Ohne Wahl", TASKS)
    assert (made["icon"], made["color"]) == ("filter", "")
    chosen = client.post("/api/smart-folders", json={"name": "Mit Wahl", "match": "all", "conditions": [TASKS],
                                                     "icon": "star", "color": "#A1B2C3"})
    assert chosen.status_code == 201, chosen.text
    assert (chosen.json()["icon"], chosen.json()["color"]) == ("star", "#a1b2c3")
    listed = {item["name"]: item for item in client.get("/api/smart-folders").json()["items"]}
    assert (listed["Mit Wahl"]["icon"], listed["Mit Wahl"]["color"]) == ("star", "#a1b2c3")


def test_notes7_look_symbol_and_colour_change_alone(client, operator):
    made = make(client, "Farbig", TASKS)
    one = f"/api/smart-folders/{made['id']}"
    answer = client.put(one, json={"icon": "heart"})
    assert answer.status_code == 200 and (answer.json()["icon"], answer.json()["color"]) == ("heart", "")
    answer = client.put(one, json={"color": "teal"})
    assert (answer.json()["icon"], answer.json()["color"], answer.json()["name"]) == ("heart", "teal", "Farbig")
    # Empty is allowed, as with folders: no colour, or no symbol (the colour as a small square).
    answer = client.put(one, json={"icon": "", "color": ""})
    assert (answer.json()["icon"], answer.json()["color"]) == ("", "")
    assert client.get(one).json()["conditions"] == [TASKS]


@pytest.mark.parametrize("look", [{"icon": "unicorn"}, {"color": "red-ish"}, {"color": "#fff"}, {"icon": "x" * 40}])
def test_notes7_look_an_unknown_symbol_or_colour_is_refused(client, operator, look):
    made = make(client, "Streng", TASKS)
    answer = client.put(f"/api/smart-folders/{made['id']}", json=look)
    assert answer.status_code == 422, answer.text
    created = client.post("/api/smart-folders", json={"name": "Neu streng", "match": "all", "conditions": [TASKS],
                                                      **look})
    assert created.status_code == 422
    assert client.get(f"/api/smart-folders/{made['id']}").json()["icon"] == "filter"
    assert "Neu streng" not in {item["name"] for item in client.get("/api/smart-folders").json()["items"]}


def test_notes7_look_presets_come_with_the_symbol_of_their_entry(client, operator):
    lena = make_account("lena-look")
    assert [(row.preset, row.icon, row.color) for row in smart_rows(lena)] == [
        ("open_tasks", "filter", ""), ("recent", "filter", ""), ("shared_with_me", "people", ""),
        ("attachments", "paperclip", ""),
    ]


def test_notes7_look_presets_from_before_get_their_symbol_once(client, operator):
    rows = {row.preset: row for row in smart_rows(operator)}
    with SessionLocal() as db:
        # A database from before symbols: the new column gave every row the filter, and the mark is not there.
        db.execute(SmartFolder.__table__.update().values(icon="filter"))
        db.execute(Setting.__table__.delete().where(Setting.key == smart_folders.SEEDED_ICONS))
        db.commit()
        smart_folders.seed_existing(db)
    after = {row.preset: row.icon for row in smart_rows(operator)}
    assert after == {"open_tasks": "filter", "recent": "filter", "shared_with_me": "people", "attachments": "paperclip"}
    # Once: a symbol the member picks later stays, also after the next start.
    assert client.put(f"/api/smart-folders/{rows['attachments'].id}", json={"icon": "filter"}).status_code == 200
    with SessionLocal() as db:
        smart_folders.seed_existing(db)
    assert {row.preset: row.icon for row in smart_rows(operator)}["attachments"] == "filter"
