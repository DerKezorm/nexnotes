/** The tag routes of the server (`backend/app/routers/tags.py`). A tag in the address is its name without `#`. */
import { api } from '../api/client'

/** A tag in the list: the spelling shown (the one used most), the key it is compared by, how many notes have it. */
export type TagInfo = { key: string; label: string; count: number }

/** A note on the page of a tag: own ones with their folder, shared ones with their owner. */
export type TagNote = {
  id: string
  title: string
  preview: string
  updated_at: string | null
  mine: boolean
  folder: { id: string; name: string; inbox: boolean } | null
  owner: { id: number; name: string } | null
}

export type TagPage = {
  key: string
  label: string
  count: number
  /** Own notes with the tag: what renaming and deleting change. */
  mine: number
  /** Notes others shared, per person: what renaming and deleting leave as they are. */
  others: Array<{ id: number; name: string; count: number }>
  notes: TagNote[]
}

export type RenameResult = { label: string; key: string; changed: number; kept: number }

const path = (name: string) => `/api/tags/${encodeURIComponent(name)}`

export const tagsApi = {
  list: () => api<{ tags: TagInfo[]; total: number }>('/api/tags'),
  page: (name: string) => api<TagPage>(path(name)),
  /** Renames in all own notes; onto a tag that exists already only with `merge` (else `tag_exists`). */
  rename: (name: string, newName: string, merge = false) => api<RenameResult>(path(name), { method: 'PUT', body: { name: newName, merge } }),
  remove: (name: string) => api<{ changed: number; kept: number }>(path(name), { method: 'DELETE' }),
}
