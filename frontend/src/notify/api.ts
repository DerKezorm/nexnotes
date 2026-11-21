/** Notifications over the server (`backend/app/routers/notify.py`, NOTES-14). */
import { api } from '../api/client'

export type NotifyKind = 'note' | 'folder'

export type NotifyDevices = {
  /** iOS devices signed up for notifications (NOTES-24). */
  apps: { id: number; name: string; on: boolean }[]
  /** Browsers that allowed them; `this` is the one asking. */
  browsers: { id: number; browser: string; system: string; this: boolean }[]
  this_browser: boolean
}

export type NotifySettings = {
  kind: NotifyKind
  id: string
  on: boolean
  /** On or off through a folder above (its nearest switch). */
  via: { id: string; name: string } | null
  /** Only what is shared can be switched on (AC-1). */
  shared: boolean
  devices: NotifyDevices
  /** How a notification looks, in the member's language (AC-8). */
  preview: { title: string; text: string }
}

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }

const at = (kind: NotifyKind, id: string) => `/api/notify/${kind}/${encodeURIComponent(id)}`

export const notifyApi = {
  get: (kind: NotifyKind, id: string) => api<NotifySettings>(at(kind, id)),
  set: (kind: NotifyKind, id: string, on: boolean) => api<NotifySettings>(at(kind, id), { method: 'PUT', body: { on } }),
  webpush: () => api<{ key: string; subscribed: boolean }>('/api/notify/webpush'),
  subscribe: (subscription: Subscription) => api<void>('/api/notify/webpush', { method: 'PUT', body: subscription }),
  unsubscribe: () => api<void>('/api/notify/webpush', { method: 'DELETE' }),
  /** This browser shows the note in view right now (AC-9), or none. */
  viewing: (noteId: string | null) => api<void>('/api/notify/viewing', { method: 'PUT', body: { note_id: noteId } }),
}
