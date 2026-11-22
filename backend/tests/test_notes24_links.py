"""NOTES-24, change of 22.11.2026: links to notes open in the iOS app ("Universal Links", NOTESIOS-29).

The server serves ``/.well-known/apple-app-site-association``; which addresses it lists decides what may open in the
app. The matcher below follows Apple's rules for ``components`` (the first that fits counts; ``*`` any characters,
``?`` one; ``exclude`` keeps an address in the browser) so that the tests read like the links people tap.
"""

from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings

PATH = "/.well-known/apple-app-site-association"


def _pattern(glob: str) -> re.Pattern[str]:
    return re.compile("^" + "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in glob) + "$")


def opens_in_app(association: dict, address: str) -> bool:
    """Whether Apple would hand ``address`` (path and query) to the app."""
    path, _, query = address.partition("?")
    params = dict(part.partition("=")[::2] for part in query.split("&") if part)
    for component in association["applinks"]["details"][0]["components"]:
        if not _pattern(component["/"]).match(path):
            continue
        wanted = component.get("?", {})
        if any(name not in params or not _pattern(glob).match(params[name]) for name, glob in wanted.items()):
            continue
        return not component.get("exclude", False)
    return False


def test_notes24_universal_links_file_names_the_app_without_signing_in(client) -> None:
    answer = client.get(PATH)
    assert answer.status_code == 200
    assert answer.headers["content-type"].startswith("application/json")
    details = answer.json()["applinks"]["details"]
    assert [entry["appIDs"] for entry in details] == [["6KQSFL9GA3.dev.nexapps.nexnotes"]]
    # Handoff never goes to the browser and no passwords are shared with the app: only links.
    assert set(answer.json()) == {"applinks"}


@pytest.mark.parametrize(("address", "in_app"), [
    ("/notes/nX_packingList-2wErTyUi", True),
    ("/folder/fZ_household-Box9xQwErT?note=nX_packingList-2wErTyUi", True),
    ("/inbox?note=nX_packingList-2wErTyUi", True),
    ("/tags/travel?note=nX_packingList-2wErTyUi", True),
    ("/search?q=eggs&note=nX_packingList-2wErTyUi", True),
    ("/smart/sM_openTasks-9xQwErTyUi?note=nX_packingList-2wErTyUi", True),
    ("/?note=nX_packingList-2wErTyUi", True),
    # NOTESIOS-29 EC-5: what is no note stays in the browser.
    ("/", False),
    ("/folder/fZ_household-Box9xQwErT", False),
    ("/login", False),
    ("/settings/devices", False),
    ("/app-connect?state=abc", False),
    ("/l/read-link-token", False),
    ("/l/read-link-token?note=nX_packingList-2wErTyUi", False),
    ("/api/app/1/hello?note=nX_packingList-2wErTyUi", False),
    ("/settings?note=nX_packingList-2wErTyUi", False),
])
def test_notes24_universal_links_only_addresses_of_a_note(client, address: str, in_app: bool) -> None:
    assert opens_in_app(client.get(PATH).json(), address) is in_app


def test_notes24_universal_links_several_apps_or_none(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "apple_app_ids", " 6KQSFL9GA3.dev.nexapps.nexnotes, ABCDE12345.com.example.notes ")
    assert client.get(PATH).json()["applinks"]["details"][0]["appIDs"] == [
        "6KQSFL9GA3.dev.nexapps.nexnotes", "ABCDE12345.com.example.notes"]
    monkeypatch.setattr(get_settings(), "apple_app_ids", "")
    answer = client.get(PATH)
    assert answer.status_code == 404
    assert answer.json()["detail"]["code"] == "not_found"


@pytest.mark.parametrize("value", ["dev.nexapps.nexnotes", "6kqsfl9ga3.dev.nexapps.nexnotes", "6KQSFL9GA3.", "x y"])
def test_notes24_universal_links_setting_refuses_what_is_no_app_id(value: str) -> None:
    with pytest.raises(ValidationError):
        Settings(apple_app_ids=value)
