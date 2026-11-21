/**
 * The search's keys, everywhere in the app, in the text too: Ctrl/⌘ + K as in the other nex apps; Ctrl/⌘ + Shift + F,
 * and `/` while no text is being written. Ctrl/⌘ + F stays the browser's. On the search page they put the cursor back
 * into the field.
 */
import { goTo, tryLeave } from '../notes/context'

export const SEARCH_PATH = '/search'
/** Sent on `window` to put the cursor into the search field (the shortcut while the page is open). */
export const FOCUS_SEARCH_EVENT = 'nexnotes:focus-search'

function writing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return false
  return Boolean(element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

/** Opens the search (or puts the cursor in its field when it is open already). */
export function openSearch(): void {
  if (window.location.pathname === SEARCH_PATH) {
    window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))
    return
  }
  tryLeave(() => goTo(SEARCH_PATH), SEARCH_PATH)
}

export function onShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey) return
  const command = event.ctrlKey || event.metaKey
  const findAll = command && event.shiftKey && event.key.toLowerCase() === 'f'
  const family = command && !event.shiftKey && event.key.toLowerCase() === 'k'
  const slash = event.key === '/' && !command && !writing(event.target)
  if (!findAll && !family && !slash) return
  event.preventDefault()
  openSearch()
}

let installed = false

export function installShortcuts(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', onShortcut)
}

