/** The notes routes of the server (`backend/app/routers/notes.py`). The text itself goes over the live connection. */
import { api } from '../api/client'

/** A note in a list: title, a preview of its text, its dates, "Titel prüfen", where it came from. */
export type NoteItem = {
  id: string
  folder_id: string
  title: string
  title_check: boolean
  origin: string
  preview: string
  created_at: string
  updated_at: string
  /** The note's color (NOTES-6 AC-8), empty for none. */
  color?: string
  /** The symbol before the title (NOTES-3 AC-18), empty for none. */
  icon?: string
}

export type FolderStep = { id: string; name: string; kind: string; inbox: boolean }
export type PersonRef = { id: number; name: string }

/** The head of an open note. */
export type NoteHead = NoteItem & {
  path: FolderStep[]
  updated_by: PersonRef | null
  owner: PersonRef | null
  deleted_at: string | null
  can_write: boolean
  /** The paper (NOTES-3 AC-17): blank, lined, grid or dots. */
  paper?: string
  /** Sharing (NOTES-13): whom an own note is shared with; only the owner shares; a member's right and own pin. */
  shared_with?: string[]
  can_share?: boolean
  level?: 'read' | 'write'
  pinned?: boolean
  /** Notifications (NOTES-14): the bell is on for this note. */
  notify?: boolean
}

export type NewNote = { id?: string; folder_id?: string; title?: string; markdown?: string; origin?: string; title_suggested?: boolean }

/** Sent on `window` when notes were made, renamed, copied or deleted: lists load again. */
export const NOTES_CHANGED_EVENT = 'nexnotes:notes-changed'

export function notesChanged(): void {
  window.dispatchEvent(new Event(NOTES_CHANGED_EVENT))
}

export const notesApi = {
  list: (folderId?: string) => api<NoteItem[]>('/api/notes', { query: { folder_id: folderId } }),
  create: (body: NewNote) => api<NoteHead>('/api/notes', { method: 'POST', body }),
  get: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}`),
  setTitle: (id: string, title: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/title`, { method: 'PUT', body: { title } }),
  /** Takes the suggested title (given, or the server's from the first words). The note gets "Titel prüfen" unless the
   * person `confirmed` the suggestion, having seen it (NOTES-3 AC-9). */
  suggestTitle: (id: string, title?: string, confirmed = false) =>
    api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/title/suggestion`, { method: 'POST', body: { ...(title ? { title } : {}), ...(confirmed ? { confirmed } : {}) } }),
  setIcon: (id: string, icon: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/icon`, { method: 'PUT', body: { icon } }),
  setPaper: (id: string, paper: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/paper`, { method: 'PUT', body: { paper } }),
  titleOk: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/title/ok`, { method: 'POST' }),
  duplicate: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  remove: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restore: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  /** A note without title and text goes without a trace (NOTES-3 EC-4). */
  discard: (id: string) => api<{ discarded: boolean }>(`/api/notes/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
}
