# nexnotes API

Programs (n8n, Home Assistant, your own scripts, the nexdeck card) read the notes of one account over `/api/v1/`.
A browser with nexnotes open shows the same description, with every route and a `curl` example, at
`/api/v1/docs` (signed in); the machine-readable form is `/api/v1/openapi.json`.

## The promise

What stands under `/api/v1/` stays as it is: new fields and new routes may come, nothing is renamed or removed and
no meaning changes. Something that would break comes under `/api/v2/` beside it. `GET /api/v1/me` names the
`features` this server offers; ask it before you use something newer.

## Switching it on, getting a token

- The operator's switch **Settings › Server › General › "API for members"** is on from the start. Off, every request
  under `/api/v1/` (the nexdeck card's too) answers `403 api_off`; tokens are kept and work again once it is on. The
  MCP switch is separate.
- A member makes a token under **Settings › Connections › API tokens › New API token**: a name, *Read only* or
  *Read and write*, optionally *Also for AI tools (MCP)*, *All notes* or *Only these folders …*, and when it runs out
  (30 days, **90 days**, 1 year, never). The token (`nn_api_…`) is shown once. The list shows each token's right,
  access, folders, run-out and last use; *Revoke* ends it at once. An account holds at most 20 tokens.
- A token never may more than its account: the account's own notes and those shared with it, by the same rules as
  the interface. It never sees the content of a locked note. *Only these folders* limits it to those folders and
  everything below them, also folders made later; notes shared with the account lie in none of them.
- The operator sees every token (account, name, right, access, number of folders, run-out, last use; never the token,
  never a title or a text) under **Settings › Server › Accounts › API tokens of all accounts** and can block one.

Older keys keep exactly what they could: an MCP key (`nn_mcp_…`) works at `/api/mcp` only, a key for the nexdeck card
(`nn_deck_…`) at the five routes of the card only (`/me`, `/dashboard`, `/notes`, `/notes/{id}`,
`/notes/{id}/items/{index}`); any other route answers `403 token_card_only`. No new keys of these kinds are made.

## Asking

```sh
curl -H "Authorization: Bearer $NEXNOTES_TOKEN" https://notes.example.com/api/v1/me
```

- The token goes in `Authorization: Bearer`, never in the address.
- A request with an `Origin` header (from a web page) is refused (`403 origin_refused`); the session cookie of a
  browser counts for nothing here.
- Answers are JSON, times ISO 8601 in UTC (`2026-11-21T08:05:00+00:00`), ids as in the interface (UUIDs; `inbox`
  names the account's inbox).
- Lists come a page at a time: `limit`, and `cursor` set to the `next_cursor` of the page before; `next_cursor` is
  `null` on the last page. Notes come newest change first.
- 600 requests a minute per token; past that `429 slow_down` with `Retry-After`. Twenty wrong tokens from one sender,
  then `429 too_many_attempts`.

## Errors

Every error is `{"detail": {"code": "...", "message": "..."}}`; a `422` also names the `fields`.

| Status | Code | Meaning |
|---|---|---|
| 401 | `token_invalid` | No token, or one unknown, revoked, run out or blocked; or its account is blocked, deleted or owes its second factor. |
| 403 | `api_off` | The operator switched the API off. |
| 403 | `origin_refused` | The request came from a web page. |
| 403 | `token_card_only` | An older nexdeck key outside the card's routes. |
| 403 | `token_reads_only` | The token may only read. |
| 403 | `not_allowed` | The note is shared with the account to read only. |
| 404 | `not_found` | Not there, or not to be seen with this token (another account's, outside the token's folders). |
| 409 | `note_locked` | The note is locked in the vault; nothing of it goes out. |
| 409 | `item_changed` | The checklist item is not there any more, or says something else now. |
| 410 | `note_trashed` | The note is in the trash. |
| 422 | `invalid_input` | A parameter cannot be read (`fields` names it). |
| 429 | `slow_down`, `too_many_attempts` | See above. |

## Routes

### `GET /api/v1/me`

The account (`name`, `display_name`), the token (`token`, `level`, `access`: `api`, `mcp`; `folders`: the ids it is
limited to or `null`; `expires_at`), the `version` of nexnotes and its `features`.

### `GET /api/v1/notes`

The notes the token sees. Filters: `folder` (an id or `inbox`), `tag`, `pinned` (`true`/`false`), `q` (words of the
title), `changed_since` (ISO 8601), `locked=true` (also locked notes, title only); `limit` 50 from the start, at most
500; `cursor`.

Each note: `id`, `title`, `icon`, `color`, `paper`, `folder_id`, `tags`, `pinned` (the account's own pin), `tasks`
(`{done, total}` of its checklists, or `null`), `locked`, `access` (`owner`, `write`, `read`), `owner` (the owner's
name, only for notes of others), `created_at`, `updated_at`.

### `GET /api/v1/notes/{id}`

One note: the fields above, its text as `markdown` (without the title; `truncated: true` past 1 MB; `markdown=false`
leaves it out), its checklist items as `items` (`index` from 0, `text`, `checked`, `depth`), `lines` (the first lines
of a note without a checklist, for the card), `can_check`, and its state as `etag` (also in the `ETag` header). The
`etag` changes with every change of title or text, deletions included; symbol, color, paper and pinning do not
change it.

Markdown carries text and the known formatting (headings, lists, checklists, bold, italic, links, tables, code).
What Markdown cannot say (highlights, folded sections, column widths) is not in it.

### `POST /api/v1/notes/{id}/items/{index}`

Tick a checklist item (`{"checked": true, "text": "Milk"}`; `false` opens it again). `text` is the item's text as it
was read: an item that says something else by now is left alone (`409 item_changed`). Needs *Read and write* and a
note the account may write. Whoever has the note open sees it at once; nothing typed at the same time is lost.

### `GET /api/v1/search`

Full text search as the search page: words match as prefixes, `"a phrase"`, `-word`, `#tag`; it finds text, tags and
the text read from pictures and PDFs. `q` (required), `folder` (an own folder with its subfolders), `tag`, `limit`
(20, at most 100), `cursor`. Each hit has an `excerpt` (parts, the hits marked `hit: true`) and the same as a
`snippet` with the hits in «guillemets». A locked note is found by its title only.

### `GET /api/v1/folders`

`inbox` (`id`, `count`), `folders` (the account's own as a tree: `id`, `name`, `icon`, `color`, `count` of its own
notes, `children`) and `shared_with_me` (folders others share with the account: `access`, `owner`). A token limited to
folders sees those only.

### `GET /api/v1/tags`

`{"tags": [{"name", "count"}]}`, the most used first.

### `GET /api/v1/smart-folders`, `GET /api/v1/smart-folders/{id}/notes`

The account's smart folders with `match`, `conditions` and how many notes fit them now (`count`); and those notes, a
page at a time.

### `GET /api/v1/shares/with-me`

What others share with the account, per owner: notes and folders with `access`. Sharing itself is only done in
nexnotes.

### `GET /api/v1/notes/{id}/attachments`, `GET /api/v1/attachments/{id}/file`

The attachments of a note (`id`, `name`, `kind`, `mime`, `size`, `file`), and the file of one as a download (ranges
work). Only when the token may read the note.

### `GET /api/v1/trash`

The account's own notes and folders in the trash: `deleted_at`, `expires_at` (the day it goes for good), `days_left`.

### `GET /api/v1/dashboard`

The pinned notes for the nexdeck card: title, first line, progress of the checklists.

## Not over the API

Sharing and read links, the vault and the content of locked notes, settings, accounts, the operator's tasks, the
history of a note, export, and deleting anything for good.
