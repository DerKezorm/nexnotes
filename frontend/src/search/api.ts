/** The search routes of the server (`backend/app/routers/search.py`). */
import { api } from '../api/client'

/** A piece of a title or an excerpt; `hit` pieces are marked. Text, never markup. */
export type Piece = { text: string; hit: boolean }

/** Where the editor finds the hit again (AC-5): the hit as written, and how many of the same text come before it. */
export type Jump = { text: string; nth: number }

/** A hit only in text beyond the body: a page of a scan or PDF, a picture (NOTES-11). */
export type AttachmentHit = { kind: string; name: string; page: number | null; ref: string }

export type Hit = {
  id: string
  title: string
  title_parts: Piece[]
  excerpt: Piece[]
  where: 'title' | 'text' | 'attachment'
  attachment: AttachmentHit | null
  jump: Jump | null
  folder: { id: string; name: string; inbox: boolean } | null
  owner_id: number
  created_at: string | null
  updated_at: string | null
}

export type SearchAnswer = {
  total: number
  offset: number
  items: Hit[]
  /** Hits without any filter; only when the filters left nothing (EC-2). */
  unfiltered: number | null
  terms: string[]
  tags: string[]
}

export type TagCount = { tag: string; key: string; count: number }

export type SearchQuery = {
  q: string
  folder_id?: string
  tag?: string
  since?: string
  until?: string
  date_field?: 'updated' | 'created'
  offset?: number
  limit?: number
}

/** Hits per page and the most one request takes. */
export const PAGE = 50
export const PAGE_MAX = 100

export const searchApi = {
  find: (query: SearchQuery) => api<SearchAnswer>('/api/search', { query }),
  tags: () => api<TagCount[]>('/api/search/tags'),
}
