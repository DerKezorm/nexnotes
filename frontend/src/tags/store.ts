/**
 * The tags of the signed-in account, shared by the sidebar, the page of all tags and the editor's suggestions: loaded
 * once, asked again after a change, when the window comes back to the front and now and then (the server reads tags
 * from the text a moment after typing).
 */
import { useSyncExternalStore } from 'react'

import { NOTES_CHANGED_EVENT } from '../notes/api'
import { tagsApi, type TagInfo } from './api'

export type TagsState = { status: 'idle' | 'loading' | 'ready' | 'failed'; tags: TagInfo[] }

/** Sent on `window` when tags were renamed or deleted: pages of tags and lists load again. */
export const TAGS_CHANGED_EVENT = 'nexnotes:tags-changed'
/** How often the list is asked again while the page is open. */
const REFRESH_MS = 30_000
/** After typing a tag: the server has read it by then (its summary follows two seconds after a change). */
const AFTER_TYPING_MS = 3_000

let state: TagsState = { status: 'idle', tags: [] }
const listeners = new Set<() => void>()
let pending: Promise<void> | null = null
let watching = false
let soon: ReturnType<typeof setTimeout> | null = null

function publish(next: TagsState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Asks the server for the tags again; one request at a time. */
export function refreshTags(): Promise<void> {
  if (pending) return pending
  if (state.status === 'idle') publish({ ...state, status: 'loading' })
  pending = tagsApi
    .list()
    .then((answer) => publish({ status: 'ready', tags: answer.tags }))
    .catch(() => publish({ ...state, status: state.status === 'ready' ? 'ready' : 'failed' }))
    .finally(() => {
      pending = null
    })
  return pending
}

/** The tags of a note changed while typing: the list follows once the server has read them. */
export function refreshTagsSoon(): void {
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => {
    soon = null
    void refreshTags()
  }, AFTER_TYPING_MS)
}

/** Tags were renamed or deleted. */
export function tagsChanged(): void {
  window.dispatchEvent(new Event(TAGS_CHANGED_EVENT))
}

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  const again = () => void refreshTags()
  window.addEventListener('focus', again)
  window.addEventListener(NOTES_CHANGED_EVENT, again)
  window.addEventListener(TAGS_CHANGED_EVENT, again)
  setInterval(() => {
    if (listeners.size > 0 && document.visibilityState !== 'hidden') again()
  }, REFRESH_MS)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  watch()
  if (state.status === 'idle') void refreshTags()
  return () => listeners.delete(listener)
}

export function useTags(): TagsState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The tags as they are now, for code outside React (the editor's suggestions). */
export function currentTags(): TagInfo[] {
  if (state.status === 'idle') void refreshTags()
  return state.tags
}

/** For tests: forget what was loaded. */
export function forgetTags(): void {
  state = { status: 'idle', tags: [] }
  pending = null
  if (soon) clearTimeout(soon)
  soon = null
}
