/**
 * Addresses of the notes' workspace (NOTES-8 AC-9): on a wider screen the sidebar, a list in the middle and the notes
 * with their tabs stand side by side like in a mail program. The sidebar (a folder, a tag, the search, the inbox, all
 * notes) changes only the list; the tabs stay. The address carries both: the list as its path, the note open on the
 * side used last as `?note=<id>`, for example `/folder/<id>?note=<id>`, `/tags/<name>?note=…`, `/search?q=…&note=…`.
 * The list of all notes keeps its old form `/notes/<id>`. An old address `/notes/<id>?folder=<folder>` means
 * `/folder/<folder>?note=<id>`.
 */
import { isDesktop } from '../tabs/desktop'
import { tabsNow } from '../tabs/store'
import { focusedKey, tabOf } from '../tabs/state'

const NOTE_PATH = /^\/notes\/([^/]+)$/
/** The paths that show a list beside the notes. */
const LIST_PATH = /^\/(?:|notes\/[^/]+|folder\/[^/]+|inbox|folders|tags|tags\/[^/]+|search|shared|shared\/folder\/[^/]+)$/

export function isListPath(pathname: string): boolean {
  return LIST_PATH.test(pathname)
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The note an address opens: `/notes/<id>`, or `?note=<id>` on a list. */
export function noteOf(pathname: string, search: string): string | null {
  const match = NOTE_PATH.exec(pathname)
  if (match) return decode(match[1])
  if (!isListPath(pathname)) return null
  return new URLSearchParams(search).get('note') || null
}

/** The list of an address, without the note: `/notes/<id>` is the list of all notes (`/`), with an old `?folder=` that
 * folder's. */
export function listOf(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  if (NOTE_PATH.test(pathname)) {
    const folder = params.get('folder')
    return folder ? `/folder/${encodeURIComponent(folder)}` : '/'
  }
  params.delete('note')
  const rest = params.toString()
  return rest ? `${pathname}?${rest}` : pathname
}

/** The address of `list` with `note` open beside it (or none). */
export function hrefIn(list: string, note: string | null | undefined): string {
  if (!note) return list
  if (list === '/' || list === '') return `/notes/${encodeURIComponent(note)}`
  const [path, query = ''] = list.split('?')
  const params = new URLSearchParams(query)
  params.set('note', note)
  return `${path}?${params.toString()}`
}

let current = '/'

/** The list on show (or shown last, while a page of its own covers everything). */
export function currentList(): string {
  return current
}

export function setCurrentList(list: string): void {
  current = list
}

/** The folder a list shows, for "New note" (NOTES-4 AC-9): a folder's id, `inbox`, or none. */
export function folderOfList(list: string): string | 'inbox' | null {
  const path = list.split('?')[0]
  const match = /^\/folder\/([^/]+)$/.exec(path)
  if (match) return decode(match[1])
  return path === '/inbox' ? 'inbox' : null
}

/**
 * Whether going to `to` keeps the notes open on a wider screen: another list, or a note that has a tab already, leaves
 * every tab as it is; then an open note without a title is not asked (NOTES-3 AC-9 asks only when its tab closes or
 * gets another note).
 */
export function keepsNotesOpen(to: string): boolean {
  if (!isDesktop()) return false
  const url = new URL(to, window.location.origin)
  if (!isListPath(url.pathname)) return false
  const note = noteOf(url.pathname, url.search)
  if (!note) return true
  const state = tabsNow()
  if (tabOf(state, focusedKey(state))?.note === note) return true
  return state.tabs.some((tab) => tab.note === note)
}
