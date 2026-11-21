/**
 * One list's notes and view, kept fresh (NOTES-6).
 *
 * - Loaded once (the first time perhaps already asked for while the program started, `preload.ts`), then the server's
 *   stamp is asked every few seconds while the page is in sight; only a changed stamp loads the list again (EC-6: a
 *   note changed on another device shows up without reloading the page). Notes made, renamed, moved or deleted here
 *   load it at once.
 * - The view (rows or tiles, sorting, grouping) is the account's per folder on the server (AC-1, AC-4, AC-5); a change
 *   shows at once and is saved behind it.
 * - Pinning and colors (AC-6, AC-8) show at once too, and go back with a notice when the server says no.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { NOTES_MOVED_EVENT } from '../../folders/actions'
import { showNotice } from '../../folders/notice'
import { problemText } from '../../lib/errors'
import { NOTES_CHANGED_EVENT, notesChanged } from '../api'
import { DEFAULT_VIEW, listApi, type ListAnswer, type ListItem, type ListView } from './api'
import { takeEarly } from './preload'

/** How often an open list asks whether anything changed. */
export const STAMP_EVERY_MS = 5000

export type NoteListState = {
  answer: ListAnswer | null
  failed: boolean
  view: ListView
  setView: (change: Partial<ListView>) => void
  pin: (item: ListItem, pinned: boolean) => void
  color: (item: ListItem, color: string) => void
  reload: () => void
}

function patchItem(answer: ListAnswer | null, id: string, change: Partial<ListItem>): ListAnswer | null {
  if (!answer) return answer
  return { ...answer, items: answer.items.map((item) => (item.id === id ? { ...item, ...change } : item)) }
}

export function useNoteList(folderId?: string): NoteListState {
  const [answer, setAnswer] = useState<ListAnswer | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setViewState] = useState<ListView>(DEFAULT_VIEW)
  const asked = useRef(0)
  const stamp = useRef('')
  /** A view chosen here and not yet confirmed: an answer that left before it keeps the choice. */
  const chosen = useRef<Partial<ListView> | null>(null)

  const load = useCallback(() => {
    const mine = ++asked.current
    const ask = () => Promise.all([listApi.read(folderId), listApi.stamp(folderId).catch(() => ({ stamp: '' }))])
    // The first load takes the answer asked for while the program started (`preload.ts`), when there is one.
    const early = takeEarly(folderId)
    ;(early ? early.then((answer) => answer ?? ask()) : ask())
      .then(([found, now]) => {
        if (mine !== asked.current) return
        stamp.current = now.stamp
        setAnswer(found)
        setViewState({ ...DEFAULT_VIEW, ...found.view, ...(chosen.current ?? {}) })
        setFailed(false)
      })
      .catch(() => {
        if (mine === asked.current) setFailed(true)
      })
  }, [folderId])

  // Another folder: start from what the server says, not from the last folder's view.
  useEffect(() => {
    chosen.current = null
    stamp.current = ''
    setAnswer(null)
    setViewState(DEFAULT_VIEW)
    load()
  }, [load])

  useEffect(() => {
    const again = () => load()
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      listApi
        .stamp(folderId)
        .then((now) => {
          if (now.stamp !== stamp.current) load()
        })
        .catch(() => undefined)
    }
    window.addEventListener(NOTES_CHANGED_EVENT, again)
    window.addEventListener(NOTES_MOVED_EVENT, again)
    window.addEventListener('focus', check)
    const timer = setInterval(check, STAMP_EVERY_MS)
    return () => {
      window.removeEventListener(NOTES_CHANGED_EVENT, again)
      window.removeEventListener(NOTES_MOVED_EVENT, again)
      window.removeEventListener('focus', check)
      clearInterval(timer)
    }
  }, [folderId, load])

  const setView = useCallback(
    (change: Partial<ListView>) => {
      chosen.current = { ...(chosen.current ?? {}), ...change }
      setViewState((old) => ({ ...old, ...change }))
      listApi
        .saveView(folderId, change)
        .then((saved) => {
          chosen.current = null
          setViewState((old) => ({ ...old, ...saved }))
        })
        .catch((error) => showNotice({ text: problemText(error) }))
    },
    [folderId],
  )

  const pin = useCallback((item: ListItem, pinned: boolean) => {
    setAnswer((old) => patchItem(old, item.id, { pinned }))
    listApi
      .pin(item.id, pinned)
      .then(() => notesChanged())
      .catch((error) => {
        setAnswer((old) => patchItem(old, item.id, { pinned: item.pinned }))
        showNotice({ text: problemText(error) })
      })
  }, [])

  const color = useCallback((item: ListItem, value: string) => {
    setAnswer((old) => patchItem(old, item.id, { color: value }))
    listApi
      .color(item.id, value)
      .then(() => notesChanged())
      .catch((error) => {
        setAnswer((old) => patchItem(old, item.id, { color: item.color }))
        showNotice({ text: problemText(error) })
      })
  }, [])

  return { answer, failed, view, setView, pin, color, reload: load }
}
