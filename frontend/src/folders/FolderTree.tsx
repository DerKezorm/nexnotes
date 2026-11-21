/**
 * The folders in the sidebar, after the drawing "Seitenleiste" (NOTES-4): the inbox with its count, then the folders
 * as a tree, each with its symbol or color, its name (cut short, whole in the tooltip, EC-3) and the number of its own
 * notes (AC-8). Open and closed are remembered per device (AC-6).
 *
 * Mouse: a click opens, the arrow beside it opens and closes, "…" or a right click opens the menu (AC-12); folders and
 * notes are dragged onto a folder (AC-3), folders also between two others (AC-11) or onto the heading (to the top).
 * Keyboard (EC-11): arrows move through the tree and open and close, Enter opens, F2 renames, Shift+F10 or the menu
 * key opens the menu, Delete asks before the trash.
 */
import { ChevronDown, ChevronRight, Inbox, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useMatch, useNavigate } from 'react-router-dom'

import type { Folder } from './api'
import { draggedNow, droppedFrom, endDrag, startFolderDrag } from './actions'
import { useFolderActions } from './useFolderActions'
import { accepts, drop, zoneAt, type Zone } from './drop'
import { FolderMark } from './FolderMark'
import { FolderMenu } from './FolderMenu'
import { flatten, indent, refreshFolders, setFolderOpen, useFolders, useOpenFolders } from './store'

function rowId(id: string): string {
  return `folder-row-${id}`
}

/** The inbox at the top of the sidebar, with its count; notes dropped on it go back into it. */
export function InboxEntry({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const [over, setOver] = useState(false)
  const inbox = tree.inbox
  const take = (event: DragEvent) => {
    if (!inbox || !accepts(tree, draggedNow(), inbox.id, 'into', true)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }
  return (
    <NavLink
      to="/inbox"
      onClick={onNavigate}
      data-testid="sidebar-inbox"
      onDragOver={take}
      onDragEnter={take}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const dragged = droppedFrom(event)
        endDrag()
        if (inbox && dragged?.kind === 'notes') void drop(tree, dragged, inbox.id, 'into')
      }}
      className={({ isActive }) =>
        'mt-1 flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors ' +
        (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800') +
        (over ? ' ring-2 ring-accent-500' : '')
      }
    >
      <Inbox aria-hidden className="h-4 w-4 shrink-0 text-mist-500" strokeWidth={1.8} />
      <span className="flex-1 truncate">{t('folders.inbox.name')}</span>
      {inbox && inbox.count > 0 && <span className="text-xs text-mist-500 tabular-nums">{inbox.count}</span>}
    </NavLink>
  )
}

export function FolderTree({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const open = useOpenFolders()
  const actions = useFolderActions()
  const navigate = useNavigate()
  const shownId = useMatch('/folder/:id')?.params.id ?? null
  const rows = flatten(tree, open)
  const [focused, setFocused] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null)
  const [target, setTarget] = useState<{ id: string | null; zone: Zone } | null>(null)
  const moveFocus = useRef(false)

  // The row that can be reached with Tab: the one last used, else the open folder, else the first.
  const tabStop = rows.some((row) => row.folder.id === focused) ? focused : rows.some((row) => row.folder.id === shownId) ? shownId : (rows[0]?.folder.id ?? null)

  useEffect(() => {
    if (!moveFocus.current || !focused) return
    moveFocus.current = false
    document.getElementById(rowId(focused))?.focus()
  }, [focused, rows.length])

  // The open folder stays in sight in a long sidebar (a deep path opened from a link or the page's path).
  const shownVisible = rows.some((row) => row.folder.id === shownId)
  useEffect(() => {
    if (shownId && shownVisible) document.getElementById(rowId(shownId))?.scrollIntoView?.({ block: 'nearest' })
  }, [shownId, shownVisible])

  const go = (id: string) => {
    moveFocus.current = true
    setFocused(id)
  }

  const openFolder = (folder: Folder) => {
    onNavigate?.()
    navigate(`/folder/${folder.id}`)
  }

  const keys = (event: KeyboardEvent, folder: Folder, index: number) => {
    const hasChildren = (tree.children.get(folder.id) ?? []).length > 0
    const isOpen = open.has(folder.id)
    switch (event.key) {
      case 'ArrowDown':
        if (rows[index + 1]) go(rows[index + 1].folder.id)
        break
      case 'ArrowUp':
        if (rows[index - 1]) go(rows[index - 1].folder.id)
        break
      case 'Home':
        if (rows[0]) go(rows[0].folder.id)
        break
      case 'End':
        if (rows.length) go(rows[rows.length - 1].folder.id)
        break
      case 'ArrowRight':
        if (hasChildren && !isOpen) setFolderOpen(folder.id, true)
        else if (hasChildren && rows[index + 1]) go(rows[index + 1].folder.id)
        break
      case 'ArrowLeft':
        if (hasChildren && isOpen) setFolderOpen(folder.id, false)
        else if (folder.parent_id) go(folder.parent_id)
        break
      case 'Enter':
        openFolder(folder)
        break
      case 'F2':
        actions.act('rename', folder)
        break
      case 'Delete':
        actions.act('trash', folder)
        break
      case 'ContextMenu':
        setMenu({ folder, anchor: event.currentTarget as HTMLElement })
        break
      case 'F10':
        if (!event.shiftKey) return
        setMenu({ folder, anchor: event.currentTarget as HTMLElement })
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const over = (event: DragEvent, id: string | null) => {
    const dragged = draggedNow()
    if (!dragged) return
    const zone = id === null ? 'into' : zoneAt(event.clientY, event.currentTarget.getBoundingClientRect(), dragged.kind)
    if (!accepts(tree, dragged, id, zone)) {
      event.dataTransfer.dropEffect = 'none'
      setTarget(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (target?.id !== id || target.zone !== zone) setTarget({ id, zone })
  }

  const land = (event: DragEvent, id: string | null) => {
    event.preventDefault()
    const dragged = droppedFrom(event)
    const zone = target?.id === id ? target.zone : 'into'
    setTarget(null)
    endDrag()
    if (accepts(tree, dragged, id, zone)) void drop(tree, dragged, id, zone)
  }

  return (
    <div data-testid="folder-tree" className="pb-2">
      <div
        className={'mt-3 flex items-center justify-between rounded-lg pr-1 pl-2.5 ' + (target?.id === null ? 'ring-2 ring-accent-500' : '')}
        onDragOver={(event) => over(event, null)}
        onDragLeave={() => target?.id === null && setTarget(null)}
        onDrop={(event) => land(event, null)}
        title={target?.id === null ? t('folders.toTop') : undefined}
      >
        <Link to="/folders" onClick={onNavigate} className="py-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase hover:text-mist-300">
          {t('folders.section')}
        </Link>
        <button type="button" onClick={() => actions.create(null)} aria-label={t('folders.newTop')} title={t('folders.newTop')} className="rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100">
          <Plus aria-hidden className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
      </div>

      {tree.status === 'failed' && (
        <p className="px-2.5 py-2 text-xs text-mist-500">
          {t('folders.loadFailed')}{' '}
          <button type="button" className="nn-btn-quiet" onClick={() => void refreshFolders()}>
            {t('folders.retry')}
          </button>
        </p>
      )}
      {tree.status === 'ready' && rows.length === 0 && <p className="px-2.5 py-2 text-xs text-mist-500">{t('folders.empty')}</p>}

      <div role="tree" aria-label={t('folders.section')} aria-describedby="folder-tree-keys">
        {rows.map(({ folder, depth }, index) => {
          const hasChildren = (tree.children.get(folder.id) ?? []).length > 0
          const isOpen = open.has(folder.id)
          const chosen = folder.id === shownId
          const zone = target?.id === folder.id ? target.zone : null
          return (
            <div
              key={folder.id}
              id={rowId(folder.id)}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-selected={chosen}
              aria-label={`${folder.name}, ${t('folders.count.notes', { count: folder.count })}`}
              tabIndex={folder.id === tabStop ? 0 : -1}
              draggable
              data-folder={folder.id}
              onFocus={() => setFocused(folder.id)}
              onKeyDown={(event) => keys(event, folder, index)}
              onClick={() => openFolder(folder)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ folder, anchor: event.currentTarget })
              }}
              onDragStart={(event) => startFolderDrag(event, folder.id)}
              onDragEnd={() => {
                endDrag()
                setTarget(null)
              }}
              onDragOver={(event) => over(event, folder.id)}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null) && target?.id === folder.id) setTarget(null)
              }}
              onDrop={(event) => land(event, folder.id)}
              className={
                'group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-1 text-[13.5px] outline-offset-[-2px] select-none pointer-coarse:h-11 ' +
                (chosen ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800') +
                (zone === 'into' ? ' ring-2 ring-accent-500' : '')
              }
              style={{ paddingLeft: indent(depth) }}
            >
              {zone === 'before' && <span aria-hidden className="absolute inset-x-1 top-0 h-0.5 rounded bg-accent-500" />}
              {zone === 'after' && <span aria-hidden className="absolute inset-x-1 bottom-0 h-0.5 rounded bg-accent-500" />}
              {hasChildren ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={isOpen ? t('folders.collapse') : t('folders.expand')}
                  onClick={(event) => {
                    event.stopPropagation()
                    setFolderOpen(folder.id, !isOpen)
                  }}
                  className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-mist-500 hover:text-mist-100"
                >
                  {isOpen ? <ChevronDown aria-hidden className="h-3 w-3" strokeWidth={3} /> : <ChevronRight aria-hidden className="h-3 w-3" strokeWidth={3} />}
                </button>
              ) : (
                <span aria-hidden className="w-3.5 shrink-0" />
              )}
              <FolderMark folder={folder} />
              <span className="min-w-0 flex-1 truncate" title={folder.name}>
                {folder.name}
              </span>
              <span aria-hidden className={'shrink-0 text-xs tabular-nums group-hover:hidden group-focus:hidden pointer-coarse:hidden ' + (chosen ? 'text-accent-400' : 'text-mist-500')}>
                {folder.count}
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('folders.menu.label', { name: folder.name })}
                onClick={(event) => {
                  event.stopPropagation()
                  setMenu({ folder, anchor: event.currentTarget.closest('[role="treeitem"]') as HTMLElement })
                }}
                className="hidden shrink-0 rounded p-0.5 text-mist-400 group-hover:block group-focus:block hover:bg-ink-700 hover:text-mist-100 pointer-coarse:block"
              >
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
      <p id="folder-tree-keys" className="sr-only">
        {t('folders.keys')}
      </p>
      {menu && <FolderMenu folder={menu.folder} anchor={menu.anchor} onClose={() => setMenu(null)} onAction={(action) => actions.act(action, menu.folder)} />}
      {actions.node}
    </div>
  )
}
