/**
 * "Neue Notiz": a note with an id made here, so that a second click (or a request sent twice) gives the same note
 * (NOTES-3 EC-9). It goes into the folder that is open, or the inbox (NOTES-4 AC-9, `useCurrentFolder`).
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { refreshFolders, useCurrentFolder } from '../folders/store'
import { notesApi, notesChanged, type NoteHead } from './api'
import { blankOpenNoteIn, goTo, tryLeave } from './context'
import { currentList, hrefIn } from './workspace'

let making: Promise<NoteHead> | null = null

export function newNoteId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Makes one note, however often it is asked while the first request runs. Without a folder: the inbox. */
export function createNote(folderId?: string | null): Promise<NoteHead> {
  if (making) return making
  making = notesApi
    .create({ id: newNoteId(), folder_id: folderId ?? undefined })
    .then((note) => {
      notesChanged()
      void refreshFolders()
      return note
    })
    .finally(() => {
      making = null
    })
  return making
}

/** Where a note opens: beside the list on show (`/folder/<id>?note=<id>`, `/notes/<id>` beside all notes; NOTES-8
 * AC-9), or beside the list of `folderId` when one is named. */
export function noteHref(id: string, folderId?: string | null): string {
  return hrefIn(folderId ? `/folder/${encodeURIComponent(folderId)}` : currentList(), id)
}

/** The note just made, opened beside the list on show with the cursor in the title (AC-1). */
export function openNew(note: NoteHead, go: (path: string, state: unknown) => void): void {
  go(noteHref(note.id), { fresh: true })
}

/** "Neue Notiz" from outside React's tree (the folder pages' button): asks the open note first, then makes and opens. */
export function startNewNote(folderId?: string | null): void {
  const blank = blankOpenNoteIn(folderId)
  if (blank) return blank.focusTitle()
  tryLeave(() => {
    createNote(folderId)
      .then((note) => openNew(note, goTo))
      .catch(() => undefined)
  })
}

/** "Neue Notiz" for a button: into the open folder, or the inbox. */
export function useNewNote(): { start: () => void; busy: boolean } {
  const navigate = useNavigate()
  const { targetFolderId } = useCurrentFolder()
  const [busy, setBusy] = useState(false)
  const start = useCallback(() => {
    // An empty note open in the same folder is the new note already: the cursor goes into its title.
    const blank = blankOpenNoteIn(targetFolderId)
    if (blank) return blank.focusTitle()
    tryLeave(() => {
      setBusy(true)
      createNote(targetFolderId)
        .then((note) => openNew(note, (path, state) => navigate(path, { state })))
        .catch(() => undefined)
        .finally(() => setBusy(false))
    })
  }, [navigate, targetFolderId])
  return { start, busy }
}
