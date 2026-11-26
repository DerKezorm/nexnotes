"""The places the guide, the README, the API's description and its page name are the settings as they are now (plan
"Einstellungen", E39): "Einstellungen › Mein Konto › …" or "Einstellungen › Server › …" with an area of that group in
the words of the navigation, the same in English. The word for a program's access is "API-Schlüssel" ("API key"),
never "API-Token", "API token" or a bare "Token" for it. The page's own texts are held the same way by
``frontend/src/i18n/places.test.ts``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.routers import api_v1

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "backend" / "app" / "guide"

#: The groups of the navigation and their areas (ui kit ``texts.ts`` and nexnotes' own "Texterkennung").
AREAS = {
    "de": {
        "Mein Konto": ("Profil", "Sicherheit", "Darstellung", "Verbindungen"),
        "Server": ("Allgemein", "Anmeldung", "Mail", "Speicher und Sicherung", "Texterkennung", "Konten", "Log"),
    },
    "en": {
        "My account": ("Profile", "Security", "Appearance", "Connections"),
        "Server": ("General", "Sign-in", "Mail", "Storage and backups", "Text recognition", "Accounts", "Log"),
    },
}
SETTINGS = {"de": "Einstellungen", "en": "Settings"}
OLD = re.compile(r"API-Token|API tokens?\b|\bein Token\b|\bden Token\b|\ba token\b|\bthe token\b|Token-Bereich|token section")


def _texts(language: str) -> dict[str, str]:
    found = {str(path.relative_to(GUIDE)): path.read_text(encoding="utf-8") for path in (GUIDE / language).rglob("*.md")}
    if language == "en":
        found["README.md"] = (ROOT / "README.md").read_text(encoding="utf-8")
        found["docs/api.md"] = (ROOT / "docs" / "api.md").read_text(encoding="utf-8")
        found["api_v1.DOCS_TEXT"] = api_v1.DOCS_TEXT
    return found


@pytest.mark.parametrize("language", ["de", "en"])
def test_every_path_into_the_settings_names_a_group_and_one_of_its_areas(language: str) -> None:
    groups = AREAS[language]
    wrong, paths = [], 0
    for name, text in _texts(language).items():
        for found in re.finditer(rf"{SETTINGS[language]} › ", text):
            paths += 1
            rest = text[found.end():]
            if not any(rest.startswith(f"{group} › {area}") for group, areas in groups.items() for area in areas):
                wrong.append(f"{name}: {rest[:60]}")
    assert wrong == []
    assert paths >= (12 if language == "de" else 18)


@pytest.mark.parametrize("language", ["de", "en"])
def test_a_programs_access_is_an_api_key(language: str) -> None:
    old = [f"{name}: {line.strip()[:100]}" for name, text in _texts(language).items() for line in text.splitlines()
           if OLD.search(line)]
    assert old == []


@pytest.mark.parametrize("language", ["de", "en"])
def test_a_place_is_written_with_its_group_and_no_card_or_comma_form(language: str) -> None:
    """E46: "Einstellungen › Mein Konto › Verbindungen › API-Schlüssel", never "…, in der Karte „API-Schlüssel“",
    "Mein Konto, Sicherheit" or an arrow; an area at the start of a path comes after its group."""
    groups = AREAS[language]
    words = "|".join(re.escape(word) for word in [SETTINGS[language], *groups, *(a for areas in groups.values() for a in areas)])
    areas = "|".join(re.escape(area) for values in groups.values() for area in values)
    wrong = []
    for name, text in _texts(language).items():
        for line in text.splitlines():
            if re.search(rf"\b({words})\s*(,|→|->)\s*({words})\b", line):
                wrong.append(f"{name}: {line.strip()[:100]}")
            if re.search(r"(in der Karte|die Karte|in the card|the card) [„“\"]", line):
                wrong.append(f"{name}: {line.strip()[:100]}")
            for found in re.finditer(rf"({areas}) › ", line):
                before = line[: found.start()]
                if not any(before.endswith(f"{group} › ") for group in groups):
                    wrong.append(f"{name}: {line.strip()[:100]}")
    assert wrong == []


def test_the_guide_points_to_nextasks_and_nexdeck_as_they_are_now() -> None:
    nextasks = (GUIDE / "de" / "7 Verbindungen" / "1 nextasks.md").read_text(encoding="utf-8")
    assert "In nextasks unter Einstellungen › Mein Konto › Verbindungen › API-Schlüssel einen Schlüssel" in nextasks
    deck = (GUIDE / "en" / "7 Connections" / "3 nexdeck card.md").read_text(encoding="utf-8")
    assert "since nexdeck 1.11.0" in deck and "next versions of nexdeck" not in deck
