/**
 * The trash (NOTES-15, drawing "N15-Papierkorb"): what was deleted, newest first, with when, where it came from, and
 * how long it stays; in the last days the time left is orange (AC-6, AC-7). A note whose folder is gone says before
 * that it comes back into the inbox (EC-1). "Back" and "delete for good" per row; emptying the whole trash asks first,
 * with the number of notes, and says it cannot be undone (EC-3).
 */
import { FileText, Folder, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { NoteIcon } from '../components/NoteIcon'
import { whenText } from '../editor/when'
import { FolderMark } from '../folders/FolderMark'
import { showNotice } from '../folders/notice'
import { refreshFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { useTitle } from '../lib/title'
import { notesChanged } from '../notes/api'
import { trashApi, type TrashItem, type TrashList } from './api'
import { leftText, originLine } from './text'

export function TrashPage() {
  const { t, i18n } = useTranslation()
  useTitle(t('trash.title'))
  const [list, setList] = useState<TrashList | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState('')
  const [asking, setAsking] = useState<null | { kind: 'empty' } | { kind: 'purge'; item: TrashItem }>(null)

  const load = useCallback(() => {
    trashApi
      .list()
      .then((found) => {
        setList(found)
        setProblem('')
      })
      .catch(() => setProblem(t('trash.failed')))
  }, [t])
  useEffect(load, [load])

  const changed = () => {
    notesChanged()
    void refreshFolders()
    load()
  }

  const restore = async (item: TrashItem) => {
    setBusy(item.id)
    try {
      await trashApi.restore(item)
      const title = item.title || t('notes.untitled')
      showNotice({ text: t(item.lands === 'inbox' ? 'trash.restoredInbox' : 'trash.restored', { title }) })
      changed()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy('')
    }
  }

  const purge = async (item: TrashItem) => {
    setAsking(null)
    setBusy(item.id)
    try {
      await trashApi.purge(item)
      showNotice({ text: t('trash.purged') })
      changed()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy('')
    }
  }

  const empty = async () => {
    if (!list) return
    setAsking(null)
    setBusy('all')
    try {
      await trashApi.empty(list.now)
      showNotice({ text: t('trash.emptied') })
      changed()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy('')
    }
  }

  const lang = i18n.language
  return (
    <div className="flex min-h-full flex-col gap-4 px-4 py-5 md:px-8 md:py-6" data-testid="trash-page">
      <div className="flex max-w-[1000px] flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-mist-100">{t('trash.title')}</h1>
        {list && <span className="text-[13px] text-mist-500">{t('trash.keeps', { count: list.trash_days })}</span>}
        <button
          type="button"
          className="nn-btn ml-auto h-[38px] border border-bad-500 px-3.5 text-[13.5px] text-bad-500 hover:bg-ink-800"
          onClick={() => setAsking({ kind: 'empty' })}
          disabled={!list || list.items.length === 0 || busy !== ''}
          data-testid="trash-empty"
        >
          {t('trash.empty')}
        </button>
      </div>
      {problem && <p className="text-sm text-bad-500">{problem}</p>}
      {list && list.items.length === 0 && (
        <p className="py-10 text-center text-sm text-mist-500" data-testid="trash-nothing">
          {t('trash.nothing')}
        </p>
      )}
      <ul className="flex max-w-[1000px] flex-col" aria-label={t('trash.title')}>
        {list?.items.map((item) => {
          const origin = originLine(item, t)
          const title = item.title || t('notes.untitled')
          return (
            <li key={`${item.kind}-${item.id}`} className="flex flex-wrap items-center gap-3.5 border-b border-ink-800 px-2.5 py-3" data-testid="trash-row" data-id={item.id}>
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-ink-800 text-mist-300" aria-hidden>
                {item.kind === 'folder' ? (
                  item.icon ? <FolderMark folder={{ icon: item.icon, color: item.color ?? '' }} size={16} /> : <Folder className="h-4 w-4" />
                ) : item.icon ? (
                  <NoteIcon icon={item.icon} color={item.color} size={16} />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
              </span>
              <span className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
                <span className="truncate text-[14.5px] font-semibold text-mist-100" title={title}>
                  {item.kind === 'folder' ? t('trash.folderTitle', { name: title, count: item.notes }) : title}
                </span>
                <span className={'text-[12.5px] ' + (origin.warn ? 'text-warn-500' : 'text-mist-500')} data-testid="trash-origin">
                  {origin.text}
                </span>
              </span>
              <span className="flex-[0_0_150px] text-[12.5px] text-mist-500">{whenText(item.deleted_at, lang, t)}</span>
              <span className={'flex-[0_0_130px] text-[12.5px] ' + (item.warn ? 'text-warn-500' : 'text-mist-500')} data-testid="trash-left" data-warn={item.warn || undefined}>
                {leftText(item, t)}
              </span>
              <span className="flex gap-2">
                <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" onClick={() => void restore(item)} disabled={busy !== ''}>
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className="nn-btn h-9 w-9 px-0 text-bad-500 hover:bg-ink-800"
                  aria-label={t('trash.purge', { title })}
                  title={t('trash.purge', { title })}
                  onClick={() => setAsking({ kind: 'purge', item })}
                  disabled={busy !== ''}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </span>
            </li>
          )
        })}
      </ul>

      {asking?.kind === 'empty' && list && (
        <Dialog title={t('trash.confirmEmpty.title')} onClose={() => setAsking(null)}>
          <div className="flex flex-col gap-3.5" data-testid="trash-empty-dialog">
            <p className="text-sm leading-relaxed text-mist-300">
              {t('trash.confirmEmpty.text', { count: list.totals.notes })}
              {list.totals.folders > 0 && <> {t('trash.confirmEmpty.folders', { count: list.totals.folders })}</>}
            </p>
            <p className="text-sm font-semibold text-bad-500">{t('trash.final')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setAsking(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="nn-btn nn-btn-danger" onClick={() => void empty()} data-testid="trash-empty-go">
                {t('trash.confirmEmpty.go')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {asking?.kind === 'purge' && (
        <Dialog title={t('trash.confirmPurge.title')} onClose={() => setAsking(null)}>
          <div className="flex flex-col gap-3.5" data-testid="trash-purge-dialog">
            <p className="text-sm leading-relaxed text-mist-300">
              {t(asking.item.kind === 'folder' ? 'trash.confirmPurge.folder' : 'trash.confirmPurge.note', { title: asking.item.title || t('notes.untitled') })}
            </p>
            <p className="text-sm font-semibold text-bad-500">{t('trash.final')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setAsking(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="nn-btn nn-btn-danger" onClick={() => void purge(asking.item)} data-testid="trash-purge-go">
                {t('trash.confirmPurge.go')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
