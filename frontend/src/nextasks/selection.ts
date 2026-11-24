/**
 * The way from the bar at the selection to the sending of lines (`SendToNextasks`): an open note whose lines can go to
 * nextasks now (connected, not locked) registers its way to the dialog here, and the bar offers "Als nextasks-Aufgabe"
 * only for such a note, under the same conditions as the head's button.
 */
import type { Editor } from '@tiptap/react'

const lineSenders = new Map<Editor, () => void>()

export function registerLineSender(editor: Editor, open: () => void): () => void {
  lineSenders.set(editor, open)
  return () => {
    if (lineSenders.get(editor) === open) lineSenders.delete(editor)
  }
}

export function canSendLines(editor: Editor): boolean {
  return lineSenders.has(editor)
}

/** The selected lines to the dialog, as the head's button sends them. */
export function sendSelection(editor: Editor): void {
  lineSenders.get(editor)?.()
}
