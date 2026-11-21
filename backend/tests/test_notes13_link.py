"""NOTES-13 Teilen: links to read one note without an account (AC-9, AC-10, AC-12, AC-13, EC-5, EC-6, EC-7, EC-11) and
the page's language (NOTES-22 AC-6)."""

from __future__ import annotations

import io
import re
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Note, Setting
from app.models_shares import ReadLink
from app.services import attachments, history, shares, tags

from .conftest import make_account, new_client
from .test_notes3 import new_note


@pytest.fixture(autouse=True)
def fresh_brake_and_clock():
    shares.LINK_BRAKE.forget()
    history.clock.reset()
    yield
    shares.LINK_BRAKE.forget()
    history.clock.reset()


@pytest.fixture
def visitor() -> TestClient:
    """Somebody without an account, in a browser of its own."""
    with TestClient(app, base_url="http://testserver") as client:
        yield client


def day(offset: int) -> str:
    # The day where the member is: Berlin in November, UTC+1 (as ``ends`` says).
    return (datetime.now(UTC) + timedelta(hours=1, days=offset)).date().isoformat()


def ends(until: str, offset: str = "+01:00") -> str:
    """The moment a day ends where the member is, as its browser sends it (Berlin in November: UTC+1)."""
    return f"{(date.fromisoformat(until) + timedelta(days=1)).isoformat()}T00:00:00{offset}"


def make_link(client: TestClient, note_id: str, until: str | None = None, offset: str = "+01:00") -> dict:
    until = until or day(7)
    answer = client.post(f"/api/notes/{note_id}/read-link", json={"expires_on": until, "ends_at": ends(until, offset)})
    assert answer.status_code == 201, answer.text
    return answer.json()


def png(color=(20, 120, 200)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (24, 24), color).save(out, "PNG")
    return out.getvalue()


GONE = "Dieser Link gilt nicht mehr"
DE = {"Accept-Language": "de-DE,de;q=0.9,en;q=0.8"}


def switch_links(on: bool) -> None:
    with SessionLocal() as db:
        db.merge(Setting(key="share_links", value=on))
        db.commit()


# --- AC-9: making, copying, changing, revoking -----------------------------------------------------------------------


def test_notes13_ac9_a_link_runs_to_a_chosen_day_never_without_one_and_can_be_changed_and_revoked(
        client, operator, visitor):
    note = new_note(client, title="Linsensuppe", markdown="250 g rote Linsen")
    link = make_link(client, note["id"])
    assert link["path"].startswith("/l/") and link["expires_on"] == day(7)
    # Shown once: the token itself is nowhere in the database, only its hash.
    token = link["path"][3:]
    with SessionLocal() as db:
        row = db.scalar(select(ReadLink).where(ReadLink.note_id == note["id"]))
        assert row.token_hash == shares.hash_token(token) and token not in repr(row.__dict__)
    assert "rote Linsen" in visitor.get(link["path"]).text
    # The day: at the earliest tomorrow, never without one.
    for wrong in (day(0), day(-3)):
        refused = client.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": wrong})
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == "link_expiry_too_soon"
    assert client.post(f"/api/notes/{note['id']}/read-link", json={}).status_code == 422
    assert client.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": None}).status_code == 422
    # Another day: the address stays.
    changed = client.put(f"/api/read-links/{link['id']}", json={"expires_on": day(1), "ends_at": ends(day(1))})
    assert changed.status_code == 200 and changed.json()["expires_on"] == day(1)
    assert "path" not in changed.json()
    assert visitor.get(link["path"]).status_code == 200
    # A new link replaces the one before.
    renewed = make_link(client, note["id"], day(30))
    assert visitor.get(link["path"]).status_code == 404
    assert visitor.get(renewed["path"]).status_code == 200
    # Revoked: gone at once.
    assert client.delete(f"/api/read-links/{renewed['id']}").status_code == 204
    gone = visitor.get(renewed["path"], headers=DE)
    assert gone.status_code == 404 and GONE in gone.text


def test_notes13_ac9_ec5_the_link_ends_with_its_day_in_the_members_time_zone(client, operator, visitor):
    note = new_note(client, title="Rezept")
    until = day(2)
    link = make_link(client, note["id"], until)
    with SessionLocal() as db:
        row = db.get(ReadLink, link["id"])
        # The end of that day in Berlin: 23:00 UTC.
        assert row.expires_at.hour == 23 and row.expires_at.date() == date.fromisoformat(until)
        end = row.expires_at
    history.clock.set(end - timedelta(minutes=1))
    assert visitor.get(link["path"]).status_code == 200
    history.clock.set(end + timedelta(seconds=1))
    expired = visitor.get(link["path"], headers=DE)
    assert expired.status_code == 404
    assert GONE in expired.text and "Rezept" not in expired.text
    # A moment that is no end of the chosen day anywhere on earth: refused.
    wrong = client.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": until, "ends_at": ends(day(5))})
    assert wrong.status_code == 422
    # Expired links do not count as wrong addresses.
    assert shares.LINK_BRAKE.wait_seconds("link:testclient", free=0) == 0


# --- AC-10: the operator's switch ----------------------------------------------------------------------------------


def test_notes13_ac10_switched_off_there_is_no_switch_and_existing_links_stop(client, operator, visitor):
    note = new_note(client, title="Rezept")
    link = make_link(client, note["id"])
    switch_links(False)
    assert client.get("/api/auth/me").json()["share_links"] is False
    assert client.get(f"/api/shares/note/{note['id']}").json()["links"] is False
    refused = client.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": day(7)})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "share_links_off"
    assert visitor.get(link["path"]).status_code == 404
    switch_links(True)
    assert visitor.get(link["path"]).status_code == 200


# --- AC-12: the page --------------------------------------------------------------------------------------------------


def test_notes13_ac12_the_page_shows_the_note_light_with_owner_day_pdf_and_footer_and_nothing_else(
        client, operator, visitor):
    note = new_note(client, title="Linsensuppe", markdown="## Zutaten für 4\n\n- 250 g rote Linsen\n\n**Limette**")
    other = new_note(client, title="Andere Notiz", markdown="geheim")
    picture = client.post("/api/attachments", params={"note_id": note["id"], "id": attachments.new_id(),
                                                        "name": "suppe.png"}, content=png()).json()
    elsewhere = client.post("/api/attachments", params={"note_id": other["id"], "id": attachments.new_id(),
                                                          "name": "privat.png"}, content=png((0, 0, 0))).json()
    from .test_notes10 import add_blocks

    add_blocks(note["id"], operator.id, {"type": "image", "attrs": {"id": picture["id"], "size": "medium"}})
    link = make_link(client, note["id"], day(7))
    page = visitor.get(link["path"], headers=DE)
    assert page.status_code == 200
    text = page.text
    shown = date.fromisoformat(day(7)).strftime("%d.%m.%Y")
    assert "Geteilt von <strong>Tester</strong> · nur lesen · gültig bis " + shown in text
    assert "Als PDF laden" in text and "Erstellt mit nexnotes" in text
    assert "<h1>Linsensuppe</h1>" in text and "250 g rote Linsen" in text and "<strong>Limette</strong>" in text
    assert "color-scheme:light" in text
    # Nothing of the server but this note: no other note, no ids of notes or accounts, no address, no script.
    assert "Andere Notiz" not in text and other["id"] not in text and note["id"] not in text
    assert "tester@example.com" not in text and "/api/" not in text and "<script" not in text.lower()
    # Its picture through the link; any other attachment not, not even of the same owner.
    assert f"/l/{link['path'][3:]}/a/{picture['id']}/view" in text
    assert visitor.get(f"{link['path']}/a/{picture['id']}/view").status_code == 200
    assert visitor.get(f"{link['path']}/a/{elsewhere['id']}/view").status_code == 404
    assert visitor.get(f"{link['path']}/a/{elsewhere['id']}/file").status_code == 404
    assert visitor.get(f"/api/attachments/{picture['id']}/view").status_code == 401
    # Its own strict policy: no script at all, nothing from elsewhere, no address handed on.
    policy = page.headers["content-security-policy"]
    assert "default-src 'none'" in policy and "script-src" not in policy and "'unsafe-inline'" not in policy
    assert page.headers["referrer-policy"] == "no-referrer" and page.headers["cache-control"] == "no-store"
    # "Als PDF laden".
    pdf = visitor.get(f"{link['path']}/pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")


def test_notes13_ac12_what_the_note_holds_goes_on_the_page_as_text(client, operator, visitor):
    note = new_note(client, title='<img src=x onerror="alert(1)">',
                    markdown='<script>alert(2)</script>\n\n[klick](javascript:alert(3)) [gut](https://example.com)')
    link = make_link(client, note["id"])
    text = visitor.get(link["path"]).text
    assert "<script>alert(2)" not in text and "&lt;script&gt;" in text
    assert "<img src=x" not in text and "javascript:" not in text
    assert 'href="https://example.com" rel="noopener noreferrer nofollow"' in text


# --- AC-13: the list in "Mein Konto" ----------------------------------------------------------------------------------


def test_notes13_ac13_my_account_lists_every_link_with_note_and_day_and_revokes_each(client, operator, visitor):
    first = new_note(client, title="Rezept")
    second = new_note(client, title="Packliste")
    one = make_link(client, first["id"], day(3))
    two = make_link(client, second["id"], day(10))
    listed = client.get("/api/read-links").json()
    assert [(item["title"], item["expires_on"], item["expired"]) for item in listed] == [
        ("Rezept", day(3), False), ("Packliste", day(10), False)]
    assert all("path" not in item for item in listed)
    assert client.delete(f"/api/read-links/{one['id']}").status_code == 204
    assert [item["title"] for item in client.get("/api/read-links").json()] == ["Packliste"]
    assert visitor.get(one["path"]).status_code == 404 and visitor.get(two["path"]).status_code == 200
    # Another account's links are none of this one's.
    other = make_account("other")
    with new_client(other) as theirs:
        assert theirs.get("/api/read-links").json() == []
        assert theirs.delete(f"/api/read-links/{two['id']}").status_code == 404
        assert theirs.put(f"/api/read-links/{two['id']}", json={"expires_on": day(2)}).status_code == 404


# --- EC-5, EC-6 -----------------------------------------------------------------------------------------------------


def test_notes13_ec5_ec6_a_link_that_ended_or_whose_note_went_or_was_locked_shows_nothing_of_it(
        client, operator, visitor, monkeypatch):
    note = new_note(client, title="Geheimrezept", markdown="Prise Zimt")
    link = make_link(client, note["id"])
    locked: list[str] = []
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.id.in_(locked)])
    locked.append(note["id"])
    for path in (link["path"], link["path"] + "/pdf"):
        answer = visitor.get(path, headers=DE)
        assert answer.status_code == 404 and "Geheimrezept" not in answer.text and "Zimt" not in answer.text
    locked.clear()
    assert visitor.get(link["path"]).status_code == 200
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    gone = visitor.get(link["path"], headers=DE)
    assert gone.status_code == 404 and GONE in gone.text and "Geheimrezept" not in gone.text
    # Back from the trash, the link works again until its day.
    assert client.post(f"/api/notes/{note['id']}/restore").status_code == 200
    assert visitor.get(link["path"]).status_code == 200
    # A locked note gets no link either.
    locked.append(note["id"])
    refused = client.post(f"/api/notes/{note['id']}/read-link", json={"expires_on": day(7)})
    assert refused.status_code == 409


def test_notes13_ec5_an_unknown_link_looks_the_same_as_one_that_ended(client, operator, visitor):
    note = new_note(client, title="Rezept")
    link = make_link(client, note["id"])
    client.delete(f"/api/read-links/{link['id']}")
    revoked = visitor.get(link["path"], headers=DE)
    unknown = visitor.get("/l/" + "A" * 43, headers=DE)
    assert revoked.status_code == unknown.status_code == 404
    strip = re.compile(r"nonce-[^']+|nonce=\"[^\"]+\"")
    assert strip.sub("", revoked.text) == strip.sub("", unknown.text)


# --- EC-7: guessing ---------------------------------------------------------------------------------------------------


def test_notes13_ec7_a_thousand_wrong_addresses_are_slowed_down_and_links_are_not_to_guess(client, operator, visitor):
    note = new_note(client, title="Rezept")
    link = make_link(client, note["id"])
    token = link["path"][3:]
    # 32 random bytes: 43 characters of base64url.
    assert len(token) >= 43 and re.fullmatch(r"[A-Za-z0-9_-]+", token)
    assert make_link(client, new_note(client, title="Zwei")["id"])["path"][3:] != token
    statuses = [visitor.get(f"/l/{shares.secrets.token_urlsafe(32)}").status_code for _ in range(1000)]
    assert statuses[: shares.LINK_FREE_MISSES] == [404] * shares.LINK_FREE_MISSES
    assert statuses.count(429) >= 1000 - shares.LINK_FREE_MISSES - 1
    slowed = visitor.get(f"/l/{shares.secrets.token_urlsafe(32)}", headers=DE)
    assert slowed.status_code == 429 and "Zu viele Versuche" in slowed.text and "Rezept" not in slowed.text
    assert int(slowed.headers["retry-after"]) >= 1
    # A link that exists is never slowed: the misses of a stranger behind the same address stop nobody's links.
    assert visitor.get(link["path"]).status_code == 200
    # Malformed addresses count as well, without asking the database.
    shares.LINK_BRAKE.forget()
    assert visitor.get("/l/kurz").status_code == 404
    assert shares.LINK_BRAKE.wait_seconds("link:testclient", free=0) > 0


# --- EC-11: previews in messengers ------------------------------------------------------------------------------------


@pytest.mark.parametrize("agent", [
    "WhatsApp/2.23.20.0", "TelegramBot (like TwitterBot)", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "facebookexternalhit/1.1", "Signal/7.0",
])
def test_notes13_ec11_a_messenger_preview_gets_nexnotes_and_the_title_only(client, operator, visitor, agent):
    note = new_note(client, title="Linsensuppe", markdown="250 g rote Linsen, Kokosmilch")
    link = make_link(client, note["id"])
    answer = visitor.get(link["path"], headers={"User-Agent": agent})
    assert answer.status_code == 200
    assert 'property="og:title" content="Linsensuppe"' in answer.text
    assert 'property="og:site_name" content="nexnotes"' in answer.text
    assert "Linsen," not in answer.text and "Kokosmilch" not in answer.text and "/pdf" not in answer.text
    # A browser gets the note.
    browser = visitor.get(link["path"], headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                                               "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"})
    assert "Kokosmilch" in browser.text


# --- NOTES-22 AC-6: the page in the visitor's language ----------------------------------------------------------------


def test_notes22_ac6_notes13_the_link_page_speaks_the_browsers_language_german_english_else_english(
        client, operator, visitor):
    note = new_note(client, title="Rezept", markdown="Text")
    link = make_link(client, note["id"], day(7))
    when = date.fromisoformat(day(7))
    german = visitor.get(link["path"], headers={"Accept-Language": "de-AT,de;q=0.9"}).text
    assert '<html lang="de">' in german and "Als PDF laden" in german and when.strftime("%d.%m.%Y") in german
    english = visitor.get(link["path"], headers={"Accept-Language": "en-GB"}).text
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    assert '<html lang="en">' in english and "Download as PDF" in english and "Made with nexnotes" in english
    assert f"{months[when.month - 1]} {when.day}, {when.year}" in english
    french = visitor.get(link["path"], headers={"Accept-Language": "fr-FR,fr;q=0.9"}).text
    assert '<html lang="en">' in french and "Shared by" in french
    # A language the operator added with the page's texts.
    from app.services import locales

    folder = locales.locales_dir()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "fr.json").write_text('{"readLink": {"page": {"pdf": "Télécharger en PDF"}}}', encoding="utf-8")
    locales.forget()
    try:
        added = visitor.get(link["path"], headers={"Accept-Language": "fr-FR,fr;q=0.9"}).text
        assert '<html lang="fr' in added and "Télécharger en PDF" in added and "Shared by" in added
    finally:
        (folder / "fr.json").unlink()
        locales.forget()
    # The gone page as well.
    assert "This link no longer works" in visitor.get("/l/" + "B" * 43, headers={"Accept-Language": "fr"}).text


def test_notes13_expired_links_leave_my_account_after_thirty_days(client, operator):
    note = new_note(client, title="Rezept")
    link = make_link(client, note["id"], day(1))
    history.clock.set(datetime.now(UTC) + timedelta(days=3))
    assert client.get("/api/read-links").json()[0]["expired"] is True
    shares._drop_old_links()
    assert len(client.get("/api/read-links").json()) == 1
    history.clock.set(datetime.now(UTC) + timedelta(days=40))
    shares._drop_old_links()
    assert client.get("/api/read-links").json() == []
    assert link
