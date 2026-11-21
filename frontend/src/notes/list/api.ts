/**
 * The lists of notes on the server (`backend/app/routers/notes_list.py`, NOTES-6): a folder's notes or all of them with
 * the account's view, the stamp a list asks for to load again, the view per folder, pins and colors.
 */
import { api } from '../../api/client'
import type { NoteItem } from '../api'

/** `gallery`: the attachments of the list's notes instead of the notes (a smart folder with "Anhang", NOTES-7). */
export type ListMode = 'list' | 'tiles' | 'gallery'
export type ListSort = 'updated' | 'created' | 'title'
export type ListDirection = 'asc' | 'desc'

/** How an account looks at one folder's notes (or "All notes"), the same on every device (AC-1, AC-4, AC-5). */
export type ListView = { mode: ListMode; sort: ListSort; direction: ListDirection; grouped: boolean }

export const DEFAULT_VIEW: ListView = { mode: 'list', sort: 'updated', direction: 'desc', grouped: true }

/** A picture, scan, sketch or video of a note: the first one, and how many of its kind there are, with the address of
 * its preview (from the attachments feature, NOTES-10). */
export type ListMedia = { kind: 'image' | 'scan' | 'drawing' | 'video'; count: number; url?: string | null; text?: boolean }

/** Who a note of the account is shared with (from sharing): their names, or only how many. */
export type ListShared = { count?: number; names?: string[] } | boolean

/** A tag as the tags feature sends it: its name, or an object with one. */
export type ListTag = string | { name: string; color?: string }

/**
 * A note in a list. Besides the fields of `GET /api/notes`, everything a row or tile shows; the fields other features
 * bring are optional, and a list shows nothing for one that is missing. A search can hand its hits to `NoteRow` in
 * this shape.
 */
export type ListItem = NoteItem & {
  pinned?: boolean
  color?: string
  tasks?: { done: number; total: number } | null
  /** The owner, only for a note of somebody else (shared with the account). */
  owner?: { id: number; name: string }
  locked?: boolean
  tags?: ListTag[]
  shared?: ListShared
  media?: ListMedia | null
}

export type ListAnswer = {
  key: string
  view: ListView
  counts: { own: number; shared: number }
  items: ListItem[]
}

const noteUrl = (id: string) => `/api/notes/${encodeURIComponent(id)}`

export const listApi = {
  /** A folder's notes, or all of them (own and shared) without a folder. */
  read: (folderId?: string) => api<ListAnswer>('/api/note-list', { query: { folder_id: folderId } }),
  stamp: (folderId?: string) => api<{ stamp: string }>('/api/note-list/stamp', { query: { folder_id: folderId } }),
  saveView: (folderId: string | undefined, view: Partial<ListView>) =>
    api<ListView>('/api/note-list/view', { method: 'PUT', body: { folder_id: folderId, ...view } }),
  pin: (id: string, pinned: boolean) => api<ListItem>(`${noteUrl(id)}/pin`, { method: 'PUT', body: { pinned } }),
  color: (id: string, color: string) => api<ListItem>(`${noteUrl(id)}/color`, { method: 'PUT', body: { color } }),
}
