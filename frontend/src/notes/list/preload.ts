/**
 * The list of the page the tab opens on, asked for at once (EC-2: the first row under a second with 10,000 notes).
 *
 * Without this the list waits for the program, then for the sign-in check, then for the page to draw, before it even
 * asks. Here it leaves while the program is still starting, next to the sign-in check; `useNoteList` takes the answer
 * for its first load when it is for the same list and still fresh, and asks itself otherwise (signed out, another
 * page, an error). Only in the built app: tests and the development server ask the usual way.
 */
import { tabId } from '../../api/client'
import type { ListAnswer } from './api'

/** An answer older than this is not taken: the list asks anew. */
const FRESH_MS = 10_000

type Early = { key: string; at: number; answer: Promise<[ListAnswer, { stamp: string }] | null> }

let early: Early | null = null

/** The list a path shows: `all`, a folder's id, or null for a page without a list of notes. */
export function listKeyOf(pathname: string, search: string): string | null {
  const folder = /^\/folder\/([^/]+)\/?$/.exec(pathname)
  if (folder) return decodeURIComponent(folder[1])
  if (pathname === '/' || /^\/notes\/[^/]+\/?$/.test(pathname)) return new URLSearchParams(search).get('folder') || 'all'
  return null
}

async function ask<T>(path: string): Promise<T | null> {
  const response = await fetch(path, { headers: { Accept: 'application/json', 'X-Nexnotes-Client': tabId() } })
  return response.ok ? ((await response.json()) as T) : null
}

/** Starts asking for the list of `pathname`, once; nothing for a page without one. */
export function preloadList(pathname: string, search: string): void {
  const key = listKeyOf(pathname, search)
  if (!key || early) return
  const query = key === 'all' ? '' : `?folder_id=${encodeURIComponent(key)}`
  const answer = Promise.all([ask<ListAnswer>(`/api/note-list${query}`), ask<{ stamp: string }>(`/api/note-list/stamp${query}`)])
    .then(([list, stamp]) => (list && stamp ? ([list, stamp] as [ListAnswer, { stamp: string }]) : null))
    .catch(() => null)
  early = { key, at: Date.now(), answer }
}

/** The early answer for this list, once: null when there is none, it was for another list or it is too old. */
export function takeEarly(folderId?: string): Early['answer'] | null {
  const found = early
  early = null
  if (!found || found.key !== (folderId ?? 'all') || Date.now() - found.at > FRESH_MS) return null
  return found.answer
}

// The built app asks as soon as this module loads, before the first render.
if (import.meta.env.PROD && typeof window !== 'undefined') preloadList(window.location.pathname, window.location.search)
