/** The vault routes of the server (`backend/app/routers/vault.py`, NOTES-16). Everything of a locked note goes there
 * encrypted; only the check value of the password and the wrapped vault key travel besides. */
import { api, ApiError, tabId } from '../api/client'
import type { AttachmentInfo } from '../attachments/api'
import type { Kdf } from './crypto'

export type VaultStatus = {
  set_up: boolean
  kdf?: Kdf
  epoch?: number
  /** Locked notes outside the trash, and with it (what a new vault takes, EC-2). */
  locked_notes: number
  locked_all: number
  /** Seconds before the next try is taken (EC-1). */
  wait?: number
  failures?: number
}

export type Wrapped = { kdf: Kdf; wrapped_key: string; auth: string }

export type LockStart = { state: string; versions: { id: number; state: string }[]; attachments: string[]; epoch: number }
export type UnlockStart = { content: string; rev: number; versions: { id: number; content: string }[]; attachments: string[]; epoch: number }
export type Sealed = { id: string; content: string; rev: number; epoch: number; title: string; saved_at: string }

const note = (id: string) => `/api/vault/notes/${encodeURIComponent(id)}`

export const vaultApi = {
  status: () => api<VaultStatus>('/api/vault'),
  setup: (body: Wrapped & { understood: boolean }) => api<VaultStatus>('/api/vault/setup', { method: 'POST', body }),
  unlock: (auth: string) => api<{ wrapped_key: string; kdf: Kdf; epoch: number }>('/api/vault/unlock', { method: 'POST', body: { auth } }),
  password: (body: Wrapped & { auth_old: string }) => api<VaultStatus>('/api/vault/password', { method: 'POST', body }),
  reset: (body: Wrapped & { understood: boolean; count: number }) => api<VaultStatus & { removed: number }>('/api/vault/reset', { method: 'POST', body }),
  lockStart: (id: string) => api<LockStart>(`${note(id)}/lock/start`, { method: 'POST' }),
  lock: (id: string) => api<{ id: string; locked: boolean; rev: number }>(`${note(id)}/lock`, { method: 'POST' }),
  lockCancel: (id: string) => api<void>(`${note(id)}/lock/cancel`, { method: 'POST' }),
  unlockStart: (id: string) => api<UnlockStart>(`${note(id)}/unlock/start`, { method: 'POST' }),
  unlockNote: (id: string, names: Record<string, string>) => api<{ id: string; locked: boolean }>(`${note(id)}/unlock`, { method: 'POST', body: { names } }),
  unlockCancel: (id: string) => api<void>(`${note(id)}/unlock/cancel`, { method: 'POST' }),
  stage: (id: string, step: 'lock' | 'unlock', part: string, data: Uint8Array<ArrayBuffer>) =>
    api<{ part: string; size: number }>('/api/vault/stage', { method: 'PUT', query: { note: id, step, part }, raw: new Blob([data]) }),
  sealed: (id: string) => api<Sealed>(note(id)),
  save: (body: { note: string; content: string; base_rev: number; epoch: number; title: string; restored_from?: number }) =>
    api<{ rev: number; conflict: boolean }>('/api/vault/save', { method: 'POST', body }),
  /** The bytes of an attachment as the server keeps them (for a locked note: the ciphertext). */
  file: (attachmentId: string) => api<Blob>(`/api/attachments/${encodeURIComponent(attachmentId)}/file`, { blob: true }),
  info: (attachmentId: string) => api<AttachmentInfo>(`/api/attachments/${encodeURIComponent(attachmentId)}`),
}

/** Uploads an encrypted attachment of an open locked note, with progress (NOTES-10 AC-10 for locked notes too). */
export function sendSealed(noteId: string, id: string, data: Blob, onProgress: (part: number) => void): { done: Promise<AttachmentInfo>; cancel: () => void } {
  const request = new XMLHttpRequest()
  const done = new Promise<AttachmentInfo>((resolve, reject) => {
    const query = new URLSearchParams({ note: noteId, id })
    request.open('PUT', `/api/vault/attachments?${query.toString()}`)
    request.setRequestHeader('X-Nexnotes-Client', tabId())
    request.setRequestHeader('Accept', 'application/json')
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      let parsed: { detail?: Record<string, unknown> } | AttachmentInfo | null
      try {
        parsed = JSON.parse(request.responseText)
      } catch {
        parsed = null
      }
      if (request.status >= 200 && request.status < 300) return resolve(parsed as AttachmentInfo)
      const detail = (parsed as { detail?: Record<string, unknown> } | null)?.detail ?? {}
      const { code, message: _message, ...values } = detail as { code?: string; message?: string }
      reject(new ApiError(request.status, typeof code === 'string' ? code : 'internal_error', values))
    }
    request.onerror = () => reject(new ApiError(0, 'network'))
    request.onabort = () => reject(new ApiError(0, 'cancelled'))
    request.send(data)
  })
  return { done, cancel: () => request.abort() }
}
