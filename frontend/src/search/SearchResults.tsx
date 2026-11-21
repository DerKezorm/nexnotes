/**
 * The list of hits (drawings "N9-Suche", "Handy-Suche"): the title with the found place marked, an excerpt with the
 * place marked, the folder and the date; a hit in an attachment says so, with its name and page (AC-1, AC-3).
 *
 * Its own list, not the notes' `NoteList`: a hit is a note plus where it was found. Arrow keys go from hit to hit, up
 * from the first one back into the field.
 */
import { FileText } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { listDate } from '../notes/listDate'
import { noteHref } from '../notes/newNote'
import type { Hit, Piece } from './api'
import { jumpToHit } from './jump'
import { attachmentOpenerFor } from './registry'

export function Marked({ pieces, fallback }: { pieces: Piece[]; fallback?: string }) {
  if (!pieces.length) return <>{fallback ?? ''}</>
  return (
    <>
      {pieces.map((piece, index) =>
        piece.hit ? (
          <mark key={index} className="rounded-[3px] bg-highlight px-px text-inherit">
            {piece.text}
          </mark>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  )
}

export type ResultsHandle = { focusFirst: () => boolean }

type Props = {
  hits: Hit[]
  /** Up from the first hit. */
  onLeaveTop: () => void
}

export const SearchResults = forwardRef<ResultsHandle, Props>(function SearchResults({ hits, onLeaveTop }, ref) {
  const { t, i18n } = useTranslation()
  const list = useRef<HTMLUListElement>(null)
  const links = () => Array.from(list.current?.querySelectorAll<HTMLAnchorElement>('a[data-hit]') ?? [])

  useImperativeHandle(ref, () => ({
    focusFirst: () => {
      const first = links()[0]
      first?.focus()
      return Boolean(first)
    },
  }))

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const all = links()
    const at = all.indexOf(document.activeElement as HTMLAnchorElement)
    if (at < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && at === 0) onLeaveTop()
    else all[Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  const open = (hit: Hit) => (event: MouseEvent<HTMLAnchorElement>) => {
    const opener = attachmentOpenerFor()
    if (hit.where === 'attachment' && opener) {
      event.preventDefault()
      opener(hit)
      return
    }
    if (hit.where !== 'attachment') jumpToHit(hit.jump)
  }

  return (
    <ul ref={list} className="flex flex-col" onKeyDown={onKeyDown} data-testid="search-results">
      {hits.map((hit) => {
        const folder = hit.folder ? (hit.folder.inbox ? t('notes.inbox') : hit.folder.name) : ''
        const when = hit.updated_at ? listDate(hit.updated_at, i18n.language) : ''
        const where = [folder, when].filter(Boolean).join(' · ')
        const attachment = hit.where === 'attachment' ? hit.attachment : null
        return (
          <li key={hit.id}>
            <Link
              to={noteHref(hit.id)}
              data-hit={hit.id}
              data-testid="search-hit"
              onClick={open(hit)}
              className="flex flex-col gap-1 rounded-[10px] border-b border-ink-800 px-0 py-3 hover:bg-ink-850 focus-visible:bg-ink-850 md:px-3"
            >
              <span className="flex justify-between gap-2.5">
                <span className="min-w-0 text-base font-semibold md:text-[15px]" data-testid="search-hit-title">
                  <Marked pieces={hit.title_parts} fallback={t('notes.untitled')} />
                </span>
                <span className="hidden shrink-0 whitespace-nowrap text-[12.5px] text-mist-500 md:inline">{where}</span>
              </span>
              {(hit.excerpt.length > 0 || attachment) && (
                <span className="text-[13.5px] leading-normal text-mist-400 md:text-[13px]" data-testid="search-hit-excerpt">
                  {attachment ? (
                    <>
                      {t('search.inAttachment')} „<Marked pieces={hit.excerpt} />“
                      {attachment.page ? `, ${t('search.page', { page: attachment.page })}` : ''}
                    </>
                  ) : (
                    <Marked pieces={hit.excerpt} />
                  )}
                </span>
              )}
              {attachment && (
                <span className="inline-flex items-center gap-1.5 self-start rounded-md bg-ink-800 px-2 py-0.5 text-xs text-mist-300" data-testid="search-hit-attachment">
                  <FileText className="h-3 w-3" aria-hidden />
                  {attachment.name || t('search.attachment')}
                </span>
              )}
              <span className="text-xs text-mist-500 md:hidden">{where}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
})
