/**
 * The notes dock onto the frame (`extensions.ts`): "Neue Notiz" at the top of the sidebar, the pages `/` and
 * `/notes/<id>`, and the actions the folder pages use (a new note in a folder, where a note opens). "Alle Notizen" is a
 * tile below the search (`folders/QuickTiles.tsx`, NOTES-4 AC-16). Imported in `main.tsx` before the folders, so that
 * "Neue Notiz" stands above the tiles.
 */
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { FEATURE_ROUTES, LIST_LAYOUT, SIDEBAR_SECTIONS } from '../extensions'
import { registerNoteActions } from '../folders/actions'
import { noteHref, startNewNote, useNewNote } from './newNote'
import { AllNotesList, NotesPage } from './NotesPage'

export function NewNoteButton() {
  const { t } = useTranslation()
  const { start, busy } = useNewNote()
  return (
    <div className="flex flex-col gap-1 pb-2">
      <button type="button" className="nn-btn nn-btn-accent w-full" onClick={start} disabled={busy} data-testid="new-note">
        <Plus className="h-4 w-4" strokeWidth={2.4} aria-hidden />
        {t('notes.new')}
      </button>
    </div>
  )
}

SIDEBAR_SECTIONS.push({ key: 'new-note', render: () => <NewNoteButton /> })
// The workspace: the lists in the middle, the notes with their tabs beside (NOTES-8 AC-9).
LIST_LAYOUT.element = <NotesPage />
FEATURE_ROUTES.push({ path: '', element: <AllNotesList />, list: true }, { path: 'notes/:noteId', element: <AllNotesList />, list: true })
registerNoteActions({ newNote: (folderId) => startNewNote(folderId), noteHref: (id) => noteHref(id) })
