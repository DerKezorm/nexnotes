"""NOTES-9 Suche: the server's part (index, query, filters, excerpts, rights, speed)."""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select, text

from app.db import SessionLocal
from app.models import FOLDER_NORMAL, Account, Folder, Note
from app.notedoc import edit
from app.services import notes, search, tags
from app.services.inbox import inbox_for
from app.services.notes import SqlNoteStore

from .conftest import make_account, new_client
from .notes_live import Live


@pytest.fixture(autouse=True)
def empty_index() -> None:
    """Every test starts with an empty index (the frame's cleanup knows only the tables of ``models.py``)."""
    search.ensure_schema()
    with SessionLocal() as db:
        db.execute(search._sql("DELETE FROM @index"))
        db.execute(search._sql("DELETE FROM @rows"))
        db.commit()


@pytest.fixture(autouse=True)
def close_connections(client):
    """Connections left open by a failing test are closed before the test client goes."""
    yield
    Live.close_all()


def new_note(client, title: str = "", body: str = "", folder_id: str | None = None) -> str:
    """A note through the API; its text set the way the live room sets it (``SqlNoteStore.summary``)."""
    answer = client.post("/api/notes", json={"title": title, **({"folder_id": folder_id} if folder_id else {})})
    assert answer.status_code == 201, answer.text
    note_id = answer.json()["id"]
    if body:
        put_text(note_id, title, body)
    return note_id


def tagged_note(client, title: str, markdown: str, folder_id: str | None = None) -> str:
    """A note whose text is in its document: tags are read from there (``note_tags``, NOTES-5)."""
    answer = client.post("/api/notes", json={"title": title, "markdown": markdown,
                                             **({"folder_id": folder_id} if folder_id else {})})
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def put_text(note_id: str, title: str, body: str) -> None:
    SqlNoteStore()._summary(note_id, title, body)


def find(client, q: str = "", **params) -> dict:
    answer = client.get("/api/search", params={"q": q, **params})
    assert answer.status_code == 200, answer.text
    return answer.json()


def titles(result: dict) -> list[str]:
    return [item["title"] for item in result["items"]]


def marked(parts: list[dict]) -> list[str]:
    return [part["text"] for part in parts if part["hit"]]


def folder(owner: Account, name: str, parent: str | None = None) -> str:
    with SessionLocal() as db:
        row = Folder(owner_id=owner.id, name=name, kind=FOLDER_NORMAL, parent_id=parent)
        db.add(row)
        db.commit()
        return row.id


def set_dates(note_id: str, when: datetime) -> None:
    with SessionLocal() as db:
        note = db.get(Note, note_id)
        assert note is not None
        note.updated_at = when
        note.created_at = when
        db.commit()


# --- AC-1 ---------------------------------------------------------------------------------------------------------


def test_notes9_ac1_hits_while_typing_with_marks_in_title_and_excerpt_and_a_count(client, operator):
    # The title hit is the older note: it still comes first.
    new_note(client, "Rechnungen Handwerker", "Fliesen und Sanitär, Zahlungsziel 14 Tage")
    new_note(client, "Nebenkosten 2026", "Abrechnung prüfen. Die Stromrechnung kam am 12. Nov., Nachzahlung prüfen.")
    new_note(client, "Einkauf", "Milch und Brot")
    # Every keystroke is a search of its own: from the first letters on, the list is there.
    for typed, count in [("r", 3), ("re", 2), ("rec", 2), ("rech", 2), ("rechn", 2), ("rechnu", 2)]:
        assert find(client, typed)["total"] == count, typed
    result = find(client, "rechn")
    assert result["total"] == 2 and len(result["items"]) == 2
    by_title = {item["title"]: item for item in result["items"]}
    handwerker = by_title["Rechnungen Handwerker"]
    assert marked(handwerker["title_parts"]) == ["Rechn"]
    assert "".join(part["text"] for part in handwerker["title_parts"]) == "Rechnungen Handwerker"
    assert handwerker["where"] == "title"
    nebenkosten = by_title["Nebenkosten 2026"]
    assert marked(nebenkosten["excerpt"]) == ["rechn", "rechn"]
    assert nebenkosten["where"] == "text"
    assert "Stromrechnung" in "".join(part["text"] for part in nebenkosten["excerpt"])
    # A hit in the title ranks before a hit in the text.
    assert titles(result)[0] == "Rechnungen Handwerker"


def test_notes9_ac1_excerpt_shows_the_place_of_the_hit_in_a_long_text(client, operator):
    filler = " ".join(f"Wort{number}" for number in range(400))
    new_note(client, "Langer Text", f"{filler} hier steht der Zaunkönig {filler}")
    item = find(client, "zaunkönig")["items"][0]
    shown = "".join(part["text"] for part in item["excerpt"])
    assert marked(item["excerpt"]) == ["Zaunkönig"]
    assert shown.startswith("… ") and shown.endswith(" …")
    assert len(shown) < 320
    # The editor jumps to it: the hit as written and the how-manieth of its kind (AC-5).
    assert item["jump"] == {"text": "Zaunkönig", "nth": 0}


# --- AC-2 ---------------------------------------------------------------------------------------------------------


def test_notes9_ac2_part_of_a_word_finds_word_starts_and_word_middles(client, operator):
    new_note(client, "Post", "Die Rechnung liegt im Flur")
    new_note(client, "Strom", "Stromrechnung bezahlt")
    new_note(client, "Andere", "Rechen im Garten")
    assert sorted(titles(find(client, "rechn"))) == ["Post", "Strom"]


# --- AC-4 ---------------------------------------------------------------------------------------------------------


def test_notes9_ac4_folder_filter_takes_its_subfolders(client, operator):
    home = folder(operator, "Haushalt")
    deep = folder(operator, "Strom", home)
    deeper = folder(operator, "2026", deep)
    work = folder(operator, "Arbeit")
    new_note(client, "Oben", "Rechnung A", home)
    new_note(client, "Tief", "Rechnung B", deeper)
    new_note(client, "Arbeit", "Rechnung C", work)
    new_note(client, "Eingang", "Rechnung D")
    assert sorted(titles(find(client, "rechnung", folder_id=home))) == ["Oben", "Tief"]
    assert titles(find(client, "rechnung", folder_id=deep)) == ["Tief"]
    assert titles(find(client, "rechnung", folder_id=work)) == ["Arbeit"]
    assert find(client, "rechnung")["total"] == 4


def test_notes9_ac4_folder_filter_only_on_own_living_folders(client, operator):
    other = make_account("other")
    with new_client(other) as theirs:
        foreign = theirs.post("/api/folders", json={"name": "Fremd"}).json()["id"]
    assert client.get("/api/search", params={"q": "x", "folder_id": foreign}).status_code == 404
    gone = folder(operator, "Weg")
    client.delete(f"/api/folders/{gone}")
    assert client.get("/api/search", params={"q": "x", "folder_id": gone}).status_code == 404
    assert client.get("/api/search", params={"q": "x", "folder_id": "nonsense!"}).status_code == 422


def test_notes9_ac4_tag_filter_is_exact_and_ignores_case(client, operator):
    tagged_note(client, "Urlaub", "Packliste #Urlaub und #reise")
    tagged_note(client, "Urlaubsplanung", "nur #urlaubsplanung")
    tagged_note(client, "Im Code", "Beispiel `#urlaub` im Code")
    new_note(client, "Ohne", "Urlaub ohne Schlagwort")
    assert titles(find(client, "", tag="urlaub")) == ["Urlaub"]
    assert titles(find(client, "packliste", tag="#URLAUB")) == ["Urlaub"]
    assert find(client, "ohne", tag="urlaub")["total"] == 0
    # Code holds no tags (NOTES-5 EC-1): the note is no hit for the tag, but its text is still found.
    assert titles(find(client, "beispiel", tag="urlaub")) == []
    assert titles(find(client, "beispiel")) == ["Im Code"]


def test_notes9_ac4_time_range_by_change_or_creation(client, operator):
    now = datetime.now(UTC)
    old = new_note(client, "Alt", "Rechnung von früher")
    fresh = new_note(client, "Neu", "Rechnung von heute")
    set_dates(old, now - timedelta(days=400))
    set_dates(fresh, now - timedelta(days=2))
    year_ago = (now - timedelta(days=365)).isoformat()
    assert titles(find(client, "rechnung", since=year_ago)) == ["Neu"]
    assert titles(find(client, "rechnung", until=year_ago)) == ["Alt"]
    week = (now - timedelta(days=7)).isoformat()
    assert titles(find(client, "rechnung", since=week, date_field="created")) == ["Neu"]
    assert client.get("/api/search", params={"q": "x", "since": "gestern"}).status_code == 422
    assert client.get("/api/search", params={"q": "x", "date_field": "deleted"}).status_code == 422


def test_notes9_ac4_filters_combine(client, operator):
    home = folder(operator, "Haushalt")
    hit = tagged_note(client, "Treffer", "Rechnung #bad", home)
    tagged_note(client, "Falscher Ordner", "Rechnung #bad")
    tagged_note(client, "Falsches Schlagwort", "Rechnung #garten", home)
    old = tagged_note(client, "Zu alt", "Rechnung #bad", home)
    set_dates(old, datetime.now(UTC) - timedelta(days=60))
    since = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    result = find(client, "rechnung", folder_id=home, tag="bad", since=since)
    assert [item["id"] for item in result["items"]] == [hit]


# --- AC-7 ---------------------------------------------------------------------------------------------------------


def test_notes9_ac7_all_words_in_any_order(client, operator):
    new_note(client, "Beide", "Der Hund bellt laut am Zaun")
    new_note(client, "Umgekehrt", "laut war es, der Hund")
    new_note(client, "Nur einer", "Der Hund schläft")
    assert sorted(titles(find(client, "laut hund"))) == ["Beide", "Umgekehrt"]
    assert sorted(titles(find(client, "hund laut"))) == ["Beide", "Umgekehrt"]


def test_notes9_ac7_quotes_ask_for_the_exact_sequence(client, operator):
    new_note(client, "Folge", "Der Hund bellt laut am Zaun")
    new_note(client, "Andere Folge", "Laut bellt der Hund")
    assert titles(find(client, '"hund bellt"')) == ["Folge"]
    assert sorted(titles(find(client, "hund bellt"))) == ["Andere Folge", "Folge"]
    # German quotes too, and the phrase is marked as a whole.
    result = find(client, "„bellt laut“")
    assert titles(result) == ["Folge"]
    assert marked(result["items"][0]["excerpt"]) == ["bellt laut"]


def test_notes9_ac7_phrase_spans_line_breaks_and_mixed_blanks(client, operator):
    new_note(client, "Zeilen", "Termin am\nMontag  früh")
    assert titles(find(client, '"am montag früh"')) == ["Zeilen"]


# --- EC-1 ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("query", "expected"), [
    ("strasse", ["Mit ss", "Mit ß"]),
    ("Straße", ["Mit ss", "Mit ß"]),
    ("STRASSE", ["Mit ss", "Mit ß"]),
    ("mueller", ["Mit ue", "Mit ü"]),
    ("Müller", ["Mit ue", "Mit ü"]),
    ("MÜLLER", ["Mit ue", "Mit ü"]),
    ("café", ["Akzent"]),
    ("cafe", ["Akzent"]),
])
def test_notes9_ec1_umlauts_sharp_s_and_case_meet(client, operator, query, expected):
    new_note(client, "Mit ß", "Hauptstraße 5")
    new_note(client, "Mit ss", "Hauptstrasse 7")
    new_note(client, "Mit ü", "Frau Müller anrufen")
    new_note(client, "Mit ue", "Herr Mueller kommt")
    new_note(client, "Akzent", "Treffen im Café")
    assert sorted(titles(find(client, query))) == expected


def test_notes9_ec1_marks_land_on_the_original_letters(client, operator):
    new_note(client, "Adresse", "Wir wohnen in der Großen Straße bei Müllers")
    item = find(client, "strasse muell")["items"][0]
    assert marked(item["excerpt"]) == ["Straße", "Müll"]


def test_notes9_ec1_text_in_decomposed_form_is_found(client, operator):
    new_note(client, "Zerlegt", "Mu\u0308ller und Gro\u00dfe")
    assert titles(find(client, "müller")) == ["Zerlegt"]
    assert titles(find(client, "mueller")) == ["Zerlegt"]


# --- EC-2 ---------------------------------------------------------------------------------------------------------


def test_notes9_ec2_no_hits_names_the_count_without_filters(client, operator):
    work = folder(operator, "Arbeit")
    for number in range(3):
        new_note(client, f"Beet {number}", "Hochbeet bauen")
    result = find(client, "hochbeet", folder_id=work, tag="urlaub")
    assert result["total"] == 0 and result["items"] == []
    assert result["unfiltered"] == 3
    # Without filters there is nothing to loosen.
    assert find(client, "zebra")["unfiltered"] is None
    assert find(client, "hochbeet")["unfiltered"] is None


# --- EC-4 ---------------------------------------------------------------------------------------------------------


def test_notes9_ec4_ten_thousand_notes_two_thousand_hits_under_half_a_second(client, operator):
    with SessionLocal() as db:
        inbox = inbox_for(db, operator.id).id
        db.commit()
    now = datetime.now(UTC)
    rows = []
    for number in range(10_000):
        hit = number % 5 == 0
        rows.append({
            "id": str(uuid.uuid4()), "owner_id": operator.id, "folder_id": inbox,
            "title": f"Notiz {number}" + (" Rechnung" if hit else ""),
            "text": (f"Eintrag {number} über die Stromrechnung, Zählerstand {number * 7}. " if hit
                     else f"Eintrag {number} über den Garten, Beet {number % 37} gießen. ") * 6,
            "ydoc": b"", "created_at": now - timedelta(minutes=number), "updated_at": now - timedelta(minutes=number),
        })
    with SessionLocal() as db:
        db.execute(insert(Note), rows)
        db.commit()
    assert search.fill() == 10_000
    find(client, "warm up")
    started = time.perf_counter()
    result = find(client, "rechn")
    took = time.perf_counter() - started
    assert result["total"] == 2000 and len(result["items"]) == search.PAGE
    assert took < 0.5, took
    # The list loads on: page after page, every hit once, each page as quick.
    seen = {item["id"] for item in result["items"]}
    offset = search.PAGE
    slowest = 0.0
    while offset < result["total"]:
        started = time.perf_counter()
        page = find(client, "rechn", offset=offset, limit=search.PAGE_MAX)
        slowest = max(slowest, time.perf_counter() - started)
        seen.update(item["id"] for item in page["items"])
        offset += len(page["items"])
        assert page["items"]
    assert len(seen) == 2000
    assert slowest < 0.5, slowest
    print(f"EC-4: first page {took:.3f} s, slowest further page {slowest:.3f} s")
    # Short words go another way (too short for trigrams) and stay quick as well.
    started = time.perf_counter()
    assert find(client, "zä")["total"] == 2000
    assert time.perf_counter() - started < 0.5


def test_notes9_ec4_page_size_has_a_limit(client, operator):
    assert client.get("/api/search", params={"q": "x", "limit": search.PAGE_MAX + 1}).status_code == 422
    assert client.get("/api/search", params={"q": "x", "offset": -1}).status_code == 422


# --- EC-5 ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("query", [
    '"', '""', '"""', '"unclosed', "*", "**", "a*", "NEAR(a b)", "NEAR", "a NEAR b", "OR", "AND", "NOT", "a OR b",
    "-a", "^a", "title:a", "{title}:a", "(a", "a)", "()", "'", "\\", "%", "_", "<", "<script>", "&", ";", "--",
    "' OR 1=1 --", "#", "##", "# ", "#1", "\x00", "\u202e", "😀", "a" * 500, "\"a\" \"b", "„", "“”",
])
def test_notes9_ec5_odd_input_never_breaks(client, operator, query):
    new_note(client, "Sonderzeichen", 'a < b, 5 * 3, "zitiert", Pfad C:\\temp, 100 % #tag')
    answer = client.get("/api/search", params={"q": query})
    assert answer.status_code == 200, (query, answer.text)
    for params in ({"tag": query[:101]}, {"q": query, "tag": "tag"}):
        assert client.get("/api/search", params=params).status_code == 200


def test_notes9_ec5_special_characters_are_found_as_text(client, operator):
    new_note(client, "Vergleich", "Wenn a < b gilt, dann <b>fett</b> nicht")
    new_note(client, "Rechnen", "5 * 3 = 15")
    new_note(client, "Zitat", 'Er sagte "hallo welt" laut')
    item = find(client, "<b>")["items"][0]
    assert item["title"] == "Vergleich"
    # Plain text pieces, never markup: the page shows them as text.
    assert marked(item["excerpt"]) == ["<b>"]
    assert titles(find(client, "*")) == ["Rechnen"]
    assert titles(find(client, '"hallo welt"')) == ["Zitat"]


def test_notes9_ec5_hash_word_finds_the_tag(client, operator):
    tagged_note(client, "Bad", "Fliesen aussuchen #bad")
    tagged_note(client, "Wort", "Das Bad ist klein")
    tagged_note(client, "Adresse", "siehe example.com/seite#bad")
    tagged_note(client, "Nummer", "Punkt #1 erledigen")
    tagged_note(client, "Code", "Im Code `#bad` steht kein Schlagwort")
    assert titles(find(client, "#bad")) == ["Bad"]
    assert marked(find(client, "#bad")["items"][0]["excerpt"]) == ["#bad"]
    # While typing: the start of a tag finds it already.
    assert titles(find(client, "#ba")) == ["Bad"]
    assert titles(find(client, "#BAD fliesen")) == ["Bad"]
    # "#1" is no tag (a number): found as text only.
    assert titles(find(client, "#1")) == ["Nummer"]


def test_notes9_ec5_too_long_a_query_is_refused_not_cut(client, operator):
    answer = client.get("/api/search", params={"q": "a" * (search.QUERY_MAX + 1)})
    assert answer.status_code == 422


# --- EC-6 ---------------------------------------------------------------------------------------------------------


def test_notes9_ec6_a_change_from_a_second_session_is_found_within_seconds(client, operator):
    from .test_notes3 import token_for, wait_for

    # Made with its text in the document itself: the live room starts from there.
    note_id = client.post("/api/notes", json={"title": "Einkauf", "markdown": "Milch"}).json()["id"]
    with new_client(operator) as second:
        assert find(second, "brot")["total"] == 0
        live = Live(client, note_id, token_for(operator))
        assert live.pump(lambda: live.synced)
        edit.append_paragraph(live.doc, "Brot vom Bäcker")
        started = time.monotonic()
        assert wait_for(lambda: find(second, "bäcker")["total"] == 1, timeout=5.0)
        assert time.monotonic() - started < 5.0
        assert titles(find(second, "milch brot")) == ["Einkauf"]
        live.close()


def test_notes9_ec6_title_changes_and_trash_follow(client, operator):
    note_id = new_note(client, "Alter Titel", "Inhalt")
    client.put(f"/api/notes/{note_id}/title", json={"title": "Neuer Titel"})
    assert titles(find(client, "neuer")) == ["Neuer Titel"]
    assert find(client, "alter")["total"] == 0
    client.delete(f"/api/notes/{note_id}")
    assert find(client, "neuer")["total"] == 0
    client.post(f"/api/notes/{note_id}/restore")
    assert titles(find(client, "neuer")) == ["Neuer Titel"]


def test_notes9_ec6_copies_and_new_notes_with_text_are_found(client, operator):
    made = client.post("/api/notes", json={"markdown": "Zettel mit Kürbissuppe"}).json()
    assert titles(find(client, "kürbis")) == [made["title"]]
    copy = client.post(f"/api/notes/{made['id']}/duplicate").json()
    assert sorted(item["id"] for item in find(client, "kürbis")["items"]) == sorted([made["id"], copy["id"]])


# --- EC-7 ---------------------------------------------------------------------------------------------------------


def test_notes9_ec7_only_own_notes_and_a_taken_right_counts_at_once(client, operator, monkeypatch):
    other = make_account("other")
    with new_client(other) as theirs:
        theirs_id = new_note(theirs, "Geheimplan", "Überraschungsparty")
        assert titles(find(theirs, "überraschung")) == ["Geheimplan"]
    new_note(client, "Meins", "Party planen")
    # Not shared: nothing of the other account is found.
    assert titles(find(client, "party")) == ["Meins"]
    # Shared (the way NOTES-13 docks on): found as long as the right lasts.
    shared: set[str] = {theirs_id}
    monkeypatch.setattr(tags, "SHARED_NOTES", [lambda account_id: select(Note.id).where(
        Note.id.in_(list(shared) if account_id == operator.id else []))])
    assert sorted(titles(find(client, "party"))) == ["Geheimplan", "Meins"]
    shared.clear()
    assert titles(find(client, "party")) == ["Meins"]


# --- Index upkeep -------------------------------------------------------------------------------------------------


def test_notes9_index_fills_what_is_missing_at_the_start_and_forgets_removed_notes(client, operator):
    keep = new_note(client, "Bleibt", "Kartoffel")
    gone = new_note(client, "Geht", "Kartoffel")
    with SessionLocal() as db:
        db.execute(search._sql("DELETE FROM @index"))
        db.execute(search._sql("DELETE FROM @rows"))
        db.commit()
    assert find(client, "kartoffel")["total"] == 0
    assert search.fill() == 2
    assert find(client, "kartoffel")["total"] == 2
    with SessionLocal() as db:
        db.delete(db.get(Note, gone))
        db.commit()
    search._cleanup()
    with SessionLocal() as db:
        left = list(db.execute(search._sql("SELECT note_id FROM @rows")).scalars())
    assert left == [keep]


def test_notes9_a_failing_index_never_keeps_a_note_from_being_saved(client, operator, monkeypatch):
    def broken(_db, _note):
        raise RuntimeError("index broken")

    monkeypatch.setattr(search, "_write", broken)
    answer = client.post("/api/notes", json={"title": "Trotzdem", "markdown": "da"})
    assert answer.status_code == 201
    put_text(answer.json()["id"], "Trotzdem", "weiter da")
    with SessionLocal() as db:
        assert db.get(Note, answer.json()["id"]).text == "weiter da"


def test_notes9_hook_registers_once(client, operator):
    search.register_hooks()
    search.register_hooks()
    assert notes.TEXT_WRITTEN.count(search.index_note) == 1


def test_notes9_older_index_versions_are_dropped(client, operator):
    with SessionLocal() as db:
        db.execute(text("CREATE TABLE IF NOT EXISTS search_rows_v0 (id INTEGER PRIMARY KEY)"))
        db.commit()
    search.ensure_schema()
    with SessionLocal() as db:
        names = set(db.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'")).scalars())
    assert "search_rows_v0" not in names and search.ROWS in names and search.INDEX in names


def test_notes9_locked_content_is_not_searched_but_its_title_is(client, operator, monkeypatch):
    locked = tagged_note(client, "Tresor PIN", "Geheimzahl 4711 #privat")
    tagged_note(client, "Offen", "Notiz #privat")
    assert find(client, "4711")["total"] == 1
    # Locking (NOTES-16) puts the note among the hidden ones and indexes it again.
    monkeypatch.setattr(tags, "HIDDEN_NOTES", [lambda: Note.title.startswith("Tresor")])
    search.reindex(locked)
    assert titles(find(client, "tresor")) == ["Tresor PIN"]
    assert find(client, "4711")["total"] == 0
    assert titles(find(client, "#privat")) == ["Offen"]
    item = find(client, "tresor")["items"][0]
    assert item["excerpt"] == []


# --- Text beyond the body (the interface for NOTES-10/11; AC-3, AC-5 and EC-3 wait for them) ----------------------


def test_notes9_text_source_hit_names_attachment_and_page(client, operator, monkeypatch):
    recognised: dict[str, list[search.TextPart]] = {}
    monkeypatch.setattr(search, "TEXT_SOURCES", [lambda _db, note: recognised.get(note.id, [])])
    note_id = new_note(client, "Scan Wasserzähler", "Foto vom Zähler")
    # Recognition still running: nothing yet.
    assert find(client, "jahresrechnung")["total"] == 0
    recognised[note_id] = [
        search.TextPart("Deckblatt", kind="pdf", name="Wasser.pdf", page=1, ref="a1"),
        search.TextPart("Jahresrechnung Wasser 2026", kind="pdf", name="Wasser.pdf", page=2, ref="a1"),
    ]
    search.reindex(note_id)
    item = find(client, "jahresrechnung")["items"][0]
    assert item["where"] == "attachment"
    assert item["attachment"] == {"kind": "pdf", "name": "Wasser.pdf", "page": 2, "ref": "a1"}
    assert marked(item["excerpt"]) == ["Jahresrechnung"]
    # The body wins over the attachment when both have it.
    assert find(client, "zähler")["items"][0]["where"] == "text"


# --- Folding and parsing ------------------------------------------------------------------------------------------


def test_notes9_fold_and_its_map_agree():
    for sample in ["Straße", "MÜLLER", "Mu\u0308ller", "a\t\n b", "Café ﬁne", "İstanbul", "Ærø", "plain ascii  text"]:
        folded, starts = search.fold_with_map(sample)
        assert folded == search.fold(sample)
        assert len(starts) == len(folded)
        assert all(0 <= at < len(sample) for at in starts)
    assert search.fold("Größe Ärger") == "groesse aerger"


def test_notes9_parse_cuts_words_phrases_and_tags():
    query = search.parse('Rechnung "Strom und Gas" #Haus, #1 #Bäder rechnung')
    assert query.terms == ["rechnung", "strom und gas", "#1"]
    assert query.tags == ["haus", "bäder"]
    assert search.parse("   ").empty


def test_notes9_ec5_match_strings_are_always_closed(client, operator):
    # The query never hands a quote or a NUL to MATCH (the parser keeps them out); the quoting holds anyway.
    assert search._quoted('a"b\x00c') == '"a""bc"'
    with SessionLocal() as db:
        account = db.get(Account, operator.id)
        match, extra = search._conditions(account, search.Query(terms=['x"y\x00z', 'NEAR("a"']), None)
        assert db.scalar(search._base(account, match, extra, search.func.count())) == 0
