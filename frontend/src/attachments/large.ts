/**
 * Where other features dock onto the attachments' blocks (NOTES-10), without the blocks knowing them:
 *
 * - `registerLargeView` (NOTES-11): "Groß öffnen" of a picture or a scan, and of a PDF, opens that view (the picture or
 *   the pages with the recognised text beside them) instead of the plain picture over the page. Without it a picture
 *   opens in the lightbox and a PDF only in the browser's viewer.
 * - `noteEditor`: the open editor of a note, for whoever puts text into it from outside the editor ("In die Notiz
 *   einfügen"); the attachments' extension keeps it (`editing.ts`).
 */
import type { Editor } from '@tiptap/core'

import type { AttachmentInfo } from './api'

export type LargeView = (info: AttachmentInfo, noteId: string) => void

let largeView: LargeView | null = null

export function registerLargeView(view: LargeView | null): void {
  largeView = view
}

export function largeViewFor(): LargeView | null {
  return largeView
}

const editors = new Map<string, Editor>()

export function keepEditor(noteId: string, editor: Editor): void {
  if (noteId) editors.set(noteId, editor)
}

export function dropEditor(noteId: string, editor: Editor): void {
  if (editors.get(noteId) === editor) editors.delete(noteId)
}

/** The editor that shows the note now, if one does. */
export function noteEditor(noteId: string): Editor | null {
  const editor = editors.get(noteId)
  return editor && !editor.isDestroyed ? editor : null
}
