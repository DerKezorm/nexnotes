/**
 * The smart folders in the sidebar (drawing "Seitenleiste", NOTES-7 AC-8): the section "Intelligent" between the
 * folders and the tags, each with its symbol in its color (as a folder, `SmartMark`), in the member's own order. The
 * order changes by dragging one onto the place of another, or with Alt + arrow up/down on the focused one; "+" makes a
 * new one.
 *
 * Like a folder's row (fifth review): "…" on hover or focus and a right click open the menu (edit, up, down, delete,
 * `SmartMenu.tsx`); Shift+F10 or the menu key open it from the keyboard.
 */
import { MoreHorizontal, Plus } from 'lucide-react'
import { useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink } from 'react-router-dom'

import { smartName } from './conditions'
import { keepOrder, moved, stepped } from './order'
import { SmartMark } from './SmartMenu'
import { useSmartFolders } from './store'
import { useSmartActions } from './useSmartActions'

const DRAG_TYPE = 'application/x-nexnotes-smart'

/** The same section on the phone's page "Ordner" (NOTES-23 AC-1): the same smart folders in the same order with the
 * same symbols, rows large enough for a finger, "+" to make one, and "…" on every row as the folders have it there. */
export function PhoneSmartSection() {
  const { t } = useTranslation()
  const { folders } = useSmartFolders()
  const actions = useSmartActions(folders)
  return (
    <section aria-label={t('smart.heading')} className="space-y-3.5" data-testid="folders-smart">
      <div className="flex items-center justify-between">
        <h2 className="px-1 text-xs font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('smart.heading')}</h2>
        <Link to="/smart/new" aria-label={t('smart.new')} title={t('smart.new')} className="flex h-11 w-11 items-center justify-center text-mist-500" data-testid="folders-smart-new">
          <Plus className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        </Link>
      </div>
      {folders.length > 0 && (
        <div className="nn-card overflow-hidden rounded-[14px]">
          {folders.map((folder) => {
            const name = smartName(folder, t)
            return (
              <div key={folder.id} className="flex min-h-[50px] items-center border-b border-ink-800 last:border-b-0" data-testid="folders-smart-row">
                <Link
                  to={`/smart/${encodeURIComponent(folder.id)}`}
                  className="flex min-h-[50px] min-w-0 flex-1 items-center justify-between gap-2 pr-1 pl-3.5 text-base hover:bg-ink-800"
                  data-testid="folders-smart-folder"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <SmartMark folder={folder} size={16} />
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                  </span>
                  <span className="shrink-0 text-[15px] text-mist-500">›</span>
                </Link>
                <button
                  type="button"
                  aria-label={t('smart.menu', { name })}
                  aria-haspopup="menu"
                  aria-expanded={actions.openId === folder.id}
                  onClick={(event) => actions.toggle(folder, event.currentTarget)}
                  className="flex h-11 w-10 shrink-0 items-center justify-center text-mist-500"
                  data-testid="folders-smart-more"
                >
                  <MoreHorizontal aria-hidden className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {actions.node}
    </section>
  )
}

export function SmartSection({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { folders } = useSmartFolders()
  const actions = useSmartActions(folders, onNavigate)
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
    if (id && id !== target) keepOrder(moved(ids, id, target))
  }
  const onKey = (id: string) => (event: KeyboardEvent<HTMLAnchorElement>) => {
    const folder = folders.find((each) => each.id === id)
    if (folder && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault()
      actions.open(folder, event.currentTarget)
      return
    }
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const next = stepped(ids, id, event.key === 'ArrowUp' ? -1 : 1)
    if (next !== ids) keepOrder(next)
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
      <ul className="flex flex-col" aria-describedby="smart-section-keys">
        {folders.map((folder) => {
          const name = smartName(folder, t)
          const open = actions.openId === folder.id
          return (
            <li key={folder.id} className="group relative">
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
                onContextMenu={(event) => {
                  event.preventDefault()
                  actions.open(folder, event.currentTarget)
                }}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Shift+F10"
                title={name}
                data-testid="sidebar-smart-folder"
                className={({ isActive }) =>
                  'flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] group-focus-within:pr-8 group-hover:pr-8 pointer-coarse:h-11 pointer-coarse:pr-8 ' +
                  (open ? 'pr-8 ' : '') +
                  (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800') +
                  (over === folder.id && dragging !== folder.id ? ' ring-2 ring-accent-500' : '') +
                  (dragging === folder.id ? ' opacity-60' : '')
                }
              >
                <SmartMark folder={folder} />
                <span className="min-w-0 truncate">{name}</span>
              </NavLink>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('smart.menu', { name })}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(event) => actions.toggle(folder, event.currentTarget)}
                className={
                  'absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-mist-400 hover:bg-ink-700 hover:text-mist-100 ' +
                  (open ? 'block' : 'hidden group-focus-within:block group-hover:block pointer-coarse:block')
                }
                data-testid="sidebar-smart-more"
              >
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </button>
            </li>
          )
        })}
      </ul>
      <p id="smart-section-keys" className="sr-only">
        {t('smart.keys')}
      </p>
      {actions.node}
    </section>
  )
}
