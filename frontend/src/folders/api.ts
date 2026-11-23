/** The server's folder routes (`backend/app/routers/folders.py`). */
import { api } from '../api/client'

export type Folder = {
  id: string
  parent_id: string | null
  name: string
  icon: string
  color: string
  position: number | null
  /** The folder's own notes, without those of its subfolders (NOTES-4 AC-8). */
  count: number
}

/** The numbers of the tiles above the tree (NOTES-4 AC-16): "Alle Notizen" (own and shared), "Mit mir geteilt", and
 * the notes in the inbox marked "Titel prüfen". */
export type Places = { all: number; shared: number; inbox_title_check: number }

/** `stamp`: what `/api/folders/stamp` said just before the tree was read (NOTES-24, changes from a device). */
export type FolderTree = { inbox: { id: string; count: number }; folders: Folder[]; places?: Places; stamp?: string }

export type InboxNote = {
  id: string
  title: string
  preview: string
  /** Where it came from: `share:<app>`, `dictation`, `mcp:<client>`, or empty. */
  origin: string
  title_check: boolean
  created_at: string
  updated_at: string
  /** The note's symbol and colour, as in the lists (NOTES-3 AC-18); empty for none. */
  icon?: string
  color?: string
  paper?: string
}

export type Impact = { notes: number; folders: number; trash_days: number }

export const foldersApi = {
  tree: () => api<FolderTree>('/api/folders'),
  /** Changes whenever the tree, its tiles or the smart folders would show something else, whichever way it came. */
  stamp: () => api<{ stamp: string }>('/api/folders/stamp'),
  create: (name: string, parent_id: string | null, look: { icon?: string; color?: string } = {}) =>
    api<Folder>('/api/folders', { method: 'POST', body: { name, parent_id, ...look } }),
  change: (id: string, change: { name?: string; icon?: string; color?: string }) =>
    api<Folder>(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: change }),
  move: (target_id: string | null, folder_ids: string[], note_ids: string[] = []) =>
    api<{ folders: number; notes: number }>('/api/folders/move', { method: 'POST', body: { target_id, folder_ids, note_ids } }),
  order: (parent_id: string | null, ids: string[]) => api<Folder[]>('/api/folders/order', { method: 'PUT', body: { parent_id, ids } }),
  impact: (id: string) => api<Impact>(`/api/folders/${encodeURIComponent(id)}/impact`),
  trash: (id: string) => api<{ id: string; folders: number; notes: number }>(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restore: (id: string) => api<{ id: string; folders: number; notes: number }>(`/api/folders/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  inbox: () => api<{ id: string; notes: InboxNote[] }>('/api/folders/inbox'),
}
