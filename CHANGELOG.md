# Changelog

All notable changes to nexnotes. The format follows Keep a Changelog; the
project uses semantic versioning.

## 1.2.0 – 2026-11-27

nexnotes now connects with your other nex apps in one click, works with AI tools the same way as every nex app, and
its settings are laid out like those of the other nex apps. Your notes are not touched.

### Connect nex apps

Under **My account › Connections**, the card **Other nex apps** lists the apps nexnotes works with: **nextasks**,
**nexlore** and **nextime**. Click **Connect with …**, agree once in the other app, and you are back, connected. No key
to make, copy and paste. The page where you agree says in plain words what each app may do (for example "Create and
change tasks") and shows the account you are signed in with. Each app may only do what the connection is for, nothing
more. The card shows since when you are connected, when the connection was last used and what it allows, with
**Check now** and **Disconnect**, which ends it on both sides.

- **nextasks: now connected with one click.** Everything you did with a key works the same way over the new
  connection: put the cursor in a line or select several and send them with **To nextasks** in the head of the note
  (each line becomes a task, with a list and an optional due date, and keeps a mark that leads to it); **As a nextasks
  task** in the bar at selected text; **As a nextasks task** in a note's menu turns the whole note into one task (the
  title becomes the task, the text its notes, and the task leads back to the note). You still choose which areas and
  lists nexnotes may use and which list comes first. A connection you made with a key keeps working as it is;
  **Connect again** turns it into the new kind.
- **nexlore, new:** **To nexlore** in a note's menu puts the note into a space of nexlore you pick, with its title and
  text. The note stays here as it is. Notes in the vault are never sent.
- **nextime, new:** in nextime, **Note in nexnotes** in an event's panel makes a note in your nexnotes inbox with the
  event's title, its time, place and notes. Clicking it again for the same event finds the note made before. nextime
  may only add notes; it reads nothing of yours.
- **The operator sets the other apps up once**, under **Server › Connections › Other nex apps**: the address of each app,
  and whether nexnotes may reach apps in the local network (**Connections into the local network**). After that every
  account only clicks. Connections can be switched off for everybody there; nothing is deleted. When something goes
  wrong in the other app, you come back to your card and read there what happened.

### AI tools (MCP)

- **MCP keys by hand again**, read only or read and write, and limited to folders, under My account › Connections ›
  AI tools (MCP). A program that connects itself can be limited to folders too.
- **Rights per tool**: for every key and every program, allow a tool, ask first, or deny it. What asks waits under
  **Waiting requests** for your answer (24 hours), and your browsers get a notification that a program is waiting
  for your yes, in your language and with the note's title and the folder's name.
- New API keys no longer offer "Also for AI tools (MCP)". Older keys with it keep working; there it can only be
  switched off. Scripts that make keys over the API with `mcp: true` work as before.
- MCP starts switched off on a new installation. An installation that had it keeps it on.
- Connecting programs is stricter: a program may only name return addresses with a plain host name or an IP
  address, and a request you allow runs exactly as it was asked, or not at all.

### Settings like in every nex app

- **Areas with an address of their own**: My account (Profile, Security, Appearance, Notifications, Connections) and
  Server for the operator, with Connections of its own for the other nex apps and the interfaces. On a phone the list
  of the areas comes first.
- **Light or dark belongs to your account** and follows you to every device; "As the system" follows each device.
- **API keys and AI tools (MCP)** are cards of their own under My account › Connections: make a key with folders and
  an end date, see it once, edit or revoke it.
- **Notifications** under My account › Notifications: which way your notifications come, this browser on or off with
  a test notification, your other browsers (remove one) and the iPhone and iPad app.
- **Install on this device** is always under My account › Connections: the button where the browser offers it,
  otherwise how it is done in your browser.
- **Ready for the internet?** under Server › Sign-in: each time you open the page, nexnotes checks its address, the
  second factor, the protection against guessing, cookies and the proxy.
- **Storage for new accounts** under Server › General › Limits: the limit every new account starts with.
- **Backups** under Server › Storage and backups at a time of day you choose, now also every month. "Back up now"
  asks first and takes an optional note, shown with the backup in the list.
- **Own languages** under Server › General › Languages: upload a language file and download a template. Files are
  checked more strictly, and a broken one says why.
- **Updates**: a new installation asks once at setup whether nexnotes may look for new versions. Only the operator
  sees whether a newer version is out and switches the check; members see their own version. nexnotes asks only
  when an operator opens Settings › About nexnotes, at most once a day, and the question goes out without the
  version of this server.

### Changed

- Sign-in providers, authentik in one step and the mail server are under Server › Sign-in and Server › Mail, laid out
  as in the other nex apps. The test mail carries nexnotes' logo.
- The switches for the API and MCP are under Server › Connections › Interfaces.
- The operator's account list has one row per account with **Manage**. A key the operator blocked can be unblocked
  again.
- A blocked or deleted account's own API and MCP keys rest and work again once it is back; paired devices and
  connected AI tools are disconnected.
- Every signed-in account sees the profile pictures of the others, as in every nex app.
- Mails about your account go out at once instead of within a minute.
- A new email address shows "Address not confirmed yet" with a link to send, until you confirm it.
- Dates and times read the same way everywhere in the settings.

### Fixed

- **Menus stay on screen**: the menu of a note low in the list, and every other menu (also those of the selection
  bar and the search filters), opens upward or moves up instead of running off the window. The choice of paper
  shows two by two with a small preview, and the colours of a note's menu wrap on a phone, so no menu scrolls
  sideways.
- The settings no longer show an empty strip and a second scroll bar below the page.
- nexnotes starts again in a container with all capabilities dropped (`cap_drop: ALL`); the check of the data folder
  stopped every start there.

### For the operator

- **Nothing to do for an update.** Before it changes anything, nexnotes makes a backup named "before 1.2.0". Every
  API key, MCP key and older nexdeck card key keeps working, paired devices stay connected, a connection to nextasks
  made with a key keeps working, backups stay readable, and the old addresses of the settings lead to their new
  place. No new environment variables, ports or paths.
- **Interface change:** turning "Require a second factor of everybody" off asks for your password once more, on the
  page and in the API: `PUT /api/settings` with `"two_factor_required": false` now needs `"current_password"` (else
  401 `wrong_password`), as does the new `PUT /api/server/sign-in` with `"factor_required": false`.
- To connect apps in one click, enter their addresses once under Server › Connections › Other nex apps. Apps in your
  local network (LAN, VPN) also need **Connections into the local network** there.

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
