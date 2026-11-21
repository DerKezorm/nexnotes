/**
 * The notes' workspace (NOTES-8 AC-9, drawing "N3-Editor"): the routes of the lists (all notes, a folder, the inbox, a
 * tag, the search) are its children, the list it shows in the middle. On a wider screen the notes with their tabs stand
 * beside it (`tabs/TabbedNotes.tsx`) and stay while the sidebar changes the list: the editors, their state and their
 * live connections stay with them. On a phone one view at a time, as before: the list, or the open note with the way
 * back to its list.
 *
 * Addresses (`workspace.ts`): the list as the path, the open note as `?note=<id>`; beside all notes `/notes/<id>`.
 */
import { ArrowLeft, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useNavigate, useOutlet } from 'react-router-dom'

import { NoteEditor } from '../editor/NoteEditor'
import { useFolders, useShownFolder } from '../folders/store'
import { useDesktop } from '../tabs/desktop'
import { TabbedNotes } from '../tabs/TabbedNotes'
import { useListPadding, useListTitle } from './listPlace'
import { NoteList } from './NoteList'
import { useNewNote } from './newNote'
import { folderOfList, hrefIn, listNameOf, listOf, noteOf, setCurrentList } from './workspace'

/** The list of all notes, at `/` and beside `/notes/<id>`. */
export function AllNotesList() {
  const { t } = useTranslation()
  const location = useLocation()
  const { start, busy } = useNewNote()
  const padding = useListPadding()
  const open = noteOf(location.pathname, location.search) !== null
  useListTitle(t('notes.all'))
  return (
    <div className={'flex min-h-full flex-col ' + padding}>
      <NoteList heading={t('notes.all')} />
      {!open && (
        <button
          type="button"
          aria-label={t('notes.new')}
          onClick={start}
          disabled={busy}
          className="fixed right-4 bottom-7 z-20 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent-500 text-on-accent shadow-lg md:hidden"
        >
          <Plus className="h-[22px] w-[22px]" strokeWidth={2.6} aria-hidden />
        </button>
      )}
    </div>
  )
}

/** What a list is called, for the way back to it on a phone. */
function useListName(list: string): string {
  const { t } = useTranslation()
  const tree = useFolders()
  const folder = folderOfList(list)
  if (folder === 'inbox') return t('notes.inbox')
  if (folder) return tree.inbox?.id === folder ? t('notes.inbox') : (tree.byId.get(folder)?.name ?? t('notes.all'))
  const path = list.split('?')[0]
  if (path === '/search') return t('search.title')
  const tag = /^\/tags\/([^/]+)$/.exec(path)
  if (tag) return `#${decodeURIComponent(tag[1])}`
  return listNameOf(path) ?? t('notes.all')
}

/** On a phone, the open note alone with the way back to its list. */
function PhoneNote({ noteId, list, fresh }: { noteId: string; list: string; fresh: boolean }) {
  const navigate = useNavigate()
  const name = useListName(list)
  return (
    <div className="flex h-full min-h-0" data-testid="notes-page">
      <div className="nn-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Link to={list} className="flex items-center gap-1.5 px-4 pt-3 text-[15px] text-accent-400 md:hidden">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {name}
        </Link>
        <NoteEditor noteId={noteId} fresh={fresh} onDeleted={() => navigate(list)} />
      </div>
    </div>
  )
}

export function NotesPage() {
  const location = useLocation()
  const outlet = useOutlet()
  const desktop = useDesktop()
  const params = new URLSearchParams(location.search)
  const noteId = noteOf(location.pathname, location.search) ?? undefined
  const list = listOf(location.pathname, location.search)
  const fresh = Boolean((location.state as { fresh?: boolean } | null)?.fresh)
  // The list on show, for every way that opens a note (`noteHref`), before anything below is drawn.
  setCurrentList(list)

  // "New note" goes into the folder whose list is on show (NOTES-4 AC-9), whether the list has room or not.
  useShownFolder(folderOfList(list))

  // An address of before: `/notes/<id>?folder=<folder>` is that folder's list with the note.
  if (location.pathname.startsWith('/notes/') && params.get('folder'))
    return <Navigate to={hrefIn(list, noteId)} replace state={location.state} />

  const shown: ReactNode = outlet ?? <AllNotesList />
  if (desktop) return <TabbedNotes noteId={noteId} fresh={fresh} list={shown} listPath={list} />
  if (noteId) return <PhoneNote noteId={noteId} list={list} fresh={fresh} />
  // Without an open note the list takes the whole width (drawing N6-Liste).
  return (
    <div className="flex h-full min-h-0" data-testid="notes-page">
      <div className="nn-scroll flex min-h-0 w-full flex-col overflow-y-auto">{shown}</div>
    </div>
  )
}
