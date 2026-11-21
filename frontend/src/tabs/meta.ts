/**
 * What a tab shows of its note without opening it: title, folder (for the color), and whether the note is still
 * there. Read from the note's head (`GET /api/notes/<id>`) for every tab, again when notes changed in this window,
 * when the window comes back into view, when a live connection stopped, and every half minute.
 *
 * - `deleted`: in the trash (the head says `deleted_at`), also when another device or somebody else put it there (EC-3).
 * - `gone`: the server does not hand it out any more (404/403): deleted for good, or no longer shared (EC-6).
 * - `locked`: the head says so (NOTES-16 brings it); the tab shows the lock (EC-5).
 */
import { useEffect, useSyncExternalStore } from 'react'

import { ApiError } from '../api/client'
import { notesApi, NOTES_CHANGED_EVENT, type NoteHead } from '../notes/api'

export type TabMeta = {
  title: string
  folder: string | null
  inbox: boolean
  state: 'ok' | 'deleted' | 'gone'
  locked: boolean
  canWrite: boolean
}

const cache = new Map<string, TabMeta>()
const listeners = new Set<() => void>()
let version = 0
const asking = new Map<string, Promise<void>>()

function emit(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

export function metaOf(note: string): TabMeta | undefined {
  return cache.get(note)
}

export function metaFromHead(head: NoteHead & { locked?: boolean }): TabMeta {
  const last = head.path.at(-1)
  return {
    title: head.title,
    folder: last?.id ?? head.folder_id ?? null,
    inbox: Boolean(last?.inbox),
    state: head.deleted_at ? 'deleted' : 'ok',
    locked: Boolean(head.locked),
    canWrite: head.can_write,
  }
}

/** Reads the heads of these notes once more (each at most once at a time). */
export function refreshMeta(notes: string[]): Promise<void> {
  return Promise.all(
    [...new Set(notes)].map((note) => {
      const running = asking.get(note)
      if (running) return running
      const ask = notesApi
        .get(note)
        .then((head) => {
          cache.set(note, metaFromHead(head))
          emit()
        })
        .catch((error: unknown) => {
          // Not there for this account any more: deleted for good, or the sharing ended. Anything else (offline, a
          // session that ended) keeps what was known.
          if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
            const known = cache.get(note)
            cache.set(note, { title: known?.title ?? '', folder: known?.folder ?? null, inbox: known?.inbox ?? false, state: 'gone', locked: false, canWrite: false })
            emit()
          }
        })
        .finally(() => asking.delete(note))
      asking.set(note, ask)
      return ask
    }),
  ).then(() => undefined)
}

/** A title typed in an open note shows in its tab at once. */
export function noteTitle(note: string, title: string): void {
  const known = cache.get(note)
  if (!known || known.title === title) return
  cache.set(note, { ...known, title })
  emit()
}

export function forgetMeta(): void {
  cache.clear()
  asking.clear()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The heads of these notes, kept fresh while the tabs are on the page. */
export function useTabMetas(notes: string[]): Map<string, TabMeta> {
  useSyncExternalStore(subscribe, () => version)
  const wanted = [...new Set(notes)].sort().join('\n')
  useEffect(() => {
    const ids = wanted ? wanted.split('\n') : []
    if (!ids.length) return
    const again = () => void refreshMeta(ids)
    again()
    const onVisible = () => {
      if (document.visibilityState === 'visible') again()
    }
    window.addEventListener(NOTES_CHANGED_EVENT, again)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(again, 30_000)
    return () => {
      window.removeEventListener(NOTES_CHANGED_EVENT, again)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [wanted])
  return cache
}
