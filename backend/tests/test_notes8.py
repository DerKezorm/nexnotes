"""NOTES-8 Nebeneinander und Tabs: what the tabs build on.

The tabs themselves live in the browser (kept per account on the device, AC-5); the server keeps nothing for them. A
tab reads its note's head (``GET /api/notes/{id}``) to show the title and folder, and learns from it that the note
went to the trash (EC-3) or is no longer there for the account at all (EC-6). These tests hold that contract.
"""

from __future__ import annotations

import pytest

from app.notedoc.room import Access
from app.services import notes

from .conftest import make_account, new_client
from .notes_live import Live, refused
from .test_notes3 import new_note, token_for


@pytest.fixture(autouse=True)
def close_connections(client):
    yield
    Live.close_all()


def test_notes8_ec3_a_note_deleted_on_another_device_says_so_in_its_head(client, operator):
    note = new_note(client, title="Lentil soup")
    with new_client(operator) as phone:
        assert phone.delete(f"/api/notes/{note['id']}").status_code == 204
    head = client.get(f"/api/notes/{note['id']}")
    assert head.status_code == 200
    assert head.json()["deleted_at"] is not None
    assert head.json()["title"] == "Lentil soup"
    # The room says it too, to a tab on show: deleted (4404), not "no right".
    assert refused(client, note["id"], token_for(operator)) == 4404
    # Back from the trash: the head says so on the next look.
    assert client.post(f"/api/notes/{note['id']}/restore").status_code == 200
    assert client.get(f"/api/notes/{note['id']}").json()["deleted_at"] is None


def test_notes8_ec6_a_note_no_longer_shared_is_not_there_for_the_tab(client, operator, monkeypatch):
    note = new_note(client, title="Shared shopping")
    anna = make_account("anna")

    def shared_with_anna(db, account, row):
        return Access.READ if account.id == anna.id and row.id == note["id"] else Access.NONE

    rules = [shared_with_anna]
    monkeypatch.setattr(notes, "ACCESS_RULES", rules)
    with new_client(anna) as theirs:
        head = theirs.get(f"/api/notes/{note['id']}")
        assert head.status_code == 200
        assert head.json()["can_write"] is False
        # Sharing ends.
        rules.clear()
        gone = theirs.get(f"/api/notes/{note['id']}")
        assert gone.status_code == 404
        assert gone.json()["detail"]["code"] == "not_found"
        assert refused(theirs, note["id"], token_for(anna)) == 4403


def test_notes8_ec6_a_note_deleted_for_good_is_not_there_for_the_tab(client, operator):
    note = new_note(client)
    assert client.post(f"/api/notes/{note['id']}/discard").status_code == 200
    assert client.get(f"/api/notes/{note['id']}").status_code == 404
