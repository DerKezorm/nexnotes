/**
 * "An nextasks" in the head of an open note (NOTES-19, drawing N19-nextasks): the button, the dialog with list and due
 * day, and the marks beside the lines sent.
 *
 * - Only with nextasks connected (AC-4), never in a locked note or one opened from the vault (NOTES-16).
 * - The dialog chooses the list used last (AC-6), names how many tasks come from several lines (EC-2) and keeps one id
 *   per opening: a second click or a retry makes no second task (EC-6).
 * - A mark leads to its task, asked first whether nextasks still has it (EC-4); the marks are the member's own (EC-5).
 * - A failure says so and leaves the note alone; a key nextasks refuses leads to Connections (EC-1).
 */
import { ListChecks } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError } from '../api/client'
import { Dialog } from '../components/Dialog'
import type { NoteHeadPartProps } from '../editor/noteParts'
import { showNotice } from '../folders/notice'
import { problemText } from '../lib/errors'
import { newRequestId, nextasksApi, type SendLine, type TaskList, type TaskMark } from './api'
import { dueText, useNextasks } from './hooks'
import { linesToSend, marksKey, marksPlugin, showMarks } from './marks'
import './marks.css'

/** Codes that mean: the connection itself is wrong, fix it in Connections (EC-1). */
const FIX_IN_CONNECTIONS = new Set(['nextasks_token_invalid', 'nextasks_api_off', 'nextasks_read_only', 'nextasks_too_old', 'nextasks_not_connected', 'nextasks_address_local', 'nextasks_address_refused', 'nextasks_address_port'])

export function SendToNextasks({ noteId, editor, head, sealed }: NoteHeadPartProps) {
  const { t, i18n } = useTranslation()
  const status = useNextasks()
  const [lines, setLines] = useState<SendLine[] | null>(null)
  const [gone, setGone] = useState<TaskMark | null>(null)
  const usable = Boolean(status?.connected) && !sealed && !head?.locked

  const refresh = useCallback(() => {
    nextasksApi.links(noteId).then(
      (found) => {
        if (!editor.isDestroyed) showMarks(editor.view, found.links)
      },
      () => undefined,
    )
  }, [noteId, editor])

  const open = useCallback(
    (mark: TaskMark) => {
      nextasksApi.open(mark.id).then(
        (found) => {
          window.open(found.url, '_blank', 'noopener,noreferrer')
        },
        (error) => {
          if (error instanceof ApiError && error.code === 'nextasks_task_gone') setGone(mark)
          else showNotice({ text: problemText(error) })
        },
      )
    },
    [],
  )

  const draw = useMemo(
    () => (mark: TaskMark) => {
      const element = document.createElement('a')
      element.className = 'nn-task-mark'
      element.href = mark.task_url || '#'
      element.contentEditable = 'false'
      element.dataset.testid = 'nextasks-mark'
      element.dataset.mark = String(mark.id)
      const due = mark.due_date ? dueText(mark.due_date, i18n.language) : ''
      element.textContent = due ? t('nextasks.mark.due', { when: due }) : t('nextasks.mark.plain')
      element.title = mark.list_name ? t('nextasks.mark.title', { list: mark.list_name }) : t('nextasks.mark.plain')
      element.addEventListener('mousedown', (event) => event.preventDefault())
      element.addEventListener('click', (event) => {
        event.preventDefault()
        open(mark)
      })
      return element
    },
    [i18n.language, open, t],
  )

  // The marks: drawn by a plugin of this editor while nextasks is connected, the member's own from the server.
  useEffect(() => {
    if (!usable || editor.isDestroyed) return
    editor.registerPlugin(marksPlugin(draw))
    refresh()
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(marksKey)
    }
  }, [usable, editor, draw, refresh])

  if (!usable) return null
  return (
    <>
      <button
        type="button"
        className="nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0"
        aria-label={t('nextasks.send.button')}
        title={t('nextasks.send.button')}
        data-testid="nextasks-send"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const found = linesToSend(editor.state)
          if (found.length === 0) showNotice({ text: t('nextasks.send.nothing') })
          else setLines(found)
        }}
      >
        <ListChecks className="h-4 w-4" aria-hidden />
      </button>
      {lines && (
        <SendDialog
          noteId={noteId}
          lines={lines}
          onClose={() => setLines(null)}
          onSent={(count) => {
            setLines(null)
            refresh()
            showNotice({ text: t('nextasks.send.done', { count }) })
          }}
          onPartly={refresh}
        />
      )}
      {gone && (
        <Dialog title={t('nextasks.gone.title')} onClose={() => setGone(null)}>
          <p className="text-sm text-mist-300" data-testid="nextasks-gone">
            {t('nextasks.gone.text')}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setGone(null)}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="nn-btn nn-btn-accent"
              data-testid="nextasks-gone-remove"
              onClick={() => {
                const mark = gone
                setGone(null)
                nextasksApi.removeLink(mark.id).then(refresh, (error) => showNotice({ text: problemText(error) }))
              }}
            >
              {t('nextasks.gone.remove')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}

function SendDialog({ noteId, lines, onClose, onSent, onPartly }: { noteId: string; lines: SendLine[]; onClose: () => void; onSent: (count: number) => void; onPartly: () => void }) {
  const { t } = useTranslation()
  // One sending, one id: whatever happens to the clicks, nextasks makes each task once (EC-6).
  const [requestId] = useState(newRequestId)
  const [lists, setLists] = useState<TaskList[] | null>(null)
  const [listId, setListId] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ text: string; fix: boolean } | null>(null)

  useEffect(() => {
    nextasksApi.lists().then(
      (found) => {
        setLists(found.lists)
        setListId(found.last ?? found.lists[0]?.id ?? '')
      },
      (error) => setProblem({ text: problemText(error), fix: error instanceof ApiError && FIX_IN_CONNECTIONS.has(error.code) }),
    )
  }, [])

  const send = async () => {
    if (busy || !listId) return
    setBusy(true)
    setProblem(null)
    const list = lists?.find((item) => item.id === listId)
    try {
      const done = await nextasksApi.send({ note_id: noteId, request_id: requestId, list_id: listId, list_name: list?.name ?? '', ...(due ? { due_date: due } : {}), lines })
      onSent(done.sent)
    } catch (error) {
      setBusy(false)
      setProblem({ text: problemText(error), fix: error instanceof ApiError && FIX_IN_CONNECTIONS.has(error.code) })
      if (error instanceof ApiError && Number(error.values.sent) > 0) onPartly()
    }
  }

  return (
    <Dialog title={t('nextasks.send.title')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {lines.length === 1 ? (
          <p className="rounded-[10px] border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-mist-100" data-testid="nextasks-line">
            {lines[0].text}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-mist-300" data-testid="nextasks-count">
              {t('nextasks.send.many', { count: lines.length })}
            </p>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-[10px] border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-100">
              {lines.map((line) => (
                <li key={line.anchor} className="truncate" data-testid="nextasks-line">
                  {line.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="block text-sm">
          <span className="font-medium text-mist-100">{t('nextasks.send.list')}</span>
          <select className="nn-field mt-1" value={listId} onChange={(event) => setListId(event.target.value)} disabled={!lists} data-testid="nextasks-list">
            {!lists && <option value="">{t('nextasks.send.loading')}</option>}
            {lists?.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-mist-100">
            {t('nextasks.send.due')} <span className="font-normal text-mist-500">{t('nextasks.send.optional')}</span>
          </span>
          <input type="date" className="nn-field mt-1" value={due} onChange={(event) => setDue(event.target.value)} data-testid="nextasks-due" />
        </label>
        <p className="text-xs text-mist-500">{t('nextasks.send.hint')}</p>
        {problem && (
          <div role="alert" className="rounded-[9px] border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500" data-testid="nextasks-problem">
            <p>{problem.text}</p>
            {problem.fix && (
              <Link to="/settings/connections" className="mt-1 inline-block font-medium underline" onClick={onClose} data-testid="nextasks-fix">
                {t('nextasks.send.fix')}
              </Link>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !listId} data-testid="nextasks-submit">
            {lines.length === 1 ? t('nextasks.send.submit') : t('nextasks.send.submitMany', { count: lines.length })}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
