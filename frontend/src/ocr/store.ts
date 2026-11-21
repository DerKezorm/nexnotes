/** Which attachment the large view shows (NOTES-11), opened from a block in a note or from a hit of the search. */
import { useSyncExternalStore } from 'react'

import type { AttachmentInfo } from '../attachments/api'
import type { Jump } from '../search/api'

export type Opening = {
  id: string
  /** What the block knows of it; from the search only the id, the rest is asked. */
  info: AttachmentInfo | null
  noteId: string
  page: number
  /** The place a hit of the search found (AC-8), marked in the text of `page`. */
  mark: Jump | null
  showText: boolean
  /** Where to go first (the note of a hit), once. */
  go: string | null
}

let current: Opening | null = null
const listeners = new Set<() => void>()

function publish(): void {
  for (const listener of listeners) listener()
}

export function openViewer(opening: Partial<Opening> & { id: string; noteId: string }): void {
  current = { info: null, page: 1, mark: null, showText: false, go: null, ...opening }
  publish()
}

export function closeViewer(): void {
  current = null
  publish()
}

/** The way to the note was taken. */
export function arrived(): void {
  if (current?.go) {
    current = { ...current, go: null }
    publish()
  }
}

export function useViewer(): Opening | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
