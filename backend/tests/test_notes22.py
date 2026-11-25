"""NOTES-22 Languages, the server's part: the account's language on every device, the operator's own language files,
and English in the log and the API. The interface's part (browser language, formats, both files complete, light and
dark) is tested in the frontend (``src/notes22.test.tsx``).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.models import Account
from app.services import locales

from .conftest import PASSWORD, make_account, new_client


@pytest.fixture
def folder() -> Path:
    path = get_settings().locales_dir
    assert path is not None
    path.mkdir(parents=True, exist_ok=True)
    for old in path.iterdir():
        old.unlink()
    locales.forget()
    yield path
    for old in path.iterdir():
        old.unlink()


def test_notes22_ac2_the_chosen_language_counts_at_once_on_every_device_of_the_account(
    client: TestClient, operator: Account
) -> None:
    anna = make_account("anna")
    laptop, phone = new_client(anna), new_client(anna)
    assert laptop.get("/api/auth/me").json()["language"] == ""
    assert phone.put("/api/me/language", json={"language": "de"}).json()["language"] == "de"
    assert laptop.get("/api/auth/me").json()["language"] == "de"
    assert laptop.put("/api/me/language", json={"language": ""}).json()["language"] == ""
    assert phone.get("/api/auth/me").json()["language"] == ""
    refused = phone.put("/api/me/language", json={"language": "xx"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "unknown_language"


def test_notes22_ec4_a_language_change_while_writing_saves_nothing_else(client: TestClient, operator: Account) -> None:
    """The text being written stays in the browser; on the server a language change touches only the language."""
    before = client.get("/api/auth/me").json()
    after = client.put("/api/me/language", json={"language": "de"}).json()
    assert {key: value for key, value in after.items() if key != "language"} == {
        key: value for key, value in before.items() if key in after and key != "language"
    }


def test_notes22_ac5_a_language_file_of_the_operator_is_offered_marked_as_the_operators(
    client: TestClient, operator: Account, folder: Path
) -> None:
    (folder / "nl.json").write_text(json.dumps({"_meta": {"name": "Nederlands"}, "settings": {"title": "Instellingen"}}),
                                    encoding="utf-8")
    listed = client.get("/api/locales").json()
    assert listed == [{"code": "nl", "name": "Nederlands", "keys": 1}]
    assert client.get("/api/locales/nl").json() == {"settings": {"title": "Instellingen"}}
    assert client.put("/api/me/language", json={"language": "nl"}).json()["language"] == "nl"


def test_notes22_ec2_a_broken_language_file_is_left_out_and_named_in_the_log(
    client: TestClient, operator: Account, folder: Path, caplog: pytest.LogCaptureFixture
) -> None:
    (folder / "nl.json").write_text('{"settings": {"title": "Instellingen"}}', encoding="utf-8")
    (folder / "fr.json").write_text('{"settings": {"title": ', encoding="utf-8")
    with caplog.at_level(logging.WARNING):
        listed = client.get("/api/locales").json()
    assert [entry["code"] for entry in listed] == ["nl"]
    skipped = [record.getMessage() for record in caplog.records if "skipped" in record.getMessage()]
    assert len(skipped) == 1 and skipped[0].startswith("Language file name=fr.json skipped: ")
    assert "nl.json" not in caplog.text
    # nexnotes runs on.
    assert client.get("/api/health").json()["status"] == "ok"


def test_notes22_ac3_the_api_answers_in_english_whatever_the_language_of_the_account(
    client: TestClient, operator: Account
) -> None:
    client.put("/api/me/language", json={"language": "de"})
    refused = client.put("/api/me/profile", json={"email": "not an address", "password": PASSWORD},
                         headers={"Accept-Language": "de-DE"})
    assert refused.json()["detail"]["message"] == "This is not an email address."
