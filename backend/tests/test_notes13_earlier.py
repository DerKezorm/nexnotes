"""What earlier features left "nicht prüfbar, wartet auf NOTES-13": now with real shares instead of stand-ins.

NOTES-2 AC-4, AC-6; NOTES-4 EC-9; NOTES-5 EC-4; NOTES-6 AC-7 and finding 5 (pin and color); NOTES-8 EC-6; NOTES-9 EC-7;
NOTES-10 EC-10; NOTES-12 AC-5, AC-6, AC-9, EC-6; NOTES-15 AC-6, AC-8; NOTES-17 AC-3, EC-8.
"""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pycrdt import YMessageType, read_message
from pycrdt._sync import Decoder

from app.db import SessionLocal
from app.models import Account
from app.notedoc import edit
from app.notedoc.room import _awareness_message
from app.services import accounts, attachments, export, export_pdf, history, notes, trash

from .conftest import make_account, new_client
from .notes_live import Live
from .test_notes3 import new_note, stored, token_for, wait_for
from .test_notes13 import all_notes, make_folder, share, titles, unshare


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


@pytest.fixture(autouse=True)
def setup(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(notes, "LEAVE_GRACE", 0.05)
    monkeypatch.setattr(export_pdf, "INLINE", True)
    monkeypatch.setattr(export, "AUTO", False)
    history.register()
    trash.register()
    history.clock.reset()
    yield
    history.clock.reset()


@pytest.fixture
def people() -> dict[str, Account]:
    return {name: make_account(name) for name in ("anna", "lena")}


@pytest.fixture
def clients(people: dict[str, Account]) -> Iterator[dict[str, TestClient]]:
    opened = {name: new_client(account) for name, account in people.items()}
    for each in opened.values():
        each.__enter__()
    yield opened
    Live.close_all()
    for each in opened.values():
        each.__exit__(None, None, None)


# --- NOTES-2 ----------------------------------------------------------------------------------------------------------


def test_notes2_ac6_notes13_a_member_reaches_its_own_and_shared_notes_and_nothing_else(client, operator, people,
                                                                                      clients):
    anna = clients["anna"]
    own = new_note(anna, title="Annas")
    shared = new_note(client, title="Geteilt")
    private = new_note(client, title="Privat")
    share(client, "note", shared["id"], people["anna"], "read")
    assert titles(all_notes(anna)) == ["Annas", "Geteilt"]
    assert anna.get(f"/api/notes/{shared['id']}").status_code == 200
    assert anna.get(f"/api/notes/{private['id']}").status_code == 404
    assert anna.get(f"/api/notes/{own['id']}").status_code == 200
    assert {hit["id"] for hit in anna.get("/api/search", params={"q": "privat"}).json()["items"]} == set()


def test_notes2_ac4_notes13_what_a_blocked_member_shared_stays_visible_for_the_others(client, operator, people,
                                                                                     clients):
    note = new_note(clients["anna"], title="Annas Plan")
    share(clients["anna"], "note", note["id"], people["lena"], "write")
    with SessionLocal() as db:
        accounts.block(db, db.get(Account, people["anna"].id))
    assert clients["lena"].get(f"/api/notes/{note['id']}").status_code == 200
    assert clients["anna"].get(f"/api/notes/{note['id']}").status_code in (401, 403)


# --- NOTES-4 EC-9 -------------------------------------------------------------------------------------------------------


def test_notes4_ec9_notes13_a_shared_folder_deleted_closes_the_open_note_of_another(client, operator, people, clients):
    family = make_folder(client, "Familie")
    note = new_note(client, title="Einkauf", folder_id=family)
    share(client, "folder", family, people["anna"], "write")
    theirs = Live(clients["anna"], note["id"], token_for(people["anna"]))
    assert theirs.pump(lambda: theirs.synced)
    assert client.delete(f"/api/folders/{family}").status_code == 200
    assert theirs.pump(lambda: theirs.closed is not None)
    assert theirs.closed == 4404
    assert clients["anna"].get(f"/api/notes/{note['id']}").json()["deleted_at"] is not None


# --- NOTES-5 EC-4 -------------------------------------------------------------------------------------------------------


def test_notes5_ec4_notes13_tags_of_notes_shared_with_the_member_count_for_it(client, operator, people, clients):
    shared = new_note(client, title="Liste", markdown="Milch #einkauf")
    new_note(client, title="Privat", markdown="#geheim")
    share(client, "note", shared["id"], people["lena"], "read")
    new_note(clients["lena"], title="Eigene", markdown="Brot #einkauf")
    tags = {item["label"]: item["count"] for item in clients["lena"].get("/api/tags").json()["tags"]}
    assert tags == {"einkauf": 2}
    unshare(client, "note", shared["id"], people["lena"])
    assert {item["label"]: item["count"] for item in clients["lena"].get("/api/tags").json()["tags"]} == {"einkauf": 1}


# --- NOTES-6 ----------------------------------------------------------------------------------------------------------


def test_notes6_ac7_notes13_all_notes_counts_real_shared_notes_with_folder_and_owner(client, operator, people,
                                                                                    clients):
    family = make_folder(client, "Familie")
    new_note(client, title="Im Ordner", folder_id=family)
    alone = new_note(client, title="Allein")
    share(client, "folder", family, people["lena"], "read")
    share(client, "note", alone["id"], people["lena"], "write")
    new_note(clients["lena"], title="Eigene")
    listing = all_notes(clients["lena"])
    assert listing["counts"] == {"own": 1, "shared": 2}
    shared = [item for item in listing["items"] if item.get("owner")]
    assert {item["folder_id"] for item in shared} >= {family}
    assert all(item["owner"]["name"] == "Tester" for item in shared)
    # Gone to the trash: neither listed nor counted.
    client.delete(f"/api/notes/{alone['id']}")
    assert all_notes(clients["lena"])["counts"] == {"own": 1, "shared": 1}


def test_notes6_notes13_a_member_pins_for_itself_and_colors_only_with_the_right_to_write(client, operator, people,
                                                                                        clients):
    note = new_note(client, title="Geteilt")
    share(client, "note", note["id"], people["lena"], "read")
    share(client, "note", note["id"], people["anna"], "write")
    pinned = clients["lena"].put(f"/api/notes/{note['id']}/pin", json={"pinned": True})
    assert pinned.status_code == 200 and pinned.json()["pinned"] is True
    lena_items = {item["id"]: item for item in all_notes(clients["lena"])["items"]}
    assert lena_items[note["id"]]["pinned"] is True
    # The pin is Lena's: the owner and Anna see it unpinned, the note itself stays unpinned.
    assert {item["id"]: item for item in all_notes(client)["items"]}[note["id"]]["pinned"] is False
    assert {item["id"]: item for item in all_notes(clients["anna"])["items"]}[note["id"]]["pinned"] is False
    assert stored(note["id"]).pinned_at is None
    assert clients["lena"].get(f"/api/notes/{note['id']}").json()["pinned"] is True
    # The color is the note's: only who may write.
    assert clients["lena"].put(f"/api/notes/{note['id']}/color", json={"color": "red"}).status_code == 404
    assert clients["anna"].put(f"/api/notes/{note['id']}/color", json={"color": "red"}).status_code == 200
    assert stored(note["id"]).color == "red"


# --- NOTES-8 EC-6 -------------------------------------------------------------------------------------------------------


def test_notes8_ec6_notes13_a_tab_of_a_note_whose_sharing_ended_is_not_found_and_its_live_closes(
        client, operator, people, clients):
    note = new_note(client, title="Im Tab")
    share(client, "note", note["id"], people["anna"], "write")
    theirs = Live(clients["anna"], note["id"], token_for(people["anna"]))
    assert theirs.pump(lambda: theirs.synced)
    unshare(client, "note", note["id"], people["anna"])
    assert theirs.pump(lambda: theirs.closed is not None)
    assert theirs.closed == 4403
    head = clients["anna"].get(f"/api/notes/{note['id']}")
    assert head.status_code == 404 and head.json()["detail"]["code"] == "not_found"


# --- NOTES-9 EC-7 -------------------------------------------------------------------------------------------------------


def test_notes9_ec7_notes13_search_finds_shared_notes_and_a_taken_right_counts_at_once(client, operator, people,
                                                                                      clients):
    family = make_folder(client, "Familie")
    note = new_note(client, title="Geheimplan", markdown="Überraschungsparty", folder_id=family)
    new_note(client, title="Nicht geteilt", markdown="Party ohne Lena")
    lena = clients["lena"]
    new_note(lena, title="Meins", markdown="Party planen")

    def found() -> list[str]:
        return sorted(hit["title"] for hit in lena.get("/api/search", params={"q": "party"}).json()["items"])

    assert found() == ["Meins"]
    share(client, "folder", family, people["lena"], "read")
    assert found() == ["Geheimplan", "Meins"]
    unshare(client, "folder", family, people["lena"])
    assert found() == ["Meins"]
    share(client, "note", note["id"], people["lena"], "read")
    assert found() == ["Geheimplan", "Meins"]


# --- NOTES-10 EC-10 -----------------------------------------------------------------------------------------------------


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (20, 20), (90, 160, 60)).save(out, "PNG")
    return out.getvalue()


def test_notes10_ec10_notes13_a_reader_opens_and_downloads_attachments_but_attaches_nothing(client, operator, people,
                                                                                           clients):
    from .test_notes10 import add_blocks

    note = new_note(client, title="Geteilt")
    row = client.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(), "name": "a.png"},
                      content=_png()).json()
    add_blocks(note["id"], operator.id, {"type": "image", "attrs": {"id": row["id"], "size": "medium"}})
    share(client, "note", note["id"], people["lena"], "read")
    lena = clients["lena"]
    assert lena.get(f"/api/attachments/{row['id']}/file").status_code == 200
    assert [item["id"] for item in lena.get(f"/api/notes/{note['id']}/attachments").json()["items"]] == [row["id"]]
    refused = lena.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(), "name": "b.png"},
                        content=_png())
    assert refused.status_code == 404
    assert clients["anna"].get(f"/api/attachments/{row['id']}/file").status_code == 404
    # The list shows the reader the picture of the note too.
    item = {each["id"]: each for each in all_notes(lena)["items"]}[note["id"]]
    assert item["media"]["count"] == 1


# --- NOTES-12 ---------------------------------------------------------------------------------------------------------


class Presence(Live):
    """A live connection that also hears who else is in the note (awareness)."""

    def __init__(self, *args, **kwargs) -> None:
        self.seen: dict[int, dict] = {}
        super().__init__(*args, **kwargs)

    def _handle(self, item) -> None:
        if isinstance(item, bytes) and item and item[0] == YMessageType.AWARENESS:
            decoder = Decoder(read_message(item[1:]))
            for _ in range(decoder.read_var_uint()):
                client_id = decoder.read_var_uint()
                decoder.read_var_uint()
                state = json.loads(decoder.read_var_string())
                if state is None:
                    self.seen.pop(client_id, None)
                else:
                    self.seen[client_id] = state
            return
        super()._handle(item)

    def announce(self, client_id: int, name: str) -> None:
        self._send(_awareness_message([(client_id, 1, {"user": {"name": name, "accountId": 0}})]))

    def names(self) -> set[str]:
        return {state["user"]["name"] for state in self.seen.values() if "user" in state}


def test_notes12_ac5_ac6_ec6_notes13_six_accounts_in_one_shared_note_see_each_other_by_their_own_names(
        client, operator):
    members = [make_account(name) for name in ("anna", "bert", "cora", "dirk", "emil")]
    note = new_note(client, title="Gemeinsam")
    for member in members:
        share(client, "note", note["id"], member, "write")
    # One server, six browsers (each with its own session): the connections of one test client share one room.
    lives = [Presence(client, note["id"], token_for(account)) for account in (operator, *members)]
    others = [new_client(member) for member in members]
    for number, live in enumerate(lives):
        assert live.pump(lambda live=live: live.synced)
        # Whatever a browser writes as its name, the room says who it is (AC-5).
        live.announce(1000 + number, "jemand anderes")
    everyone = ["Tester", "Anna", "Bert", "Cora", "Dirk", "Emil"]
    for own, live in zip(everyone, lives, strict=True):
        wanted = set(everyone) - {own}
        assert live.pump(lambda live=live, wanted=wanted: live.names() == wanted, timeout=5), live.names()
    # Their pictures (AC-6): the people of the note see each other's; since konten 1.0.0 every signed-in account does.
    stranger = make_account("fremd")
    with SessionLocal() as db:
        for member in members:
            row = db.get(Account, member.id)
            row.avatar = b"RIFF0000WEBP"
            from app.models import utcnow

            row.avatar_at = utcnow()
        db.commit()
    assert others[0].get(f"/api/avatars/{members[4].id}").status_code == 200
    assert client.get(f"/api/avatars/{members[1].id}").status_code == 200
    with new_client(stranger) as theirs:
        assert theirs.get(f"/api/avatars/{members[1].id}").status_code == 200
    for each in others:
        each.close()


def test_notes12_ac9_notes13_changed_by_names_the_member_who_wrote_last(client, operator, people, clients):
    note = new_note(client, title="Gemeinsam", markdown="Anfang")
    share(client, "note", note["id"], people["anna"], "write")
    theirs = Live(clients["anna"], note["id"], token_for(people["anna"]))
    assert theirs.pump(lambda: theirs.synced)
    edit.append_paragraph(theirs.doc, "von Anna")
    theirs.settle(0.3)
    assert wait_for(lambda: client.get(f"/api/notes/{note['id']}").json()["updated_by"]["name"] == "Anna")
    theirs.close()


# --- NOTES-15 -----------------------------------------------------------------------------------------------------------


def test_notes15_ac6_notes13_the_trash_names_who_deleted_in_a_shared_folder(client, operator, people, clients):
    family = make_folder(client, "Familie")
    note = new_note(client, title="Gelöscht von Lena", folder_id=family)
    mine = new_note(client, title="Selbst gelöscht", folder_id=family)
    share(client, "folder", family, people["lena"], "write")
    assert clients["lena"].delete(f"/api/notes/{note['id']}").status_code == 204
    assert client.delete(f"/api/notes/{mine['id']}").status_code == 204
    items = {item["title"]: item["deleted_by"] for item in client.get("/api/trash").json()["items"]}
    assert items == {"Gelöscht von Lena": {"id": people["lena"].id, "name": "Lena"}, "Selbst gelöscht": None}


def test_notes15_ac8_notes13_readers_look_writers_restore_strangers_see_nothing(client, operator, people, clients):
    from .test_notes15 import T0, history_of, session

    stranger = make_account("fremd")
    note = new_note(client, title="Geteilt", markdown="v1")
    share(client, "note", note["id"], people["lena"], "read")
    share(client, "note", note["id"], people["anna"], "write")
    session(note["id"], operator.id, ["v2"], T0)
    version = history_of(client, note["id"])["versions"][0]
    base = f"/api/notes/{note['id']}/history"
    lena = clients["lena"]
    assert lena.get(base).json()["can_restore"] is False
    assert lena.get(f"{base}/{version['id']}").status_code == 200
    assert lena.post(f"{base}/{version['id']}/restore").status_code == 404
    anna = clients["anna"]
    assert anna.get(base).json()["can_restore"] is True
    assert anna.post(f"{base}/{version['id']}/restore").status_code == 200
    with new_client(stranger) as theirs:
        assert theirs.get(base).status_code == 404
        assert theirs.get(f"{base}/{version['id']}").status_code == 404


# --- NOTES-17 -----------------------------------------------------------------------------------------------------------


def _zip(client: TestClient) -> zipfile.ZipFile:
    answer = client.post("/api/export/jobs", json={"folder_id": None})
    assert answer.status_code == 202, answer.text
    export.run_pending()
    download = client.get(f"/api/export/jobs/{answer.json()['id']}/download")
    assert download.status_code == 200, download.text
    return zipfile.ZipFile(io.BytesIO(download.content))


def test_notes17_ac3_ec8_notes13_the_export_puts_shared_notes_under_shared_with_me_per_owner(client, operator, people,
                                                                                            clients):
    family = make_folder(clients["anna"], "Familie")
    new_note(clients["anna"], title="Rezept", markdown="Teig", folder_id=family)
    new_note(clients["anna"], title="Privat", markdown="nicht geteilt")
    share(clients["anna"], "folder", family, operator, "read")
    urlaub = new_note(clients["lena"], title="Urlaub", markdown="Strand")
    share(clients["lena"], "note", urlaub["id"], operator, "write")
    new_note(client, title="Eigene")
    names = _zip(client).namelist()
    notes_in = {name for name in names if name.endswith(".md")}
    assert notes_in == {"Inbox/Eigene.md", "Shared with me/Anna/Rezept.md", "Shared with me/Lena/Urlaub.md"}
    # Reading is enough to export one note (EC-8), not shared is not found.
    assert client.get(f"/api/export/notes/{urlaub['id']}/markdown").status_code == 200
    private = next(item for item in all_notes(clients["anna"])["items"] if item["title"] == "Privat")
    assert client.get(f"/api/export/notes/{private['id']}/pdf").status_code == 404
