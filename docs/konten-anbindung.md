# Anbindung des Kontenmoduls (`nexkonten`) an nexnotes

Stand 24.11.2026, Zweig `konten`. Vorbereitung, noch nichts angebunden. Maßgeblich sind der Entwurf in nexlore
(`Development/nexapps/Baupläne/Entwurf Konten, Einrichtung und Anmeldung.md`) und die Schnittstelle des Moduls
(`bauplaene/konten/SCHNITTSTELLE.md`, Zweig `konten`, Fassung 0.1.0). Wo nexnotes etwas braucht, das die Schnittstelle
nicht hergibt, steht es unter „Passt das Modul?“ (Abschnitt 12); offene Entscheidungen unter „Offene Fragen“.

nexnotes ist für das Modul das Vorbild (Weg „nexnotes und nextime“, Oberfläche nach `AuthPages.tsx` und
`AccountTab.tsx`). Es ändert sich deshalb weniger als in den anderen Apps: Der Benutzername (`accounts.name`) wird
sichtbar und änderbar, „Passwort vergessen“ bekommt den Weg per Mail, Adressen bekommen einen Bestätigungslink.

## 0. Was gebaut ist / was fehlt

Stand 25.11.2026, Zweig `konten`. Module aus `bauplaene` Zweig `konten`: `konten` 0.3.3 (`e2a5994`), `oidc` 1.1.0,
`post` 0.1.1, kopiert mit `tools/sync.py copy`. App-Version unverändert 1.0.1.

**Gebaut (Backend):**

| Teil | Wo |
|---|---|
| Store | `services/konten_store.py` (Store, FactorStore, PasskeyStore, SessionStore, PictureStore über `accounts`, `invites`, `password_resets`, `auth_sessions`, `api_tokens` und die neuen Tabellen) |
| Neue Spalten | `accounts.email_confirmed` (1), `email_proven` (0), `avatar_source`, `passkey_handle`, `new_sign_in_mail` (1), `new_password_origin`; `auth_sessions.uid`, `remember` (1), `stage` (`full`), `kind` (`browser`); `invites.display_name`, `invites.mailed` (0); `password_resets.origin` (`operator`) |
| Neue Tabellen | `models_accounts.py`: `former_names`, `setup_claims`, `email_changes`, `passkeys`, `failed_unknown`, `mail_outbox` |
| Wanderung | `services/konten_wanderung.py` aus `db.init_db` (Sicherung davor wie bisher): `uid` für alte Sitzungen, eindeutiger Index auf `lower(name)` erst nach Zählen, Indizes auf `lower(email)` und `former_names` |
| Anmelden | `POST /api/auth/login` über `login.authenticate`, Bremse `BRAKE` mit `attempt_key` (bekannter Browser: eigener Topf über `known_mark`, 5 frei), Feld `remember` neu, Sitzung über `sessions.start`, Mail „Neue Anmeldung“ |
| Einrichtung | `POST /api/setup` über `setup.setup` (Feld `name` neu, sonst Vorschlag) |
| Passwort vergessen | `POST /api/auth/forgot` (`name`), `resets.forgot_in_background`; `GET /api/auth/methods` sagt `forgot_mail`, `passkeys` |
| Einladung | `GET/POST /api/invite/{token}` über `invite_form`/`accept_invite` (Feld `name` neu), `POST /api/invites` mit `display_name` |
| Reset-Link | `GET/POST /api/reset/{token}` über `reset_state`/`use_reset`; Betreiber `POST /api/accounts/{id}/reset-link` über `resets.reset_link` (Mail oder Link, `sent`) |
| Profil | `PUT /api/me/profile` (`name`, `password` neu), `POST /api/me/email/resend`, `DELETE /api/me/email/pending`, `GET/POST /api/email/{token}`, `PUT /api/me/new-sign-in-mail` |
| Sitzungen | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{uid}`, `GET /api/auth/access`, `POST /api/auth/access/disconnect`, `POST /api/auth/access/seen` |
| Betreiber | `PUT /api/accounts/{id}/name`, `/display-name`, `DELETE /api/accounts/{id}/email`; Liste mit `email_duplicate`; Faktor-Reset über `factor.operator_reset` (Feld `disconnect_devices`) |
| Zweiter Faktor | Code-Schritt prüft über `factor.check_code` (alte Codes gelten); Einrichten über `factor.begin_totp`/`confirm_totp` |
| OIDC 1.1.0 | `services/oidc_store.py`: Namensregeln und belegte Namen aus dem Modul, Anzeigename aus dem Claim, Bild vom Anbieter im Faden, Adresse über `profiles.provider_email` (Konten mit Passwort: nur angeboten) |
| Mails | `services/post_store.py` (Store über `smtp_*` und `mail_outbox`, Minutenrunde in `main`), `services/kontenpost.py`; Einladung und Testmail über `post` sofort |
| Alte Fehlerkennungen | `konten_store.OLD_CODES` (`invalid_email`, `name_taken`, `invalid_account_name`) |
| Passkeys | `routers/passkeys.py`: Liste, Hinzufügen (Passwort bzw. frische Anbieteranmeldung), Entfernen, Anmelden ohne Passwort und Code, an Stelle des Codes einer wartenden Anmeldung; Betreiber-Schalter `passkeys_allowed` |
| Notfallbefehl | `python -m app.emergency reset-link <Benutzername oder E-Mail> [--days 1/7/30]` |
| Mail-Einstellungen | `smtp_sender_name`, `mail_last_*`, `passkeys_allowed` in `GET/PUT /api/settings` |
| Frontend | `pages/AuthPages.tsx` (Einrichtung, Anmelden mit „Angemeldet bleiben“ und Passkey, `ForgotPage`, `EmailPage`, Einladung, neues Passwort), `pages/settings/AccountTab.tsx` (Profil mit Benutzername, wartender Adresse, Passwortdialog), `pages/settings/SecurityBoxes.tsx` (Passkeys, „Wo du angemeldet bist“, „Diese Geräte haben noch Zugriff“), `AccountsTab.tsx` (Benutzername · E-Mail, doppelte Adresse, Umbenennen, Anzeigename, Adresse entfernen, Reset-Link mit Mail, Faktor-Reset mit Geräten), Server-Karten (Absendername, Warnung ohne Verschlüsselung, letzter Mailstand, Passkey-Schalter); `lib/passkeys.ts`, `lib/errors.ts` mit `accountErrorKey`/`mailErrorKey` |
| Tests | Vertrag `tests/nexkonten` + `tests/nexpost` (216 grün, 5 übersprungen mit Grund), Test „Bestand“ ohne `xfail` und mit Teil 2 (54 grün: Mailserver, Profilbild, Sitzung von 1.0.1, Authenticator), angepasste App-Tests (Brems-Zahlen des Moduls, Setup-Code ≥ 16 Zeichen, Mailtexte von `post`), vitest `nexkonten.test.ts`, `nexpost.test.ts`, e2e-Texte („Username or email“, Setup-Code der Läufe) |
| Läufe (25.11.2026, nach konten 0.3.3) | Backend `pytest -q -n 2`: 1988 grün, 47 übersprungen; Vertrag `tests/nexkonten` 206 grün, 2 übersprungen (Einladung mit festem Benutzernamen); Frontend `vitest --maxWorkers=2`: 880 grün; `tsc -b` und `npm run lint` sauber. Die `conftest.py` der Modul-Vertragstests heißen alle `conftest`; `tests/conftest.py` stellt vor jedem Test die nächstgelegene in `sys.modules` (wie nexmail); Einladungstests setzen die öffentliche Adresse (Fixture `public_address`) |

**Seit konten 0.3.2/0.3.3 nachgezogen:** Ein Passkey zählt als zweiter Faktor (`Store.second_factor` über
`factor.state`: ohne „für alle verlangen“ genügt das Passwort, mit dem Schalter ist der Passkey der zweite Schritt,
Anmeldeantwort `code: false`, die Seite zeigt dann nur „Mit Passkey anmelden“; `totp.factor_missing` zählt Passkeys).
Bremse: bekannter Browser über `sessions.known_mark` und `BRAKE.claim(keys, browser=…)` (der eigene Topf von 1.0.1 ist
weg). Authenticator einrichten über `factor.begin_totp`/`confirm_totp`, der halb eingerichtete Schlüssel wartet
versiegelt in `accounts.totp_pending`/`totp_pending_until` (Kontext `totp-pending`); neue Codes über
`factor.new_codes` (10 statt 8). Anbieteradresse über `profiles.provider_email`; Konten mit Passwort übernehmen sie im
Profil mit Passwort („Adresse von <Anbieter> übernehmen?“, `take_offered_email`, mit Mailserver wartet sie auf ihren
Link), „Nein, danke“ merkt sich die Adresse weiter in `provider_email_off`. Geräteliste mit `language=`, Einladung mit
`public_url=` (ohne öffentliche Adresse abgelehnt), frische Anmeldung 5 statt 10 Minuten (`common.fresh_sign_in`),
Passkey-Routen mit `request_url`, Nothammer `NEXNOTES_SECOND_FACTOR_OFF` (Warnung beim Start, Feld
`second_factor_off`, Hinweis oben in „Mein Konto“ und bei den Anmelde-Einstellungen), Betreiber-Reset mit Übersicht
(`GET /api/accounts/{id}/totp/reset`) und Haken „Passkeys auch entfernen“ (ab Werk an), auch für Konten nur mit
Passkey. Vertragsadapter: `required_second_factor` und `reusable_invites` aus statt `skip`.

**Abweichungen vom Modul (bewusst):** Die wartende Anmeldung zwischen Passwort und Code bleibt nexnotes' eigene
(`totp.start_pending`, Cookie `PENDING_COOKIE`; geprüft wird über `factor.check_code`), weil nexnotes eine eigene
Sitzungsschicht hat. Geräte bleiben nach einem Reset-Link verbunden (Modul, Entscheidung 25.11.2026); NOTES-2 AC-7 sagt
anderes und ist anzupassen.

**Fehlt noch:** Sichtprüfung der geänderten Bildschirme (kein Playwright in dieser Runde), die iPhone-App
(`login` beim Laden auffrischen, Beschriftung „Benutzername“), der Dialog „Sitzung abgelaufen“ kennt keinen
Passkey-Schritt (ein Konto nur mit Passkey bei „für alle verlangen“ meldet sich dort über die Anmeldeseite an).

## 1. Bestand heute (1.0.1)

### Datenmodell (`backend/app/models.py`)

| Tabelle | Was zum Konto gehört |
|---|---|
| `accounts` | `id` (Ganzzahl, an ihr hängt alles), `name` (String 64, `unique=True`, **immer klein** gespeichert, unsichtbar erzeugt aus Adresse oder Anzeigename, `accounts.free_name`), `display_name` (80, Pflicht außer bei OIDC-Konten: dort leer), `role` (`operator`/`member`), `sign_in` (`password`/`oidc`), `password_hash` (Argon2id, leer = nur Anbieter), `email` (255, **ohne eindeutigen Index**), `email_source` (`""`/`provider`), `provider_email`, `provider_email_off` (Angebot der Anbieteradresse), `language` (reist mit), `failed_logins`, `locked_until` (Sperre nach 10 Fehlversuchen, 15 min), `blocked_at`, `deleted_at` (30 Tage wiederherstellbar), `password_reset_notice`, `totp_*`, `avatar`, `avatar_at`, `device_key` |
| `invites` | `token_hash`, `role`, `email`, `created_by`, `expires_at` (1, 7 oder 30 Tage), **kein Anzeigename, kein Name** |
| `password_resets` | nur Betreiber-Links: `token_hash`, `account_id`, `created_by`, `expires_at` (1, 7 oder 30 Tage) |
| `auth_sessions` | Browser, am `account_id` |
| `api_tokens` | gekoppelte Geräte (`device`), MCP-Schlüssel, nexdeck-Schlüssel, API-Tokens; alle am `account_id` |
| `oidc_providers`, `oidc_links` | Verknüpfung `(provider_id, subject)` → `account_id`; `email` nur Anzeige |

### Dienste und Router

| Ort | Was |
|---|---|
| `services/accounts.py` | `by_name` (klein), `by_email` (ohne Groß/Klein, **`limit(1)`**), `by_login` (@ → Adresse, sonst Name), `NAME_PATTERN` = Muster des Moduls, `free_name`, `create_with_password` (Mindestlänge 12, Anzeigename Pflicht), `setup_code`/`announce_setup_code`/`create_operator` (Code schon heute, `NEXNOTES_SETUP_TOKEN`), `authenticate` (Blindhash, Sperre am Konto, „bekannter Browser“ darf trotz Sperre), Reset-Links, Sperren, Löschen, Einladungen |
| `services/oidc_store.py` | Store für `vendor/nexoidc` 1.0.14: `clean_name` (eigene Regel), `name_taken`, `create_account` (Adresse vom Anbieter, sonst die der Einladung), Anbieteradresse folgen oder anbieten |
| `routers/auth.py` | `GET/POST /api/setup` (`display_name`, `email`, `password`, `password_confirm`, `language`, `code`), `POST /api/auth/login` (`name`, `password`), `/auth/logout(-all)`, `GET /api/auth/me`, `PUT /api/auth/password`, `PUT /api/me/profile` (`display_name`, `email`), `PUT /api/me/language` |
| `routers/invites.py` | Betreiber `GET/POST /api/invites` (`days`, `email`, `role`, `send`, `language`), `DELETE /api/invites/{id}`; `GET/POST /api/invite/{token}` (`display_name`, `email`, `password`, `password_confirm`); `GET/POST /api/reset/{token}` (`password`, `password_confirm`) |
| `routers/accounts.py` | Betreiber: Liste, Löschen/Wiederherstellen, Sperren, Rolle, Speichergrenze, `POST /api/accounts/{id}/reset-link` (`days`, `current_password`) |
| `routers/totp.py`, `routers/oidc.py`, `routers/app_pairing.py`, `routers/app1.py`, `routers/tokens.py` | zweiter Faktor, Anbieter (auch `POST/DELETE /api/oidc/me/address`), Koppeln der iPhone-App, Geräte-API, Tokens |
| `deps.confirm_operator` | Betreiberhandlungen mit eigenem Passwort; **Betreiber ohne Passwort** (nur Anbieter) bestätigen mit frischer Anmeldung beim Anbieter |
| `services/mailer.py` | nur Einladung und Testmail; kein Rücksetzen per Mail |

### Wanderung

`db.init_db()` bei jedem Start (`main.lifespan`): `create_all`, fehlende Spalten per `ALTER TABLE … ADD COLUMN` mit
der Vorgabe des Modells (`_add_missing_columns`, **davor eine Sicherung** `backups.UPDATE`), fehlende Indizes
(`table_index.create(checkfirst=True)`, ohne Prüfung, ob sie anlegbar sind). Vorher sichert `_backup_before_update`,
wenn die Fassung wechselt. Kein Alembic, keine Schemanummer.

### Frontend

`pages/AuthPages.tsx` (`SetupPage`, `LoginPage`, `InvitePage`, `ResetPage`; Bausteine `AuthFrame`, `AuthField`,
`Primary`, `Problem`, `Warning`, `PasswordConfirmField`, `ProviderButtons`), `pages/settings/AccountTab.tsx` (Karte
„Profil“ mit `Field`, `Card`, Angebot der Anbieteradresse, Sprache), `pages/settings/AccountsTab.tsx` (Tabelle,
`MenuItem`, `Dialog`, `Input`, `Select`, `Toggle`, `CopyLink`). Wortlaute `frontend/src/i18n/{de,en}.json`.

### iPhone-App (`nexnotes-ios`, geprüft)

Kein eigenes Formular: Koppeln per QR-Code oder Anmeldeseite des Servers in `ASWebAuthenticationSession`
(`Views/AddServerView.swift:190`). Erkannt wird ein Serverkonto über **Adresse und Konto-ID**
(`SharedServer.identity`, `Accounts/Stores.swift`), nie über den Namen. Den Namen (`login`) zeigt sie an drei Stellen:
„Signed in as <login> · <email>“ (`Views/MemberViews.swift:95`, frisch aus `/api/app/1/me`), „Signed in as“ in den
Einstellungen (`Views/SettingsView.swift:314`) und im Kontowechsler (`App/Links.swift:469`, `Views/SyncSheet.swift:183`).
**Abweichung vom Entwurf:** Die beiden letzten lesen den beim Koppeln **gespeicherten** `login`
(`ServerAccount.login` in `accounts.json` und im iCloud-Schlüsselbund) und frischen ihn nie auf; nach einer Änderung
zeigen sie den alten Namen, bis das Gerät neu gekoppelt wird, nicht nur bis „die App das Konto neu lädt“. Brechen tut
nichts.

## 2. Wo der Benutzername mehr ist als Anzeige

**bricht** = Umbenennen oder Umbau macht etwas kaputt; **lösen** = vor dem Ändern-Knopf anfassen; **harmlos** = nur
Anzeige oder Protokoll.

| Stelle | Rolle des Namens | Bewertung |
|---|---|---|
| `models.py:84` `accounts.name unique=True`, stets klein | eindeutig, weil immer klein geschrieben | harmlos: wirkt wie ein Index ohne Groß/Klein, solange jedes Schreiben klein schreibt (`check_username` tut das). Kein neuer Index nötig |
| `services/accounts.py:69-73` `by_email(...).limit(1)` | Anmelden mit der **ersten** von mehreren gleichen Adressen | **lösen**: Regel 3. Heute meldet sich bei doppelter Adresse das ältere Konto damit an (Fixture: `kim`), künftig keins |
| `routers/auth.py:257-264` Bremse `login:<ip>|<eingetippt>` | Zähler je eingetipptem Text | **lösen** (wie nexmail): Name und Adresse sind zwei Zähler je Absender. Die **Sperre am Konto** (`accounts.note_failure`) zählt schon heute beides zusammen (Test „Bestand“). Nach dem Auflösen am Konto zählen |
| `oidc_store.py:351` `AccountState.name`, `358-362` `clean_name`/`name_taken` | Name fürs OIDC-Modul | lösen mit `nexoidc` 1.1.0: `nexkonten.clean_username`, `username_taken` |
| `oidc_store.py:364-379` `create_account(name, …)` | Name aus `preferred_username`; **Anzeigename bleibt leer** (Claim `name` kommt nicht an) | harmlos; mit 1.1.0 Anzeigename aus dem Claim |
| `routers/totp.py:83` `provisioning_uri(seed, account.name)` | Beschriftung im Authenticator | harmlos: alte Einträge zeigen den alten Namen, Codes gelten weiter |
| `deps.py:187, 199`, `api_v1.py:109`, `app1.py:105`, `mcp.py:144`, `oidc.py:313` `logs.set_actor(name)` und alle `logger…name=%s` | Name in Logzeilen | harmlos; alte Zeilen behalten den alten Namen. Neue Logzeile beim Umbenennen nennt beide |
| `routers/auth.py:146` `account_view.name`, `routers/app1.py:118` `login`, `routers/api_v1.py:151` `name`, `routers/invites.py:152` `signed_in_as` | Antwortfelder | harmlos, Feldnamen bleiben; Skripte sehen nach einer Änderung den neuen Namen |
| `services/shares.py:297-308` `find_people` | Suche beim Teilen auch nach `name` | harmlos: geteilt wird an die Konto-ID (`set_person(person_id)`), die Suche findet den neuen Namen |
| `notedoc/room.py:55`, `routers/notes.py:285`, `services/appsync.py:558`, `services/mcp.py:292`, `routers/tokens.py:111` | Anzeige (Mitbearbeiter, Besitzer) | harmlos |
| Sitzungen, Geräte (`api_tokens.account_id`), API-/MCP-/nexdeck-Tokens, OAuth-Verbindungen (`oauth_spent`), Push (`PushDevice.account_id`), Profilbild (`/api/avatars/{id}`), Teilen (`shares`), nextasks-Verbindung (`models_nextasks`, Name dort ist der des nextasks-Kontos), Tresor, Sicherungen | alle an der ID | harmlos: **nichts in nexnotes hängt einen Pfad, eine Datei oder einen Schlüssel an den Namen**. Kein DAV-Server |
| `frontend/src/pages/settings/AccountsTab.tsx:88` `data-testid="account-${row.name}"` | Kennung für Oberflächentests | harmlos (e2e-Tests müssen den Namen kennen) |
| iPhone `ServerAccount.login`, `SharedServer.login` | gespeicherte Anzeige | harmlos, bleibt bis zum Neukoppeln alt (Abschnitt 1). Beim Umstellen der App aus `/api/app/1/me` (`account.login`) auffrischen |

Ergebnis: **Ein Umbenennen bricht in nexnotes nichts.** Zu lösen sind nur `limit(1)` bei der Adresse und die Bremse.

## 3. Zuordnung nexnotes ↔ Modul

| Modul | nexnotes |
|---|---|
| `id` (`AccountId`, hier `int`) | `accounts.id` |
| `username` | `accounts.name` (Feldname der Schnittstelle bleibt `name`) |
| `display_name` | `display_name` |
| `email`, `email_source` | `email`, `email_source` (`provider` gibt es schon) |
| `email_confirmed` | neu `email_confirmed` |
| `pending_email` | neue Tabelle `email_changes` |
| `has_password` | `sign_in == "password" and password_hash != ""` (wie `oidc_store.account_state`) |
| `blocked` | `blocked_at is not None or deleted_at is not None` |
| `operator` | `role == "operator"` |
| `picture` | `avatar_at` leer → `""`, sonst `avatar_source or "own"` |
| `Invite` | `invites`; `rights` = die Zeile (Rolle); `display_name` neue Spalte; `username` immer `""` (nexnotes gab nie einen Namen vor) |
| `Reset` | `password_resets` (`created_by` NULL = selbst angefordert, neu möglich) |

Store `services/konten_store.py` (neu), eine Instanz je Anfrage wie `oidc_store.SqlStore`, mit `hold` für Abläufe,
die selbst committen. Abbildung der Methoden:

| Store | nexnotes |
|---|---|
| `count_accounts` | `accounts.count` (zählt gelöschte mit) |
| `find_by_username` | `name == lower(eingabe)`; **auch gesperrte und gelöschte** (ihr Name bleibt 30 Tage belegt, sonst scheitert das Wiederherstellen) |
| `find_by_email` | `lower(email) == lower(eingabe)`, **alle** Treffer (statt `limit(1)`), auch gelöschte |
| `add_account` | Zeile wie `create_with_password` (`whats_new_seen`, `sign_in`, `language`); Einladung: `accounts.redeem` (Rolle heben); `IntegrityError` auf `name` → `Taken("username")` |
| `set_username` | `name = …`; `IntegrityError` → `Taken("username")`. Kein Sitzungsende |
| `set_email` | `email`, `email_confirmed`, `email_source`; `provider_email` leeren, wenn gleich |
| `check_password` | `verify_password` gegen `password_hash` bzw. `_dummy_hash()` |
| `set_password` | `hash_password`, `password_changed_at`, `sign_in = password`, `failed_logins = 0`, `locked_until = None` |
| `end_sessions` | `security.end_all_sessions` (Browser, Geräte-Tokens, `device_key` neu) |
| `set_provider_picture` | `UPDATE accounts SET avatar=…, avatar_at=…, avatar_source='provider' WHERE id=… AND avatar_at IS NULL` über `services/avatars.py` (gleiche Aufbereitung wie ein Hochladen) |
| `find_invite` / `consume_invite` | `accounts.find_invite` (auch abgelaufen zurückgeben, mit `expires_at`) / `accounts.consume` |
| `start_reset` / `find_reset` / `consume_reset` / `drop_resets` | `password_resets` wie `create_reset` (ein Link je Konto); `find_reset` **ohne** die heutige Prüfung „Ersteller ist Betreiber“ (die macht das Modul, und `created_by` NULL ist neu erlaubt) |
| `start/find/consume/drop_email_change` | Tabelle `email_changes` |

`nexoidc` 1.1.0 kommt im selben Zug: `clean_name` → `nexkonten.clean_username`, `name_taken` →
`nexkonten.username_taken`, `create_account(…, display_name, picture)` setzt den Anzeigenamen aus dem Claim (heute
bleibt er leer), `provider_picture` im Hintergrund. `nexkonten.configure(AppConfig(app_name="nexnotes",
setup_token=lambda: get_settings().setup_token, logger_name="nexnotes.auth"))`: der Code kommt so auch aus einer
`.env` (pydantic-Einstellungen), nicht nur aus der Umgebung. `accounts.setup_code`, `_generated_code` und
`announce_setup_code` fallen weg, sonst stünde ein anderer Code im Log als der, den das Modul prüft.

## 4. Neue Spalten und Wanderung (nur ergänzend)

| Neu | Typ, Vorgabe | Bedeutung der Vorgabe |
|---|---|---|
| `accounts.email_confirmed` | Boolean, `default=True`, `server_default '1'` | **alle** Bestandsadressen gelten als bestätigt (Regel 2), auch die mit `email_source = provider`: `sam` im Fixture meldet sich heute mit der übernommenen Anbieteradresse an und muss es weiter können |
| `accounts.avatar_source` | String(16), `server_default ''` | vorhandene Bilder gelten als eigene |
| `invites.display_name` | String(80), `server_default ''` | Bestandseinladungen ohne Anzeigename (das Formular schlägt dann aus der Adresse vor) |
| Tabelle `email_changes` | `account_id` (eindeutig, FK CASCADE), `address`, `token_hash` (eindeutig), `expires_at` | leer im Bestand |
| `password_resets.created_by` | gibt es schon, nullable | NULL war bisher nie gesetzt; künftig = selbst angefordert |
| Index auf `lower(email)` | **nicht eindeutig** | Doppel gibt es im Bestand (Fixture `kim`/`lou`). Ein eindeutiger Teilindex `WHERE email <> ''` erst, wenn auf der Kopie der Live-Datenbank keins gezählt wurde, und dann nur aus einem eigenen Schritt, der vorher zählt (**nicht** über `table_index.create` in `init_db`, das risse den Start bei einem Doppel um) |

Alles läuft über `_add_missing_columns` (Sicherung davor ist schon da). Der Zählschritt für den Adressindex kommt als
`services/konten_wanderung.py` nach `init_db` und vor `_remember_version`. Rückweg auf 1.0.1 eine Fassung lang: alle
neuen Spalten haben eine Tabellenvorgabe, 1.0.1 schreibt weiter Konten; die neue Tabelle stört nicht. Einschränkungen
nach dem Rückweg: wartende Adressen bleiben liegen, selbst angeforderte Reset-Links gelten in 1.0.1 nicht (es prüft
den Ersteller), ein geänderter Name gilt weiter (gleiche Spalte).

## 5. Routen

**Feldnamen bleiben** (`name` ist in nexnotes der Benutzername, überall). Antworten bekommen höchstens Felder dazu.

| Route | Heute | Künftig |
|---|---|---|
| `GET /api/setup` | `needs_setup`, `code_required`, `min_password` … | unverändert |
| `POST /api/setup` | `display_name`, `email`, `password`, `password_confirm`, `language`, `code` | dazu `name` (frei; fehlt er, gilt `suggest_username(display_name)`) → `nexkonten.setup` |
| `POST /api/auth/login` | `name` (Adresse oder Name), `password` | Feldname bleibt → `nexkonten.resolve_login` + Sperre/bekannter Browser der App + Passwort (siehe Lücke L2). Fehlertext „Benutzername, E-Mail oder Passwort stimmt nicht.“, Kennung bleibt `wrong_credentials`. `password_login_off` bleibt nach der Passwortprüfung |
| neu `POST /api/auth/forgot` | – | `name` → `nexkonten.forgot`; nur mit Mailserver, öffentlicher Adresse, Passwort-Anmeldung; Antwort immer 202; Mail im Hintergrund |
| `GET/POST /api/reset/{token}` | Betreiber-Link | bleibt; `reset_state`/`use_reset`; GET gibt dazu `username` |
| `GET /api/auth/me` | … `name`, `display_name`, `email`, `provider_email` | dazu `email_confirmed`, `pending_email` |
| `PUT /api/me/profile` | `display_name`, `email` | bleibt; dazu `name` und `password`. Leerer `display_name` wird **erlaubt** (Modul; heute `display_name_empty`). Adresse über `change_email` (mit Mailserver wartet sie), `name` über `change_username`. Vom Gerät (Bearer) weiter nur `display_name` |
| neu `GET/POST /api/email/{token}`, `DELETE /api/me/pending-email` | – | Bestätigungslink, wartende Adresse zurücknehmen |
| `POST /api/oidc/me/address` | Anbieteradresse übernehmen | bleibt App-Sache, schreibt über `store.set_email(..., source="provider")` (Lücke L6) |
| `POST /api/invites` | `days`, `email`, `role`, `send`, `language` | dazu `display_name`; `invite_values` prüft Adresse und Anzeigenamen |
| `GET /api/invite/{token}` | `by`, `email`, `role`, `min_password`, `password`, `signed_in_as` | dazu `display_name`, `name` (Vorschlag aus `invite_form`) |
| `POST /api/invite/{token}` | `display_name`, `email`, `password`, `password_confirm` | dazu `name` (frei; fehlt er, gilt der Vorschlag) → `accept_invite`; das Formular von 1.0.1 geht weiter (Test „Bestand“) |
| `POST /api/accounts/{id}/reset-link` | `days`, `current_password` → `link` | → `reset_link`; mit Mailserver und Adresse per Mail (`sent: true`), sonst `link`; `days` wird angenommen, aber ignoriert (24 Stunden), falls die feste Dauer gilt (Frage 2) |
| neu `PUT /api/accounts/{id}/name`, `PUT /api/accounts/{id}/display-name`, `DELETE /api/accounts/{id}/email` | – | Betreiber, mit eigenem Passwort (bzw. frischer Anbieteranmeldung, Lücke L1) |
| `GET /api/accounts` | … | dazu `email_confirmed`, `email_duplicate` |

Fehlerkennungen, die sich ändern (Werte, keine Feldnamen): `invalid_email` → `email_invalid`, `name_taken` →
`username_taken`, `invalid_account_name` → `username_invalid`. Die iPhone-App liest keine davon (sie ändert nur den
Anzeigenamen); die Oberfläche bekommt sie über `accountErrorKey`.

## 6. Oberfläche

Vorgabe (24.11.2026): optisch so wenig wie möglich, und nexnotes **ist** das Vorbild. Gebaut wird nur aus den
vorhandenen Bausteinen: `AuthFrame`, `AuthField` (Beschriftung oben, Hinweis klein darunter), `Primary`, `Problem`,
`Warning`, `PasswordConfirmField`, `ProviderButtons`, `Card`, `Field`, `Avatar`, `Dialog`, `Input`, `Select`, `Toggle`,
`MenuItem`, `CopyLink`. Kein neuer Baustein. Wortlaute aus `vendor/nexkonten` (Namensraum `account`) neben den
eigenen in `i18n/{de,en}.json`.

| Bildschirm | Heute | Künftig | Sichtbar anders |
|---|---|---|---|
| **Ersteinrichtung** (`SetupPage`) | Einrichtungscode, „Name“, E-Mail, Passwort, Passwort wiederholen; Sprache unsichtbar aus dem Browser | Einrichtungscode (`setupCodeHint`), Anzeigename, **Benutzername** (folgt dem Anzeigenamen, bis man ihn anfasst), E-Mail (`emailHint`), Passwort, Passwort wiederholen, Sprache (`Select`, vorbelegt aus dem Browser; Frage 4) | ein, ggf. zwei Felder mehr; „Name“ heißt „Anzeigename“; Hinweistexte aus dem Entwurf |
| **Anmelden** (`LoginPage`) | Feld „E-Mail“ (`autoComplete="username"`), Passwort, „Passwort vergessen?“ klappt den Satz „Der Betreiber kann dir … einen Link erstellen“ auf, Anbieterknöpfe | Feld „Benutzername oder E-Mail“, Passwort; „Passwort vergessen?“ führt mit Mailserver zur neuen Seite, ohne zeigt es den Satz wie heute (`account.forgotNoMail`) | Beschriftung; Fehlertext |
| **Passwort vergessen** (neu) | – | `AuthFrame` mit einem `AuthField` „Benutzername oder E-Mail“, `Primary`; danach immer `account.forgotSent` | neue Seite, nur mit Mailserver |
| **Einladung annehmen** (`InvitePage`) | „Name“, E-Mail (vorbelegt), Passwort zweimal, darunter Anbieter | Anzeigename (vorbelegt aus der Einladung), **Benutzername** (Vorschlag), E-Mail (vorbelegt), Passwort zweimal, darunter „oder“ und die Anbieter wie heute | ein Feld mehr, „Name“ heißt „Anzeigename“ |
| **Neues Passwort** (`ResetPage`) | „Für {{name}}“ (Anzeigename) | Satz nennt den Benutzernamen | ein Wort |
| **E-Mail bestätigen** (neu) | – | `AuthFrame` mit Adresse und `Primary` | neue Seite, nur mit Mailserver |
| **Profil** (`AccountTab`, Karte „Profil“) | Bild; „Name“ und E-Mail in einer Zeile mit „Speichern“; Rolle klein; Kasten „Anbieteradresse übernehmen“; Sprache | Bild; Anzeigename, **Benutzername**, E-Mail (darunter, solange eine wartet, `account.emailPending` mit „Zurücknehmen“); „Speichern“; Benutzername oder E-Mail geändert und Passwort vorhanden: `Dialog` mit Passwortfeld (`account.confirmWithPassword`); Rolle, Angebotskasten, Sprache wie heute | Benutzername sichtbar; Passwortabfrage beim Ändern der Adresse (heute ohne); Anzeigename darf leer sein |
| **Konten** (`AccountsTab`) | Zeile: Anzeigename, darunter klein `email || name`; Menü mit „Link zum Zurücksetzen“ (Dialog mit „Gültig“ 1/7/30 Tage); Einladen-Dialog: E-Mail, Rolle, Gültig, „Per Mail senden“ | Zeile: Anzeigename, darunter klein „Benutzername · E-Mail“, Hinweis `account.emailDuplicate`; Menü dazu „Benutzername ändern“, „Anzeigename ändern“, „Adresse entfernen“ (je `Dialog` mit eigenem Passwort); Reset-Dialog ohne „Gültig“ (falls 24 h fest) und mit Mailversand; Einladen-Dialog dazu **Anzeigename** (frei), kein Benutzername | neue Menüpunkte, zweite Zeile zeigt immer den Benutzernamen |

Vor dem Festschreiben wird jede geänderte Ansicht gezeigt und abgenommen. Die Oberflächentests (`e2e/*.spec.ts`)
suchen Beschriftungen wie „E-Mail“ am Anmeldefeld und „Name“; sie wandern mit den Wortlauten.

## 7. Passwort vergessen: beide Wege

- **Selbst per Mail** (neu): `POST /api/auth/forgot`, Link eine Stunde, einmal, beendet Sitzungen und Geräte; nur an
  eine bestätigte, eindeutige Adresse eines Kontos mit Passwort. Mailtext DE/EN in `services/mailer.py` (neu
  `send_reset`, `send_confirm_email`, `send_username_changed`), Sprache über `mailer.language_for`.
- **Betreiber-Link** wie heute, mit Mailversand dazu. Für ein Konto nur über Anbieter gibt er ein erstes Passwort
  (Entwurf: erlaubt, wenn die Passwort-Anmeldung an ist; heute in nexnotes schon so).
- Der Hinweis „Passwort wurde über den Link des Betreibers gesetzt“ (`password_reset_notice`, NOTES-2 AC-7) gilt nur
  für Betreiber-Links, nicht für den selbst angeforderten (Lücke L4).

## 8. Test „Bestand“

`backend/tests/test_bestand.py` mit `backend/tests/bestand/bestand-1.0.1.sql.gz` (gebaut von 1.0.1 mit
`tests/bestand/bauen.py`, Beschreibung in `bestand-1.0.1.json`). Start:

    cd backend && .venv/Scripts/python -m pytest tests/test_bestand.py -q

Konten: `betrieb` (Betreiber aus der Einrichtung mit Code, Adresse, zweiter Faktor), `erika-muster` (ohne Adresse,
offene Sitzung, offener Betreiber-Reset-Link), `jonas` (Adresse aus der Einladung, API-Token), `kim`/`lou` (dieselbe
Adresse in anderer Schreibweise, nachgestellter Wettlauf zweier Profilspeicherungen mit den Funktionen von 1.0.1),
`mona` (zweiter Faktor, gekoppeltes iPhone), `sam` (Passwort und Anbieter, hat die Anbieteradresse übernommen),
`robin.sso` (nur Anbieter, als Betreiber eingeladen), `gesperrt`, `weg` (gelöscht, wiederherstellbar), eine offene
Einladung (30 Tage).

Geprüft (44 grün): Start ergänzt nur; jedes Konto mit Name, Adresse, Herkunft, Rolle, Sperre; Anmelden mit Name (auch
in Großbuchstaben), mit eindeutiger Adresse in jeder Schreibweise (auch die übernommene Anbieteradresse), falsches
Passwort, Wiederherstellungscode, gesperrt erst nach richtigem Passwort, gelöscht bleibt draußen und kommt mit
Wiederherstellen zurück, „Passwort-Anmeldung aus“, Sperre nach 10 Fehlversuchen **am Konto** (Name und Adresse
gemischt), Anbieter (Rolle bleibt), kein Passwort für Anbieter-Konten, Sitzung, Gerät (`login`), API-Token, offene
Einladung mit dem Formular von 1.0.1, offener Reset-Link (einmal, beendet Sitzungen, Hinweis an).

Strikte `xfail` (werden mit der Anbindung grün, dann Marker entfernen): eine doppelte Adresse meldet **keins** der
beiden Konten an (heute `kim`), „Passwort vergessen“ per Mail mit Name und eindeutiger Adresse (je Konto). Immer grün:
eine doppelte Adresse und ein Konto ohne Adresse bekommen nie einen Link per Mail.

Gegen neun Mutationen geprüft, jede Rückgabecode 1: Adresssuche mit Groß/Klein, Anmelden nur mit Namen, Name mit
Groß/Klein verglichen, Start löscht offene Einladungen, Start beendet Sitzungen, Start löscht Reset-Links, Sperre
zählt nur bei Eingabe des Namens, gelöschtes Konto meldet sich an, und Regel 3 vorab gebaut (die doppelte Adresse
meldet keinen mehr an): dann wird das strikte `xfail` rot, wie es soll.

Der Vertragstest des Moduls (`tests/nexkonten/test_nexkonten_existing.py`) fragt die App über `Adapter.legacy()`
nach einer Datenbank der Vorfassung und einer Liste `(eingetippt, Passwort, geht)`. Die Fixture hier liefert beides:
`legacy()` lädt `bestand-1.0.1.sql.gz` wie `test_bestand.py` und baut die Liste aus `bestand-1.0.1.json` (Name und
eindeutige Adresse: geht; doppelte Adresse, gesperrt, gelöscht, nur Anbieter: geht nicht).

Vor dem Aufspielen dieselbe Probe auf einer **Kopie** der Live-Datenbank (Regel 11): doppelte Adressen zählen
(`SELECT lower(email), count(*) FROM accounts WHERE email <> '' GROUP BY 1 HAVING count(*) > 1`), dann die neue
Fassung gegen die Kopie starten.

## 9. Risiken

1. **Doppelte Adressen im Bestand**: Wer sich heute als „erstes“ Konto mit einer geteilten Adresse anmeldet, kann es
   danach nur noch mit dem Benutzernamen, und den hat er nie gesehen (heute unsichtbar). Die Anmeldeseite muss den
   Namen dann nennen können: Hinweis des Betreibers in der Kontenliste, Benutzername im Profil sichtbar.
2. **Unsichtbare Namen**: Alle Bestandskonten kennen ihren Benutzernamen nicht (`erika-muster`, `robin.sso`). Wer sich
   mit Adresse anmeldet, merkt nichts; Konten ohne Adresse melden sich heute schon mit dem Namen an (sie haben ihn vom
   Betreiber).
3. **Eindeutiger Adressindex** darf den Start nie abbrechen (Abschnitt 4).
4. **Betreiber ohne Passwort** (`robin.sso`) verliert Betreiberhandlungen, wenn das Modul so bleibt (Lücke L1).
5. **Codes in Fehlermeldungen** ändern sich (Abschnitt 5); Skripte, die `invalid_email` prüfen, sehen `email_invalid`.
6. **Profil vom Gerät**: `PUT /api/me/profile` mit Bearer darf weiter keine Adresse ändern; auch keinen Benutzernamen
   (sonst änderte ein gestohlenes Gerät die Anmeldung).
7. **Link-Dauern**: Betreiber wählen heute 1, 7 oder 30 Tage für Einladung und Reset-Link; der Entwurf sagt 7 Tage und
   24 Stunden (Frage 2).
8. **Mails**: nexnotes hat heute nur die Einladungsmail; drei neue Mailtexte in zwei Sprachen.

## 10. Offene Fragen

1. Betreiber, die nur über einen Anbieter kommen: sollen sie andere umbenennen und Reset-Links machen dürfen (heute
   ja, mit frischer Anbieteranmeldung)? Dann braucht das Modul Lücke L1.
2. Gültigkeit: Bleibt die Auswahl 1/7/30 Tage für Einladung und Betreiber-Link in nexnotes, oder gilt überall fest
   7 Tage bzw. 24 Stunden?
3. Übernommene Anbieteradresse (Angebotskasten): gilt sie nach der Übernahme als bestätigt (heute meldet man sich
   damit an)? Sonst verliert jedes Konto, das ab jetzt übernimmt, das Anmelden mit Adresse.
4. Sprache bei der Einrichtung: sichtbares Auswahlfeld (Entwurf) oder weiter unsichtbar aus dem Browser (heute)?
5. Reset-Link für ein **gesperrtes** Konto: heute erlaubt, das Modul lehnt ab. Passt das?

## 11. Reihenfolge beim Bau

1. `nexkonten` und `nexoidc` 1.1.0 per `sync.py` holen, Vertragstests grün.
2. Spalten, Tabelle `email_changes`, `services/konten_store.py`, Vertragsadapter.
3. Login, Setup, Einladung, Reset über das Modul; Bremse am Konto; Test „Bestand“ grün, `xfail` für Regel 3 weg.
4. Profil (Benutzername, Adresse mit Link), Betreiberaktionen, „Passwort vergessen“ per Mail; zweite `xfail` weg.
5. Oberfläche nach Abschnitt 6, abnehmen lassen; iPhone-App: Beschriftung „Benutzername“, `login` beim Laden auffrischen.

## 12. Passt das Modul?

Gegenüber `SCHNITTSTELLE.md` (Zweig `konten`, 0.1.0). **L** = Lücke (die Schnittstelle muss etwas ändern oder
ergänzen), **R** = Reibung (geht, aber mit Umweg in der App).

| | Was nexnotes braucht | Was die Schnittstelle hergibt | Vorschlag |
|---|---|---|---|
| **L1** | Betreiber **ohne Passwort** (nur Anbieter) bestätigen Betreiberhandlungen mit frischer Anbieteranmeldung (`deps.confirm_operator` → `_fresh_from_provider`) | `common.acting` und `reset_link` verlangen `actor.has_password` und prüfen das Passwort selbst: ein solcher Betreiber kann weder umbenennen, Adressen entfernen noch Reset-Links machen (heute kann er Reset-Links) | Parameter `actor_confirmed: bool = False` (die App hat schon bestätigt), oder ein Store-Haken `confirm_actor(actor_id, password) -> bool`. Nebenbei: Die App prüft das Passwort heute mit eigener Bremse (`reauth_guard/failed/succeeded`); prüft das Modul noch einmal, rechnet Argon2 doppelt |
| **L2** | Sperre nach 10 Fehlversuchen am Konto, ein „bekannter Browser“ darf trotz Sperre (`authenticate(..., device)`), Prüfungen eines Kontos nacheinander (`_one_check_at_a_time`) | `authenticate` kennt keine Sperre und sagt bei `wrong_credentials` nicht, welches Konto es war; die App kann keine Fehlversuche zählen, ohne `resolve_login` selbst noch einmal aufzurufen | `authenticate(store, typed, password, *, locked=None, failed=None)` mit zwei Rückrufen, oder `AccountError.extra["account_id"]` bei falschem Passwort, oder Store-Methoden `is_locked(id)`/`note_failure(id)`/`note_success(id)`. Die Regel „Bremse zählt am Konto“ steht im Entwurf, die Schnittstelle gibt dafür nichts her |
| **L3** | Betreiber wählt die Gültigkeit (1/7/30 Tage) von Reset-Link und Einladung | `reset_link` fest 24 Stunden (`OPERATOR_HOURS`) | entweder `hours`-Parameter, oder es gilt „24 h überall“ (Frage 2) |
| **R4** | Hinweis nach Betreiber-Link (`password_reset_notice`) nur, wenn der Link vom Betreiber kam | `use_reset` ruft `set_password(id, password)` ohne zu sagen, woher; gibt nur `Account` zurück | `set_password(id, password, *, reset: Reset | None = None)` oder `use_reset` gibt `(Account, Reset)`. Umweg heute: die App liest vorher selbst `store.find_reset(token)` |
| **L5** | Name und Adresse **gelöschter** Konten bleiben 30 Tage belegt (sonst scheitert das Wiederherstellen am eindeutigen Namen) | `find_by_username`/`find_by_email` sagen nicht, ob gesperrte/gelöschte dazugehören | im Vertrag festschreiben: „auch gesperrte und gelöschte“, mit Vertragstest |
| **L6** | Übernommene Anbieteradresse (Angebot an Konten mit Passwort) gilt heute fürs Anmelden; `email_source = provider` | Schnittstelle: „Adresse vom Anbieter gilt nicht als bestätigt“; `email_confirmed` und `email_source` sind zwar getrennte Felder, der Text koppelt sie | klarstellen, dass `email_confirmed` unabhängig von `email_source` ist und die App bei einer vom Menschen übernommenen Adresse `confirmed=True, source=provider` schreiben darf (Frage 3) |
| **R7** | Einrichtungscode kommt aus pydantic-Einstellungen (auch `.env`) | Vorgabe liest nur `os.environ` | geht mit `AppConfig.setup_token=callable`; in SCHNITTSTELLE erwähnen, dass Apps mit Einstellungsobjekt das übergeben müssen |
| **R8** | Geräte (Bearer) dürfen Anzeigename ändern, aber weder Adresse noch Benutzername | Modul kennt keine Herkunft der Anfrage | App-Sache, vor dem Modulaufruf; im README des Moduls als Hinweis für alle Apps mit Geräte-API |
| **R9** | Sprache prüft nexnotes gegen die vorhandenen Sprachen (`check_language`) | `clean_language` nimmt jedes Sprach-Tag | App prüft vorher; harmlos |
| **R10** | Fehlerkennungen `invalid_email`, `name_taken`, `invalid_account_name` | feste Liste `email_invalid`, `username_taken`, `username_invalid` | hinnehmen (Abschnitt 5) oder eine Abbildung je App; im Entwurf steht nur „Feldnamen bleiben“, nichts zu Fehlerkennungen |
| **R11** | Reset-Link für gesperrte Konten (heute erlaubt) und für sich selbst | Modul lehnt beides ab (`account_blocked`, `use_account_page`) | hinnehmen (Frage 5) |
| **R12** | `display_name` heute Pflicht im Profil | Modul erlaubt leer | hinnehmen (Entwurf will es so); sichtbare Änderung |
