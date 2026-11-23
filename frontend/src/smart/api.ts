/**
 * Smart folders on the server (`backend/app/routers/smart_folders.py`, NOTES-7): make, change, order, delete, the
 * preview while making one, and the list one shows. The conditions are the search's (`services/search.py`).
 */
import { api } from '../api/client'
import type { Gallery, GalleryKind, GallerySort } from '../attachments/api'
import type { ListAnswer, ListItem, ListView } from '../notes/list/api'

export type Match = 'all' | 'any'
export type Period = 'today' | 'week' | 'month' | 'year' | 'custom'
export type AttachmentType = 'any' | 'image' | 'pdf' | 'scan' | 'recording' | 'sketch' | 'video' | 'file'

export type TextCondition = { kind: 'text'; value: string }
export type TagCondition = { kind: 'tag'; op: 'has' | 'not'; key: string; label: string }
export type FolderCondition = { kind: 'folder'; op: 'in' | 'tree'; id: string; name?: string }
export type DateCondition = { kind: 'date'; field: 'updated' | 'created'; period: Period; from?: string; to?: string }
export type TasksCondition = { kind: 'tasks'; op: 'open' }
export type AttachmentCondition = { kind: 'attachment'; type: AttachmentType }
export type SharedCondition = { kind: 'shared'; op: 'by_me' | 'with_me' }
export type PinnedCondition = { kind: 'pinned' }
export type ColorCondition = { kind: 'color'; color: string }

export type Condition =
  | TextCondition
  | TagCondition
  | FolderCondition
  | DateCondition
  | TasksCondition
  | AttachmentCondition
  | SharedCondition
  | PinnedCondition
  | ColorCondition

/** The ones every account gets (AC-7); without a name of their own they are named in the language of the page.
 * `attachments` took the place of the sidebar's fixed entry "Anhänge". "Mit mir geteilt" is a fixed place (the tiles
 * at the top of the sidebar), no preset (23.11.2026). */
export type Preset = '' | 'open_tasks' | 'recent' | 'attachments'

export type SmartFolder = {
  id: string
  name: string
  preset: Preset
  /** As a folder's: a symbol of `lib/symbols.ts` (the filter unless another was picked) and a color (`palette.ts`). */
  icon: string
  color: string
  match: Match
  conditions: Condition[]
  position: number
}

/** A condition that points nowhere (EC-1): a folder gone, a tag no note has any more. */
export type Broken = { index: number; kind: 'folder' | 'tag'; name: string }

/** A smart folder's list: the shape of `/api/note-list`, with the folder and what points nowhere. */
export type SmartAnswer = ListAnswer & { folder: SmartFolder; broken: Broken[] }

export type Preview = { total: number; items: ListItem[]; broken: Broken[] }

export type SmartFolderIn = { name: string; match: Match; conditions: Condition[]; icon?: string; color?: string }

/** The device's time zone by name: periods count from today there (EC-3). */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

const one = (id: string) => `/api/smart-folders/${encodeURIComponent(id)}`

export const smartApi = {
  list: () => api<{ items: SmartFolder[] }>('/api/smart-folders'),
  create: (folder: SmartFolderIn) => api<SmartFolder>('/api/smart-folders', { method: 'POST', body: folder }),
  read: (id: string) => api<SmartFolder>(one(id)),
  update: (id: string, change: Partial<SmartFolderIn>) => api<SmartFolder>(one(id), { method: 'PUT', body: change }),
  remove: (id: string) => api<void>(one(id), { method: 'DELETE' }),
  order: (ids: string[]) => api<{ items: SmartFolder[] }>('/api/smart-folders/order', { method: 'PUT', body: { ids } }),
  preview: (match: Match, conditions: Condition[]) =>
    api<Preview>('/api/smart-folders/preview', { method: 'POST', body: { match, conditions, tz: deviceZone() } }),
  notes: (id: string) => api<SmartAnswer>(`${one(id)}/notes`, { query: { tz: deviceZone() } }),
  stamp: (id: string) => api<{ stamp: string }>(`${one(id)}/stamp`, { query: { tz: deviceZone() } }),
  saveView: (id: string, view: Partial<ListView>) => api<ListView>(`${one(id)}/view`, { method: 'PUT', body: view }),
  /** The attachments of the notes that fit now, in the shape of the gallery (the view "Anhänge"). */
  gallery: (id: string, query: { kind?: GalleryKind; sort?: GallerySort; offset: number; limit: number }) =>
    api<Gallery>(`${one(id)}/attachments`, { query: { ...query, tz: deviceZone() } }),
}
