/** The trash routes of the server (`backend/app/routers/trash.py`). */
import { api } from '../api/client'

export type TrashOrigin = { id: string; name: string; inbox: boolean; gone: boolean }

/** A root of a deletion: a note deleted on its own, or the top folder of a deleted branch. */
export type TrashItem = {
  kind: 'note' | 'folder'
  id: string
  title: string
  /** Its symbol and colour (NOTES-3 AC-18); empty for none. */
  icon?: string
  color?: string
  deleted_at: string
  expires_at: string
  /** Whole days left by the server's clock, rounded up. */
  days_left: number
  /** In the last days of the deadline: orange (NOTES-15 AC-7). */
  warn: boolean
  origin: TrashOrigin | null
  /** The folder it came from is not there any more (EC-1). */
  origin_gone: boolean
  /** Where it comes back to: its folder, the inbox (a note whose folder is gone) or the top (a folder). */
  lands: 'origin' | 'inbox' | 'top'
  /** What went with a folder. */
  notes: number
  folders: number
  /** Who deleted it, in a shared folder (NOTES-13); empty otherwise. */
  deleted_by: { id: number; name: string } | null
}

export type TrashList = {
  /** The server's time of the list: emptying takes only what was deleted until then (EC-3). */
  now: string
  trash_days: number
  warn_days: number
  items: TrashItem[]
  totals: { notes: number; folders: number }
}

const part = encodeURIComponent

export const trashApi = {
  list: () => api<TrashList>('/api/trash'),
  restore: (item: Pick<TrashItem, 'kind' | 'id'>) => api<Record<string, unknown>>(`/api/trash/${item.kind}s/${part(item.id)}/restore`, { method: 'POST' }),
  purge: (item: Pick<TrashItem, 'kind' | 'id'>) => api<{ notes: number; folders: number }>(`/api/trash/${item.kind}s/${part(item.id)}`, { method: 'DELETE' }),
  empty: (until: string) => api<{ notes: number; folders: number }>('/api/trash/empty', { method: 'POST', body: { until } }),
}
