/** Text recognition on the server (`backend/app/routers/ocr.py`, NOTES-11). */
import { api } from '../api/client'
import type { AttachmentInfo } from '../attachments/api'

export type PageState = 'pending' | 'done' | 'empty' | 'failed'
export type TextState = 'queued' | 'working' | 'done' | 'failed' | 'unavailable' | 'locked' | 'device' | 'none'

/** The text of one page: `language` is one of the operator's (`de`, `en` ...) or empty. */
export type PageText = { page: number; state: PageState; text: string; language: string; source: string }

export type AttachmentText = { id: string; state: TextState; pages: number; items: PageText[] }

/** Kinds of attachments the view shows with their text. */
export const TEXT_KINDS = ['image', 'scan', 'pdf']

const base = (id: string) => `/api/attachments/${encodeURIComponent(id)}`

/** A page of a PDF as the server draws it. */
export const pageUrl = (id: string, page: number, width = 1400) => `${base(id)}/pages/${page}?width=${width}`

export const ocrApi = {
  text: (id: string) => api<AttachmentText>(`${base(id)}/text`),
  attachment: (id: string) => api<AttachmentInfo>(base(id)),
}

/** Whether the server is still reading pages of it (and will say more on asking again). */
export function stillReading(text: AttachmentText | null): boolean {
  if (!text) return true
  if (['queued', 'working', 'device'].includes(text.state)) return true
  return false
}
