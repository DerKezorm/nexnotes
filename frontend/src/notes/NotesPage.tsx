/**
 * The notes: the list in the middle column and the open note beside it (drawing "N3-Editor"); on a phone one or the
 * other. `/` shows all notes, `/notes/<id>` one of them; `?folder=<id>` keeps the list of the folder it was opened
 * from beside it, and a new note made there lands in that folder.
 */
import { ArrowLeft, Plus } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { NoteEditor } from '../editor/NoteEditor'
import { setCurrentFolder, useFolders } from '../folders/store'
import { useTitle } from '../lib/title'
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
  useTitle(noteId ? null : heading)

  // A note opened from a folder: "Neue Notiz" goes there too (NOTES-4 AC-9).
  useEffect(() => {
    if (!folderId) return
    setCurrentFolder(folderId)
    return () => setCurrentFolder(null)
  }, [folderId])

  const back = folderId ? (inbox ? '/inbox' : `/folder/${encodeURIComponent(folderId)}`) : '/'
  return (
    <div className="flex h-full min-h-0" data-testid="notes-page">
      <div className={'min-h-0 w-full shrink-0 flex-col overflow-y-auto border-ink-700 px-3 py-4 md:flex md:w-[300px] md:border-r ' + (noteId ? 'hidden' : 'flex')}>
        <NoteList folderId={folderId} selectedId={noteId} heading={heading} />
      </div>
      {noteId ? (
        <div className="nn-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Link to={back} className="flex items-center gap-1.5 px-4 pt-3 text-[15px] text-accent-400 md:hidden">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {heading}
          </Link>
          <NoteEditor noteId={noteId} fresh={fresh} onDeleted={() => navigate(back)} />
        </div>
      ) : (
        <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center md:flex">
          <p className="max-w-sm text-sm text-mist-500">{t('notes.pick')}</p>
          <button type="button" className="nn-btn nn-btn-accent" onClick={start} disabled={busy}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('notes.new')}
          </button>
        </div>
      )}
    </div>
  )
}
