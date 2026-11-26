/**
 * A note into nexlore (module verbinden, pair nexnotes → nexlore, Runde 2 V19, Entwurf): "An nexlore" in a note's menu,
 * once nexlore is connected with a click under My account › Connections. The dialog chooses a space of nexlore; the
 * note goes there as a new note with its title and text. A locked note offers nothing.
 */
import { BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import type { NoteMenuContext } from '../editor/noteParts'
import { showNotice } from '../folders/notice'
import { problemText } from '../lib/errors'
import { known, nexloreApi, type NexloreStatus } from './api'

const OPEN = 'nexnotes:nexlore-note'

function useNexlore(): NexloreStatus | null {
  const [status, setStatus] = useState<NexloreStatus | null>(null)
  useEffect(() => {
    known.status ??= nexloreApi.status().catch(() => ({ connected: false, spaces: [] }))
    let live = true
    void known.status.then((found) => {
      if (live) setStatus(found)
    })
    return () => {
      live = false
    }
  }, [])
  return status
}

export function NoteNexloreItem({ noteId, head, sealed, close }: NoteMenuContext) {
  const { t } = useTranslation()
  const status = useNexlore()
  if (!status?.connected || sealed || !head || head.locked || head.deleted_at) return null
  return (
    <button
      type="button"
      role="menuitem"
      className="nn-menu-item"
      data-testid="note-nexlore"
      onClick={() => {
        close()
        window.dispatchEvent(new CustomEvent(OPEN, { detail: { noteId } }))
      }}
    >
      <BookOpen className="h-4 w-4" aria-hidden />
      {t('nexlore.menu')}
    </button>
  )
}

/** The dialog over the page: the menu that opened it is gone by then. */
export function NexloreHost() {
  const { t } = useTranslation()
  const [noteId, setNoteId] = useState<string | null>(null)
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null)
  const [space, setSpace] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    const open = (event: Event) => {
      setNoteId((event as CustomEvent<{ noteId: string }>).detail.noteId)
      setProblem('')
      setSpaces(null)
      nexloreApi.status().then(
        (found) => {
          setSpaces(found.spaces)
          setSpace(found.spaces[0]?.id ?? '')
        },
        (error) => setProblem(problemText(error)),
      )
    }
    window.addEventListener(OPEN, open)
    return () => window.removeEventListener(OPEN, open)
  }, [])
  if (!noteId) return null

  const send = async () => {
    if (busy || !space) return
    setBusy(true)
    setProblem('')
    try {
      const done = await nexloreApi.send(noteId, space)
      setNoteId(null)
      showNotice({ text: t('nexlore.sent', { path: done.path }) })
    } catch (error) {
      setProblem(problemText(error))
    }
    setBusy(false)
  }

  return (
    <Dialog title={t('nexlore.title')} onClose={() => setNoteId(null)}>
      <form
        className="space-y-4"
        data-testid="nexlore-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <p className="text-sm text-mist-300">{t('nexlore.text')}</p>
        {spaces && spaces.length === 0 && <p className="text-sm text-mist-300">{t('nexlore.none')}</p>}
        <label className="block text-sm">
          <span className="font-medium text-mist-100">{t('nexlore.space')}</span>
          <select className="nn-field mt-1" value={space} onChange={(event) => setSpace(event.target.value)} disabled={!spaces?.length} data-testid="nexlore-space">
            {spaces?.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        {problem && (
          <p role="alert" className="rounded-[9px] border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500" data-testid="nexlore-problem">
            {problem}
          </p>
        )}
        <div className="flex justify-end">
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !space} data-testid="nexlore-send">
            {t('nexlore.send')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
