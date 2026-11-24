/** The member's own nextasks over the server (`backend/app/routers/nextasks.py`, NOTES-19). */
import { api } from '../api/client'

export type NextasksStatus = {
  connected: boolean
  /** The operator lets connections point into the own network (Settings, Server). */
  local_allowed: boolean
  url?: string
  host?: string
  /** The name nextasks gave for the key's account. */
  name?: string
  last_list?: { id: string; name: string } | null
}

/** A list the sending offers; `default` marks the standard list chosen in Connections (interface 0.14). */
export type TaskList = { id: string; name: string; hidden: boolean; default?: boolean }

/** An area of nextasks with its lists for "Bereiche und Listen": the area whole (its later lists too), or lists alone. */
export type AreaChoice = { id: string; name: string; icon?: string; color?: string; whole: boolean; lists: { id: string; name: string; icon?: string; color?: string; chosen: boolean }[] }

export type AreaAnswer = { areas: AreaChoice[]; default: string | null }

export type TaskMark = {
  id: number
  note_id: string
  /** The Yjs id of the line's block, `<client>.<clock>`. */
  anchor: string
  task_url: string
  list_name: string
  due_date: string | null
  created_at: string | null
}

export type SendLine = { text: string; anchor: string }

export type Sending = {
  note_id: string
  request_id: string
  list_id: string
  list_name: string
  due_date?: string
  lines?: SendLine[]
  /** The whole note as one task: its title, its text in the task's notes (cut to nextasks' limit). */
  whole?: boolean
}

export const nextasksApi = {
  status: () => api<NextasksStatus>('/api/nextasks'),
  connect: (url: string, token: string) => api<NextasksStatus>('/api/nextasks', { method: 'PUT', body: { url, token } }),
  disconnect: () => api<void>('/api/nextasks', { method: 'DELETE' }),
  lists: () => api<{ lists: TaskList[]; last: string | null }>('/api/nextasks/lists'),
  areas: () => api<AreaAnswer>('/api/nextasks/areas'),
  chooseAreas: (areas: string[], lists: string[], standard: string | null) => api<AreaAnswer>('/api/nextasks/areas', { method: 'PUT', body: { areas, lists, default: standard } }),
  send: (sending: Sending) => api<{ sent: number; links: TaskMark[]; cut?: boolean }>('/api/nextasks/send', { method: 'POST', body: sending }),
  links: (noteId: string) => api<{ links: TaskMark[] }>('/api/nextasks/links', { query: { note_id: noteId } }),
  open: (id: number) => api<{ url: string }>(`/api/nextasks/links/${id}/open`),
  removeLink: (id: number) => api<void>(`/api/nextasks/links/${id}`, { method: 'DELETE' }),
}

/** The connection, shared by every open note and the section in Connections: asked once, told when it changes. */
let known: NextasksStatus | null = null
let asking: Promise<NextasksStatus> | null = null
const listeners = new Set<() => void>()

export function nextasksStatus(): NextasksStatus | null {
  return known
}

export function loadNextasks(force = false): Promise<NextasksStatus> {
  if (asking && !force) return asking
  asking = nextasksApi.status().then(
    (status) => {
      setNextasks(status)
      return status
    },
    (error) => {
      asking = null
      throw error
    },
  )
  return asking
}

export function setNextasks(status: NextasksStatus | null): void {
  known = status
  if (status === null) asking = null
  for (const listener of listeners) listener()
}

export function onNextasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A new id for one sending: the same id again (a second click, a retry) makes no second task (EC-6). */
export function newRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
