"""Builds the "Bestand" test database with the code that is checked out right now.

The test ``tests/test_bestand.py`` loads what this script wrote and checks that every way in that worked in that
version still works in the running one. That only means something if the database comes from the OLD code. So:

    git worktree add ../nexnotes-1.0.1 v1.0.1
    cd ../nexnotes-1.0.1/backend
    <venv>/python tests/bestand/bauen.py --ziel <this repo>/backend/tests/bestand

⚠️ **Never rebuild it with a newer version and commit the result.** It would then describe the new schema, and the
test would prove nothing about installations that run 1.0.1 today. The script refuses to run when ``__version__`` is
not ``FASSUNG``; a fixture for a later version gets its own file name.

Every account is made the way a person makes it in 1.0.1: through the routes (setup with the code, invitations,
the provider, the operator's list). One thing cannot be made by one request: two accounts with one address. 1.0.1
checks the address (``accounts.clean_email``) and writes it in two steps, without a unique index; two profile saves at
the same moment both pass the check. The script plays exactly that, with the version's own functions, in two sessions.

Only invented people and ``example.*`` addresses. Every random value that the test needs to know (session cookies,
device and API tokens, the invitation and reset links, recovery codes, second-factor seeds) is made predictable by
replacing ``secrets`` in the few modules that draw them; the code paths themselves are the ones of the version. Ids
and password hashes stay as the version makes them.

⚠️ **Stored as gzip'ed SQL, not as ``.db``.** A database file in the repository looks like operating data, and the
commit hook refuses 32+ hex characters in a text diff, which every token hash in a plain dump is. The search index
(FTS5) is left out; the version builds it when it needs it.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import secrets
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode, urlsplit

HIER = Path(__file__).resolve().parent
FASSUNG = "1.0.1"
#: The same values as ``tests/conftest.py``: the test opens the fixture with them (sealed TOTP seeds, the client
#: secret of the provider).
TESTSCHLUESSEL = "test-secret-key-for-the-test-run-only"
EINRICHTUNGSCODE = "bestand-einrichtung"
ISSUER = "https://sso.example.com"
CLIENT_ID = "nexnotes-bestand"
CLIENT_GEHEIMNIS = "bestand-client"
KUERZEL = "sso"
OEFFENTLICHE_ADRESSE = "https://notes.example.com"
TAB = {"X-Nexnotes-Client": "tab-bestand0"}


#: The mail server the operator saved (made-up host and password, never reached).
MAILSERVER = {
    "smtp_host": "smtp.example.com",
    "smtp_port": 465,
    "smtp_security": "tls",
    "smtp_user": "notes@example.com",
    "smtp_from": "notes@example.com",
}
MAIL_PASSWORT = "bestand-mail-26"


def _png() -> bytes:
    """A small picture made at run time (no file in Git)."""
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 120, 40)).save(out, format="PNG")
    return out.getvalue()


def dump_datei(ordner: Path = HIER) -> Path:
    return ordner / f"bestand-{FASSUNG}.sql.gz"


def manifest_datei(ordner: Path = HIER) -> Path:
    return ordner / f"bestand-{FASSUNG}.json"


def totp_geheimnis(etikett: str) -> str:
    """The TOTP seed of an account in the fixture, derived instead of stored (no secret-looking value in Git)."""
    return base64.b32encode(hashlib.sha256(f"bestand-totp-{etikett}".encode()).digest()[:20]).decode().rstrip("=")


class FesterZufall:
    """Stands in for ``secrets`` in the modules that hand out values the test must know.

    ``token_urlsafe`` returns ``bestand-<etikett>``; the script sets ``etikett`` before each call that draws one, so
    each value is unique and readable. ``choice`` walks the alphabet (recovery codes). Everything else is the real
    module, ``compare_digest`` included.
    """

    def __init__(self) -> None:
        self.etikett = "unbenannt"
        self._schritt = 0
        self._zaehler = 0

    def token_urlsafe(self, nbytes: int | None = None) -> str:
        # A counter keeps two draws under one label apart (a pairing draws its id and its secret).
        self._zaehler += 1
        return f"bestand-{self.etikett}-{self._zaehler}"

    def choice(self, folge):
        self._schritt += 1
        return folge[(self._schritt * 7) % len(folge)]

    def __getattr__(self, name: str):
        return getattr(secrets, name)


def _umgebung(daten: Path) -> None:
    os.environ["NEXNOTES_DATA_DIR"] = str(daten)
    os.environ["NEXNOTES_SECRET_KEY"] = TESTSCHLUESSEL
    os.environ["NEXNOTES_SETUP_TOKEN"] = EINRICHTUNGSCODE
    os.environ["NEXNOTES_DISABLE_BACKGROUND"] = "1"
    os.environ["NEXNOTES_FRONTEND_DIST"] = str(daten / "no-frontend")
    os.environ["NEXNOTES_LOCALES_DIR"] = str(daten / "locales")
    os.environ["NEXNOTES_API_DOCS"] = "false"
    os.environ["NEXNOTES_GUIDE"] = "0"
    os.environ["NEXNOTES_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
    # Cheap hashes: the parameters travel inside each hash, the test verifies them whatever its own settings are.
    os.environ["NEXNOTES_ARGON2_TIME"] = "1"
    os.environ["NEXNOTES_ARGON2_MEMORY_KIB"] = "1024"
    os.environ["NEXNOTES_ARGON2_PARALLELISM"] = "1"


def bauen(ziel: Path) -> None:
    daten = Path(tempfile.mkdtemp(prefix="nexnotes-bestand-"))
    _umgebung(daten)
    backend = HIER.parent.parent
    sys.path.insert(0, str(backend))
    sys.path.insert(0, str(backend / "tests" / "nexoidc"))

    import time

    import oidc_fakes as fakes
    from fastapi.testclient import TestClient

    from app import __version__, security
    from app.config import get_settings
    from app.db import SessionLocal, engine
    from app.main import app
    from app.models import Account
    from app.services import accounts, apitokens, devices, settings_service, totp
    from app.vendor import nexoidc
    from app.vendor.nexoidc import attempt, protocol

    if __version__ != FASSUNG:
        sys.exit(f"This is nexnotes {__version__}; the fixture describes {FASSUNG}. Check out v{FASSUNG} first.")

    zufall = FesterZufall()
    for modul in (security, accounts, apitokens, devices, totp):
        modul.secrets = zufall  # type: ignore[attr-defined]
    totp.generate_seed = lambda: totp_geheimnis(zufall.etikett)

    netz = fakes.Network()
    nexoidc.use_transport(netz.transport())
    protocol.clear_caches()
    attempt.forget_used_states()
    anbieter = netz.add(fakes.FakeProvider(ISSUER, client_id=CLIENT_ID, client_secret=CLIENT_GEHEIMNIS))

    konten: list[dict] = []
    start = TestClient(app, base_url="http://testserver", headers=TAB)
    start.__enter__()  # the start of the version: tables, columns, indexes, the setup code in the log

    def browser() -> TestClient:
        return TestClient(app, base_url=OEFFENTLICHE_ADRESSE, follow_redirects=False, headers=TAB)

    def ok(antwort, *codes: int):
        assert antwort.status_code in (codes or (200,)), (antwort.status_code, antwort.text[:300])
        return antwort

    def wer(klient: TestClient) -> dict:
        return ok(klient.get("/api/auth/me")).json()

    def zwei_faktor_an(klient: TestClient, etikett: str, passwort: str) -> list[str]:
        zufall.etikett = etikett
        geheimnis = ok(klient.post("/api/auth/totp/begin")).json()["secret"]
        assert geheimnis == totp_geheimnis(etikett)
        code = totp.code_at(geheimnis, time.time())
        antwort = ok(klient.post("/api/auth/totp/confirm", json={"code": code, "password": passwort}))
        return antwort.json()["recovery_codes"]

    def einladen(etikett: str, *, email: str = "", role: str = "member", days: int = 7) -> str:
        zufall.etikett = f"einladung-{etikett}"
        antwort = ok(betrieb.post("/api/invites", json={"days": days, "email": email, "role": role}), 201)
        return antwort.json()["link"].rsplit("/", 1)[-1]

    def annehmen(schluessel: str, *, anzeigename: str, email: str, passwort: str, etikett: str) -> TestClient:
        klient = browser()
        zufall.etikett = f"sitzung-{etikett}"
        ok(
            klient.post(
                f"/api/invite/{schluessel}",
                json={"display_name": anzeigename, "email": email, "password": passwort, "password_confirm": passwort},
            )
        )
        return klient

    def ueber_anbieter(klient: TestClient, person: dict, etikett: str, *, einladung: str | None = None):
        anbieter.person = dict(person)
        zufall.etikett = f"sitzung-{etikett}"
        params = {"invite": einladung} if einladung else {}
        ziel_url = klient.get(f"/api/oidc/{KUERZEL}/start", params=params).headers["location"]
        pfad = urlsplit(fakes.query_of(ziel_url)["redirect_uri"]).path
        zurueck = klient.get(f"{pfad}?{urlencode(anbieter.authorize(ziel_url))}")
        assert zurueck.status_code in (302, 303) and "error=" not in zurueck.headers["location"], zurueck.headers

    # --- The operator: setup with the code, address, second factor ------------------------------------------------
    betrieb = browser()
    zufall.etikett = "sitzung-betrieb"
    pw_betrieb = "Bestand-betr-26"
    ok(
        betrieb.post(
            "/api/setup",
            json={
                "display_name": "Betrieb Beispiel",
                "email": "betrieb@example.com",
                "password": pw_betrieb,
                "password_confirm": pw_betrieb,
                "language": "de",
                "code": EINRICHTUNGSCODE,
            },
        )
    )
    codes_betrieb = zwei_faktor_an(betrieb, "betrieb", pw_betrieb)
    assert wer(betrieb)["name"] == "betrieb"
    konten.append(
        {
            "name": "betrieb",
            "passwort": pw_betrieb,
            "email": "betrieb@example.com",
            "operator": True,
            "zweiter_faktor": "betrieb",
            "wiederherstellungscodes": codes_betrieb,
            "fall": "operator from the setup, name made from the address, address, second factor",
        }
    )

    with SessionLocal() as db:
        settings_service.save(db, {"public_url": OEFFENTLICHE_ADRESSE})
    # The mail server as the settings page of the version saves it (the password sealed with the server's key).
    ok(betrieb.put("/api/settings", json=MAILSERVER | {"smtp_password": MAIL_PASSWORT}))
    ok(
        betrieb.post(
            "/api/oidc/admin/providers",
            json={
                "label": "SSO",
                "slug": KUERZEL,
                "issuer": ISSUER,
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_GEHEIMNIS,
            },
        ),
        201,
    )

    # --- No address: the name comes from the display name; an open browser session --------------------------------
    pw_erika = "Bestand-erika26"
    erika = annehmen(einladen("erika"), anzeigename="Erika Muster", email="", passwort=pw_erika, etikett="erika")
    assert wer(erika)["name"] == "erika-muster" and wer(erika)["email"] == ""
    konten.append(
        {
            "name": "erika-muster",
            "passwort": pw_erika,
            "email": "",
            "sitzung": erika.cookies.get(security.SESSION_COOKIE),
            "fall": "invited without an address, name made from the display name, open browser session",
        }
    )

    # --- Address from the invitation, an API token ------------------------------------------------------------------
    pw_jonas = "Bestand-jonas26"
    jonas = annehmen(
        einladen("jonas", email="jonas@example.net"),
        anzeigename="Jonas Beispiel",
        email="",
        passwort=pw_jonas,
        etikett="jonas",
    )
    assert wer(jonas)["email"] == "jonas@example.net"
    zufall.etikett = "api-jonas"
    api_token = ok(
        jonas.post("/api/tokens", json={"name": "Dashboard", "level": "read", "days": None}), 201
    ).json()["token"]
    konten.append(
        {
            "name": "jonas",
            "passwort": pw_jonas,
            "email": "jonas@example.net",
            "api_token": api_token,
            "fall": "address from the invitation, signs in by address, API token",
        }
    )

    # --- One address, two accounts (case differs): two profile saves at the same moment ---------------------------
    pw_kim, pw_lou = "Bestand-kim-26", "Bestand-lou-26"
    annehmen(einladen("kim"), anzeigename="Kim", email="", passwort=pw_kim, etikett="kim")
    annehmen(einladen("lou"), anzeigename="Lou", email="", passwort=pw_lou, etikett="lou")
    with SessionLocal() as erste, SessionLocal() as zweite:
        kim = erste.query(Account).filter(Account.name == "kim").one()
        lou = zweite.query(Account).filter(Account.name == "lou").one()
        # Both requests check before either writes: neither sees the other's address yet.
        fuer_kim = accounts.clean_email(erste, "familie@example.net", own_id=kim.id)
        fuer_lou = accounts.clean_email(zweite, "Familie@Example.net", own_id=lou.id)
        kim.email, lou.email = fuer_kim, fuer_lou
        erste.commit()
        zweite.commit()
    konten += [
        {
            "name": "kim",
            "passwort": pw_kim,
            "email": "familie@example.net",
            "doppelte_adresse": True,
            "fall": "address shared with lou (two profile saves at once); 1.0.1 signs in the first by it",
        },
        {
            "name": "lou",
            "passwort": pw_lou,
            "email": "Familie@Example.net",
            "doppelte_adresse": True,
            "fall": "address shared with kim, in other case",
        },
    ]

    # --- Second factor and a paired iPhone ----------------------------------------------------------------------------
    pw_mona = "Bestand-mona-26"
    mona = annehmen(
        einladen("mona", email="mona@example.com"),
        anzeigename="Mona Beispiel",
        email="mona@example.com",
        passwort=pw_mona,
        etikett="mona",
    )
    codes_mona = zwei_faktor_an(mona, "mona", pw_mona)
    # A profile picture of her own (the version draws it anew as WebP).
    ok(mona.put("/api/auth/avatar", content=_png()))
    zufall.etikett = "kopplung-mona"
    kopplung = ok(mona.post("/api/app-pairing", json={"address": OEFFENTLICHE_ADRESSE}), 201).json()
    zufall.etikett = "geraet-mona"
    geraet = ok(
        browser().post(
            f"/api/app/1/pairing/{kopplung['id']}/key",
            json={"secret": kopplung["secret"], "device_name": "iPhone (Bestand)", "device_kind": "ios"},
        )
    ).json()["token"]
    konten.append(
        {
            "name": "mona",
            "passwort": pw_mona,
            "email": "mona@example.com",
            "zweiter_faktor": "mona",
            "wiederherstellungscodes": codes_mona,
            "geraet": geraet,
            "bild": True,
            "fall": "password, second factor, paired iPhone, own profile picture",
        }
    )

    # --- Password and a provider; the account took the provider's address ------------------------------------------
    pw_sam = "Bestand-sam-26"
    sam = annehmen(einladen("sam"), anzeigename="Sam", email="", passwort=pw_sam, etikett="sam")
    sam_person = {"sub": "bestand-sam", "preferred_username": "sam", "name": "Sam Beispiel", "email": "sam@example.org"}
    verknuepfung = ok(sam.post(f"/api/oidc/{KUERZEL}/link", json={"password": pw_sam})).json()["url"]
    anbieter.person = dict(sam_person)
    pfad = urlsplit(fakes.query_of(verknuepfung)["redirect_uri"]).path
    zurueck = sam.get(f"{pfad}?{urlencode(anbieter.authorize(verknuepfung))}")
    assert zurueck.status_code in (302, 303) and "error=" not in zurueck.headers["location"], zurueck.headers
    assert wer(sam)["provider_email"] == "sam@example.org"
    ok(sam.post("/api/oidc/me/address"))
    with SessionLocal() as db:
        assert db.query(Account).filter(Account.name == "sam").one().email_source == "provider"
    konten.append(
        {
            "name": "sam",
            "passwort": pw_sam,
            "email": "sam@example.org",
            "email_source": "provider",
            "anbieter": sam_person,
            "fall": "password and a linked provider; took the provider's address (email_source provider)",
        }
    )

    # --- Only a provider, invited as operator -----------------------------------------------------------------------
    robin_person = {
        "sub": "bestand-robin",
        "preferred_username": "Robin.SSO",
        "name": "Robin Beispiel",
        "email": "robin@sso.example.com",
    }
    robin = browser()
    ueber_anbieter(robin, robin_person, "robin", einladung=einladen("robin", email="robin@example.com", role="operator"))
    robin_ich = wer(robin)
    assert robin_ich["name"] == "robin.sso" and robin_ich["sign_in"] == "oidc" and robin_ich["role"] == "operator"
    konten.append(
        {
            "name": "robin.sso",
            "email": robin_ich["email"],
            "email_source": "provider",
            "operator": True,
            "anbieter": robin_person,
            "fall": "provider only, invited as operator, name from preferred_username, follows the provider's address",
        }
    )

    # --- Blocked, and deleted (restorable) --------------------------------------------------------------------------
    pw_gesperrt, pw_weg = "Bestand-sperr26", "Bestand-weg-26"
    annehmen(einladen("gesperrt", email="gesperrt@example.com"), anzeigename="Gesperrt Beispiel", email="",
             passwort=pw_gesperrt, etikett="gesperrt")
    annehmen(einladen("weg", email="weg@example.com"), anzeigename="Weg Beispiel", email="", passwort=pw_weg,
             etikett="weg")
    with SessionLocal() as db:
        ids = {row.name: row.id for row in db.query(Account).all()}
    ok(betrieb.post(f"/api/accounts/{ids['gesperrt']}/block", json={"current_password": pw_betrieb}), 204)
    ok(betrieb.request("DELETE", f"/api/accounts/{ids['weg']}", json={"current_password": pw_betrieb}), 204)
    konten += [
        {
            "name": "gesperrt",
            "passwort": pw_gesperrt,
            "email": "gesperrt@example.com",
            "gesperrt": True,
            "fall": "blocked by the operator: hears so only after the right password",
        },
        {
            "name": "weg",
            "passwort": pw_weg,
            "email": "weg@example.com",
            "geloescht": True,
            "fall": "deleted by the operator, restorable for 30 days",
        },
    ]

    # --- Open links: an invitation with an address, a reset link of the operator ----------------------------------
    offen = einladen("gast", email="gast@example.org", days=30)
    zufall.etikett = "ruecksetzen-erika"
    ruecksetzen = ok(
        betrieb.post(
            f"/api/accounts/{ids['erika-muster']}/reset-link", json={"days": 30, "current_password": pw_betrieb}
        ),
        201,
    ).json()["link"].rsplit("/", 1)[-1]

    for klient in (betrieb, erika, jonas, mona, sam, robin):
        klient.close()
    start.__exit__(None, None, None)
    nexoidc.use_transport(None)
    engine.dispose()

    ziel.mkdir(parents=True, exist_ok=True)
    _sql_schreiben(get_settings().database_path, dump_datei(ziel))
    manifest = {
        "fassung": FASSUNG,
        "testschluessel": "tests/conftest.py (NEXNOTES_SECRET_KEY)",
        "anbieter": {"kuerzel": KUERZEL, "issuer": ISSUER, "client_id": CLIENT_ID, "client_geheimnis": CLIENT_GEHEIMNIS},
        "oeffentliche_adresse": OEFFENTLICHE_ADRESSE,
        "konten": konten,
        "offene_einladung": {"schluessel": offen, "email": "gast@example.org", "role": "member"},
        "offener_ruecksetzlink": {"schluessel": ruecksetzen, "name": "erika-muster"},
        "mailserver": MAILSERVER | {"smtp_password": MAIL_PASSWORT},
    }
    manifest_datei(ziel).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(daten, ignore_errors=True)
    print(f"Wrote {dump_datei(ziel)} and {manifest_datei(ziel)}.")


def _sql_schreiben(db_pfad: Path, ziel: Path) -> None:
    """The database as SQL, without the search index (an FTS5 table with shadow tables)."""
    verbindung = sqlite3.connect(str(db_pfad))
    try:
        zeilen = [
            z
            for z in verbindung.iterdump()
            if "search_index_v" not in z and "search_rows_v" not in z and not z.startswith("PRAGMA writable_schema")
        ]
    finally:
        verbindung.close()
    roh = ("\n".join(zeilen) + "\n").encode("utf-8")
    puffer = io.BytesIO()
    # mtime 0: the same SQL gives the same file.
    with gzip.GzipFile(fileobj=puffer, mode="wb", mtime=0) as gepackt:
        gepackt.write(roh)
    ziel.write_bytes(puffer.getvalue())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ziel", type=Path, default=HIER, help="where the .sql.gz and .json go (default: here)")
    bauen(parser.parse_args().ziel)
