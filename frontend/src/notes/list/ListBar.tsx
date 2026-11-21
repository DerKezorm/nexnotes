/**
 * The controls above a list (drawings N6-Kacheln, N6-Liste): the sorting (last changed, created, title A–Z; up or
 * down, AC-4), "Nach Datum" (grouping, off while sorted by title, AC-5) and the switch between list and tiles (AC-1).
 * A list that offers more views names them in `modes` (a smart folder with "Anhang": its attachments as the gallery,
 * which sorts itself and leaves out sorting and grouping here).
 */
import { ArrowDown, ArrowUp, Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ListMode, ListSort, ListView } from './api'

const SORTS: ListSort[] = ['updated', 'created', 'title']

type Props = { view: ListView; onChange: (change: Partial<ListView>) => void; narrow?: boolean; modes?: readonly ListMode[] }

const MODES: readonly ListMode[] = ['list', 'tiles']

export function ListBar({ view, onChange, narrow, modes = MODES }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const byTitle = view.sort === 'title'

  useEffect(() => {
    if (!open) return
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const sortName = (sort: ListSort) => (sort === 'title' ? t(view.direction === 'desc' && view.sort === 'title' ? 'noteList.sort.titleDesc' : 'noteList.sort.title') : t(`noteList.sort.${sort}`))
  const Arrow = view.direction === 'asc' ? ArrowUp : ArrowDown
  const gallery = view.mode === 'gallery' && modes.includes('gallery')
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="list-bar">
      {!gallery && (
        <span ref={box} className="relative">
          <button
            type="button"
            className={'flex items-center gap-2 rounded-[9px] border border-ink-700 px-3 text-[13px] text-mist-100 hover:bg-ink-800 ' + (narrow ? 'h-8' : 'h-9')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('noteList.sort.label') + ': ' + sortName(view.sort)}
            data-testid="list-sort"
            onClick={() => setOpen(!open)}
          >
            {sortName(view.sort)}
            {!byTitle && <Arrow aria-hidden className="h-3.5 w-3.5 text-mist-500" strokeWidth={2.4} />}
            <ChevronDown aria-hidden className="h-3 w-3 text-mist-500" strokeWidth={2.6} />
          </button>
          {open && (
            <div role="menu" aria-label={t('noteList.sort.label')} className="nn-menu absolute top-full left-0 mt-1">
              {SORTS.map((sort) => (
                <button
                  key={sort}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view.sort === sort}
                  className="nn-menu-item"
                  onClick={() => {
                    // Titles read best from A; dates from the newest.
                    onChange(sort === view.sort ? { sort } : { sort, direction: sort === 'title' ? 'asc' : 'desc' })
                    setOpen(false)
                  }}
                >
                  <Check aria-hidden className={'h-4 w-4 ' + (view.sort === sort ? '' : 'invisible')} />
                  {t(`noteList.sort.${sort}`)}
                </button>
              ))}
              <div className="my-1 h-px bg-ink-700" role="separator" />
              {(['desc', 'asc'] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view.direction === direction}
                  className="nn-menu-item"
                  onClick={() => {
                    onChange({ direction })
                    setOpen(false)
                  }}
                >
                  <Check aria-hidden className={'h-4 w-4 ' + (view.direction === direction ? '' : 'invisible')} />
                  {t(byTitle ? `noteList.sort.${direction}Title` : `noteList.sort.${direction}`)}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {!gallery && (
        <span className={'flex items-center gap-2 text-[13px] ' + (byTitle ? 'text-mist-600' : 'text-mist-300')}>
          <button
            type="button"
            role="switch"
            aria-checked={view.grouped && !byTitle}
            aria-label={t('noteList.groupLabel')}
            disabled={byTitle}
            title={byTitle ? t('noteList.groupOffByTitle') : undefined}
            data-testid="list-group"
            onClick={() => onChange({ grouped: !view.grouped })}
            className={'flex h-5 w-[34px] items-center rounded-[10px] p-0.5 disabled:opacity-50 ' + (view.grouped && !byTitle ? 'justify-end bg-accent-500' : 'justify-start bg-ink-600')}
          >
            <span aria-hidden className={'h-4 w-4 rounded-full ' + (view.grouped && !byTitle ? 'bg-on-accent' : 'bg-mist-100')} />
          </button>
          <span aria-hidden>{t('noteList.group')}</span>
        </span>
      )}
      <span role="radiogroup" aria-label={t('noteList.view.label')} className="flex rounded-[9px] border border-ink-700 bg-ink-850 p-[3px] text-[12.5px]">
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={view.mode === mode}
            data-testid={`list-mode-${mode}`}
            onClick={() => view.mode !== mode && onChange({ mode })}
            className={'rounded-md px-2.5 py-[5px] ' + (view.mode === mode ? 'bg-accent-wash font-semibold text-accent-400' : 'text-mist-500 hover:text-mist-100')}
          >
            {t(`noteList.view.${mode}`)}
          </button>
        ))}
      </span>
    </span>
  )
}
