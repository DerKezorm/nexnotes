/** The tag routes of the server (`backend/app/routers/tags.py`). A tag in the address is its name without `#`. */
import { api } from '../api/client'
import type { ListAnswer, ListView } from '../notes/list/api'

/** A tag in the list: the spelling shown (the one used most), the key it is compared by, how many notes have it. */
export type TagInfo = { key: string; label: string; count: number }

/** A tag on its page: the spelling shown, its key, how many notes have it and whose. */
export type TagHead = {
  /** The key the tag is compared by. */
  tag: string
  label: string
  count: number
  /** Own notes with the tag: what renaming and deleting change. */
  mine: number
  /** Notes others shared, per person: what renaming and deleting leave as they are. */
  others: Array<{ id: number; name: string; count: number }>
}

/** The page of a tag as a list like every other (`/api/note-list`): its notes with the view kept for the tag. */
export type TagList = ListAnswer & TagHead

export type RenameResult = { label: string; key: string; changed: number; kept: number }

const path = (name: string) => `/api/tags/${encodeURIComponent(name)}`

export const tagsApi = {
  list: () => api<{ tags: TagInfo[]; total: number }>('/api/tags'),
  /** The notes with the tag, own and shared, in the shape of every list; the sort and grouping kept for the tag. */
  notes: (name: string) => api<TagList>(`${path(name)}/notes`),
  stamp: (name: string) => api<{ stamp: string }>(`${path(name)}/stamp`),
  saveView: (name: string, view: Partial<ListView>) => {
    const { sort, direction, grouped } = view
    return api<ListView>(`${path(name)}/view`, { method: 'PUT', body: { sort, direction, grouped } })
  },
  /** Renames in all own notes; onto a tag that exists already only with `merge` (else `tag_exists`). */
  rename: (name: string, newName: string, merge = false) => api<RenameResult>(path(name), { method: 'PUT', body: { name: newName, merge } }),
  remove: (name: string) => api<{ changed: number; kept: number }>(path(name), { method: 'DELETE' }),
}
