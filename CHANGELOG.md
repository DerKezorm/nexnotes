# Changelog

All notable changes to nexnotes. The format follows Keep a Changelog; the
project uses semantic versioning.

## 1.1.0 – 2026-11-25

Accounts, sign-in and mail are built anew, the same way as in the other nex apps. Your notes are not touched.

### Added

- **A username of your own.** You choose it when you set nexnotes up or accept an invitation, and you can change it
  later in your profile.
- **Sign in with your username or your email address.**
- **Passkeys**: sign in with your fingerprint, your face or your device's PIN, without a password. A passkey also
  counts as the second step after the password.
- **"Stay signed in"** on the sign-in page. Without it, nexnotes signs you out when the browser closes, after
  12 hours at the latest.
- **Your signed-in devices** under Security: where you are signed in, with a sign-out for each one or for all others
  at once.
- **Forgot your password?** nexnotes mails you a link, when the server can send mail.
- **A mail when your account signs in somewhere new** (you can switch it off).
- **A new email address counts once you confirm it** with the link nexnotes mails to it (when the server can send
  mail).
- **A profile picture from your sign-in provider**, as long as you have not set one yourself.
- **Operator tools**: rename accounts, change display names and remove addresses in the account list, which also
  marks addresses that two accounts share. A password link for an account can go out by mail. The mail settings take
  a sender name, warn about a connection without encryption and show how the last mail went. Passkeys can be
  switched off for the whole server.

### Changed

- The account pages (profile, security, setup, invitation, sign-in) have a new, calmer layout.
- Wrong passwords and codes slow down whoever guesses at every door: after five failed tries, the next one has to
  wait.
- Mails that cannot be sent at once are tried again later.
- Display names are unique.
- New authenticators come with ten recovery codes instead of eight.

### For the operator

- **Nothing to do for an update.** Everybody stays signed in, paired devices and API tokens keep working, and
  everybody who signed in with their email address keeps doing so. The one exception: an address that two accounts
  share signs neither of them in; they use their username, and the account list shows which ones.
- **The setup code is only for a new server without any account.** A running installation never asks for it. A code
  you set yourself in `NEXNOTES_SETUP_TOKEN` needs at least 16 characters; a shorter one is ignored, and the log says
  so.
- **When the second factor locks people out**, set `NEXNOTES_SECOND_FACTOR_OFF=true` and restart: nobody is asked
  for a second factor until you remove it again. The log warns while it is set.
- **When the operator has lost the password**,
  `docker exec -u nexnotes nexnotes python -m app.emergency reset-link <username or email>` prints a link to set a
  new one.

## 1.0.1 – 2026-11-24

The first published image.

### Fixed

- The arm64 image takes the SQLite that comes with it, not Debian's older one (the image of 1.0.0 did not build).

## 1.0.0 – 2026-11-24

The first release.

### Added

- **Notes** with a title first, formatting by toolbar, by Markdown as you type or by a bar at selected text:
  headings that fold, an outline, checklists that move what is done to the bottom, tables, code, highlights, links
  as cards, a paper and a symbol per note.
- **Editing together, live** (Yjs): everybody with access writes at the same time and sees the others' cursors.
- **Inbox, folders and subfolders** with symbol and colour, `#tags` in the text, pins and colours, and **smart
  folders** from conditions (text, tag, folder, period, open checklists, attachment, colour, shared).
- **Four list styles** (list, cards, compact, tiles) with hints (checklists, attachments, tags) switched on and off
  one by one, sorting and date groups per folder.
- **Tabs** (Alt-click opens a new one) and **two notes side by side**; the sidebar and the list fold away.
- **Search** over titles, text, tags and recognised text, with Ctrl+K.
- **Attachments**: pictures in three sizes, PDFs to leaf through, videos, a gallery of every attachment; **text
  recognition** with Tesseract in nine languages; sketches and recordings from the iOS app shown in the browser.
- **Sharing** notes and folders with other accounts, to read or to write, and **read links** with a last day.
- **Notifications** for shared notes and folders, by Web Push and to the iOS app.
- **The vault**: notes encrypted end to end on the device.
- **History** of every note with its authors, **trash** for 90 days.
- **Export** as Markdown, as a ZIP with attachments, or as a PDF set with Typst; a folder or everything in the
  background.
- **nextasks**: send lines and checklists as tasks. **nexdeck**: a card with pinned notes or a checklist.
- **API** under `/api/v1` with API tokens per account and a description at `/api/v1/docs`; **MCP** at `/api/mcp`
  with a key or by OAuth.
- **On the phone**: one view at a time, installable as a web app, the Android share menu leads into the inbox.
- **A guide** in English and German as the first content of every account.
- **Accounts** by invitation, a second factor (TOTP), sign-in with any number of OpenID Connect providers,
  one-step setup for authentik.
- **For the operator**: backups every night and before every update, upload and restore, a log in four levels, a
  storage overview, mail for invitations and password resets.
- **Languages**: English and German, and your own as JSON files.
