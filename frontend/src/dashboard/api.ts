/** Keys for nexdeck cards over the server (`backend/app/routers/dashboard.py`, NOTES-21). */
import { api } from '../api/client'

export type DeckLevel = 'read' | 'write'

export type DeckKey = {
  id: number
  name: string
  level: DeckLevel
  prefix: string
  created_at: string | null
  last_used_at: string | null
}

export type DeckKeys = {
  /** The address nexdeck is given for nexnotes. */
  address: string
  max_keys: number
  keys: DeckKey[]
}

export type MadeDeckKey = { key: DeckKey; token: string }

export const deckApi = {
  keys: () => api<DeckKeys>('/api/dashboard/keys'),
  make: (name: string, level: DeckLevel) => api<MadeDeckKey>('/api/dashboard/keys', { method: 'POST', body: { name, level } }),
  revoke: (id: number) => api<void>(`/api/dashboard/keys/${id}`, { method: 'DELETE' }),
}
