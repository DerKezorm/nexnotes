/**
 * The filters of a search (AC-4): a folder with its subfolders, a tag, a period. Each is a chip; an active one is
 * honey (drawing "N9-Suche"). A chip opens a small menu; Escape or a click outside closes it.
 */
import { ChevronDown, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useFolders } from '../folders/store'
import { tagsApi, type TagInfo } from '../tags/api'
import type { Period, SearchConditions } from './conditions'

type Props = {
  conditions: SearchConditions
  onChange: (next: SearchConditions) => void
}

const ACTIVE = 'border-accent-500 bg-accent-wash text-accent-400'
const IDLE = 'border-edge text-mist-100 hover:bg-ink-800'

function Chip({ label, active, testId, children }: { label: string; active: boolean; testId: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={testId}
        data-active={active || undefined}
        onClick={() => setOpen((was) => !was)}
        className={'flex h-[34px] items-center gap-1.5 rounded-full border px-3 text-[13px] ' + (active ? ACTIVE : IDLE)}
      >
        <span className="max-w-[220px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 text-mist-500" strokeWidth={3} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="nn-menu absolute left-0 top-10 max-h-80 w-64 overflow-y-auto" data-testid={`${testId}-menu`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function FolderChoice({ conditions, onChange }: Props) {
  const { t } = useTranslation()
  const tree = useFolders()
  const chosen = conditions.folderId
  const name = chosen ? (tree.inbox?.id === chosen ? t('notes.inbox') : (tree.byId.get(chosen)?.name ?? '…')) : ''
  const rows: { id: string; name: string; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const id of tree.children.get(parent) ?? []) {
      const folder = tree.byId.get(id)
      if (!folder) continue
      rows.push({ id, name: folder.name, depth })
      walk(id, depth + 1)
    }
  }
  walk(null, 0)
  return (
    <Chip label={chosen ? t('search.filter.inFolder', { name }) : t('search.filter.allFolders')} active={Boolean(chosen)} testId="filter-folder">
      {(close) => {
        const pick = (folderId: string) => {
          onChange({ ...conditions, folderId })
          close()
        }
        return (
          <>
            <button type="button" role="menuitem" className="nn-menu-item" onClick={() => pick('')}>
              {t('search.filter.allFolders')}
            </button>
            {tree.inbox && (
              <button type="button" role="menuitem" className="nn-menu-item" onClick={() => pick(tree.inbox!.id)}>
                {t('notes.inbox')}
              </button>
            )}
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                className={'nn-menu-item ' + (row.id === chosen ? 'text-accent-400' : '')}
                style={{ paddingLeft: 10 + row.depth * 14 }}
                onClick={() => pick(row.id)}
                data-testid={`filter-folder-${row.id}`}
              >
                <span className="truncate">{row.name}</span>
              </button>
            ))}
          </>
        )
      }}
    </Chip>
  )
}

function TagChoice({ conditions, onChange }: Props) {
  const { t } = useTranslation()
  const [tags, setTags] = useState<TagInfo[] | null>(null)
  const [typed, setTyped] = useState('')
  return (
    <Chip label={conditions.tag ? `#${conditions.tag}` : t('search.filter.tag')} active={Boolean(conditions.tag)} testId="filter-tag">
      {(close) => {
        if (tags === null) {
          // The tags of NOTES-5: what counts as a tag is theirs to say.
          tagsApi
            .list()
            .then((answer) => setTags(answer.tags))
            .catch(() => setTags([]))
        }
        const pick = (tag: string) => {
          onChange({ ...conditions, tag: tag.replace(/^#+/, '').trim() })
          setTyped('')
          close()
        }
        const shown = (tags ?? []).filter((entry) => entry.key.includes(typed.replace(/^#/, '').toLowerCase()))
        return (
          <>
            <form
              className="p-1"
              onSubmit={(event) => {
                event.preventDefault()
                if (typed.trim()) pick(typed)
              }}
            >
              <input
                className="nn-field h-8"
                value={typed}
                autoFocus
                maxLength={100}
                placeholder={t('search.filter.tagPlaceholder')}
                aria-label={t('search.filter.tag')}
                onChange={(event) => setTyped(event.target.value)}
                data-testid="filter-tag-input"
              />
            </form>
            {conditions.tag && (
              <button type="button" role="menuitem" className="nn-menu-item" onClick={() => pick('')}>
                <X className="h-3.5 w-3.5" aria-hidden />
                {t('search.filter.anyTag')}
              </button>
            )}
            {shown.map((entry) => (
              <button key={entry.key} type="button" role="menuitem" className="nn-menu-item justify-between" onClick={() => pick(entry.label)}>
                <span className="truncate text-accent-400">#{entry.label}</span>
                <span className="text-xs text-mist-500">{entry.count}</span>
              </button>
            ))}
            {tags !== null && shown.length === 0 && <p className="px-2.5 py-1.5 text-sm text-mist-500">{t('search.filter.noTags')}</p>}
          </>
        )
      }}
    </Chip>
  )
}

function periodLabel(conditions: SearchConditions, t: (key: string, values?: Record<string, unknown>) => string, lang: string): string {
  switch (conditions.period) {
    case 'week':
      return t('search.filter.week')
    case 'month':
      return t('search.filter.month')
    case 'year':
      return t('search.filter.year')
    case 'custom': {
      const show = (day: string) => (day ? new Date(`${day}T00:00:00`).toLocaleDateString(lang) : '…')
      return t('search.filter.between', { from: show(conditions.from), to: show(conditions.to) })
    }
    default:
      return t('search.filter.period')
  }
}

function PeriodChoice({ conditions, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const active = conditions.period !== '' && (conditions.period !== 'custom' || Boolean(conditions.from || conditions.to))
  const presets: { period: Period; label: string }[] = [
    { period: '', label: t('search.filter.anyTime') },
    { period: 'week', label: t('search.filter.week') },
    { period: 'month', label: t('search.filter.month') },
    { period: 'year', label: t('search.filter.year') },
  ]
  return (
    <Chip label={periodLabel(conditions, t, i18n.language)} active={active} testId="filter-period">
      {(close) => (
        <>
          {presets.map((preset) => (
            <button
              key={preset.period || 'any'}
              type="button"
              role="menuitem"
              className={'nn-menu-item ' + (preset.period === conditions.period ? 'text-accent-400' : '')}
              onClick={() => {
                onChange({ ...conditions, period: preset.period, from: '', to: '' })
                close()
              }}
            >
              {preset.label}
            </button>
          ))}
          <div className="flex flex-col gap-1.5 border-t border-ink-700 px-2.5 pt-2 pb-1.5">
            <span className="text-xs text-mist-500">{t('search.filter.custom')}</span>
            <label className="flex items-center justify-between gap-2 text-sm text-mist-300">
              {t('search.filter.from')}
              <input
                type="date"
                className="nn-field h-8 w-36"
                value={conditions.from}
                data-testid="filter-from"
                onChange={(event) => onChange({ ...conditions, period: 'custom', from: event.target.value })}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-mist-300">
              {t('search.filter.to')}
              <input
                type="date"
                className="nn-field h-8 w-36"
                value={conditions.to}
                data-testid="filter-to"
                onChange={(event) => onChange({ ...conditions, period: 'custom', to: event.target.value })}
              />
            </label>
          </div>
        </>
      )}
    </Chip>
  )
}

export function Filters(props: Props) {
  return (
    <>
      <FolderChoice {...props} />
      <TagChoice {...props} />
      <PeriodChoice {...props} />
    </>
  )
}
