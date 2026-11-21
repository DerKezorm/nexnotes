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
  /** Takes the suggested title (given, or the server's from the first words); the note gets "Titel prüfen". */
  suggestTitle: (id: string, title?: string) =>
    api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/title/suggestion`, { method: 'POST', body: title ? { title } : {} }),
  setPaper: (id: string, paper: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/paper`, { method: 'PUT', body: { paper } }),
  titleOk: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/title/ok`, { method: 'POST' }),
  duplicate: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  remove: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restore: (id: string) => api<NoteHead>(`/api/notes/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  /** A note without title and text goes without a trace (NOTES-3 EC-4). */
  discard: (id: string) => api<{ discarded: boolean }>(`/api/notes/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
}
