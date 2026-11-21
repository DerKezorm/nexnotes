/**
 * The notes dock onto the frame (`extensions.ts`): "Neue Notiz" and "Alle Notizen" at the top of the sidebar, the
 * pages `/` and `/notes/<id>`, and the actions the folder pages use (a new note in a folder, where a note opens).
 * Imported in `main.tsx` before the folders, so that "Neue Notiz" stands above the inbox (drawing "Seitenleiste").
 */
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { registerNoteActions } from '../folders/actions'
import { noteHref, startNewNote, useNewNote } from './newNote'
import { NotesPage } from './NotesPage'

export function NewNoteButton() {
  const { t } = useTranslation()
  const { start, busy } = useNewNote()
  return (
    <div className="flex flex-col gap-1 pb-2">
      <button type="button" className="nn-btn nn-btn-accent w-full" onClick={start} disabled={busy} data-testid="new-note">
        <Plus className="h-4 w-4" strokeWidth={2.4} aria-hidden />
        {t('notes.new')}
      </button>
      <NavLink
        to="/"
        end
        className={({ isActive }) => 'flex h-[34px] items-center rounded-lg px-2.5 text-[13.5px] ' + (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800')}
      >
        {t('notes.all')}
      </NavLink>
    </div>
  )
}

SIDEBAR_SECTIONS.push({ key: 'new-note', render: () => <NewNoteButton /> })
FEATURE_ROUTES.push({ path: '', element: <NotesPage /> }, { path: 'notes/:noteId', element: <NotesPage /> })
registerNoteActions({ newNote: (folderId) => startNewNote(folderId), noteHref: (id) => noteHref(id) })
