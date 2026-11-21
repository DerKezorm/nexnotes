/**
 * The notes: the list in the middle column and the open note beside it (drawing "N3-Editor"); on a phone one or the
 * other. `/` shows all notes, `/notes/<id>` one of them; `?folder=<id>` keeps the list of the folder it was opened
 * from beside it, and a new note made there lands in that folder.
 *
 * On a wider screen the tabs and the two sides of NOTES-8 take over the page (`tabs/TabbedNotes.tsx`); on a phone one
 * note at a time, as here.
 */
import { ArrowLeft, Plus } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { NoteEditor } from '../editor/NoteEditor'
import { setCurrentFolder, useFolders } from '../folders/store'
import { useTitle } from '../lib/title'
import { useDesktop } from '../tabs/desktop'
import { TabbedNotes } from '../tabs/TabbedNotes'
import { NoteList } from './NoteList'
import { useNewNote } from './newNote'

export function NotesPage() {
  const { t } = useTranslation()
  const { noteId } = useParams()
  const [params] = useSearchParams()
  const folderId = params.get('folder') ?? undefined
  const location = useLocation()
  const navigate = useNavigate()
  const fresh = Boolean((location.state as { fresh?: boolean } | null)?.fresh)
  const tree = useFolders()
  const folder = folderId ? tree.byId.get(folderId) : undefined
  const inbox = folderId !== undefined && tree.inbox?.id === folderId
  const heading = folder?.name ?? (inbox ? t('notes.inbox') : t('notes.all'))
  const { start, busy } = useNewNote()
  const desktop = useDesktop()
  useTitle(noteId ? null : heading)

  // A note opened from a folder: "Neue Notiz" goes there too (NOTES-4 AC-9).
  useEffect(() => {
    if (!folderId) return
    setCurrentFolder(folderId)
    return () => setCurrentFolder(null)
  }, [folderId])

  const back = folderId ? (inbox ? '/inbox' : `/folder/${encodeURIComponent(folderId)}`) : '/'
  if (desktop)
    return <TabbedNotes noteId={noteId} folderId={folderId} fresh={fresh} back={back} list={<NoteList folderId={folderId} selectedId={noteId} heading={heading} />} />
  // Without an open note the list takes the whole width (drawing N6-Liste); beside a note it is the column of N3-Editor.
  return (
    <div className="flex h-full min-h-0" data-testid="notes-page">
      <div
        className={
          'nn-scroll min-h-0 w-full shrink-0 flex-col overflow-y-auto border-ink-700 ' +
          (noteId ? 'hidden px-3 py-4 md:flex md:w-[300px] md:border-r' : 'flex px-4 py-5 md:flex-1 md:shrink md:px-8 md:py-6')
        }
      >
        <NoteList folderId={folderId} selectedId={noteId} heading={heading} />
      </div>
      {noteId && (
        <div className="nn-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Link to={back} className="flex items-center gap-1.5 px-4 pt-3 text-[15px] text-accent-400 md:hidden">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {heading}
          </Link>
          <NoteEditor noteId={noteId} fresh={fresh} onDeleted={() => navigate(back)} />
        </div>
      )}
      {!noteId && (
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
