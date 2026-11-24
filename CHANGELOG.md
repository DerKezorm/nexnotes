# Changelog

All notable changes to nexnotes. The format follows Keep a Changelog; the
project uses semantic versioning.

## 0.1.0 (unreleased)

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
