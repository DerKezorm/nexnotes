/**
 * A link to a note clicked with the middle button, or with Ctrl or ⌘, opens a tab of nexnotes instead of one of the
 * browser (NOTES-8 AC-3), in every list of notes. Links inside a note's text keep the browser's way (NOTES-3).
 */
import { folderOfList, listOf, noteOf } from '../notes/workspace'
import { isDesktop } from './desktop'
import { openNoteInNewTab } from './open'

function noteLink(event: MouseEvent): { note: string; folder?: string } | null {
  const target = event.target as Element | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor || anchor.closest('[contenteditable="true"], .ProseMirror')) return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin) return null
  // `/notes/<id>`, or a list with `?note=<id>` (NOTES-8 AC-9).
  const note = noteOf(url.pathname, url.search)
  if (!note) return null
  const folder = folderOfList(listOf(url.pathname, url.search))
  return { note, folder: folder && folder !== 'inbox' ? folder : undefined }
}

function onClick(event: MouseEvent): void {
  if (!isDesktop() || event.defaultPrevented) return
  const inNewTab = (event.type === 'auxclick' && event.button === 1) || (event.type === 'click' && event.button === 0 && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey)
  if (!inNewTab) return
  const link = noteLink(event)
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  openNoteInNewTab(link.note, link.folder)
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
