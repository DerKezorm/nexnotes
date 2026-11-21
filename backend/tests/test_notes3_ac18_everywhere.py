"""NOTES-3 AC-18 in the second review: wherever a note stands with its title, its symbol and colour come along, the same
as in ``GET /api/notes``: the inbox, the page of a tag, the trash and the head of the history."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models import Account


def _note(client: TestClient, title: str, markdown: str) -> dict:
    answer = client.post("/api/notes", json={"title": title, "markdown": markdown})
    assert answer.status_code == 201, answer.text
    return answer.json()


def _listed(client: TestClient, note_id: str) -> dict:
    return next(item for item in client.get("/api/notes").json() if item["id"] == note_id)


def test_notes3_ac18_the_inbox_gives_symbol_colour_and_paper_as_the_lists_do(client: TestClient, operator: Account):
    plain = _note(client, "Plain", "no symbol")
    marked = _note(client, "Packing list", "socks")
    assert client.put(f"/api/notes/{marked['id']}/icon", json={"icon": "plane"}).status_code == 200
    assert client.put(f"/api/notes/{marked['id']}/color", json={"color": "teal"}).status_code in (200, 204)
    assert client.put(f"/api/notes/{marked['id']}/paper", json={"paper": "grid"}).status_code == 200
    inbox = {item["id"]: item for item in client.get("/api/folders/inbox").json()["notes"]}
    for note in (plain, marked):
        listed = _listed(client, note["id"])
        for field in ("icon", "color"):
            assert inbox[note["id"]][field] == listed[field]
        assert inbox[note["id"]]["paper"] == client.get(f"/api/notes/{note['id']}").json()["paper"]
    assert inbox[marked["id"]]["icon"] == "plane" and inbox[marked["id"]]["color"] == "teal"
    assert inbox[plain["id"]]["icon"] == "" and inbox[plain["id"]]["color"] == ""


def test_notes3_ac18_tag_page_trash_and_history_name_the_symbol_too(client: TestClient, operator: Account):
    note = _note(client, "Trip", "pack for #holiday")
    client.put(f"/api/notes/{note['id']}/icon", json={"icon": "plane"})
    client.put(f"/api/notes/{note['id']}/color", json={"color": "teal"})
    listed = _listed(client, note["id"])
    tagged = next(item for item in client.get("/api/tags/holiday").json()["notes"] if item["id"] == note["id"])
    assert (tagged["icon"], tagged["color"]) == (listed["icon"], listed["color"]) == ("plane", "teal")
    history = client.get(f"/api/notes/{note['id']}/history").json()
    assert (history["icon"], history["color"]) == ("plane", "teal")
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    trashed = next(item for item in client.get("/api/trash").json()["items"] if item["id"] == note["id"])
    assert (trashed["icon"], trashed["color"]) == ("plane", "teal")
