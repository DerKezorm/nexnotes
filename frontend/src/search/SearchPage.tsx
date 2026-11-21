/**
 * The search page `/search` (drawings "N9-Suche", "N9-Keine-Treffer", "Handy-Suche").
 *
 * - Hits appear while typing, with the count in the field (AC-1); words in any order, phrases in quotes, `#tag`,
 *   umlauts and case are the server's business (AC-2, AC-7, EC-1, EC-5).
 * - Filters as chips, active ones in honey (AC-4); with no hit the page names the count without filters and offers to
 *   drop them, and says that locked notes are not searched (EC-2).
 * - 50 hits at a time, the next ones when the end of the list comes into view (EC-4).
 * - The list asks again every few seconds while the page is in front and when the window comes back, so a note
 *   changed meanwhile is right within seconds (EC-6). Only the first page and the count are asked again, however many
 *   pages are loaded; the pages further down stay as they came.
 * - A search the server refuses (no tag in the tag filter, too many words, a phrase too long) says why.
 * - Keys: arrow down from the field into the list, Enter opens the first hit, Escape empties the field and then leaves.
 */
import { Search, SearchX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { PhoneListWays } from '../pwa/phone'
import { PAGE, searchApi, type Hit } from './api'
import { askable, hasFilters, readConditions, toQuery, withoutFilters, writeConditions, type SearchConditions } from './conditions'
import { Filters } from './Filters'
import { useFolderName } from './folderName'
import { smartFolderSaver } from './registry'
import { SearchResults, type ResultsHandle } from './SearchResults'
import { FOCUS_SEARCH_EVENT } from './shortcuts'

/** Waiting after a keystroke before asking, so fast typing asks once. */
export const TYPE_DELAY_MS = 120
/** How often an open list asks again (EC-6). */
export const REFRESH_MS = 5000

type Shown = { key: string; total: number; items: Hit[]; unfiltered: number | null }

/** The first page asked again, laid over what is loaded: the first page as it is now, then what was loaded after its
 * last hit, as it came; no hit twice, never more than there are. */
function refreshed(before: Hit[], first: Hit[], total: number): Hit[] {
  const known = new Set(first.map((hit) => hit.id))
  const last = first.length ? before.findIndex((hit) => hit.id === first[first.length - 1].id) : -1
  const rest = before.slice(last >= 0 ? last + 1 : first.length)
  return [...first, ...rest.filter((hit) => !known.has(hit.id))].slice(0, Math.max(total, first.length))
}

function keyOf(conditions: SearchConditions): string {
  return JSON.stringify(conditions)
}

export function SearchPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const conditions = useMemo(() => readConditions(params), [params])
  const key = keyOf(conditions)
  const [shown, setShown] = useState<Shown | null>(null)
  /** Why the last question got no answer: `null` while all is well. */
  const [failed, setFailed] = useState<unknown>(null)
  const [more, setMore] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const results = useRef<ResultsHandle>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  /** Only the answer to the latest question counts; an older one arriving late is dropped. */
  const asked = useRef(0)
  const folderName = useFolderName(conditions.folderId)
  const padding = useListPadding()
  useListTitle(t('search.title'))

  // The note open beside the hits stays in the address (NOTES-8 AC-9).
  const change = useCallback(
    (next: SearchConditions) =>
      setParams(
        (before) => {
          const written = writeConditions(next)
          const note = before.get('note')
          if (note) written.set('note', note)
          return written
        },
        { replace: true },
      ),
    [setParams],
  )

  // A new question: after a short pause in typing.
  useEffect(() => {
    if (!askable(conditions)) {
      asked.current++
      setShown(null)
      setFailed(null)
      return
    }
    const ticket = ++asked.current
    const timer = window.setTimeout(() => {
      searchApi
        .find({ ...toQuery(conditions), offset: 0, limit: PAGE })
        .then((answer) => {
          if (ticket !== asked.current) return
          setFailed(null)
          setShown({ key, total: answer.total, items: answer.items, unfiltered: answer.unfiltered })
        })
        .catch((error: unknown) => {
          if (ticket !== asked.current) return
          setFailed(error)
          setShown(null)
        })
    }, TYPE_DELAY_MS)
    return () => window.clearTimeout(timer)
    // `key` stands for `conditions`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const current = shown && shown.key === key ? shown : null

  // The same question again: every few seconds while in front, and when the window comes back (EC-6). A page loaded
  // further down needs no new timer.
  const live = current !== null
  useEffect(() => {
    if (!live) return
    const again = () => {
      if (document.visibilityState === 'hidden') return
      const ticket = asked.current
      searchApi
        .find({ ...toQuery(conditions), offset: 0, limit: PAGE })
        .then((answer) => {
          if (ticket !== asked.current) return
          setShown((before) =>
            before && before.key === key
              ? { key, total: answer.total, items: refreshed(before.items, answer.items, answer.total), unfiltered: answer.unfiltered }
              : before,
          )
        })
        .catch(() => undefined)
    }
    const timer = window.setInterval(again, REFRESH_MS)
    window.addEventListener('focus', again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [live, key, conditions])

  const loadMore = useCallback(() => {
    if (!current || more || current.items.length >= current.total) return
    const ticket = asked.current
    setMore(true)
    searchApi
      .find({ ...toQuery(conditions), offset: current.items.length, limit: PAGE })
      .then((answer) => {
        if (ticket !== asked.current) return
        setShown((before) => {
          if (!before || before.key !== key) return before
          const known = new Set(before.items.map((hit) => hit.id))
          return { ...before, total: answer.total, items: [...before.items, ...answer.items.filter((hit) => !known.has(hit.id))] }
        })
      })
      .catch(() => undefined)
      .finally(() => setMore(false))
  }, [conditions, current, key, more])

  // The next page when the end of the list comes into view (EC-4).
  useEffect(() => {
    const end = sentinel.current
    if (!end || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { rootMargin: '400px' })
    observer.observe(end)
    return () => observer.disconnect()
  }, [loadMore])

  useEffect(() => {
    const focus = () => {
      field.current?.focus()
      field.current?.select()
    }
    window.addEventListener(FOCUS_SEARCH_EVENT, focus)
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus)
  }, [])

  const leave = () => {
    const index = typeof window.history.state?.idx === 'number' ? window.history.state.idx : 0
    if (index > 0) navigate(-1)
    else navigate('/')
  }

  const onFieldKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (results.current?.focusFirst()) event.preventDefault()
    } else if (event.key === 'Enter') {
      const first = document.querySelector<HTMLAnchorElement>('a[data-hit]')
      if (first) {
        event.preventDefault()
        first.click()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (conditions.q) change({ ...conditions, q: '' })
      else leave()
    }
  }

  const filtered = hasFilters(conditions)
  const save = smartFolderSaver()
  const nothing = current !== null && current.total === 0

  return (
    <div className={'flex min-h-full flex-col gap-3.5 ' + padding} data-testid="search-page">
      <PhoneListWays />
      <div className="flex max-w-[880px] items-center gap-2.5">
        <label className="flex h-11 flex-1 items-center gap-2.5 rounded-xl border border-edge bg-ink-850 px-3.5 focus-within:border-accent-500 focus-within:shadow-[0_0_0_3px_rgb(242_193_78/0.30)] md:h-12">
          <Search className="h-[18px] w-[18px] shrink-0 text-mist-500" strokeWidth={2} aria-hidden />
          <input
            ref={field}
            type="search"
            autoFocus
            value={conditions.q}
            maxLength={500}
            onChange={(event) => change({ ...conditions, q: event.target.value })}
            onKeyDown={onFieldKey}
            placeholder={t('search.placeholder')}
            aria-label={t('search.field')}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-base text-mist-100 outline-none placeholder:text-mist-600 md:text-[17px] [&::-webkit-search-cancel-button]:hidden"
            data-testid="search-field"
          />
          {current && (
            <span className="hidden shrink-0 text-[12.5px] text-mist-500 md:inline" data-testid="search-count" aria-live="polite">
              {t('search.count', { count: current.total })}
            </span>
          )}
        </label>
        <button type="button" className="h-11 px-1 text-base text-accent-400 md:hidden" onClick={leave} data-testid="search-done">
          {t('search.done')}
        </button>
      </div>

      <div className="-mx-4 flex max-w-[880px] items-center gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0" data-testid="search-filters">
        <Filters conditions={conditions} onChange={change} />
        {save && askable(conditions) && (
          <button
            type="button"
            className="ml-auto flex h-[34px] shrink-0 items-center rounded-[9px] border border-edge px-3 text-[13px] text-mist-100 hover:bg-ink-800"
            onClick={() => void save(conditions)}
            data-testid="search-save-smart"
          >
            {t('search.saveSmart')}
          </button>
        )}
      </div>

      {current && !nothing && (
        <span className="text-xs text-mist-500 md:hidden" data-testid="search-count-phone">
          {t('search.count', { count: current.total })}
        </span>
      )}

      <div className="max-w-[880px]">
        {!askable(conditions) && (
          <p className="py-10 text-center text-sm text-mist-500" data-testid="search-hint">
            {t('search.hint')}
          </p>
        )}
        {failed !== null && (
          <div className="flex flex-wrap items-center gap-3 py-6" data-testid="search-failed">
            <p className="text-sm text-bad-500" role="alert">
              {failed instanceof ApiError && failed.status === 422 ? problemText(failed) : t('search.failed')}
            </p>
            {failed instanceof ApiError && failed.code === 'search_tag_invalid' && conditions.tag && (
              <button type="button" className="nn-btn nn-btn-ghost" onClick={() => change({ ...conditions, tag: '' })} data-testid="search-drop-tag">
                {t('search.filter.anyTag')}
              </button>
            )}
          </div>
        )}
        {nothing && (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-600 p-6 text-center md:min-h-[420px]" data-testid="search-empty">
            <SearchX className="h-10 w-10 text-accent-400" strokeWidth={1.6} aria-hidden />
            <span className="text-lg font-semibold">
              {conditions.q.trim() ? t('search.empty.title', { q: conditions.q.trim() }) : t('search.empty.titleNoWords')}
              {conditions.folderId && folderName ? t('search.empty.inFolder', { folder: folderName }) : ''}
              {conditions.tag ? t('search.empty.withTag', { tag: conditions.tag }) : ''}
            </span>
            <span className="max-w-[420px] text-sm leading-normal text-mist-500">
              {filtered && current.unfiltered !== null ? `${t('search.empty.unfiltered', { count: current.unfiltered })} ` : ''}
              {t('search.empty.locked')}
            </span>
            {filtered && (
              <button type="button" className="nn-btn nn-btn-accent" onClick={() => change(withoutFilters(conditions))} data-testid="search-clear-filters">
                {t('search.empty.clear')}
              </button>
            )}
          </div>
        )}
        {current && !nothing && (
          <>
            <SearchResults ref={results} hits={current.items} onLeaveTop={() => field.current?.focus()} />
            <div ref={sentinel} />
            {current.items.length < current.total && (
              <div className="flex justify-center pt-3">
                <button type="button" className="nn-btn nn-btn-ghost" onClick={loadMore} disabled={more} data-testid="search-more">
                  {t('search.more', { count: current.total - current.items.length })}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
