# Anbindung des Kontenmoduls (`nexkonten`) an nexnotes

Stand 24.11.2026, Zweig `konten`. Vorbereitung, noch nichts angebunden. Maßgeblich sind der Entwurf in nexlore
(`Development/nexapps/Baupläne/Entwurf Konten, Einrichtung und Anmeldung.md`) und die Schnittstelle des Moduls
(`bauplaene/konten/SCHNITTSTELLE.md`, Zweig `konten`, Fassung 0.1.0). Wo nexnotes etwas braucht, das die Schnittstelle
nicht hergibt, steht es unter „Passt das Modul?“ (Abschnitt 12); offene Entscheidungen unter „Offene Fragen“.

nexnotes ist für das Modul das Vorbild (Weg „nexnotes und nextime“, Oberfläche nach `AuthPages.tsx` und
`AccountTab.tsx`). Es ändert sich deshalb weniger als in den anderen Apps: Der Benutzername (`accounts.name`) wird
sichtbar und änderbar, „Passwort vergessen“ bekommt den Weg per Mail, Adressen bekommen einen Bestätigungslink.

## 0. Was gebaut ist / was fehlt

### Durchgang „Einstellungen“, Teil 1 (25./26.11.2026)

Nach dem Bauplan in nexlore `Development/nexapps/Baupläne/Bauplan Einstellungen.md`. Aus `bauplaene` Zweig `konten`:
**`ui` 1.1.0, `log` 1.0.0, `sicherung` 1.0.0** (je `tools/sync.py copy`). `konten`, `oidc`, `post` stehen noch auf 1.0.0 /
1.1.2 / 1.0.0 (Teil 2), `schluessel` fehlt noch (Teil 3).

| Bereich | woher jetzt | was gewandert ist (alt → neu) |
|---|---|---|
| Gerüst | `SettingsLayout`, `SettingsNav`, `SettingsPage` (ui) in `pages/SettingsPage.tsx`; Titel und Zeilen der gemeinsamen Bereiche aus `areaText` | eigene `SettingsNav`/`SettingsJump` (Auswahlliste schmal) → Liste unter `/settings` auf dem Handy, Bereich mit Rückweg; Slugs unverändert, alte Pfade (`/settings/account`, `/settings/server`, `/about`) leiten weiter um |
| Darstellung | `pages/settings/AppearanceArea.tsx`: „Aussehen“ (`ThemeSegment`), „Papier neuer Notizen“, „Notizlisten“ (`Segment`, `CheckboxRow`), „Anleitung“ | Karte „Aussehen und Papier“ → zwei Karten; Hell/Dunkel bleibt bis konten 1.1.0 im Browser (`TODO konten 1.1.0`) |
| Verbindungen | „Geräte“ (Rows, Badge, `sm` danger „Trennen“, primary „iPhone oder iPad verbinden“), neu „Auf diesem Gerät installieren“ (`pwa/InstallCard.tsx`, nur wenn der Browser es anbietet oder auf iPhone/iPad), „nextasks“ als `Collapsible variant="card"`, API-Token/MCP unverändert (Teil 3) | eigene Faltkarte → `Collapsible` (Klappzustand weiter `fold.nextasks` je Gerät) |
| Allgemein | `pages/settings/GeneralCards.tsx`: „Grenzen“ (`Field action`), „Funktionen für alle Konten“ (`CheckboxRow`), „Sprachen“ (`Chip`, `Field action` „Sprache hochladen“) | Proxy-Hinweis bleibt bis „Bereit fürs Internet?“ (als `Notice`); MCP/API-Schalter bis „Schnittstellen“ (schluessel) |
| Speicher und Sicherung | Modul sicherung: `StorageArea` über `/api/server/storage`; Haken `services/backup_hooks.py` (Format unverändert: `nexnotes-backup.json`, `database/nexnotes.db`, `attachments/`, `secret.key`) | eigene `BackupsCard` → Karten „Speicher“ und „Sicherung“; neu Uhrzeit (`backup_time`, Vorgabe 03:00) und „Jeden Monat“; alte Wege `/api/backups/*` mit `x-nexnotes-password` über `legacy_router` in alter Form; vorgemerkter Restore jetzt mit Marke `nexsicherung-pending.json` |
| Texterkennung | `OcrCard` mit `Segment multiple` (mindestens eine Sprache) | Knopfreihe mit `aria-pressed` → Segment |
| Log | Modul log: `services/logs.py` = `configure` + `from app.vendor.nexlog import *`, `routers/logs.py` = `nexlog.api.router`, Karte `LogCard` des Moduls | Format, Datei, Schlüssel `log_mode`/`log_mode_until` unverändert; geschwärzt jetzt auch `nn_api_`, `nn_mcp_`, `nn_deck_`, `nnd_`; `GET /api/logs/level` nennt `variable` |
| Über | `AboutPage` (ui) in `pages/settings/AboutArea.tsx`, Logo `/logo.svg` | eigene Seite → drei Karten `about`, `about-updates`, `about-built-with`; nexnotes' Satz „was hinausgeht“ bleibt |
| Profil, Sicherheit, Anmeldung, Mail, Konten | unverändert (Teil 2) | – |

Umwege von Teil 1 (`backup_hooks.DAMAGE` mit `zlib.error`, `tidy()` für leere Archive) sind mit sicherung 1.0.1 weg
(siehe Teil 2 und 3).

### Durchgang „Einstellungen“, Teil 2 und 3 (26.11.2026)

Aus `bauplaene` Zweig `konten` (`bauplaene-stand`): **`konten` 1.1.0, `oidc` 1.2.0, `post` 1.1.0, `schluessel` 1.0.0**;
**`sicherung` 1.0.1** aus `bauplaene-einst` (`c21542d` und Nachtrag `b874a2c`). Alle mit `tools/sync.py copy`, `check`
grün. ruff nimmt die Module samt Vertragstests aus (`pyproject.toml`, wie oidc/log/sicherung schon).

| Bereich | woher jetzt | was gewandert ist (alt → neu) |
|---|---|---|
| Profil | `PAGES.profile` wie bisher; `UnconfirmedEmailBox` (wo `showUnconfirmed`, Route `POST /api/me/email/prove`), `SignOutCard` | eigene Karte „Abmelden“ → Modulkarte (Satz mit `{{things}}`, Rückfrage bei wartenden Änderungen, gezählt beim Drücken); `me.mail_server`, `me.email_proven` |
| Darstellung | `AppearanceCard` (konten) | Hell/Dunkel im Browser (`TODO konten 1.1.0`) → Spalte `accounts.theme`, `PUT /api/me/theme`; beim Laden `POST /api/me/theme/adopt` mit dem Wert von `nexnotes.theme` (einmal, wenn das Konto keinen hat); `lib/theme.takeAccountTheme`, der Browser behält den Wert für den ersten Anstrich |
| Verbindungen | „Geräte“, „Auf diesem Gerät installieren“ (immer, E28), „nextasks“, `ApiKeysCard`, `ToolsCard` (schluessel) | `tokens/TokensSection.tsx` → Modulkarten über `/api/connections` (`tokens/KeysCards.tsx`, Wörter für Ordner); Install-Karte: Knopf „Installieren“ oder Weg je Browser (iPhone/iPad, Safari Mac, Firefox, andere), installiert „läuft schon“ |
| Allgemein | „Grenzen“, „Funktionen für alle Konten“, `InterfacesCard` (schluessel), „Sprachen“ | Haken MCP/API aus „Funktionen“ → „Schnittstellen“; Proxy-Hinweis → „Bereit fürs Internet?“ |
| Anmeldung | `SignInPage` (konten) + `SignInProviders` (oidc), `pages/settings/SignInArea.tsx` | `SignInCards.tsx` weg; Schalter über `GET/PUT /api/server/sign-in` (`signin.view`/`change`), Bereitschaft `GET /api/server/sign-in/readiness` (`readiness.check`, Klappzustand je Gerät `fold.ready`); öffentliche Adresse weiter über `PUT /api/settings` |
| Mail | `MailCard` (post) über `/api/server/mail` (`routers/server_mail.py`) | eigene Karte weg; Satz der App nennt alle Mails (`server.mailHint`); alte Wege `/api/settings` (`smtp_*`), `POST /api/settings/mail-test` bleiben |
| Speicher und Sicherung | sicherung 1.0.1 | `archives.tidy_at_start()` beim Start (`main.lifespan`, Adapter `restart`); eigenes `tidy()` nur noch für Beiseitegelegtes einer Wiederherstellung, `DAMAGE = tools.DAMAGE` |
| Konten | `manage.*` (konten) in `routers/accounts.py`, `capsOf('nexnotes', …)`, `storageFact`, `STORAGE_LIMIT_DIALOG`, `WhatYouSeeCard`, `AllKeysCard` | eigener Knopf „Speichergrenze“ (`OwnButton`) → eingebaut; Karte „Was du siehst“ aus dem Modul mit nexnotes' Satz; „API-Token aller Konten“ → „API-Schlüssel aller Konten“ |
| Fenster aus den Einstellungen (E31) | Bausatz `Dialog`, `Field`, `CheckboxRow`, `Button`, `Notice` | Tresor „Neues Passwort“, „Passwort vergessen“ (dieselbe Einrichtungsform auch beim ersten Sperren einer Notiz), „iPhone oder iPad verbinden“; `pages/settings/ui.tsx` ganz weg (`SignInAgain` als eigene Datei aus dem Bausatz, `Outcome` statt `Feedback`) |

**Server, konten 1.1.0:** `KontenStore` beantwortet `ManageStore`, `ThemeStore`, `SignInStore` (`model3.py`); `_account`
füllt `blocked_at`, `deleted_at`, `theme`, `storage_limit`. Wanderung: Spalte `accounts.theme` (leer); beim Start, der
sie anlegt, genau einmal `email_proven = 1` für jede zählende Adresse (E23, `konten_wanderung.run(added=…)`,
`db._add_missing_columns` nennt jetzt die neuen Spalten). Hausputz `accounts.purge_deleted` → `manage.purge_due`
(`purge_account`: `content.account_purged`, Namen bleiben reserviert). `services/accounts.block/unblock/delete/restore`
gehen über dieselben Store-Schritte und Ereignisse. Alte Wege `PUT /api/settings` mit `password_login`,
`two_factor_required`, `passkeys_allowed` gehen über `signin.change` (Abschalten des Faktors jetzt mit `current_password`).

**Server, post 1.1.0:** `mail_outbox.letter_key` (eindeutiger Index, nur hinzufügend), Brief als `letter_data`,
`waiting`, `on_commit`, `recipient`; `AppConfig(outbox_runner=…)` (Kontomails sofort, ohne Hintergrund bei
`disable_background`). Eigener Mailer weg: Einladung `outbox.deliver_now(compose("invite"))`, Testmail
`outbox.test_mail`, „Passwort vergessen“ `deliver_now`; `services/mailer.py` behält nur Sprache, `configured`,
`one_line` und `old_code` (alte Kennungen `mail_off`/`mail_failed`/`invalid_email`, `mail_code` dazu).

**Server, schluessel 1.0.0:** `services/schluessel_store.py` (`CONFIG` = Vorschlag aus `tests/app_configs.py`, gegen
`apitokens` geprüft: `nn_api_`, `nn_deck_` als alte Form, `nn_mcp_` nur noch vorhanden, Programme über OAuth, 20 je
Konto, 30/90/365/nie, `tokens_too_many`), `KeyStore` über `api_tokens` ohne Geräte, Ordner als Bereiche (Eingang zuerst,
Pfad im Namen), `keys_wait` = `totp.factor_missing`. Routen `routers/connections.py` unter `/api/connections`
(`DEVICE_REFUSED_PREFIXES`). Alte Wege `/api/tokens` (Anlegen über `keys.make`, gewählte Ordner-Reihenfolge bleibt,
Widerrufen `keys.revoke`) und `/api/admin/tokens` (Sperren `keys.block`) in alter Form; die Prüfung beim Vorlegen bleibt
nexnotes' (`apiaccess`). OAuth bleibt in `routers/oauth.py` (E27).

**Umwege und Abweichungen** (Fragen in `einst-fragen/nexnotes.md`): `shut_out` lässt Browser-Sitzungen und eine
wartende Anmeldung stehen (zählen nichts, solange gesperrt; Frage 5); `frontend/src/nexpost.test.ts` mit
`count` (`TODO post 1.1.0`, Frage 2); `frontend/src/nexschluessel.test.tsx` ohne den Namen aus der Vorlage (Frage 3).

**Tests neu:** `backend/tests/test_settings_pass.py` (Theme und Übernahme, Box mit Link, Faktor nur mit Passwort auf
altem und neuem Weg, Passwort-Anmeldung nur mit Anbieter, nur Betreiber, Bereitschaft mit Proxy, Mail-Seite und alter
Weg, alte und neue Schlüsselwege dieselben Schlüssel, Geräte nie dabei, Schnittstellen = alte Schalter; je eine
Mutation rot), `frontend/src/pwa/install.test.tsx` (Mutation rot), `frontend/src/pages/signInArea.test.tsx` (aus
`signInCards.test.tsx`), `frontend/src/tokens/tokens.test.tsx` auf die Modulkarten (Mutation rot), Vorlagen
`nexkonten.cards.test.tsx`, `nexoidc.cards.test.tsx`, `nexpostMailCard.test.tsx`, `nexschluessel.test.tsx`; Adapter um
`age_deletion`, `provider_active`, `readiness` (konten), `account`, `client` (post), neu `nexschluessel_adapter.py`.

**Nach Bauplan E31 und E33:** Fenster nur aus den Einstellungen aus dem Bausatz (die übrigen in den Fragen unter
„Nach Stufe 1“); ein Konto mit geschuldetem zweiten Faktor erreicht `/api/connections/keys` (`deps.SETUP_ONLY_PREFIXES`,
Schlüssel ruhen bis zum Faktor); auch die alten Listen `GET /api/tokens`, `GET /api/admin/tokens` über `keys.listing`
bzw. `keys.overview`; Passwortfelder mit den Wörtern des Moduls (`account.password`, `account.currentPassword`,
`account.newPassword`, `account.passwordRepeat`). Vorlagen-Kopien tragen die Kopfzeile `// Vorlage <Paket> <Fassung>`
(bauplaene-stand `bef0132`, `check` ok für alle sieben Module).

**Nachgezogen auf bauplaene-stand 7685875 und b0d3618 (E33 bis E38) und Bauplan E41:**
- `things`/`thingsDative` (Notizen/Notizen) an Gerüst, Log und „API-Schlüssel“.
- Spalte „Ordner“ in „API-Schlüssel aller Konten“ über `admin_extra`; der Anfang eines Schlüssels bleibt beim Betreiber
  verborgen.
- Der Satz zur Anbieter-Ausnahme am Faktor-Haken kommt aus konten.
- `KontenStore.on_shut_out`/`on_back`; Push-Abos hängen in nexnotes an Sitzung und Gerät (Frage 11).
- Vorlagen-Kopien mit den Änderungen und Kopfzeilen von 7685875; sicherung aus b0d3618 ohne Ausschlüsse in
  tsc/eslint; Satz für `restore_options_invalid`.
- E44: „Speicher für neue Konten“ (GB, leer = ohne Grenze) in Allgemein › Grenzen als `Field action`; Einstellung
  `new_account_storage_limit` (Bytes, `GET/PUT /api/settings`), jedes neue Konto (Einrichtung, Einladung, Anbieter)
  startet damit, vorhandene behalten ihre Grenze (Tests `test_settings_pass.py`, `limits.test.tsx`).
- E41: Eigene Schlüssel ruhen beim Sperren und Löschen und kommen mit dem Konto zurück; Geräte und OAuth-Programme
  werden getrennt (`apitokens.shut_out`, Test `test_keys_rest.py`).

**Nachgezogen auf bauplaene-stand a374e3c (E44) und Verweise (E39):**
- post: `catch_mail` fängt jeden Weg und verweigert echte Mailserver; kein Test von nexnotes erreichte einen
  (gemessen mit einem Wächter um den ganzen Lauf). `test_accounts.py` nimmt `catch_mail` statt eines eigenen Ersatzes
  für `send.deliver`.
- log: nach „Bearer“ bleibt die Vorsilbe sichtbar; der Adapter prüft es für `nn_api_`, `nn_mcp_`, `nn_deck_`, `nnd_`,
  `nxa_`.
- konten: „Gespeichert.“ auf der Seite Anmeldung erst nach dem Speichern; der neue Test der Vorlage
  `nexkonten.cards.test.tsx` von Hand übernommen.
- E39: Oberfläche, Anleitung (DE/EN), README, `docs/api.md` und die Beschreibung unter `/api/v1/docs` sagen
  „API-Schlüssel“/„API key“ und nennen die Orte der Navigation (Mein Konto › Verbindungen, › Sicherheit, Server ›
  Anmeldung, Server › Allgemein › Funktionen für alle Konten; bei nextasks dessen Mein Konto › Verbindungen ›
  API-Schlüssel). Kapitel „API-Schlüssel und MCP“, nexdeck-Karte „seit nexdeck 1.11.0, als Beta“, Hinweise auf
  „Auf diesem Gerät installieren“ und „Geräte“. Bilder `nextasks`, `tokens`, `token-dialog` der Anleitung neu
  (`e2e/guide-shots.mjs` auf die Karten umgestellt). Die Texte der alten Token-Karten sind weg; `used.test.ts` ließ
  sie durch (`t${` galt für jeden Schlüssel mit „t“) und prüft jetzt erst ab dem Punkt. Wächter:
  `frontend/src/i18n/places.test.ts`, `backend/tests/test_places.py` (je Mutation rot).
- Läufe danach (26.11.2026): `reihe.sh nexnotes ende` ruff, lint, build sauber, pytest 2186 grün, 29 übersprungen;
  vitest zuerst 2 rot (zwei Tests mit dem alten Wortlaut, umgestellt), danach 1030 grün in 82 Dateien. Playwright 139
  grün, 11 rot: die zehn bekannten außerhalb der Einstellungen und `folders.spec.ts:86` (Tastatur im Ordnerbaum, allein
  wiederholt 2 von 5 grün; `FolderTree.tsx` und der Test in diesem Durchgang unverändert, also wackelig wie
  split-toolbar).

**Gemeinsame Runde auf bauplaene-stand 86a0cce (E45, E46, E48, E49, „Verwalten“):**
- Alle sieben Module neu gezogen, `check` ok; Kopfzeile der Vorlage `e2e/nexoidc.spec.ts` auf 1.2.0.
- E45: `add_account` schreibt `NewAccount.theme` (`system`), `oidc_store.create_account` ebenso; die Seite schickt
  `nexnotes.theme` roh, auch leer (dann nimmt der Server die Vorgabe von vorher, `system`), nie die Vorliebe des
  Browsers; ohne das Feld `theme` (Server vor 1.1.0) bleibt der Browser, wie er ist (`lib/theme.test.ts`).
- E46: Orte als „Gruppe › Bereich › Karte“, auch in der Anleitung (statt „…, in der Karte „…““); Wächter
  `places.test.ts` und `test_places.py` prüfen Kommas, Pfeile, Kartenform und Bereiche ohne Gruppe.
- E48: Grenzen „Die Grenze eines Kontos setzt du unter Server › Konten › Verwalten.“ (einmal in der Karte), Funktionen „Was
  jedes Konto auf diesem Server nutzen darf.“; keine Web-Push-Karte, keine Schriften-Überschrift unter „Gebaut mit“.
- E49: Entwurf „Was ist neu“ nennt die Orte mit „›“. Passkeys (konten 1ce1a8f): `/api/auth/me` trägt
  `passkeys_can_add` (`passkeys.can_add` aus c0b07ab: eine gesetzte Adresse zählt allein und nur mit https, ohne Adresse nur localhost), der
  Kasten „Passkeys“ zeigt `PasskeyAddition`: den Knopf oder den Satz, beim Betreiber mit Link auf Server › Anmeldung;
  vorhandene Passkeys bleiben (`test_settings_pass.py`, `pages/settings/passkeysBox.test.tsx`, Vorlage von Hand).
- „Verwalten“ und alle Zeilenknöpfe von konten in `sm`: `AccountButton` nimmt die Größe aus `BUTTONS`
  (`buttonSize`), die Seite kann keine setzen (`components/AccountButton.test.tsx`).
- Läufe: `reihe.sh nexnotes ende` ruff, lint, build sauber, pytest 2190 grün, 29 übersprungen; vitest danach (nach dem
  Theme-Nachtrag und `AccountButton`) 1039 grün in 83 Dateien. Playwright 138 grün, 12 rot: die elf von vorher und
  `toolbar.spec.ts:75` (1440 px), der lief neben einer Playwright-Reihe von nexlore; allein 6 von 6 grün.
- Nach konten 1ce1a8f/c0b07ab und dem neuen Satz unter Grenzen: `reihe.sh nexnotes ende` ruff, lint, build sauber,
  pytest 2192 grün, 29 übersprungen; vitest 1046 grün in 84 Dateien.

**Modul sprachen 1.0.0 (E51) und schluessel 4f3e75e:**
- `services/locales.py` ist das Modul (`configure` mit `NEXNOTES_LOCALES_DIR`, Deutsch und Englisch eingebaut, Vorlage
  auf der Seite); `routers/locales.py` ist weg, die Wege kommen aus `nexsprachen.api.router(operator=require_operator)`
  unter `/api/locales`, ohne Anmeldung lesbar wie bisher. Die Liste nennt jetzt zuerst die eingebauten Sprachen
  (`built_in`, `own`); `test_locales.py` liest sie wie die Aufrufer von vorher und zeigt, dass die alten Wege so
  antworten wie bisher. Profilsprache über `locales.known`. Vertragstests `tests/nexsprachen` mit eigenem Adapter
  (frischer Ordner je Test). Die Lese-Seite (`share_page.py`) nimmt `load`/`valid_code` aus dem Modul.
- Seite: Karte „Sprachen“ ist `LanguagesCard` des Moduls (Anfragen mit `X-Nexnotes-Client`, `onChange=own.forget`,
  Vorlage aus den englischen Texten); i18n über `ownLanguages`, Profilmenü über `own.options`; alte Karte und
  Wörter weg (`pages/settings/languagesCard.test.tsx`, Mutationen rot).
- schluessel: „Neuer MCP-Schlüssel“ md secondary Plus; Vorlage `nexschluessel.test.tsx` von Hand.
- sprachen a335909/e18169e und E52: `/api/locales` behält in `/api/openapi.json` die operationIds des alten Routers und
  den Schemanamen `LocaleEntry` (Adapter-Felder; die Vertragstests lesen sie seit 68fd070 über `description()` =
  `app.openapi()`, veröffentlicht wird sie weiter nur mit `NEXNOTES_API_DOCS`);
  `tidy_at_start` beim Start, `restart()` im Adapter; die Profilsprache nimmt genau an, was sie vorher annahm
  (`test_the_old_way_takes_a_profile_language_as_before`, zwei Mutationen rot), `known` nur für die Auswahl.
- Läufe: `reihe.sh nexnotes ende` ruff, lint, build sauber, pytest 2263 grün, 29 übersprungen; vitest 1062 grün in 86
  Dateien. Playwright (vor a335909) 141 grün, 9 rot, alle bekannt außerhalb der Einstellungen.
- E53 (bauplaene 0e372f1, 130e4e9): die API-Beschreibung behält alle Namen von konten. Liste `/api/locales` wieder
  „Languages the operator added“, `POST /api/auth/access/disconnect` wieder mit „API token“; sicherung braucht nichts,
  der Adapter gibt `app.openapi()` heraus. `tests/test_openapi_names.py` hält jede operationId, summary und jeden
  Schemanamen von konten fest (348 Wege, 135 Schemas, Zusätze erlaubt; Mutation rot); `openapi-namen/vergleichen.py`:
  0 Änderungen, nur Zusätze. Reihe: pytest 2269 grün, 29 übersprungen; vitest 1062 grün.

**E57 (N9) und Module dcbd5d1:**
- Neuer Bereich Mein Konto › Benachrichtigungen (Slug `notifications`, Bell, zwischen Darstellung und Verbindungen):
  „Auf welchem Weg“ (`NotifyWays`) mit diesem Browser (ein/aus, Probemeldung), den Browsern des Kontos (dieser
  markiert, andere entfernen) und der iPhone- und iPad-App (Verweis auf Verbindungen); keine Mail. Dazu die Wege
  `GET /api/notify/devices`, `DELETE /api/notify/webpush/{id}` (nur eigene), `POST /api/notify/webpush/test`
  (E34). Tests: `test_notes14.py` (E57), `pages/settings/notificationsArea.test.tsx`, Navigation, Orte; Mutationen rot.
  Anleitung „Mitteilungen“ nennt den Ort.
- sprachen 1.0.1 (Rückfrage beim Entfernen), konten 1.1.1, schluessel 1.0.1; drei Vorlagen von Hand, der eigene Test
  der Karte „Sprachen“ bestätigt im Fenster.
- Läufe: `reihe.sh nexnotes ende` ruff, lint, build sauber, pytest 2277 grün, 29 übersprungen; vitest 1074 grün in 88
  Dateien. Playwright der Einstellungen (settings-nav, signout, api, nextasks, mcp, notify, nexoidc, deck): 27 grün,
  2 rot (notify.spec 26 und 60, die bekannten Roten von „Nach Stufe 1“, an der Glocke einer Notiz).

**Läufe nach dem Nachziehen (26.11.2026):** ruff, lint, build sauber; pytest 2180 grün, 29 übersprungen; vitest 1022
grün in 80 Dateien; Playwright 140 grün, 10 rot (die bekannten außerhalb der Einstellungen: list-styles 2, notify 2,
review4-smart 2, review5-p14 1, shares 1, smart 1, split-toolbar 1).

**Läufe (26.11.2026, Testplatz `reihe.sh nexnotes ende`):** ruff sauber; pytest 2175 grün, 29 übersprungen (darin die
Vertragstests `nexkonten`, `nexoidc`, `nexpost`, `nexlog`, `nexsicherung`, `nexschluessel`, Test „Bestand“); lint
sauber; vitest 1002 grün in 80 Dateien; build sauber. Playwright `npm run e2e` (kopflos): 139 grün, 11 rot, alle 11
außerhalb der Einstellungen und schon vorher veraltet (Liste in `einst-fragen/nexnotes.md`); die betroffenen Specs
danach noch einmal einzeln: 37 grün (vault, settings-nav, signout, api, mcp, deck, nexoidc, menus, attachments), vorher
36 grün (dazu nextasks, split-list, workspace, logo, sheet).


Stand 25.11.2026 spätabends, Zweig `konten`: **auf den Modulen 1.0.0** (eingefroren). Aus `bauplaene` Zweig `konten`
(`3c55402`): `konten` 1.0.0, `ui` 1.0.0, `post` 1.0.0, `oidc` 1.1.2, kopiert mit `tools/sync.py copy`, `check` grün.
App-Version unverändert 1.1.0 (live), kein neues Release vorbereitet. Was seit 0.3.7 dazukam, steht unten unter „Seit
konten 0.3.8 bis 0.3.10“ und „Seit 1.0.0“.

**Gebaut (Backend):**

| Teil | Wo |
|---|---|
| Store | `services/konten_store.py` (Store, FactorStore, PasskeyStore, SessionStore, PictureStore über `accounts`, `invites`, `password_resets`, `auth_sessions`, `api_tokens` und die neuen Tabellen) |
| Neue Spalten | `accounts.email_confirmed` (1), `email_proven` (0), `avatar_source`, `passkey_handle`, `new_sign_in_mail` (1), `new_password_origin`; `auth_sessions.uid`, `remember` (1), `stage` (`full`), `kind` (`browser`); `invites.display_name`, `invites.mailed` (0); `password_resets.origin` (`operator`) |
| Neue Tabellen | `models_accounts.py`: `former_names`, `setup_claims`, `email_changes`, `passkeys`, `failed_unknown`, `mail_outbox` |
| Wanderung | `services/konten_wanderung.py` aus `db.init_db` (Sicherung davor wie bisher): `uid` für alte Sitzungen, eindeutiger Index auf `lower(name)` erst nach Zählen, Indizes auf `lower(email)` und `former_names` |
| Anmelden | `POST /api/auth/login` über `login.sign_in` (Bremse im Modul seit 0.3.10; bekannter Browser: eigener Topf über nexnotes' Gerätezeichen, 5 frei), Feld `remember` neu, Sitzung über `sessions.start`, Mail „Neue Anmeldung“ |
| Einrichtung | `POST /api/setup` über `setup.setup` (Feld `name` neu, sonst Vorschlag) |
| Passwort vergessen | `POST /api/auth/forgot` (`name`), `resets.forgot_in_background`, Mail sofort über `kontenpost.deliver_now` (nie über die Outbox, seit 0.3.10); `GET /api/auth/methods` sagt `forgot_mail`, `passkeys` |
| Einladung | `GET/POST /api/invite/{token}` über `invite_form`/`accept_invite` (Feld `name` neu), `POST /api/invites` mit `display_name`; Link über `invites.invite_link(..., request_base=…)`: ohne öffentliche Adresse die, unter der der Betreiber nexnotes geöffnet hat (auch der Reset-Link des Betreibers) |
| Reset-Link | `GET/POST /api/reset/{token}` über `reset_state`/`use_reset`; Betreiber `POST /api/accounts/{id}/reset-link` über `resets.reset_link` (Mail oder Link, `sent`) |
| Profil | `PUT /api/me/profile` (`name`, `password` neu), `POST /api/me/email/resend`, `DELETE /api/me/email/pending`, `GET/POST /api/email/{token}`, `PUT /api/me/new-sign-in-mail` |
| Sitzungen | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{uid}`, `GET /api/auth/access`, `POST /api/auth/access/disconnect`, `POST /api/auth/access/seen` |
| Betreiber | `PUT /api/accounts/{id}/name`, `/display-name`, `DELETE /api/accounts/{id}/email`; Liste mit `email_duplicate`; Faktor-Reset über `factor.operator_reset` (Feld `disconnect_devices`) |
| Zweiter Faktor | Code-Schritt prüft über `factor.check_code` (alte Codes gelten); Einrichten über `factor.begin_totp`/`confirm_totp`, wartende Einrichtung `GET /api/auth/totp/setup` (`factor.pending_setup`); Ausschalten über `factor.disable_totp` |
| OIDC 1.1.0 | `services/oidc_store.py`: Namensregeln und belegte Namen aus dem Modul, Anzeigename aus dem Claim, Bild vom Anbieter im Faden, Adresse über `profiles.provider_email` (Konten mit Passwort: nur angeboten) |
| Mails | `services/post_store.py` (Store über `smtp_*` und `mail_outbox`, Minutenrunde in `main`), `services/kontenpost.py`; Einladung und Testmail über `post` sofort |
| Alte Fehlerkennungen | `konten_store.OLD_CODES` (`invalid_email`, `name_taken`, `invalid_account_name`) |
| Passkeys | `routers/passkeys.py`: Liste, Hinzufügen (Passwort bzw. frische Anbieteranmeldung), Entfernen, Anmelden ohne Passwort und Code, an Stelle des Codes einer wartenden Anmeldung; Betreiber-Schalter `passkeys_allowed` |
| Notfallbefehl | `python -m app.emergency reset-link <Benutzername oder E-Mail> [--days 1/7/30]` |
| Mail-Einstellungen | `smtp_sender_name`, `mail_last_*`, `passkeys_allowed` in `GET/PUT /api/settings` |
| Frontend | `pages/AuthPages.tsx` (Einrichtung, Anmelden mit „Angemeldet bleiben“ und Passkey, `ForgotPage`, `EmailPage`, Einladung, neues Passwort), `pages/settings/AccountTab.tsx` (Profil mit Benutzername, wartender Adresse, Passwortdialog), `pages/settings/SecurityBoxes.tsx` (Passkeys, „Wo du angemeldet bist“, „Diese Geräte haben noch Zugriff“), `AccountsTab.tsx` (Benutzername · E-Mail, doppelte Adresse, Umbenennen, Anzeigename, Adresse entfernen, Reset-Link mit Mail, Faktor-Reset mit Geräten), Server-Karten (Absendername, Warnung ohne Verschlüsselung, letzter Mailstand, Passkey-Schalter); `lib/passkeys.ts`, `lib/errors.ts` mit `accountErrorKey`/`mailErrorKey` |
| Tests | Vertrag `tests/nexkonten` + `tests/nexpost` (216 grün, 5 übersprungen mit Grund), Test „Bestand“ ohne `xfail` und mit Teil 2 (54 grün: Mailserver, Profilbild, Sitzung von 1.0.1, Authenticator), angepasste App-Tests (Brems-Zahlen des Moduls, Setup-Code ≥ 16 Zeichen, Mailtexte von `post`), vitest `nexkonten.test.ts`, `nexpost.test.ts`, e2e-Texte („Username or email“, Setup-Code der Läufe) |
| Läufe (25.11.2026, nach konten 0.3.6) | Backend `pytest -q -n 2`: 2008 grün, 47 übersprungen; Vertrag `tests/nexkonten` 223 grün, 2 übersprungen (Einladung mit festem Benutzernamen); Frontend `vitest --maxWorkers=2`: 882 grün; `tsc -b` und `npm run lint` sauber. Die `conftest.py` der Modul-Vertragstests heißen alle `conftest`; `tests/conftest.py` stellt vor jedem Test die nächstgelegene in `sys.modules` (wie nexmail); Einladungstests setzten die öffentliche Adresse (Fixture `public_address`, mit 0.3.5 entfernt) |

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

**Seit konten 0.3.4 bis 0.3.6 nachgezogen:** Bremse an allen Türen über das Modul: `deps.reauth_*` (Passwort
bestätigt eine Änderung, Betreiber-Handlungen, Tresor) zählt an `confirm:<Konto>` wie das Modul selbst, der Code-Schritt
an `code:<Konto>` (in `factor.check_code`), „Passwort vergessen“ an `forgot:<Absender>` (auch ohne Mailserver); die
eigenen Zähler je Absender an diesen Türen sind weg, die Sperre am Konto nach zehn Fehlversuchen bleibt. Fünf frei, ab
dem sechsten Fehlversuch wartet es (App-Tests auf diese Zahl angepasst). Angebotene Adresse mit Anbietername in
`accounts.provider_email_from` (neue Spalte), „Nein, danke“ für genau diese Adresse in `provider_email_off` (Spalte von
1.0.1, Bestand gilt weiter; `Account.declined_email`). Einladen ohne öffentliche Adresse geht wieder (`request_base`),
die 26 roten e2e-Läufe hingen daran. Konto-Antwort mit `provider_email_from` und `factor_state` (`factor.state`). Oberfläche:
Profil und Sicherheit nur noch aus `PAGES` (untereinander, „Profilbild hochladen“, Benutzername im Feld mit
Passwort-Rückfrage beim Speichern, Rolle klein am Ende; Sicherheit: Passwort, Zweiter Faktor „An“/„Aus“,
Wiederherstellungscodes, Passkeys, „Angemeldete Geräte“ mit „Überall sonst abmelden“, „Mail bei neuer Anmeldung“),
nexnotes' eigene Teile danach (`APP_PAGES` in `pages/settings/accountPages.ts`: Abmelden, Anbieter, Links zum Lesen,
Tresor); wartender QR-Code nach dem Neuladen; Dialog „Sitzung abgelaufen“ nach `sessionExpiredParts` (auch Passkey;
der Schritt kommt aus der Anmeldeantwort von 1.0.1, `code: false` = Passkey); Reset-Dialog aus `factorResetParts`;
Einrichtung mit `SETUP_PAGE`, ohne Satz zum zweiten Faktor (`setupNotes`); vitest-Vorlage übernommen.

**Seit konten 0.3.7 nachgezogen:** Profil speichert Anzeigename, Benutzername und E-Mail mit einem Knopf
(`PAGES.profile.saveButton`), Passwort-Rückfrage nach `confirmOnSave`, nichts beim Verlassen eines Felds. Hinweise aus
`screenFields().hints`, jeder in eigener Zeile per `aria-describedby` (`Field` mit `hints`; Benutzername:
`usernameHintProfile` und `usernameRules`; Sprache: Hinweis außerhalb des Labels). Zweites Passwortfeld heißt wie im
Modul „Passwort wiederholen“ (`account.passwordRepeat`, `auth.passwordConfirm` entfernt). vitest-Vorlage neu übernommen,
`APP_RENDER` für alle sechs Bildschirme gefüllt; `@testing-library/dom` als devDependency. Läufe: Frontend
`vitest --maxWorkers=2` 890 grün, `tsc -b` und `npm run lint` sauber; Vertrag `tests/nexkonten` 223 grün, 2 übersprungen.

**Seit konten 0.3.8 bis 0.3.10 nachgezogen (ui 0.1.2, oidc 1.1.1, post 0.1.2):**

- **Anmelden** über `login.sign_in(store, name, password, sender=client_ip, browser=<Gerätezeichen>, known_browser=…)`:
  Wartet nur der Topf des Kontos oder der Eingabe, antwortet die Anmeldung wie bei falschem Passwort (401,
  `wrong_credentials`), 429 nur bei vollem Absendertopf (30). „5 frei“ heißt genau 5 an jeder Tür. Der geänderte
  Bremstest (`test_the_brake_holds_a_guesser_back`) prüft wieder das Modulverhalten (fünf Fehlversuche, dann auch das
  richtige Passwort 401); die Härtungstests, die nach wenigen Versuchen 429 erwarteten, rechnen mit 401 bzw. füllen den
  Absendertopf mit verschiedenen Namen.
- **Fehler** mit `account_code` neben der alten Kennung, wo `OLD_CODES` umbenennt (`routers/auth.fail`); die Seite nimmt
  `accountErrorKeyOf` (`lib/errors.ts`).
- **Store:** `password_changed_at` aus der Spalte von 1.0.1 in `get_account` (Bestand ohne Datum: „Zuletzt geändert:
  unbekannt“); `list_access` mit `ACCESS_DEVICE`, `ACCESS_API_KEY`, `ACCESS_PASSKEY`.
- **Sicherheit:** Kasten Passwort mit `passwordChanged(...)` („Zuletzt geändert am …“ bzw. „unbekannt“).
- **Passwort vergessen** schickt sofort (`kontenpost.deliver_now` → `mailer.deliver_letter` → `nexpost.send.deliver`);
  geht die Mail nicht hinaus, nimmt das Modul den Link zurück. Der Test „Bestand“ las die Post aus der Outbox; seine
  Vorrichtung `post` fängt jetzt auch sofort Gesendetes ab (Prüfungen unverändert).
- **Einladungen:** `GET /api/invites` liefert auch abgelaufene, mit `expired`, bis sie zurückgenommen sind.
- **Speichergrenze** (`PUT /api/accounts/{id}/storage-limit`) verlangt jetzt das eigene Passwort (`current_password`,
  bzw. frische Anbieteranmeldung), wie alles, was ein Konto ändert (konten 0.3.9).
- **Kontenliste aus konten 0.3.9** (`pages/settings/AccountsTab.tsx`, `accountList.ts`): je Konto eine Zeile mit Bild
  (`Avatar` aus `ui`, Avatar-Variablen hell und dunkel in `styles/index.css`), Name, Marken und „Benutzername · E-Mail“,
  rechts „Verwalten“; das Fenster mit Angaben (dazu nexnotes' Speicher mit Grenze) und den Gruppen Ändern, Zugang,
  Beenden. Keine Tabelle, kein Menü. Schalter `APP_CAPS`: alles an (`rename`, `roles`, `emailRemove`, `resetLink`,
  `factorReset`, `signOut`, `unlink`, `blocking`, `remove`, `restore`). Eigener Knopf „Speichergrenze“ in „Ändern“ nach
  „Zum Mitglied machen“, mit eigenem Passwort. Löschen nennt Notizen und geteilte, dann die 30 Tage zum Zurückholen;
  gelöschte Konten zeigen nur „Zurückholen“. Am eigenen Konto kein Rollenwechsel, kein Sperren, Löschen, Passwort-Link,
  Faktor-Reset, Überall abmelden, Lösen (`NOT_ON_SELF`). Offene Einladungen als Karte des Moduls (abgelaufene mit
  „Abgelaufen“, Zurücknehmen mit Rückfrage), Einladen und Passwort-Link aus `INVITE_DIALOG`/`RESET_LINK_DIALOG`. Darunter
  nexnotes' eigene Karte „Was du siehst“ und, wie bisher, „API-Token aller Konten“.
- **vitest-Vorlage** mit den Blöcken von 0.3.9 und 0.3.10 (`values`, Namensraum `account`, „Zuletzt geändert“,
  Kontenliste mit `APP_CAPS`, `APP_OWN`, `APP_ACCOUNTS_RENDER.list`); unter `account.*` keine eigenen Schlüssel.
- **Playwright** (nicht ausgeführt): `e2e/menus.spec.ts` prüft jetzt das Fenster „Verwalten“ statt des Menüs,
  `e2e/attachments.spec.ts` setzt die Speichergrenze mit dem Passwort des Betreibers.
- **Läufe (25.11.2026 abends):** Backend `pytest -q -n 2` 2016 grün, 47 übersprungen (darin Vertrag `tests/nexkonten`
  230 grün, 2 übersprungen; Test „Bestand“ 55 grün); `pytest -m timing` 17 grün; Frontend `vitest --maxWorkers=2` 916
  grün in 72 Dateien; `npm run build`, `npm run lint`, `ruff check` sauber. Playwright nicht ausgeführt.

**Seit 1.0.0 nachgezogen:**

- Vertragsadapter: `forgot_through_route` (Route `POST /api/auth/forgot`, Post über `nexpost.testing.catch_mail`) und
  `picture_status` (Route `GET /api/avatars/{id}`); `nexpost_adapter.new_sign_in_letter` (Anmeldung über die Route aus
  einem neuen Browser).
- Mail „Neue Anmeldung“ mit Link zur Seite Sicherheit (`kontenpost.link_for` → `<öffentliche Adresse>/settings/security`),
  Browser und System aus dem User-Agent, nie eine Netzadresse; ohne eigene Zeitzone je Person (die des Servers).
- **Profilbilder sieht jedes angemeldete Konto** (Entscheidung für alle Apps): `avatars.may_see` ist immer wahr für
  Angemeldete, `SEE_RULES` und die Regel der Freigaben sind weg; NOTES-2 AC-11 und NOTES-13 AC-6 (Tests
  `test_avatars`, `test_notes13_earlier`) entsprechend angepasst.
- Test „Bestand“: die Vorrichtung `post` fängt mit `nexpost.testing.catch_mail()` (Prüfungen unverändert).
- „Grenze entfernen“ mit dem Knopf `removeValue`.
- vitest-Vorlage 1.0.0 mit dem Abschnitt „Helpers“ (die Orte `APP_*` von nexnotes eingesetzt).
- Der Haken in `tests/conftest.py`, der je Vertragsordner `conftest` in `sys.modules` setzte, ist weg (kein Vertragstest
  importiert mehr `conftest` beim Namen, oidc 1.1.2).
- Lauf (25.11.2026 spätabends, Testplatz): Backend `pytest -q -n 2` 2019 grün, 47 übersprungen (Vertrag `nexkonten`,
  `nexoidc`, `nexpost` im selben Lauf); vitest 917 grün in 72 Dateien; `npm run build`, `npm run lint`, `ruff` sauber.

**Abweichungen vom Modul (bewusst):** Die wartende Anmeldung zwischen Passwort und Code bleibt nexnotes' eigene
(`totp.start_pending`, Cookie `PENDING_COOKIE`; geprüft wird über `factor.check_code`), weil nexnotes eine eigene
Sitzungsschicht hat. Geräte bleiben nach einem Reset-Link verbunden (Modul, Entscheidung 25.11.2026); NOTES-2 AC-7 sagt
anderes und ist anzupassen.

**Fehlt noch:** Sichtprüfung der geänderten Bildschirme (kein Playwright in dieser Runde), die iPhone-App
(`login` beim Laden auffrischen, Beschriftung „Benutzername“), e2e-Läufe (Texte geprüft, nicht ausgeführt).

### Durchgang „Module“ (26.11.2026)

Aus `bauplaene` Zweig `einst-module` (bis `80a3dd0`), je `tools/sync.py copy`, `check` grün. Fragen und Modulfehler in
`einst-fragen/nexnotes-module.md`.

| Modul | Fassung | was nexnotes dafür gebaut hat | alte Wege (bleiben) | Umwege |
|---|---|---|---|---|
| ui | 1.1.1 | `AboutPage showUpdates` (Mitglieder ohne Karte „Aktualisierungen“) | – | – |
| schluessel | 1.1.1 | `CONFIG`: Extra `mcp` an API-Schlüsseln ausgedient (`retired_options`), Art `mcp` wieder anlegbar mit Ordnern, Programme zählen mit; Vorlage `nexschluessel.test.tsx` 1.1.0 | `POST /api/tokens` setzt `mcp: true` weiter (`retired=True`, Entscheidung 12) | – |
| sicherung | 1.0.4 | nichts (keine App-Tests mit altem Wortlaut oder „Jetzt sichern“ ohne Bestätigen); neuer Vertragstest herunterladen → hochladen → prüfen grün | `/api/backups/*` | – |
| updates | 0.1.2 | `services/updates.py` = `configure` + Modulnamen, `routers/about.py` = `nexupdates.api.router` (Zusammenfassungen von vorher, E53), Einrichtung mit „Nach neuen Versionen sehen“ (`UpdateSetupRow bell={false}`: Satz ohne Glocke, `SetupIn.update_check` → `at_setup`), `AboutArea` mit `useUpdates`; keine Glocke, also kein Blick im Hintergrund (U19) | `/api/about`, `/api/about/updates` (Mitglied: alte Form leer + `hidden`, U21), Schalter `update_check` | – (Adapter `has_bell = False`; die Glocken-Fälle laufen) |
| mcp | 1.1.2 | `services/mcp.py`: Werkzeuge als `nexmcp.Tool` (Namen, Schemas unverändert; Gruppen read/change, `trash_note` risky), `CONFIG` (403 `mcp_off`, `oauth_off_status=403`/`oauth_off_code="mcp_off"` für OAuth bei MCP aus (E55), 4 MB, `nn_mcp_`/`nnr_`, Codes `nnc_`); `services/mcp_store.py` (Store über `api_tokens`, `oauth_*`, neu `mcp_tool_rights`, `mcp_requests`; Spalten `api_tokens.refreshed_at`, `oauth_codes.folder_ids`/`resource`); Wanderung: „MCP-Zugang“ einer Bestands-Datenbank bleibt an, neue Installation aus (Entscheidung 5); Oberfläche: Zustimmung, `/mcp/requests/<id>`, „Rechte je Werkzeug“, „Wartende Rückfragen“, Betreiber-Einstellungen in „Schnittstellen“; Bescheid über `notify.mcp_event` (`waiting` → Web Push) | `/api/mcp` (gleiche Status, Kennungen), `/api/oauth/register|authorize|token`, Schlüssel `nn_mcp_`, `nn_api_` mit Haken, Programme samt `refresh_old_hash`, `/api/tokens` | – (seit mcp 1.1.2 alle OAuth-Wege aus dem Modul; `routers/oauth.py` hält nur noch Store, Adresse und alte Namen) |
| verbinden | 0.1.4 | `models_verbinden.py` (`vb_*`), `services/verbinden_store.py` (Zugang `nnx_`/`nnxr_`/`nnxc_`, Einstellungen `connect.*`, Altes über `nextasks_connections`), `routers/verbinden.py`; Gastgeber: `/api/v1` nimmt Verbindungs-Token mit Zweck `notes.add` (Recht und Ordner wie ein API-Token, Schalter „Verbindungen“ statt API-Schalter); Gast: nextasks-Abrufe über `nexverbinden.call`, wenn verbunden; Karten aller Partner (`connect/AppsArea.tsx`), nextasks' Schlüssel als „Von Hand verbinden“, „Bereiche und Listen“ auch bei Verbindung per Klick; Betreiber-Karte „Andere nex-Apps“ unter Allgemein (Haken „Verbindungen ins eigene Netz“ = `connections_local_network`, derselbe Wert wie der eigene Schalter, `set_local_allowed`); `on_disconnected` räumt nach dem Trennen die schlüssellose Zeile von `nextasks_connections` weg; Seiten `/connect/app`, `/connect/return`; Widerrufe alle 5 Minuten, endgültiges Löschen beendet Verbindungen | `PUT`/`DELETE /api/nextasks`, `GET /api/nextasks` (dazu `by`), API-Token an `/api/v1` | – |

Runde 2 (V18 bis V23, MCP 14 bis 16): nextasks läuft über die Klick-Verbindung genauso wie über den Schlüssel
(Listen, zuletzt benutzte Liste, „Bereiche und Listen“ in einer schlüssellosen Zeile von `nextasks_connections`,
Senden, Marken, Fehler; `tests/test_notes19_click.py` über beide Wege); neu Gast nexlore (`routers/nexlore.py`,
„An nexlore“ im Menü einer Notiz, Entwurf); Gastgeberin nextime über `/api/v1` (`notes.add`); wartende MCP-Anfragen
als Web Push (`notify.request_waiting`). Mit verbinden 0.1.2: Partner in Gebrauch (`in_use`), Logos aus dem Modul,
„Bereiche und Listen“ offen in der Karte für Schlüssel und Klick (V23).

Runde 3 (Nachzug `9bc9f73`: mcp 1.1.1, updates 0.1.2, verbinden 0.1.3): Adapter mcp mit `notified()` und
`change_arguments()`, Vertragstests als Programm ohne App-Köpfe grün; updates ohne Glocke über den Vertrag statt
übersprungener Fälle; verbinden ohne eigene Änderung (nexnotes nutzt `people.read` nicht). E55: OAuth bei
ausgeschaltetem MCP wie vor dem Durchgang (`register` 403 `access_denied`, Zustimmung 403 `mcp_off`), der neue Schalter
„Programme“ mit der 404 des Moduls (`tests/test_mcp_module.py`). „Gesperrte Notiz an nexlore“ gegen beide Prüfungen
gemessen (`tests/test_nexlore_send.py`).

Runde 4 (Nachzug `80a3dd0`: mcp 1.1.2, schluessel 1.1.1, verbinden 0.1.4): die Hüllen um `GET`/`POST
/api/oauth/authorize` und `/register` sind weg, das Modul prüft die Zustimmung, kennt `approve`, nennt `client_name` und
antwortet bei MCP aus wie nexnotes (`oauth_off_*`). Eigene Wörter `foldersAll`/`foldersSome` gestrichen (ein Wortlaut
„Alle Ordner, auch spätere“). Adapter verbinden mit `disconnected()`; Tests `test_verbinden_module.py` (eigenes Netz an
beiden Orten, Trennen räumt nur die schlüssellose Zeile), je Mutation rot.

Dazu: `PROGRAM_PATHS` des Tab-Wächters um `/api/oauth/revoke`, `/api/connect/token|revoke|retire` (Test
`tests/test_program_paths.py`); Geräte erreichen `/api/connect/` nicht (`DEVICE_REFUSED_PREFIXES`).

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
