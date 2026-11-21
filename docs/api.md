# nexnotes API

Programs (n8n, Home Assistant, your own scripts, the nexdeck card) read the notes of one account over `/api/v1/`.
A browser with nexnotes open shows the same description, with every route and a `curl` example, at
`/api/v1/docs` (signed in); the machine-readable form is `/api/v1/openapi.json`.

## The promise

What stands under `/api/v1/` stays as it is: new fields and new routes may come, nothing is renamed or removed and
no meaning changes. Something that would break comes under `/api/v2/` beside it. `GET /api/v1/me` names the
`features` this server offers (`read`, `search`, `write`, `external_ref`, `replace`, `upload`, …); ask it before you use something newer.

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
| 403 | `not_allowed` | The note or folder is shared with the account to read only. |
| 403 | `not_owner` | Only the note's owner may move it. |
| 404 | `not_found` | Not there, or not to be seen with this token (another account's, outside the token's folders). |
| 409 | `note_locked` | The note is locked in the vault; nothing of it goes out. |
| 409 | `item_changed` | The checklist item is not there any more, or says something else now. |
| 409 | `tag_exists` | Renaming onto a tag that exists already; send `merge: true` to join them. |
| 400 | `inbox_fixed` | The inbox cannot be renamed, moved or deleted. |
| 410 | `note_trashed` | The note is in the trash. |
| 412 | `note_changed` | Replacing the text: the note changed since it was read; `etag` names its state now. |
| 413 | `too_large`, `attachment_too_large` | Markdown over 512 KB; a file over the operator's limit per file. |
| 422 | `invalid_input` | A parameter cannot be read (`fields` names it), e.g. a title over 120 or a folder name over 60 characters. |
| 428 | `precondition_required` | Replacing the text without `If-Match` or `base`. |
| 507 | `storage_limit_reached` | The storage of the account is full. |
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

## Writing

Everything below needs a token with *Read and write* (else `403 token_reads_only`) and the right to write what it
changes; a token limited to folders writes only inside them. Changes of a note's text go through the same live
connection as the browser's: whoever has the note open sees them at once, and nothing typed at the same moment is
lost. The note's history names the change as "<account> via API token <name>", and members the note is shared with
are notified as of any change of the account. Answers that return a note give it as `GET /api/v1/notes/{id}` does,
with its new `etag`.

### `POST /api/v1/notes`

```json
{"markdown": "- [ ] Milk", "title": "Shopping", "folder_id": "inbox", "icon": "star", "color": "honey",
 "paper": "lined", "pinned": true, "external_ref": "shopping-2026-11-21"}
```

All fields are optional, but a note needs a text or a title. Without `folder_id` it lands in the inbox (a token
limited to folders: in the first of them), marked "Via the API from <token name>". Without a title the first words
become one and the owner is asked to check it. `201` with the note; with an `external_ref` that made a note before,
`200` with that note and nothing new, also when the same request arrives twice at the same moment. A note gone for
good frees its reference.

### `PATCH /api/v1/notes/{id}`

Any of `title`, `icon`, `color`, `paper`, `pinned`, `folder_id`. Pinning is the account's own (also for a note shared
to read only); moving to another folder is the owner's (`403 not_owner`). With `If-Match` it changes only the state
read (`412 note_changed`).

### `POST /api/v1/notes/{id}/append`

`{"markdown": "..."}` at the end of the text. Needs no `etag`: it joins whatever was typed meanwhile.

### `PUT /api/v1/notes/{id}/content`

`{"markdown": "...", "base": "<etag>"}`, or the `etag` in `If-Match`. One of the two is required (`428
precondition_required`). If anything changed since that state, nothing is changed and the answer is `412
note_changed` with the current `etag`: read again and decide. Otherwise the text is replaced block by block: blocks
whose Markdown is the same stay exactly as they were, with what Markdown cannot say (highlights, folded sections,
column widths, attachments); only the blocks that differ are replaced. The title stays.

### `DELETE /api/v1/notes/{id}`, `POST /api/v1/notes/{id}/restore`

Into the trash (`204`), never away for good; and back from it.

### `POST /api/v1/notes/{id}/attachments?name=photo.jpg`

The file is the request body. It comes as a block at the end of the note: a picture as a picture, anything else as a
file. The operator's limit per file and the account's storage hold (`413 attachment_too_large`, `507
storage_limit_reached`). `201` with the attachment.

### `POST /api/v1/folders`, `PATCH /api/v1/folders/{id}`, `DELETE /api/v1/folders/{id}`, `POST /api/v1/folders/{id}/restore`

The account's own folders: `{"name", "parent_id", "icon", "color"}` to make one (at most 60 characters, at the top or
in another own folder; a token limited to folders only inside them), the same fields to change one (`parent_id: null`
moves it to the top), delete puts it into the trash with everything in it. The inbox stays as it is
(`inbox_fixed`).

### `PATCH /api/v1/tags/{name}`

`{"name": "new", "merge": false}` renames a tag in the account's own notes; notes of others keep theirs (`kept`).

## Not over the API

Sharing and read links, the vault and the content of locked notes, settings, accounts, the operator's tasks, the
history of a note, export, and deleting anything for good.

## The description page

`/api/v1/docs` is Swagger UI shipped with nexnotes, under the same Content-Security-Policy as the app
(`default-src 'self'`, no `unsafe-eval`): nothing is loaded from elsewhere and the page sends no requests of its own
but the description.
