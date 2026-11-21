/** The history routes of the server (`backend/app/routers/history.py`). */
import { api } from '../api/client'
import type { NoteHead, PersonRef } from '../notes/api'

/** Who wrote in a version: a person, or a person's program (`via` = `mcp:<key name>`). */
export type Author = { id: number | null; name: string; via: string }

export type VersionItem = {
  id: number
  created_at: string
  started_at: string
  title: string
  authors: Author[]
  /** Made by a restore: the time of the version it brought back. */
  restored_from: string | null
  /** The newest version, and nothing was written since: it is the note as it is. */
  current: boolean
}

export type VersionPage = {
  versions: VersionItem[]
  /** The id to ask for the next page with (`before`), or null at the end (EC-5). */
  next: number | null
  /** Written since the newest version: the note itself is newer than every version. */
  pending: boolean
  updated_at: string
  updated_by: PersonRef | null
  can_restore: boolean
  history_days: number
}

export type ProseNode = { type: string; attrs?: Record<string, unknown>; content?: ProseNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }

export type Version = Omit<VersionItem, 'current'> & { note_id: string; content: ProseNode; text: string; can_restore: boolean }

export type LastRestore = { id: number; at: string; version_at: string; authors: Author[] } | null

const part = encodeURIComponent

export const historyApi = {
  list: (noteId: string, before?: number) => api<VersionPage>(`/api/notes/${part(noteId)}/history`, { query: { before } }),
  get: (noteId: string, id: number) => api<Version>(`/api/notes/${part(noteId)}/history/${id}`),
  restore: (noteId: string, id: number) => api<{ id: number | null; restored_from: string }>(`/api/notes/${part(noteId)}/history/${id}/restore`, { method: 'POST' }),
  copy: (noteId: string, id: number, when: string) => api<NoteHead>(`/api/notes/${part(noteId)}/history/${id}/copy`, { method: 'POST', body: { when } }),
  lastRestore: (noteId: string) => api<{ last: LastRestore }>(`/api/notes/${part(noteId)}/history/restored`),
}
