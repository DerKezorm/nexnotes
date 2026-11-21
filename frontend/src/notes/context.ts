/**
 * Leaving a note. An open note without a title may not be left inside nexnotes (NOTES-3 AC-9): the editor puts up a
 * guard (`setLeaveGuard`), every way out inside the app asks it first (`tryLeave`), the editor catches links
 * anywhere on the page too, and the browser's back and forward buttons (`setPopGuard`).
 */

import { keepsNotesOpen } from './workspace'

/** Answers whether leaving must wait; if it must, it calls `proceed` itself once the member decided. */
export type LeaveGuard = (proceed: () => void) => boolean

let guard: LeaveGuard | null = null

export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next
}

/** Answers whether a step of the browser's back or forward button is the open note's to handle (true: the router
 * never sees it). */
export type PopGuard = (event: PopStateEvent) => boolean

let popGuard: PopGuard | null = null

export function setPopGuard(next: PopGuard | null): void {
  popGuard = next
}

// Listening from the moment this module loads, before the router (BrowserRouter, no data router, so no `useBlocker`)
// adds its own listener: listeners on the window run in the order they came, and once the router has the event the
// page has moved on (the note unmounted, its guard gone).
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => {
    if (popGuard?.(event)) event.stopImmediatePropagation()
  })
}

/** An open note, as far as "New note" needs it (NOTES-3 AC-1, EC-4). `guarded`: the one on the side used last (the
 * only one without a second side). `focusTitle` brings its side to the front first, if it has to. */
export type OpenNote = { noteId: string; folderId: string; guarded: boolean; isBlank: () => boolean; focusTitle: () => void }

const openNotes = new Set<OpenNote>()

/** An open editor tells "New note" about its note; the function it gets back takes it out again. */
export function addOpenNote(note: OpenNote): () => void {
  openNotes.add(note)
  return () => void openNotes.delete(note)
}

/**
 * An open note that is quite empty (no title, no text) and lies in `folderId`: "New note" there, in the sidebar or
 * as "+" in the row of tabs, takes it instead of making a second one, which the first would make vanish again a
 * moment later (EC-4). The note on the side used last first, then the other side's (fifth review).
 */
export function blankOpenNoteIn(folderId: string | null | undefined): OpenNote | null {
  if (!folderId) return null
  const candidates = [...openNotes].filter((note) => note.folderId === folderId).sort((a, b) => Number(b.guarded) - Number(a.guarded))
  return candidates.find((note) => note.isBlank()) ?? null
}

/** Leaves at once, or after the open note had its say. Going `to` another list on a wider screen leaves no note
 * (the tabs stay, NOTES-8 AC-9), so nothing is asked then. */
export function tryLeave(proceed: () => void, to?: string): void {
  if (to !== undefined && keepsNotesOpen(to)) return proceed()
  if (guard && guard(proceed)) return
  proceed()
}

/** Goes to an address of the app from outside React's tree (a registered action): the router follows the history. */
export function goTo(path: string, state?: unknown): void {
  const index = typeof window.history.state?.idx === 'number' ? window.history.state.idx + 1 : 0
  window.history.pushState({ usr: state ?? null, key: Math.random().toString(36).slice(2, 10), idx: index }, '', path)
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
}
