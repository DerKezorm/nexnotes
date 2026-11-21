"""NOTES-4 Folders and inbox: the tree without a depth limit, moving, renaming, symbol and colour, the member's order,
the trash with its way back, the fixed inbox, and two devices at once.

Notes are made straight through the model here: writing them is the note editor's business (NOTES-3).
"""

from __future__ import annotations

import json
import re
import threading
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select

from app.db import SessionLocal, engine
from app.models import Account, Folder, Note, utcnow
from app.services import folders as folder_service
from app.services.inbox import inbox_for

from .conftest import make_account, new_client

ROOT = Path(__file__).resolve().parents[2]


# --- Helpers ----------------------------------------------------------------------------------------------------------


def make(client: TestClient, name: str, parent: str | None = None, **style: str) -> str:
    answer = client.post("/api/folders", json={"name": name, "parent_id": parent, **style})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def tree(client: TestClient) -> dict[str, Any]:
    answer = client.get("/api/folders")
    assert answer.status_code == 200, answer.text
    return answer.json()


def by_id(client: TestClient) -> dict[str, dict[str, Any]]:
    return {folder["id"]: folder for folder in tree(client)["folders"]}


def note(account: Account, folder_id: str, title: str = "A note", origin: str = "") -> str:
    with SessionLocal() as db:
        row = Note(owner_id=account.id, folder_id=folder_id, title=title, text=f"Text of {title}", origin=origin)
        db.add(row)
        db.commit()
        return row.id


def inbox_id(account: Account) -> str:
    with SessionLocal() as db:
        found = inbox_for(db, account.id)
        db.commit()
        return found.id


def note_row(note_id: str) -> Note:
    with SessionLocal() as db:
        row = db.get(Note, note_id)
        assert row is not None
        db.expunge(row)
        return row


def code(answer: Any) -> str:
    return answer.json()["detail"]["code"]


def assert_no_note_lost(account: Account) -> None:
    """Every living note and folder hangs on a chain of living folders up to the top; everything else is in the trash.
    A living note under a folder in the trash would be found nowhere."""
    with SessionLocal() as db:
        folders = {row.id: row for row in db.scalars(select(Folder).where(Folder.owner_id == account.id))}
        notes = db.scalars(select(Note).where(Note.owner_id == account.id)).all()

        def chain_alive(folder_id: str | None) -> bool:
            seen: set[str] = set()
            while folder_id is not None:
                if folder_id in seen:
                    return False
                seen.add(folder_id)
                folder = folders.get(folder_id)
                if folder is None or folder.deleted_at is not None:
                    return False
                folder_id = folder.parent_id
            return True

        for row in notes:
            if row.deleted_at is None:
                assert chain_alive(row.folder_id), f"note {row.title!r} is alive in a folder nobody can see"
        for folder in folders.values():
            if folder.deleted_at is None:
                assert chain_alive(folder.id), f"folder {folder.name!r} is alive under a folder in the trash"


# --- AC-1 Making, at any depth ----------------------------------------------------------------------------------------


def test_notes4_ac1_folders_nest_at_the_top_and_fifteen_levels_deep(client: TestClient, operator: Account) -> None:
    top = make(client, "Arbeit")
    parent = top
    chain = [top]
    for level in range(2, 16):
        parent = make(client, f"Ebene {level}", parent)
        chain.append(parent)
    folders = by_id(client)
    assert len(chain) == 15
    for upper, lower in zip(chain, chain[1:], strict=False):
        assert folders[lower]["parent_id"] == upper
    assert folders[top]["parent_id"] is None
    # And deeper still: there is no limit.
    deepest = make(client, "Ebene 16", parent)
    assert by_id(client)[deepest]["parent_id"] == parent


def test_notes4_ac1_folders_belong_to_their_account_only(client: TestClient, operator: Account) -> None:
    mine = make(client, "Privat")
    other = make_account("berta")
    with new_client(other) as berta:
        assert tree(berta)["folders"] == []
        assert berta.post("/api/folders", json={"name": "Drin", "parent_id": mine}).status_code == 404
        assert berta.patch(f"/api/folders/{mine}", json={"name": "Meins"}).status_code == 404
        assert berta.delete(f"/api/folders/{mine}").status_code == 404
        assert berta.get(f"/api/folders/{mine}/impact").status_code == 404
        own = make(berta, "Eigenes")
        assert berta.post("/api/folders/move", json={"target_id": own, "folder_ids": [mine]}).status_code == 404
    assert [folder["name"] for folder in tree(client)["folders"]] == ["Privat"]


# --- AC-2, AC-3, AC-14 Moving -----------------------------------------------------------------------------------------


def test_notes4_ac2_a_moved_folder_takes_all_subfolders_and_notes_along(client: TestClient, operator: Account) -> None:
    work = make(client, "Arbeit")
    projects = make(client, "Projekte", work)
    year = make(client, "2026", projects)
    archive = make(client, "Archiv")
    notes = [note(operator, projects, "Plan"), note(operator, year, "Q4")]
    answer = client.post("/api/folders/move", json={"target_id": archive, "folder_ids": [projects]})
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"folders": 1, "notes": 0}
    folders = by_id(client)
    assert folders[projects]["parent_id"] == archive
    assert folders[year]["parent_id"] == projects
    assert note_row(notes[0]).folder_id == projects and note_row(notes[1]).folder_id == year
    assert folders[archive]["count"] == 0 and folders[projects]["count"] == 1 and folders[year]["count"] == 1
    assert client.get(f"/api/folders/{archive}/impact").json() == {"notes": 2, "folders": 2, "trash_days": 90}


def test_notes4_ac3_notes_move_into_a_folder_one_or_many(client: TestClient, operator: Account) -> None:
    home = make(client, "Haushalt")
    shop = make(client, "Einkauf", home)
    inbox = inbox_id(operator)
    first, second, third = (note(operator, inbox, title) for title in ("Milch", "Brot", "Käse"))
    assert client.post("/api/folders/move", json={"target_id": shop, "note_ids": [first]}).json()["notes"] == 1
    assert client.post("/api/folders/move", json={"target_id": shop, "note_ids": [second, third]}).json()["notes"] == 2
    assert {note_row(n).folder_id for n in (first, second, third)} == {shop}
    assert by_id(client)[shop]["count"] == 3
    assert tree(client)["inbox"]["count"] == 0
    # A note that is not there (or in the trash) moves nothing at all.
    assert client.post("/api/folders/move", json={"target_id": home, "note_ids": [first, "00000000-dead"]}).status_code == 404
    assert note_row(first).folder_id == shop


def test_notes4_ac3_a_folder_goes_to_the_top_and_into_another(client: TestClient, operator: Account) -> None:
    home = make(client, "Haushalt")
    garden = make(client, "Garten", home)
    assert client.post("/api/folders/move", json={"target_id": None, "folder_ids": [garden]}).status_code == 200
    assert by_id(client)[garden]["parent_id"] is None
    assert client.post("/api/folders/move", json={"target_id": home, "folder_ids": [garden]}).status_code == 200
    assert by_id(client)[garden]["parent_id"] == home


def test_notes4_ac14_a_note_from_the_inbox_is_sorted_into_a_folder(client: TestClient, operator: Account) -> None:
    recipes = make(client, "Rezepte")
    captured = note(operator, inbox_id(operator), "Pesto", origin="share:Safari")
    assert [n["id"] for n in client.get("/api/folders/inbox").json()["notes"]] == [captured]
    assert client.post("/api/folders/move", json={"target_id": recipes, "note_ids": [captured]}).status_code == 200
    assert client.get("/api/folders/inbox").json()["notes"] == []
    assert note_row(captured).folder_id == recipes
    # And back into the inbox, should it have been the wrong folder.
    assert client.post("/api/folders/move", json={"target_id": inbox_id(operator), "note_ids": [captured]}).status_code == 200
    assert note_row(captured).folder_id == inbox_id(operator)


# --- EC-1 Never into itself -------------------------------------------------------------------------------------------


def test_notes4_ec1_a_folder_never_goes_into_itself_or_a_subfolder(client: TestClient, operator: Account) -> None:
    work = make(client, "Arbeit")
    projects = make(client, "Projekte", work)
    year = make(client, "2026", projects)
    for target in (projects, year):
        answer = client.post("/api/folders/move", json={"target_id": target, "folder_ids": [projects]})
        assert answer.status_code == 400 and code(answer) == "folder_into_itself", target
    assert by_id(client)[projects]["parent_id"] == work
    # Its parent and the top are fine.
    assert client.post("/api/folders/move", json={"target_id": None, "folder_ids": [projects]}).status_code == 200


def test_notes4_ec1_folders_never_into_the_inbox_notes_never_to_the_top(client: TestClient, operator: Account) -> None:
    work = make(client, "Arbeit")
    inbox = inbox_id(operator)
    refused = client.post("/api/folders/move", json={"target_id": inbox, "folder_ids": [work]})
    assert code(refused) == "folder_target_not_allowed"
    assert code(client.post("/api/folders", json={"name": "Drin", "parent_id": inbox})) == "folder_target_not_allowed"
    loose = note(operator, work)
    assert code(client.post("/api/folders/move", json={"target_id": None, "note_ids": [loose]})) == "folder_target_not_allowed"
    assert note_row(loose).folder_id == work


# --- AC-4 Renaming ----------------------------------------------------------------------------------------------------


def test_notes4_ac4_a_renamed_folder_carries_its_new_name_everywhere(client: TestClient, operator: Account) -> None:
    work = make(client, "Arbeit")
    sub = make(client, "Projekte", work)
    answer = client.patch(f"/api/folders/{work}", json={"name": "Beruf"})
    assert answer.status_code == 200 and answer.json()["name"] == "Beruf"
    assert by_id(client)[work]["name"] == "Beruf"
    with new_client(operator) as laptop:
        assert by_id(laptop)[work]["name"] == "Beruf"
    # Its subfolders hang on the id, not the name.
    assert by_id(client)[sub]["parent_id"] == work


# --- AC-5, EC-10 Trash, undo and later ---------------------------------------------------------------------------------


def test_notes4_ac5_trash_takes_the_folder_and_all_inside_and_undo_brings_back_exactly_that(
    client: TestClient, operator: Account
) -> None:
    old = make(client, "Alte Rechnungen")
    year = make(client, "2024", old)
    kept = make(client, "Bleibt")
    inside = [note(operator, old, "Strom"), note(operator, year, "Gas")]
    elsewhere = note(operator, kept, "Wasser")
    # A note that went to the trash on its own before stays there when the folder comes back.
    earlier = note(operator, old, "Schon weg")
    with SessionLocal() as db:
        row = db.get(Note, earlier)
        assert row is not None
        row.deleted_at = utcnow() - timedelta(days=3)
        db.commit()
    assert client.get(f"/api/folders/{old}/impact").json() == {"notes": 2, "folders": 1, "trash_days": 90}

    gone = client.delete(f"/api/folders/{old}")
    assert gone.status_code == 200, gone.text
    assert gone.json()["notes"] == 2 and gone.json()["folders"] == 1
    assert set(by_id(client)) == {kept}
    assert all(note_row(n).deleted_at is not None for n in inside)
    assert note_row(elsewhere).deleted_at is None

    back = client.post(f"/api/folders/{old}/restore")
    assert back.status_code == 200 and back.json()["notes"] == 2 and back.json()["folders"] == 1
    folders = by_id(client)
    assert set(folders) == {old, year, kept}
    assert folders[year]["parent_id"] == old
    assert all(note_row(n).deleted_at is None for n in inside)
    assert note_row(earlier).deleted_at is not None
    assert folders[old]["count"] == 1 and folders[year]["count"] == 1


def test_notes4_ac5_a_subfolder_deleted_before_stays_in_the_trash(client: TestClient, operator: Account) -> None:
    top = make(client, "Oben")
    sub = make(client, "Unten", top)
    client.delete(f"/api/folders/{sub}")
    client.delete(f"/api/folders/{top}")
    client.post(f"/api/folders/{top}/restore")
    assert set(by_id(client)) == {top}
    # Its own way back still works, under its parent again.
    client.post(f"/api/folders/{sub}/restore")
    assert by_id(client)[sub]["parent_id"] == top


def test_notes4_ec10_a_folder_comes_back_from_the_trash_long_after_the_notice(client: TestClient, operator: Account) -> None:
    home = make(client, "Haushalt")
    garden = make(client, "Garten", home)
    kept = note(operator, garden, "Beete")
    client.delete(f"/api/folders/{garden}")
    # Days later: the notice is long gone; the trash still has it.
    with SessionLocal() as db:
        for row in db.scalars(select(Folder).where(Folder.id == garden)):
            row.deleted_at = utcnow() - timedelta(days=40)
        db.commit()
    # Meanwhile its parent went to the trash too, and a new folder of the same name stands at the top.
    client.delete(f"/api/folders/{home}")
    make(client, "garten")
    assert client.post(f"/api/folders/{garden}/restore").status_code == 200
    folders = by_id(client)
    assert folders[garden]["parent_id"] is None
    assert folders[garden]["name"] == "Garten (2)"
    assert note_row(kept).deleted_at is None
    assert_no_note_lost(operator)


def test_notes4_ac5_undo_twice_or_of_a_living_folder_changes_nothing(client: TestClient, operator: Account) -> None:
    folder = make(client, "Einmal")
    client.delete(f"/api/folders/{folder}")
    assert client.post(f"/api/folders/{folder}/restore").status_code == 200
    again = client.post(f"/api/folders/{folder}/restore")
    assert again.status_code == 200 and again.json()["folders"] == 0
    assert [f["name"] for f in tree(client)["folders"]] == ["Einmal"]


# --- AC-7 The inbox ---------------------------------------------------------------------------------------------------


def test_notes4_ac7_the_inbox_cannot_be_deleted_renamed_or_moved(client: TestClient, operator: Account) -> None:
    inbox = tree(client)["inbox"]["id"]
    work = make(client, "Arbeit")
    for answer in (
        client.delete(f"/api/folders/{inbox}"),
        client.patch(f"/api/folders/{inbox}", json={"name": "Post"}),
        client.patch(f"/api/folders/{inbox}", json={"color": "red"}),
        client.post("/api/folders/move", json={"target_id": work, "folder_ids": [inbox]}),
        client.post("/api/folders/move", json={"target_id": None, "folder_ids": [inbox]}),
    ):
        assert answer.status_code == 400 and code(answer) == "inbox_fixed", answer.text
    assert tree(client)["inbox"]["id"] == inbox
    # The inbox is beside the folders, not among them.
    assert inbox not in by_id(client)


def test_notes4_ac7_captured_notes_land_in_the_inbox_with_where_they_came_from(client: TestClient, operator: Account) -> None:
    inbox = tree(client)["inbox"]["id"]
    for title, origin in (("Kompost", "share:Safari"), ("Zahnarzt", "dictation"), ("Einkauf", "mcp:Desktop")):
        note(operator, inbox, title, origin)
    listed = client.get("/api/folders/inbox").json()
    assert listed["id"] == inbox
    assert {n["title"]: n["origin"] for n in listed["notes"]} == {
        "Kompost": "share:Safari", "Zahnarzt": "dictation", "Einkauf": "mcp:Desktop",
    }
    assert all(n["preview"].startswith("Text of ") for n in listed["notes"])
    assert tree(client)["inbox"]["count"] == 3
    # Every account has its own, made on first use.
    with new_client(make_account("carla")) as carla:
        assert tree(carla)["inbox"]["id"] != inbox
        assert carla.get("/api/folders/inbox").json()["notes"] == []


# --- AC-8 The count beside a folder -----------------------------------------------------------------------------------


def test_notes4_ac8_beside_a_folder_stands_the_number_of_its_own_notes(client: TestClient, operator: Account) -> None:
    home = make(client, "Haushalt")
    shop = make(client, "Einkauf", home)
    for index in range(3):
        note(operator, home, f"Haus {index}")
    for index in range(4):
        note(operator, shop, f"Einkauf {index}")
    binned = note(operator, home, "Weg")
    with SessionLocal() as db:
        row = db.get(Note, binned)
        assert row is not None
        row.deleted_at = utcnow()
        db.commit()
    folders = by_id(client)
    assert folders[home]["count"] == 3
    assert folders[shop]["count"] == 4


# --- AC-10 Symbol and colour --------------------------------------------------------------------------------------------


def test_notes4_ac10_symbol_and_colour_come_from_fixed_rows_and_reach_every_device(
    client: TestClient, operator: Account
) -> None:
    assert len(folder_service.FOLDER_COLORS) == 12
    assert len(folder_service.FOLDER_ICONS) == len(set(folder_service.FOLDER_ICONS)) >= 12
    folder = make(client, "Projekte")
    answer = client.patch(f"/api/folders/{folder}", json={"icon": "briefcase", "color": "orange"})
    assert answer.status_code == 200
    with new_client(operator) as phone:
        seen = by_id(phone)[folder]
        assert (seen["icon"], seen["color"]) == ("briefcase", "orange")
    for wrong in ({"icon": "skull"}, {"color": "#123456"}):
        refused = client.patch(f"/api/folders/{folder}", json=wrong)
        assert refused.status_code == 400 and code(refused) == "folder_style_unknown"
    assert code(client.post("/api/folders", json={"name": "X", "color": "pink"})) == "folder_style_unknown"
    # Back to plain.
    client.patch(f"/api/folders/{folder}", json={"icon": "", "color": ""})
    assert (by_id(client)[folder]["icon"], by_id(client)[folder]["color"]) == ("", "")


def test_notes4_ac10_the_page_knows_the_same_colours_and_symbols() -> None:
    source = (ROOT / "frontend" / "src" / "folders" / "palette.ts").read_text(encoding="utf-8")
    colors = dict(re.findall(r"\{ key: '([a-z-]+)', hex: '(#[0-9a-f]{6})' \}", source))
    icons = re.findall(r"\['([a-z-]+)', [A-Z]\w+\]", source)
    assert colors == folder_service.FOLDER_COLORS
    assert tuple(icons) == folder_service.FOLDER_ICONS


# --- AC-11 Order ------------------------------------------------------------------------------------------------------


def names(client: TestClient, parent: str | None = None) -> list[str]:
    return [f["name"] for f in tree(client)["folders"] if f["parent_id"] == parent]


def test_notes4_ac11_new_folders_stand_alphabetically_then_the_members_order_holds_on_every_device(
    client: TestClient, operator: Account
) -> None:
    for name in ("Rezepte", "Ärger", "arbeit", "Thema 10", "Thema 2", "Zoo"):
        make(client, name)
    assert names(client) == ["arbeit", "Ärger", "Rezepte", "Thema 2", "Thema 10", "Zoo"]
    ids = {f["name"]: f["id"] for f in tree(client)["folders"]}
    wanted = ["Zoo", "arbeit", "Rezepte", "Ärger", "Thema 10", "Thema 2"]
    answer = client.put("/api/folders/order", json={"parent_id": None, "ids": [ids[name] for name in wanted]})
    assert answer.status_code == 200
    with new_client(operator) as laptop:
        assert names(laptop) == wanted
        # A rename no longer moves it: the member's order holds.
        laptop.patch(f"/api/folders/{ids['Zoo']}", json={"name": "Aaa"})
        assert names(laptop)[0] == "Aaa"
    # A new folder after the member ordered joins at the end, also one moved in.
    make(client, "Neu")
    sub = make(client, "Unten", ids["Rezepte"])
    # Ordered first where it was (its place there is 0): at its new place it still joins at the end.
    client.put("/api/folders/order", json={"parent_id": ids["Rezepte"], "ids": [sub, make(client, "Daneben", ids["Rezepte"])]})
    client.post("/api/folders/move", json={"target_id": None, "folder_ids": [sub]})
    assert names(client)[-2:] == ["Neu", "Unten"]


def test_notes4_ac11_order_from_an_older_list_keeps_folders_made_meanwhile(client: TestClient, operator: Account) -> None:
    parent = make(client, "Oben")
    a, b = make(client, "A", parent), make(client, "B", parent)
    late = make(client, "C", parent)
    client.put("/api/folders/order", json={"parent_id": parent, "ids": [b, a, "00000000-dead"]})
    assert [f["id"] for f in tree(client)["folders"] if f["parent_id"] == parent] == [b, a, late]


# --- EC-2, EC-7 Names -------------------------------------------------------------------------------------------------


def test_notes4_ec2_the_same_name_twice_in_one_place_is_refused_whatever_the_case(client: TestClient, operator: Account) -> None:
    home = make(client, "Haushalt")
    other = make(client, "Arbeit")
    taken = client.post("/api/folders", json={"name": "  haushalt "})
    assert taken.status_code == 409 and code(taken) == "folder_name_taken"
    assert taken.json()["detail"]["name"] == "haushalt"
    assert code(client.patch(f"/api/folders/{other}", json={"name": "HAUSHALT"})) == "folder_name_taken"
    assert names(client) == ["Arbeit", "Haushalt"]
    # Elsewhere it is free; moving it beside its twin is not.
    twin = make(client, "Arbeit", home)
    refused = client.post("/api/folders/move", json={"target_id": None, "folder_ids": [twin]})
    assert code(refused) == "folder_name_taken"
    assert by_id(client)[twin]["parent_id"] == home
    # Its own name in other letters is a rename, not a twin.
    assert client.patch(f"/api/folders/{other}", json={"name": "ARBEIT"}).status_code == 200
    # A folder in the trash leaves its name free.
    client.delete(f"/api/folders/{home}")
    assert client.post("/api/folders", json={"name": "Haushalt"}).status_code == 201


def test_notes4_ec7_names_keep_umlauts_and_emoji_lose_edge_blanks_and_stay_within_sixty(
    client: TestClient, operator: Account
) -> None:
    folder = make(client, "  Größe 🌱 Übersicht\t")
    assert by_id(client)[folder]["name"] == "Größe 🌱 Übersicht"
    assert make(client, "Zeile\neins") and "Zeile eins" in names(client)
    for blank in ("", "   ", "\n\t"):
        refused = client.post("/api/folders", json={"name": blank})
        assert refused.status_code == 400 and code(refused) == "folder_name_missing"
    exactly = "x" * 60
    sixty = make(client, exactly)
    assert by_id(client)[sixty]["name"] == exactly
    too_long = client.post("/api/folders", json={"name": "y" * 61})
    assert code(too_long) == "folder_name_too_long" and too_long.json()["detail"]["maximum"] == 60
    assert code(client.patch(f"/api/folders/{folder}", json={"name": "z" * 61})) == "folder_name_too_long"
    # Blanks at the edges do not count toward the sixty.
    assert client.post("/api/folders", json={"name": "  " + "w" * 60 + "  "}).status_code == 201


# --- EC-4 Two devices at once -----------------------------------------------------------------------------------------


def _interleave(monkeypatch: pytest.MonkeyPatch, name: str, other: Any) -> list[Any]:
    """While the request reads the tree (``services/folders.<name>``), another device sends ``other``: it starts in
    its own thread and has half a second to get through. With the lock it waits for this request to finish."""
    original = getattr(folder_service, name)
    results: list[Any] = []
    fired = threading.Event()

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        found = original(*args, **kwargs)
        if not fired.is_set():
            fired.set()
            thread = threading.Thread(target=lambda: results.append(other()))
            thread.start()
            thread.join(0.5)
            results.append(thread)
        return found

    monkeypatch.setattr(folder_service, name, wrapped)
    return results


def _finish(results: list[Any]) -> Any:
    thread = next(item for item in results if isinstance(item, threading.Thread))
    thread.join(20)
    assert not thread.is_alive()
    return next(item for item in results if not isinstance(item, threading.Thread))


def test_notes4_ec4_a_folder_moved_into_one_being_deleted_loses_no_note(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    doomed = make(client, "Wird gelöscht")
    moving = make(client, "Wandert")
    notes = [note(operator, moving, "Eins"), note(operator, moving, "Zwei")]
    with new_client(operator) as laptop:
        results = _interleave(
            monkeypatch, "_subtree",
            lambda: laptop.post("/api/folders/move", json={"target_id": doomed, "folder_ids": [moving]}),
        )
        assert client.delete(f"/api/folders/{doomed}").status_code == 200
        moved = _finish(results)
    # The move came second and found its target in the trash: nothing moved, nothing lost.
    assert moved.status_code == 404
    assert by_id(client)[moving]["parent_id"] is None
    assert all(note_row(n).deleted_at is None for n in notes)
    assert_no_note_lost(operator)


def test_notes4_ec4_a_folder_deleted_while_it_is_moved_ends_whole_in_the_trash(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = make(client, "Ziel")
    moving = make(client, "Wandert")
    inner = make(client, "Darin", moving)
    notes = [note(operator, moving, "Eins"), note(operator, inner, "Zwei")]
    with new_client(operator) as laptop:
        results = _interleave(monkeypatch, "_ancestors", lambda: laptop.delete(f"/api/folders/{moving}"))
        assert client.post("/api/folders/move", json={"target_id": target, "folder_ids": [moving]}).status_code == 200
        deleted = _finish(results)
    assert deleted.status_code == 200
    # Moved first, then deleted where it went: folder, subfolder and notes are in the trash together.
    assert set(by_id(client)) == {target}
    assert all(note_row(n).deleted_at is not None for n in notes)
    assert_no_note_lost(operator)
    assert client.post(f"/api/folders/{moving}/restore").json()["notes"] == 2
    assert by_id(client)[moving]["parent_id"] == target
    assert_no_note_lost(operator)


def test_notes4_ec4_many_moves_and_deletes_from_two_devices_never_hide_a_note(client: TestClient, operator: Account) -> None:
    ids = [make(client, f"Ordner {index}") for index in range(8)]
    for folder in ids:
        note(operator, folder, f"in {folder[:4]}")
    errors: list[BaseException] = []

    def device(steps: list[tuple[str, str, str]]) -> None:
        try:
            with new_client(operator) as other:
                for kind, first, second in steps:
                    if kind == "move":
                        other.post("/api/folders/move", json={"target_id": second, "folder_ids": [first]})
                    else:
                        other.delete(f"/api/folders/{first}")
        except BaseException as problem:  # noqa: BLE001 - handed to the test thread
            errors.append(problem)

    moves = [("move", ids[i], ids[(i + 3) % 8]) for i in range(8)] * 2
    deletes = [("delete", ids[i], "") for i in (1, 4, 6)]
    threads = [threading.Thread(target=device, args=(moves,)), threading.Thread(target=device, args=(deletes,))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert not errors
    assert_no_note_lost(operator)


# --- EC-8 Many folders ------------------------------------------------------------------------------------------------


def test_notes4_ec8_five_hundred_folders_load_in_one_query_and_quickly(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        inbox = inbox_for(db, operator.id)
        parents: list[str | None] = [None]
        for index in range(500):
            folder = Folder(owner_id=operator.id, name=f"Ordner {index:03d}", parent_id=parents[index // 10])
            db.add(folder)
            db.flush()
            parents.append(folder.id)
            db.add(Note(owner_id=operator.id, folder_id=folder.id, title=f"N {index}"))
        db.add(Note(owner_id=operator.id, folder_id=inbox.id, title="Eingang"))
        db.commit()

    statements: list[str] = []

    def count(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        with SessionLocal() as db:
            listed = folder_service.tree(db, operator.id)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert len(listed["folders"]) == 500
    assert all(folder["count"] == 1 for folder in listed["folders"])
    reads = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    # The inbox and the tree with its counts: two reads, not one per folder.
    assert len(reads) == 2, reads

    client.get("/api/folders")
    started = time.perf_counter()
    for _ in range(3):
        assert len(client.get("/api/folders").json()["folders"]) == 500
    took = (time.perf_counter() - started) / 3
    assert took < 0.5, f"the sidebar's tree took {took:.3f} s"


# --- The texts of the errors --------------------------------------------------------------------------------------------


def test_notes4_every_folder_error_has_its_sentence_in_both_languages() -> None:
    source = (ROOT / "backend" / "app" / "services" / "folders.py").read_text(encoding="utf-8")
    codes = set(re.findall(r'error\(\s*"([a-z_]+)"', source)) - {"not_found"}
    assert {"folder_name_missing", "folder_name_too_long", "folder_name_taken", "folder_into_itself", "inbox_fixed",
            "folder_target_not_allowed", "folder_style_unknown"} <= codes
    for language in ("de", "en"):
        texts = json.loads((ROOT / "frontend" / "src" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
        assert codes <= set(texts["errors"]), language
