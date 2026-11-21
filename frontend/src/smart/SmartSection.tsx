/**
 * The smart folders in the sidebar (drawing "Seitenleiste", NOTES-7 AC-8): the section "Intelligent" between the
 * folders and the tags, each with the filter symbol ("Mit mir geteilt" and "Anhänge" with the symbols of the sidebar
 * entries they replaced), in the member's own order. The order changes by dragging one onto
 * the place of another, or with Alt + arrow up/down on the focused one; "+" makes a new one.
 */
import { Filter, Paperclip, Plus, Users, type LucideIcon } from 'lucide-react'
import { useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink } from 'react-router-dom'

import { showNotice } from '../folders/notice'
import { problemText } from '../lib/errors'
import { smartApi, type Preset } from './api'
import { smartName } from './conditions'
import { moved } from './order'
import { refreshSmartFolders, showOrder, useSmartFolders } from './store'

const DRAG_TYPE = 'application/x-nexnotes-smart'

/** The presets that keep the symbol of the fixed entry they replaced. */
const PRESET_ICONS: Partial<Record<Preset, LucideIcon>> = { shared_with_me: Users, attachments: Paperclip }

function keep(ids: string[]): void {
  showOrder(ids)
  smartApi
    .order(ids)
    .catch((error) => {
      showNotice({ text: problemText(error) })
    })
    .finally(() => void refreshSmartFolders())
}

export function SmartSection({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { folders } = useSmartFolders()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const ids = folders.map((folder) => folder.id)

  const take = (target: string) => (event: DragEvent) => {
    if (!dragging || !event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(target)
  }
  const land = (target: string) => (event: DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData(DRAG_TYPE) || dragging
    setDragging(null)
    setOver(null)
    if (id && id !== target) keep(moved(ids, id, target))
  }
  const onKey = (id: string) => (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const index = ids.indexOf(id)
    const next = event.key === 'ArrowUp' ? index - 1 : index + 1
    if (next < 0 || next >= ids.length) return
    keep(moved(ids, id, ids[next]))
  }

  return (
    <section aria-label={t('smart.heading')} className="pb-1" data-testid="sidebar-smart">
      <div className="flex items-center justify-between pr-1">
        <h2 className="px-2.5 pt-3.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('smart.heading')}</h2>
        <Link
          to="/smart/new"
          onClick={onNavigate}
          aria-label={t('smart.new')}
          title={t('smart.new')}
          className="mt-2.5 rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100"
          data-testid="sidebar-smart-new"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        </Link>
      </div>
      <ul className="flex flex-col">
        {folders.map((folder) => {
          const name = smartName(folder, t)
          const Icon = PRESET_ICONS[folder.preset]
          return (
            <li key={folder.id}>
              <NavLink
                to={`/smart/${encodeURIComponent(folder.id)}`}
                onClick={onNavigate}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, folder.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging(folder.id)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                onDragOver={take(folder.id)}
                onDragEnter={take(folder.id)}
                onDragLeave={() => setOver((now) => (now === folder.id ? null : now))}
                onDrop={land(folder.id)}
                onKeyDown={onKey(folder.id)}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title={name}
                data-testid="sidebar-smart-folder"
                className={({ isActive }) =>
                  'flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] ' +
                  (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800') +
                  (over === folder.id && dragging !== folder.id ? ' ring-2 ring-accent-500' : '') +
                  (dragging === folder.id ? ' opacity-60' : '')
                }
              >
                {Icon ? (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-mist-500" strokeWidth={2} aria-hidden data-testid={`smart-icon-${folder.preset}`} />
                ) : (
                  <Filter className="h-3.5 w-3.5 shrink-0 text-mist-500" strokeWidth={2} aria-hidden data-testid="smart-filter-icon" />
                )}
                <span className="min-w-0 truncate">{name}</span>
              </NavLink>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
