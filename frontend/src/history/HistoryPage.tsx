/**
 * The history of a note (NOTES-15, drawing "N15-Verlauf"): the chosen version whole in the middle, with "Version of …"
 * and Close, As a copy, Restore above it (AC-3); the versions on the right, grouped by today, yesterday, day and week,
 * each with its time and who wrote (AC-1). The list comes a page at a time (EC-5). Restoring makes the version the note
 * as a new change, the note before stays in the history (AC-4); a copy is a new note in the same folder (AC-5). Who may
 * only read sees the versions but neither restores nor copies (AC-8).
 */
import { Clock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { NoteIcon } from '../components/NoteIcon'
import { showNotice } from '../folders/notice'
import { refreshFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { moment } from '../lib/time'
import { useTitle } from '../lib/title'
import { notesChanged } from '../notes/api'
import { noteHref } from '../notes/newNote'
import { historyApi, type Version, type VersionItem, type VersionPage } from './api'
import { groupVersions, whoText } from './groups'
import { VersionView } from './VersionView'

export function HistoryPage() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const navigate = useNavigate()
  const noteId = useParams().noteId ?? ''
  const [params, setParams] = useSearchParams()
  const chosenId = Number(params.get('v')) || null
  const [page, setPage] = useState<VersionPage | null>(null)
  const [items, setItems] = useState<VersionItem[]>([])
  const [version, setVersion] = useState<Version | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  useTitle(t('history.title'))

  useEffect(() => {
    let live = true
    historyApi
      .list(noteId)
      .then((found) => {
        if (!live) return
        setPage(found)
        setItems(found.versions)
      })
      .catch((error) => live && setProblem(problemText(error)))
    return () => {
      live = false
    }
  }, [noteId])

  const shownId = chosenId ?? items[0]?.id ?? null
  useEffect(() => {
    if (shownId === null) return
    let live = true
    historyApi
      .get(noteId, shownId)
      .then((found) => live && setVersion(found))
      .catch((error) => live && setProblem(problemText(error)))
    return () => {
      live = false
    }
  }, [noteId, shownId])

  const more = useCallback(async () => {
    if (!page?.next || loadingMore) return
    setLoadingMore(true)
    try {
      const found = await historyApi.list(noteId, page.next)
      setPage(found)
      setItems((before) => [...before, ...found.versions.filter((v) => !before.some((b) => b.id === v.id))])
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setLoadingMore(false)
    }
  }, [noteId, page, loadingMore])

  // Near the end of the list the next page comes by itself (EC-5); the button stays for keyboards and old browsers.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = sentinel.current
    if (!target || typeof IntersectionObserver === 'undefined' || !page?.next) return
    const observer = new IntersectionObserver((seen) => seen.some((entry) => entry.isIntersecting) && void more())
    observer.observe(target)
    return () => observer.disconnect()
  }, [page, more])

  const groups = useMemo(() => groupVersions(items, lang, (date) => t('history.weekOf', { date })), [items, lang, t])
  const shown = items.find((item) => item.id === shownId)
  const canRestore = Boolean(page?.can_restore && version?.can_restore)
  const close = () => navigate(noteHref(noteId))

  const restore = async () => {
    if (!version) return
    setBusy(true)
    try {
      await historyApi.restore(noteId, version.id)
      notesChanged()
      showNotice({ text: t('history.restored', { when: moment(version.created_at, lang) }) })
      close()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!version) return
    setBusy(true)
    try {
      const when = new Date(version.created_at).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })
      const made = await historyApi.copy(noteId, version.id, when)
      notesChanged()
      void refreshFolders()
      showNotice({ text: t('history.copied') })
      navigate(noteHref(made.id))
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  const keep = page ? (page.history_days % 365 === 0 ? t('history.keepYears', { count: page.history_days / 365 }) : t('history.keepDays', { count: page.history_days })) : ''

  return (
    <div className="flex min-h-full flex-wrap" data-testid="history-page">
      <main className="flex min-w-0 flex-[999_1_480px] flex-col">
        {version && (
          <div role="status" className="flex flex-wrap items-center gap-2.5 border-b border-ink-700 bg-ink-850 px-6 py-3" data-testid="history-banner">
            <Clock className="h-4 w-4 shrink-0 text-accent-400" aria-hidden />
            <span className="text-sm text-mist-100">
              {t('history.versionOf')} <strong>{moment(version.created_at, lang)}</strong>
              {version.authors.length > 0 && <> · {whoText(version.authors, t)}</>}
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" onClick={close} data-testid="history-close">
                {t('common.close')}
              </button>
              {canRestore && (
                <>
                  <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" onClick={() => void copy()} disabled={busy} data-testid="history-copy">
                    {t('history.asCopy')}
                  </button>
                  {!shown?.current && (
                    <button type="button" className="nn-btn nn-btn-accent h-9 px-3.5 text-[13px]" onClick={() => void restore()} disabled={busy} data-testid="history-restore">
                      {t('history.restore')}
                    </button>
                  )}
                </>
              )}
            </span>
          </div>
        )}
        {problem && <p className="px-6 pt-4 text-sm text-bad-500">{problem}</p>}
        {version ? (
          <article className="flex w-full max-w-[760px] flex-col gap-3 px-6 py-7 opacity-95 md:px-10">
            <h1 className="flex min-w-0 items-center gap-2.5 text-[28px] font-bold tracking-tight text-mist-100" data-testid="version-title">
              <NoteIcon icon={page?.icon} color={page?.color} size={24} />
              <span className="min-w-0">{version.title || t('notes.untitled')}</span>
            </h1>
            {version.restored_from && <p className="text-[12.5px] text-mist-500">{t('history.restoredFrom', { when: moment(version.restored_from, lang) })}</p>}
            <VersionView doc={version.content} noteId={version.note_id} />
          </article>
        ) : (
          page &&
          items.length === 0 && (
            <p className="px-6 py-10 text-sm text-mist-500" data-testid="history-none">
              {t('history.none')}
            </p>
          )
        )}
      </main>
      <aside aria-label={t('history.title')} className="flex min-w-[260px] flex-[1_1_320px] flex-col gap-1.5 border-l border-ink-700 bg-ink-900 px-3.5 py-4">
        <h2 className="mb-1.5 px-1.5 text-base font-bold text-mist-100">{t('history.title')}</h2>
        {page?.pending && (
          <button type="button" onClick={close} className="flex justify-between gap-2 rounded-[9px] px-2.5 py-2 text-left text-[13.5px] hover:bg-ink-800" data-testid="history-now">
            <span className="font-semibold text-mist-100">{t('history.now')}</span>
            <span className="text-mist-500">{page.updated_by?.name ?? ''}</span>
          </button>
        )}
        {groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-0.5" aria-label={t(`history.groups.${group.key}`)}>
            <h3 className="px-1.5 pt-2.5 pb-0.5 text-[11px] font-semibold tracking-wider text-mist-500 uppercase">{t(`history.groups.${group.key}`)}</h3>
            {group.entries.map(({ version: item, label }) => {
              const chosen = item.id === shownId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setParams({ v: String(item.id) }, { replace: true })}
                  aria-current={chosen || undefined}
                  className={'flex justify-between gap-2 rounded-[9px] px-2.5 py-2 text-left text-[13.5px] ' + (chosen ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800')}
                  data-testid="history-item"
                  data-id={item.id}
                >
                  <span className={item.current ? 'font-semibold' : ''}>
                    {label}
                    {item.current && <> · {t('history.current')}</>}
                    {item.restored_from && <> · {t('history.restoredShort')}</>}
                  </span>
                  <span className="truncate text-mist-500">{whoText(item.authors, t)}</span>
                </button>
              )
            })}
          </section>
        ))}
        {page?.next && (
          <div ref={sentinel} className="px-1.5 pt-2">
            <button type="button" className="nn-btn nn-btn-quiet text-[13px]" onClick={() => void more()} disabled={loadingMore} data-testid="history-more">
              {t('history.more')}
            </button>
          </div>
        )}
        <p className="mt-auto px-1.5 pt-2.5 text-xs leading-relaxed text-mist-500">{keep}</p>
      </aside>
    </div>
  )
}
