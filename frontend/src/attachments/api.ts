/**
 * Attachments on the server (`backend/app/routers/attachments.py`, NOTES-10): uploading with progress and a way to
 * cancel, the limits before an upload, a note's attachments, the gallery, the card of a link.
 */
import { api, ApiError, tabId } from '../api/client'

export type AttachmentKind = 'image' | 'scan' | 'pdf' | 'recording' | 'drawing' | 'video' | 'file' | 'linkimage'

/** An attachment as the server describes it. */
export type AttachmentInfo = {
  id: string
  note_id: string
  kind: AttachmentKind
  name: string
  mime: string
  size: number
  width: number | null
  height: number | null
  pages: number | null
  duration_ms: number | null
  /** A WebP every browser shows exists (`/view`). */
  view: boolean
  /** A preview exists (`/thumb`). */
  thumb: boolean
  /** The file itself may be shown in the page (a picture drawn anew, a PDF, a video); otherwise only downloaded. */
  inline: boolean
  created_at: string | null
}

export type Limits = { max_mb: number; used: number; limit: number | null; full: boolean; link_previews: boolean }

export type GalleryKind = Exclude<AttachmentKind, 'linkimage'>
export const GALLERY_KINDS: GalleryKind[] = ['image', 'scan', 'pdf', 'recording', 'drawing', 'video', 'file']
export type GallerySort = 'newest' | 'largest'
export type GalleryItem = AttachmentInfo & { note: { id: string; title: string } }
export type Gallery = { total: number; all: number; bytes: number; counts: Record<GalleryKind, number>; items: GalleryItem[] }

export type LinkCard = { href: string; title: string | null; description: string | null; site: string | null; image: string | null }

const base = (id: string) => `/api/attachments/${encodeURIComponent(id)}`

/** Where the browser finds the file, the picture every browser shows, the preview. */
export const fileUrl = (id: string, download = false) => `${base(id)}/file${download ? '?download=1' : ''}`
export const viewUrl = (id: string) => `${base(id)}/view`
export const thumbUrl = (id: string) => `${base(id)}/thumb`

export const attachmentsApi = {
  limits: () => api<Limits>('/api/attachments/limits'),
  ofNote: (noteId: string) => api<{ items: AttachmentInfo[] }>(`/api/notes/${encodeURIComponent(noteId)}/attachments`),
  gallery: (query: { kind?: GalleryKind; sort?: GallerySort; offset?: number; limit?: number }) =>
    api<Gallery>('/api/attachments', { query }),
  linkPreview: (noteId: string, url: string) =>
    api<{ preview: LinkCard | null; reason: string | null }>(`/api/notes/${encodeURIComponent(noteId)}/link-preview`, { method: 'POST', body: { url } }),
}

/** A new attachment id: 16 random bytes as base64url, 22 characters, the same shape the server takes. */
export function newAttachmentId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type Sending = { done: Promise<AttachmentInfo>; cancel: () => void }

/** Uploads one file: progress from 0 to 1 while it goes, `cancel` stops it. A broken connection rejects with the code
 * `network`, a refusal with the server's code and values (`attachment_too_large`, `storage_limit_reached`). */
export function sendFile(noteId: string, id: string, file: Blob, name: string, onProgress: (part: number) => void): Sending {
  const request = new XMLHttpRequest()
  const done = new Promise<AttachmentInfo>((resolve, reject) => {
    const query = new URLSearchParams({ note_id: noteId, id, name })
    request.open('POST', `/api/attachments?${query.toString()}`)
    request.setRequestHeader('X-Nexnotes-Client', tabId())
    request.setRequestHeader('Accept', 'application/json')
    if (file.type) request.setRequestHeader('Content-Type', file.type)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      let data: { detail?: Record<string, unknown> } | AttachmentInfo | null
      try {
        data = JSON.parse(request.responseText)
      } catch {
        data = null
      }
      if (request.status >= 200 && request.status < 300) return resolve(data as AttachmentInfo)
      const detail = (data as { detail?: Record<string, unknown> } | null)?.detail ?? {}
      const { code, message: _message, ...values } = detail as { code?: string; message?: string }
      reject(new ApiError(request.status, typeof code === 'string' ? code : 'internal_error', values))
    }
    request.onerror = () => reject(new ApiError(0, 'network'))
    request.ontimeout = () => reject(new ApiError(0, 'network'))
    request.onabort = () => reject(new ApiError(0, 'cancelled'))
    request.send(file)
  })
  return { done, cancel: () => request.abort() }
}
