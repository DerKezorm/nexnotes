/**
 * A plain list of notes: title, "Titel prüfen", the start of the text, the date. All notes, or those of one folder
 * (`folderId`). The real list with tiles, sorting and pinning comes with NOTES-6; until then this one is what folder
 * pages show in their middle column.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import { endDrag, NOTES_MOVED_EVENT, startNoteDrag } from '../folders/actions'
import { notesApi, NOTES_CHANGED_EVENT, type NoteItem } from './api'
import { tryLeave } from './context'
import { listDate } from './listDate'
import { noteHref } from './newNote'

export type NoteListProps = {
  /** Only the notes of this folder; all of the account's notes when left out. */
  folderId?: string
  /** The open note, marked in the list. */
  selectedId?: string
  /** Opens a note; by default the note page `/notes/<id>`. */
  onOpen?: (id: string) => void
  /** The address of a note, for the link (opening in a new tab); by default `/notes/<id>`, with the folder. */
  hrefFor?: (id: string) => string
  /** A heading above the list. */
  heading?: string
}

export function NoteList({ folderId, selectedId, onOpen, hrefFor, heading }: NoteListProps) {
  const href = hrefFor ?? ((id: string) => noteHref(id, folderId))
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [notes, setNotes] = useState<NoteItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    notesApi
      .list(folderId)
      .then((list) => {
        setNotes(list)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [folderId])

  useEffect(() => {
    load()
    window.addEventListener(NOTES_CHANGED_EVENT, load)
    window.addEventListener(NOTES_MOVED_EVENT, load)
    window.addEventListener('focus', load)
    const timer = setInterval(load, 30_000)
    return () => {
      window.removeEventListener(NOTES_CHANGED_EVENT, load)
      window.removeEventListener(NOTES_MOVED_EVENT, load)
      window.removeEventListener('focus', load)
      clearInterval(timer)
    }
  }, [load])

  const open = (id: string) => tryLeave(() => (onOpen ? onOpen(id) : navigate(href(id))))

  return (
    <section aria-label={heading ?? t('notes.list.title')} className="flex min-h-0 flex-col gap-1" data-testid="note-list" data-folder={folderId ?? ''}>
      {heading && <h1 className="px-2 pb-2 text-lg font-bold text-mist-100">{heading}</h1>}
      {failed && <p className="px-2 text-sm text-bad-500">{t('notes.list.failed')}</p>}
      {notes && notes.length === 0 && <p className="px-2 py-6 text-sm text-mist-500">{t('notes.list.empty')}</p>}
      <ul className="flex flex-col gap-0.5">
        {(notes ?? []).map((note) => {
          const chosen = note.id === selectedId
          return (
            <li key={note.id} draggable onDragStart={(event) => startNoteDrag(event, [note.id])} onDragEnd={endDrag} data-note={note.id}>
              <Link
                to={href(note.id)}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return
                  event.preventDefault()
                  open(note.id)
                }}
                aria-current={chosen ? 'page' : undefined}
                data-testid="note-row"
                className={'flex flex-col gap-0.5 rounded-[10px] px-2.5 py-2 ' + (chosen ? 'nn-chosen' : 'hover:bg-ink-800')}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={'min-w-0 truncate text-sm font-semibold ' + (chosen ? 'text-accent-400' : 'text-mist-100')} title={note.title || undefined}>
                    {note.title || t('notes.untitled')}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-mist-500">
                  <span className="shrink-0">{listDate(note.updated_at, i18n.language)}</span>
                  {note.title_check && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0 text-accent-400">{t('notes.titleCheck')}</span>
                    </>
                  )}
                  {note.preview && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">{note.preview}</span>
                    </>
                  )}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
