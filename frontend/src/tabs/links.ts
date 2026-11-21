/**
 * A link to a note clicked with the middle button, or with Ctrl or ⌘, opens a tab of nexnotes instead of one of the
 * browser (NOTES-8 AC-3), in every list of notes. Links inside a note's text keep the browser's way (NOTES-3).
 *
 * Alt-click (⌥-click on a Mac) opens a tab too while a note is open, and the note itself while none is (third review).
 * The browser's own way would be worse than nothing: Chrome and Safari download the link's address on Alt-click, so
 * the click never reaches the browser.
 */
import { folderOfList, listOf, noteOf } from '../notes/workspace'
import { isDesktop } from './desktop'
import { openNoteInNewTab, openPath } from './open'
import { tabsNow } from './store'

function noteLink(event: MouseEvent): { note: string; folder?: string; path: string } | null {
  const target = event.target as Element | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor || anchor.closest('[contenteditable="true"], .ProseMirror')) return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin) return null
  // `/notes/<id>`, or a list with `?note=<id>` (NOTES-8 AC-9).
  const note = noteOf(url.pathname, url.search)
  if (!note) return null
  const folder = folderOfList(listOf(url.pathname, url.search))
  return { note, folder: folder && folder !== 'inbox' ? folder : undefined, path: url.pathname + url.search }
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented) return
  const leftClick = event.type === 'click' && event.button === 0 && !event.shiftKey
  if (leftClick && event.altKey) {
    const link = noteLink(event)
    if (link) altClickOpens(event, link.note, link.path, link.folder)
    return
  }
  if (!isDesktop()) return
  const inNewTab = (event.type === 'auxclick' && event.button === 1) || (leftClick && (event.ctrlKey || event.metaKey) && !event.altKey)
  if (!inNewTab) return
  const link = noteLink(event)
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  openNoteInNewTab(link.note, link.folder)
}

type Click = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'button' | 'preventDefault' | 'stopPropagation'>

/** Alt-click (⌥-click) on a note, a link or a button that leads to one: a new tab while a note is open, otherwise
 * (none open yet, or a phone) the note as with a plain click at `path`. Returns whether it took the click. */
export function altClickOpens(event: Click, note: string, path: string, folder?: string): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return false
  event.preventDefault()
  event.stopPropagation()
  if (!isDesktop() || tabsNow().tabs.length === 0) openPath(path)
  else openNoteInNewTab(note, folder)
  return true
}

/** The middle button scrolls the page on Windows from its press; on a link to a note it opens a tab instead. */
function onPress(event: MouseEvent): void {
  if (event.button === 1 && isDesktop() && noteLink(event)) event.preventDefault()
}

let installed = false

export function installTabLinks(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onClick, true)
  document.addEventListener('mousedown', onPress, true)
}
