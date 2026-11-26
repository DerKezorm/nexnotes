/** A note into nexlore over the server (`backend/app/routers/nexlore.py`, module verbinden). */
import { api } from '../api/client'

export type NexloreStatus = { connected: boolean; host?: string; spaces: { id: string; name: string }[] }

export const nexloreApi = {
  status: () => api<NexloreStatus>('/api/nexlore'),
  send: (noteId: string, space: string) => api<{ sent: boolean; path: string }>('/api/nexlore/send', { method: 'POST', body: { note_id: noteId, space } }),
}

/** Whether nexlore is connected, asked once per page (the menu opens often). */
export const known: { status: Promise<NexloreStatus> | null } = { status: null }
export function forgetNexlore(): void {
  known.status = null
}
