# nexnotes

Quick notes, self-hosted. A notes app for the browser, iPhone and iPad, with your own server instead of somebody
else's cloud.

> Early days: this is the frame (accounts, sign-in, backups, settings). The notes themselves come next.

## Run it

```yaml
services:
  nexnotes:
    image: nexnotes
    build: .
    ports:
      - "8570:8000"
    volumes:
      - ./data:/data
    environment:
      PUID: 1000
      PGID: 1000
      # NEXNOTES_SETUP_TOKEN: choose-a-long-one
```

Open `http://<your-host>:8570`. The first account you create is the operator; it needs the setup code that nexnotes
writes to its log at every start until it is set up (`docker logs nexnotes`), or the one you set in
`NEXNOTES_SETUP_TOKEN`.

Keep the data folder on a local disk: SQLite's locking does not work reliably over SMB or NFS, and nexnotes warns
about a data folder on a network share.

## Settings from the environment

| Variable | Meaning |
|---|---|
| `NEXNOTES_DATA_DIR` | Database, attachments, backups, log and your own language files (`/data` in the image). |
| `NEXNOTES_SETUP_TOKEN` | The code the first account needs. Without it nexnotes makes one at every start until set up. |
| `NEXNOTES_PUBLIC_URL` | The address people use, for invitation links and the sign-in providers' redirect. Also in the settings. |
| `NEXNOTES_TRUSTED_PROXIES` | Addresses or networks of your reverse proxy, so the sign-in brake sees the real sender. |
| `NEXNOTES_SECRET_KEY` | Signs sign-in attempts and encrypts stored secrets. Empty: a random key in the data folder. |
| `NEXNOTES_OPERATOR_NETWORKS` | Networks the operator's settings may be changed from. Empty: anywhere. |
| `NEXNOTES_COOKIE_SECURE` | `auto` (default), `true` or `false`. |
| `NEXNOTES_LOG_LEVEL` | Overrides the log level set in the interface: `quiet`, `normal`, `detailed` or `trace`. |
| `NEXNOTES_SESSION_DAYS` | Days a browser stays signed in, 1 to 3650 (default 30). |
| `NEXNOTES_COOKIE_SUFFIX` | Appended to the cookie names when two instances share a host: letters, digits and `_`. |
| `NEXNOTES_PUSH_RELAY` | Where notifications for the iOS app go (default `https://push.nexapps.dev`; it sees only what is encrypted for the device). Empty: none to iPhones and iPads. |
| `NEXNOTES_GUIDE` | `true` (default): every account gets a folder "Guide" ("Anleitung" in German) that explains nexnotes. `false`: only who asks for it under Settings › Appearance. |
| `NEXNOTES_PORT` | Port inside the container, 1 to 65535 (default 8000), for host networking. |

A variable with a value nexnotes cannot use stops the start with a line in the log that names the variable and the
values it takes.

## Sign-in

Password with an optional second factor (TOTP with recovery codes), and any number of OpenID Connect providers
(authentik, Microsoft Entra ID, Keycloak, Authelia, Pocket ID). authentik can be set up in one step from the settings.

## Notifications

Members can switch on notifications for a shared note or folder: when somebody else changes it, a notification names
who, the note and what was added or ticked, bundled once nobody has written for two minutes. They arrive in every
browser that allowed them (Web Push; the message is encrypted for the browser, so the push service never reads it) and
in the iOS app. The key that signs Web Push is made at the first start and kept encrypted with the server's secret.

## On a phone

In a phone's browser nexnotes shows one view at a time: folders, then notes, then the note. It installs as a web app
("Add to Home screen" in Chrome on Android, Safari on iPhone) and starts without the browser bar. The service worker
keeps only the app itself, never notes: without a connection the installed app says so and tries again. On Android
nexnotes appears in the share menu; what another app shares opens as "Save to nexnotes" with a suggested title and
lands in the inbox. The shared things stay in the browser's memory until saved, nothing is stored on the device.

## Languages

English and German ship with nexnotes. Put a language file (`nl.json`, same keys as the English one) into
`<data>/locales` and restart: it is offered in the language menu, marked as yours.

## Export

A note goes out as Markdown (a ZIP with its attachments, when it has any) or as a PDF set on the server with
[Typst](https://typst.app). A folder or everything runs in the background as a ZIP of Markdown files in their folders;
nexnotes says when it is ready, and it can be fetched for 24 hours. The ZIPs lie under `<data>/exports`, count towards
no account's storage and are in no backup. An export needs the room it takes plus 256 MB free on the data disk.

## Development

- Backend: `cd backend && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`, then
  `.venv/bin/python -m pytest -q`.
- Frontend: `cd frontend && npm install`, `npm run dev` (port 5570, the API proxied to 8570), `npm test`,
  `npm run build`.

## Licence

AGPL-3.0, see `LICENSE`. What nexnotes brings along from others, and under which licence: `THIRD-PARTY.md`.
