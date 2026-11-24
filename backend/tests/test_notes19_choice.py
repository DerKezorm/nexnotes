"""NOTES-19, "Bereiche und Listen" in Connections (asked for on 24.11.2026, as nextime's card): the areas of nextasks
with their lists, an area ticked whole (its later lists too) or single lists, all areas from the start; a standard
list among the chosen ones. The choice is kept per account at the server and decides what the sending offers, in the
browser and in the app (interface 0.14); a standard list chosen away or gone in nextasks counts as none, quietly.

nextasks is the stand-in of ``test_notes19.py``; the app is the paired device of ``test_notes24.py``."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect, text

from app import db as db_module
from app.db import SessionLocal
from app.models import Base
from app.models_nextasks import NextasksConnection
from app.services import backups, devices, nextasks

from . import test_notes19
from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note
from .test_notes19 import FAMILY_AREA, HOME_AREA, LIST, OTHER_LIST, PUBLIC, SECTION, FakeNextasks, code, connected, send
from .test_notes24 import paired

fake = test_notes19.fake
LATER_HOME = "55555555-5555-4555-8555-555555555555"
LATER_FAMILY = "66666666-6666-4666-8666-666666666666"


@pytest.fixture(autouse=True)
def _forget(client):
    devices.forget()
    yield
    Live.close_all()


def offered(client, **headers) -> dict:
    answer = client.get("/api/nextasks/lists", headers=headers or None)
    assert answer.status_code == 200, answer.text
    return answer.json()


def names(found: dict) -> list[str]:
    return [one["name"] for one in found["lists"]]


def choose(client, areas: list[str], lists: list[str], default: str | None = None) -> dict:
    answer = client.put("/api/nextasks/areas", json={"areas": areas, "lists": lists, "default": default})
    assert answer.status_code == 200, answer.text
    return answer.json()


def add_list(fake: FakeNextasks, list_id: str, area: str, area_name: str, name: str) -> None:
    fake.lists.append({"id": list_id, "space_id": area, "space_name": area_name, "name": name, "writable": True,
                       "hidden": False, "sections": []})
    # The areas are kept a minute for the card; a new list in nextasks shows there after that.
    nextasks.forget()


def test_notes19_choice_every_area_is_chosen_from_the_start_with_symbols_and_colours(client, operator, fake):
    connected(client)
    found = client.get("/api/nextasks/areas").json()
    assert found["default"] is None
    assert [(area["id"], area["name"], area["icon"], area["color"], area["whole"]) for area in found["areas"]] == [
        (HOME_AREA, "Zuhause", "house", "orange", True), (FAMILY_AREA, "Familie", "heart", "#3a86ff", True)]
    home, family = found["areas"]
    assert home["lists"] == [{"id": LIST, "name": "Renovierung", "icon": "hammer", "color": "red", "chosen": True}]
    assert family["lists"] == [{"id": OTHER_LIST, "name": "Einkauf", "icon": "shopping-cart", "color": "green",
                                "chosen": True}]
    lists = offered(client)
    assert names(lists) == ["Zuhause › Renovierung", "Zuhause › Renovierung › Bad", "Familie › Einkauf"]
    assert all(one["default"] is False for one in lists["lists"])


def test_notes19_choice_single_lists_or_a_whole_area_with_its_later_lists(client, operator, fake):
    connected(client)
    # Only the shopping list: the home area is out, its sections too.
    answer = choose(client, [], [OTHER_LIST])
    assert [area["whole"] for area in answer["areas"]] == [False, False]
    assert answer["areas"][1]["lists"][0]["chosen"] is True and answer["areas"][0]["lists"][0]["chosen"] is False
    assert names(offered(client)) == ["Familie › Einkauf"]
    # The home area whole: a list nextasks gets later is offered at once; one of the family area chosen singly not.
    choose(client, [HOME_AREA], [OTHER_LIST])
    add_list(fake, LATER_HOME, HOME_AREA, "Zuhause", "Garten")
    add_list(fake, LATER_FAMILY, FAMILY_AREA, "Familie", "Urlaub")
    assert names(offered(client)) == ["Zuhause › Renovierung", "Zuhause › Renovierung › Bad", "Familie › Einkauf",
                                      "Zuhause › Garten"]
    areas = client.get("/api/nextasks/areas").json()["areas"]
    assert [one["chosen"] for one in areas[0]["lists"]] == [True, True]
    assert [one["chosen"] for one in areas[1]["lists"]] == [True, False]
    # Nothing at all: the sending offers nothing.
    choose(client, [], [])
    assert offered(client)["lists"] == []


def test_notes19_choice_the_standard_list_is_marked_and_the_one_used_last_only_while_offered(client, operator, fake):
    connected(client)
    answer = choose(client, [HOME_AREA, FAMILY_AREA], [], default=OTHER_LIST)
    assert answer["default"] == OTHER_LIST
    found = offered(client)
    assert [(one["id"], one["default"]) for one in found["lists"]] == [
        (LIST, False), (f"{LIST}/{SECTION}", False), (OTHER_LIST, True)]
    note = new_note(client, markdown="Fliesen")
    assert send(client, note["id"], ["Fliesen"], list_id=LIST, list_name="Zuhause › Renovierung").status_code == 200
    assert offered(client)["last"] == LIST
    choose(client, [FAMILY_AREA], [], default=OTHER_LIST)
    assert offered(client)["last"] is None, "the list used last is not offered any more"
    # Kept per account: another account of the server has its own choice, every area and no standard list.
    other = make_account("friend")
    with new_client(other) as as_other:
        assert as_other.put("/api/nextasks", json={"url": test_notes19.HOME, "token": test_notes19.GOOD}).status_code == 200
        assert as_other.get("/api/nextasks/areas").json()["default"] is None
        assert len(offered(as_other)["lists"]) == 3
    with SessionLocal() as db:
        row = db.get(NextasksConnection, operator.id)
        assert row is not None and row.default_list_id == OTHER_LIST


def test_notes19_choice_a_standard_list_chosen_away_counts_as_none_and_stays_none(client, operator, fake):
    connected(client)
    choose(client, [HOME_AREA, FAMILY_AREA], [], default=OTHER_LIST)
    answer = choose(client, [HOME_AREA], [], default=OTHER_LIST)
    assert answer["default"] is None
    assert not any(one["default"] for one in offered(client)["lists"])
    # Ticked again later, it is no standard list by itself.
    assert choose(client, [HOME_AREA, FAMILY_AREA], [])["default"] is None
    with SessionLocal() as db:
        assert db.get(NextasksConnection, operator.id).default_list_id == ""


def test_notes19_choice_a_standard_list_gone_in_nextasks_counts_as_none_without_an_error(client, operator, fake):
    connected(client)
    choose(client, [HOME_AREA, FAMILY_AREA], [], default=OTHER_LIST)
    fake.lists = [one for one in fake.lists if one["id"] != OTHER_LIST]
    nextasks.forget()
    found = client.get("/api/nextasks/areas")
    assert found.status_code == 200 and found.json()["default"] is None
    lists = offered(client)
    assert names(lists) == ["Zuhause › Renovierung", "Zuhause › Renovierung › Bad"]
    assert not any(one["default"] for one in lists["lists"])


def test_notes19_choice_the_app_gets_the_same_lists_with_default(client, operator, fake):
    connected(client)
    choose(client, [], [OTHER_LIST], default=OTHER_LIST)
    device = paired(client)
    found = offered(client, **device.headers)
    assert found["lists"] == [{"id": OTHER_LIST, "name": "Familie › Einkauf", "hidden": False, "default": True}]
    # What an app before 0.14 reads stays as it was: ``lists`` with ``id``, ``name``, ``hidden``, and ``last``.
    assert set(found) == {"lists", "last"}


def test_notes19_choice_the_input_is_checked(client, operator, fake):
    assert code(client.get("/api/nextasks/areas")) == "nextasks_not_connected"
    assert code(client.put("/api/nextasks/areas", json={"areas": [], "lists": []})) == "nextasks_not_connected"
    connected(client)
    # A section is no standard list, nor an id of another form; ids of other forms are left out.
    assert choose(client, [HOME_AREA, "../x"], ["a b"], default=f"{LIST}/{SECTION}")["default"] is None
    assert choose(client, [HOME_AREA], [], default="no/such/list")["default"] is None
    too_long = client.put("/api/nextasks/areas", json={"areas": ["x" * 101], "lists": []})
    assert too_long.status_code == 422
    assert client.put("/api/nextasks/areas", json={"areas": "all"}).status_code == 422


def test_notes19_choice_ticking_box_after_box_asks_nextasks_once_a_minute(client, operator, fake):
    connected(client)
    client.get("/api/nextasks/areas")
    asked = len(fake.requests)
    for _ in range(5):
        choose(client, [HOME_AREA], [])
    assert len(fake.requests) == asked


def test_notes19_choice_another_nextasks_starts_with_every_area_again(client, operator, fake):
    connected(client)
    choose(client, [], [OTHER_LIST], default=OTHER_LIST)
    assert client.put("/api/nextasks", json={"url": PUBLIC, "token": test_notes19.GOOD}).status_code == 200
    found = client.get("/api/nextasks/areas").json()
    assert found["default"] is None and all(area["whole"] for area in found["areas"])


def test_notes19_choice_a_database_from_before_gets_the_columns_and_every_area(tmp_path, monkeypatch):
    """The migration: ``init_db`` adds the two columns to an existing table, a connection made before keeps going
    with every area and no standard list."""
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        # The table as it was before the choice.
        connection.execute(text("ALTER TABLE nextasks_connections DROP COLUMN task_choice"))
        connection.execute(text("ALTER TABLE nextasks_connections DROP COLUMN default_list_id"))
        connection.execute(text(
            "INSERT INTO nextasks_connections (account_id, url, token_enc, name, checked_at, last_list_id, "
            "last_list_name) VALUES (7, 'https://tasks.example.com', 'x', 'the owner', '2026-11-01 00:00:00', '', '')"))
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(backups, "create", lambda **_: None)
    db_module._add_missing_columns()
    columns = {column["name"] for column in inspect(engine).get_columns("nextasks_connections")}
    assert {"task_choice", "default_list_id"} <= columns
    with engine.connect() as connection:
        row = connection.execute(text(
            "SELECT task_choice, default_list_id FROM nextasks_connections WHERE account_id = 7")).one()
    assert tuple(row) == ("", "")
    assert nextasks.choice_of(NextasksConnection(task_choice=row[0])) is None
    engine.dispose()
