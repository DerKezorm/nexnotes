/**
 * The notice at the bottom of the page after a folder went to the trash, with "Undo" for ten seconds (NOTES-4 AC-5).
 * After that the way back is the trash (EC-10). It lives in a root of its own on `document.body`, so that it stays
 * when the page that started it goes away (the folder that was open is gone, the phone's sidebar closes).
 */
import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import { NoticeHost } from './NoticeHost'

/** How long "Undo" stays (the spec: 10 seconds). */
export const UNDO_MS = 10_000

export type Notice = { text: string; undo?: () => Promise<string | void> }

let notice: (Notice & { key: number }) | null = null
let counter = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
let mounted = false

function publish(next: typeof notice): void {
  notice = next
  for (const listener of listeners) listener()
}

export function hideNotice(): void {
  if (timer) clearTimeout(timer)
  timer = null
  publish(null)
}

/** Shows a notice; with `undo`, the button "Undo" until the time is up. A new notice takes the place of the old. */
export function showNotice(next: Notice, ms = next.undo ? UNDO_MS : 5000): void {
  ensureHost()
  if (timer) clearTimeout(timer)
  counter += 1
  publish({ ...next, key: counter })
  timer = setTimeout(hideNotice, ms)
}

export function useNotice() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => notice,
  )
}

function ensureHost(): void {
  if (mounted || typeof document === 'undefined') return
  mounted = true
  const box = document.createElement('div')
  box.dataset.folderNotices = ''
  document.body.append(box)
  createRoot(box).render(createElement(NoticeHost))
}
