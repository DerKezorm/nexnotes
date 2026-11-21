/**
 * What the folder pages need from the note editor, which comes with its own feature: how to start a new note in a
 * folder ("New note in “Garden”" of the empty folder) and where a note opens (the titles in the inbox). The editor
 * registers both once (`registerNoteActions`); until it does, the button is not shown and the titles are plain text.
 *
 * And the other way round: rows of notes become draggable onto the folders of the sidebar with `startNoteDrag`.
 */
import type { DragEvent } from 'react'
import { useSyncExternalStore } from 'react'

export type NoteActions = {
  /** Starts a new note in this folder (or the inbox) and opens it. */
  newNote?: (folderId: string) => void
  /** The address a note opens at. */
  noteHref?: (noteId: string) => string
}

let actions: NoteActions = {}
const listeners = new Set<() => void>()

export function registerNoteActions(next: NoteActions): void {
  actions = { ...actions, ...next }
  for (const listener of listeners) listener()
}

export function useNoteActions(): NoteActions {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => actions,
  )
}

/** Sent on `window` when notes changed their folder, for lists that show them (the inbox, the notes of a folder). */
export const NOTES_MOVED_EVENT = 'nexnotes:notes-moved'

export function notesMoved(noteIds: string[], folderId: string): void {
  window.dispatchEvent(new CustomEvent(NOTES_MOVED_EVENT, { detail: { noteIds, folderId } }))
}

// ---- Dragging --------------------------------------------------------------------------------------------------------

/** The kinds of things that can be dropped on a folder. A browser shows the data of a drag only at the drop, so what is
 * dragged is also kept here for the way over the rows (where a folder must decide whether it accepts it). */
export const NOTE_DRAG = 'application/x-nexnotes-notes'
export const FOLDER_DRAG = 'application/x-nexnotes-folder'

export type Dragged = { kind: 'notes'; ids: string[] } | { kind: 'folder'; ids: string[] } | null

let dragged: Dragged = null

export function draggedNow(): Dragged {
  return dragged
}

function start(event: DragEvent, type: string, value: Exclude<Dragged, null>): void {
  dragged = value
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(type, JSON.stringify(value.ids))
  event.dataTransfer.setData('text/plain', value.ids.join('\n'))
  const done = () => {
    dragged = null
    window.removeEventListener('dragend', done, true)
  }
  window.addEventListener('dragend', done, true)
}

/** Makes a drag of one or more notes, for any list of notes (`onDragStart`). */
export function startNoteDrag(event: DragEvent, noteIds: string[]): void {
  start(event, NOTE_DRAG, { kind: 'notes', ids: noteIds })
}

export function startFolderDrag(event: DragEvent, folderId: string): void {
  start(event, FOLDER_DRAG, { kind: 'folder', ids: [folderId] })
}

/** What a drop carries: from this page (kept above) or, failing that, from the drop's own data. */
export function droppedFrom(event: DragEvent): Dragged {
  if (dragged) return dragged
  for (const [type, kind] of [
    [NOTE_DRAG, 'notes'],
    [FOLDER_DRAG, 'folder'],
  ] as const) {
    try {
      const ids = JSON.parse(event.dataTransfer.getData(type) || 'null')
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) return { kind, ids }
    } catch {
      // not ours
    }
  }
  return null
}

export function endDrag(): void {
  dragged = null
}
