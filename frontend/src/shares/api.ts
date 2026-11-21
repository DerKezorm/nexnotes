/** Sharing over the server (`backend/app/routers/shares.py`, NOTES-13). */
import { api } from '../api/client'

export type Level = 'read' | 'write'
export type ShareKind = 'note' | 'folder'

export type Person = { id: number; name: string; email: string; avatar: string | null }
export type SharedPerson = Person & { level: Level }

export type ReadLink = {
  id: number
  note_id: string
  expires_on: string
  expires_at: string
  created_at: string
  expired: boolean
  title?: string
  /** Only right after it was made: the server keeps nothing but its hash. */
  path?: string
  note_gone?: boolean
}

export type Sharing = {
  kind: ShareKind
  id: string
  title: string
  people: SharedPerson[]
  /** Who has it through a folder above it. */
  through_folder: (SharedPerson & { folder: string })[]
  /** Read links are on (the operator's switch, AC-10) and this is a note. */
  links: boolean
  link?: ReadLink | null
}

export type WithMeItem = {
  kind: ShareKind
  id: string
  title: string
  level: Level
  updated_at: string | null
  icon: string
  color: string
  /** A folder: how many notes are in it and below. */
  notes?: number
}

export type WithMeGroup = { owner: { id: number; name: string; avatar: string | null }; items: WithMeItem[] }
export type ShareNotice = { id: number; reason: 'ended' | 'owner_gone'; kind: ShareKind; title: string; owner: string; at: string }
export type WithMe = { groups: WithMeGroup[]; count: number; notices: ShareNotice[] }

export type SharedFolder = {
  id: string
  name: string
  icon: string
  color: string
  level: Level
  owner: { id: number; name: string }
  folders: { id: string; name: string; icon: string; color: string }[]
}

/** The moment the day `YYYY-MM-DD` ends in this browser's time zone (its midnight after it): a link's day ends there. */
export function endOfDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date + 1).toISOString()
}

const enc = encodeURIComponent

export const sharesApi = {
  people: (q: string) => api<Person[]>('/api/shares/people', { query: { q } }),
  of: (kind: ShareKind, id: string) => api<Sharing>(`/api/shares/${kind}/${enc(id)}`),
  set: (kind: ShareKind, id: string, person: number, level: Level) =>
    api<Sharing>(`/api/shares/${kind}/${enc(id)}/people/${person}`, { method: 'PUT', body: { level } }),
  remove: (kind: ShareKind, id: string, person: number) => api<Sharing>(`/api/shares/${kind}/${enc(id)}/people/${person}`, { method: 'DELETE' }),
  withMe: () => api<WithMe>('/api/shares/with-me'),
  leave: (kind: ShareKind, id: string) => api<void>(`/api/shares/with-me/${kind}/${enc(id)}`, { method: 'DELETE' }),
  dropNotice: (id: number) => api<void>(`/api/shares/notices/${id}`, { method: 'DELETE' }),
  folder: (id: string) => api<SharedFolder>(`/api/shared-folders/${enc(id)}`),
  moveCheck: (noteIds: string[], targetId: string | null) =>
    api<{ notes: { id: string; title: string; people: string[] }[] }>('/api/shares/move-check', { method: 'POST', body: { note_ids: noteIds, target_id: targetId } }),
  makeLink: (noteId: string, expiresOn: string) =>
    api<ReadLink>(`/api/notes/${enc(noteId)}/read-link`, { method: 'POST', body: { expires_on: expiresOn, ends_at: endOfDay(expiresOn) } }),
  links: () => api<ReadLink[]>('/api/read-links'),
  changeLink: (id: number, expiresOn: string) => api<ReadLink>(`/api/read-links/${id}`, { method: 'PUT', body: { expires_on: expiresOn, ends_at: endOfDay(expiresOn) } }),
  revokeLink: (id: number) => api<void>(`/api/read-links/${id}`, { method: 'DELETE' }),
}

/** `YYYY-MM-DD` of a day `days` from today, in this browser's time. */
export function dayFrom(days: number, now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** The default last day of a new link: in seven days (AC-9). */
export const LINK_DAYS = 7

/** Sent on `window` when shares changed (the sidebar's count, "Mit mir geteilt"). */
export const SHARES_CHANGED_EVENT = 'nexnotes:shares-changed'

export function sharesChanged(): void {
  window.dispatchEvent(new Event(SHARES_CHANGED_EVENT))
}
