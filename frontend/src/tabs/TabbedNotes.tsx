/**
 * The notes page on a wider screen (NOTES-8): the row of tabs on top, the list in the middle beside the open notes
 * while there is room for both, and one note or two side by side (drawings "N8-Nebeneinander", "N8-Tabs-Probe").
 *
 * - The list is whatever the sidebar chose (a folder, a tag, the search, the inbox, all notes); choosing another changes
 *   only the list, the tabs and their editors stay (AC-9).
 * - The address names the list and the note on the side used last. Every way that opens a note (the list, a link, the
 *   search, the browser's back button) opens it there: its tab if it has one, otherwise in place of that side's note.
 *   An address without a note while tabs are open gets the note of the side used last (also the first visit after a
 *   reload, AC-5).
 * - Two sides need 2 × 340 px; with less, one shows with a switcher, and the split comes back when the window grows
 *   (EC-2). The line between them moves with the mouse or the arrow keys, never below 340 px a side (AC-2).
 * - A note dragged from a list, or a tab, onto the right edge opens beside (AC-1).
 * - On the first visit of a page load at "/", the tabs of last time come back with their split (AC-5).
 */
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ColumnHandle } from '../components/ColumnHandle'
import { draggedNow } from '../folders/actions'
import { useFolders } from '../folders/store'
import { useColumnWidth } from '../lib/columns'
import { ListPlaceContext } from '../notes/listPlace'
import { folderOfList, hrefIn } from '../notes/workspace'
import { useAuth } from '../state/auth'
import { listenForTabKeys } from './keys'
import { installTabLinks } from './links'
import { onLiveStopped } from './live'
import { refreshMeta, useTabMetas } from './meta'
import { focusSide as focusSideAction, openNoteBeside, setNavigation } from './open'
import { focusedKey, focusSide, MAX_RATIO, MIN_RATIO, tabOf, type Side } from './state'
import { isOtherAccountsNote, loadAccountTabs, tabs, tabsNow, useTabs } from './store'
import { draggedTab, MIN_PANE, ROOMY_PANE, SEPARATOR } from './layout'
import { TabBar } from './TabBar'
import { TabPane } from './TabPane'

// Middle button and Ctrl/⌘ on a link to a note, in every list of the app (AC-3).
installTabLinks()

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [box, width]
}

type Props = {
  noteId?: string
  /** Just made: the cursor goes into the title. */
  fresh: boolean
  /** The list in the middle (all notes, a folder, the inbox, a tag, the search). */
  list: ReactNode
  /** Its address without a note (`/folder/<id>`, `/search?q=…`, `/`). */
  listPath: string
}

export function TabbedNotes(props: Props) {
  const { me } = useAuth()
  if (!me) return null
  return <Tabbed {...props} account={me.id} />
}

function Tabbed({ noteId, fresh, list, listPath, account }: Props & { account: number }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tree = useFolders()
  loadAccountTabs(account)
  const state = useTabs()
  const metas = useTabMetas(state.tabs.map((tab) => tab.note))
  const [page, measured] = useWidth()
  const area = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(false)
  const [dropping, setDropping] = useState(false)
  // The list beside an open note, as wide as set on this device; it gives way before a note gets too narrow.
  const [listWidth] = useColumnWidth('list')

  useEffect(() => {
    setNavigation((path, options) => navigate(path, { replace: options?.replace, state: options?.state }))
    return () => setNavigation(null)
  }, [navigate])

  // The folder of the list, kept with a tab opened from it.
  const shownFolder = folderOfList(listPath)
  const folderId = shownFolder === 'inbox' ? (tree.inbox?.id ?? '') : (shownFolder ?? '')

  // The address opens its note on the side used last; before anything is drawn. Not a note of the account before,
  // though, which the address may still name after another account came into this browser tab: that goes to the
  // start (the list may be a folder of the account before too), and never into this account's tabs. An address without a note keeps the tabs and names the note on
  // the side used last (another list chosen in the sidebar, the first visit after a reload).
  useLayoutEffect(() => {
    if (noteId && isOtherAccountsNote(noteId)) {
      setSettled(false)
      navigate('/', { replace: true })
      return
    }
    if (noteId) tabs.openHere(noteId, folderId)
    else {
      const state = tabsNow()
      const tab = tabOf(state, focusedKey(state))
      if (tab) navigate(hrefIn(listPath, tab.note), { replace: true })
    }
    setSettled(true)
  }, [noteId, folderId, listPath, account, navigate])

  useEffect(() => listenForTabKeys(), [])
  useEffect(() => onLiveStopped((note) => void refreshMeta([note])), [])

  const width = measured || 1280
  const left = tabOf(state, state.left)
  const right = tabOf(state, state.right)
  const side = focusSide(state)
  const open = settled && Boolean(left)
  const split = open && Boolean(right)
  const both = split && width >= 2 * MIN_PANE + SEPARATOR
  const showList = open && width - listWidth >= (both ? 2 * ROOMY_PANE + SEPARATOR : MIN_PANE)
  const areaWidth = width - (showList ? listWidth : 0)
  const room = areaWidth - SEPARATOR
  const leftWidth = Math.round(Math.min(Math.max(state.ratio * room, MIN_PANE), room - MIN_PANE))

  // ---- the line between the sides (AC-2) -------------------------------------------------------------------------
  const moveTo = (clientX: number) => {
    const box = area.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    tabs.ratio((clientX - box.left - SEPARATOR / 2) / (box.width - SEPARATOR))
  }
  const onSeparatorDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    const move = (next: PointerEvent) => moveTo(next.clientX)
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  // ---- dropped on the right edge (AC-1) ----------------------------------------------------------------------------
  const dragged = (): { note: string; folder?: string } | null => {
    const notes = draggedNow()
    if (notes?.kind === 'notes' && notes.ids.length === 1) return { note: notes.ids[0], folder: folderId }
    const tab = tabOf(tabsNow(), draggedTab())
    return tab ? { note: tab.note, folder: tab.folder } : null
  }
  const atRightEdge = (event: DragEvent) => {
    const box = area.current?.getBoundingClientRect()
    if (!box) return false
    return event.clientX >= box.right - Math.max(120, box.width * 0.25)
  }
  const onDragOver = (event: DragEvent) => {
    const what = dragged()
    const here = Boolean(what) && atRightEdge(event)
    setDropping(here)
    if (!here) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent) => {
    const what = dragged()
    setDropping(false)
    if (!what || !atRightEdge(event)) return
    event.preventDefault()
    event.stopPropagation()
    openNoteBeside(what.note, what.folder)
  }

  const shown = [left, right].filter((tab): tab is NonNullable<typeof tab> => Boolean(tab))
  return (
    <div ref={page} className="flex h-full min-h-0 flex-col" data-testid="notes-page" data-tabs="on">
      {state.tabs.length > 0 && <TabBar state={state} metas={metas} split={split} open={open} />}
      <div className="flex min-h-0 flex-1">
        {(!open || showList) && (
          <div className={'relative flex min-h-0 shrink-0 ' + (open ? '' : 'w-full flex-1')} style={open ? { width: listWidth } : undefined} data-testid="list-column">
            <div className={'nn-scroll min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-ink-700 ' + (open ? 'flex border-r' : 'flex w-full')}>
              <ListPlaceContext.Provider value={open ? 'column' : 'page'}>{list}</ListPlaceContext.Provider>
            </div>
            {open && <ColumnHandle column="list" />}
          </div>
        )}
        {open && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {split && !both && (
              <div role="radiogroup" aria-label={t('tabs.sides')} className="flex shrink-0 gap-1 border-b border-ink-700 px-3 py-1.5" data-testid="side-switch">
                {(['left', 'right'] as Side[]).map((one) => {
                  const tab = one === 'left' ? left : right
                  const title = (tab && metas.get(tab.note)?.title) || t('notes.untitled')
                  return (
                    <button
                      key={one}
                      type="button"
                      role="radio"
                      aria-checked={side === one}
                      onClick={() => focusSideAction(one)}
                      className={'nn-btn h-8 min-w-0 flex-1 px-3 text-[13px] ' + (side === one ? 'nn-btn-accent' : 'nn-btn-ghost')}
                    >
                      <span className="shrink-0 font-semibold">{t(`tabs.${one}`)}</span>
                      <span className="min-w-0 truncate">{title}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <div
              ref={area}
              className="relative flex min-h-0 min-w-0 flex-1"
              onDragOverCapture={onDragOver}
              onDropCapture={onDrop}
              onDragLeave={(event) => {
                if (!area.current?.contains(event.relatedTarget as Node | null)) setDropping(false)
              }}
            >
              {shown.map((tab) => {
                const one: Side = tab.key === state.left ? 'left' : 'right'
                const focused = one === side
                const style = both ? (one === 'left' ? { order: 0, flex: `0 0 ${leftWidth}px` } : { order: 2, flex: '1 1 0' }) : { order: one === 'left' ? 0 : 2, flex: '1 1 0' }
                return (
                  <TabPane
                    key={tab.key}
                    tab={tab}
                    side={one}
                    meta={metas.get(tab.note)}
                    focused={focused}
                    line={both && focused}
                    hidden={split && !both && !focused}
                    fresh={fresh && focused && tab.note === noteId}
                    style={style}
                  />
                )
              })}
              {both && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('tabs.resize')}
                  aria-valuemin={Math.round(MIN_RATIO * 100)}
                  aria-valuemax={Math.round(MAX_RATIO * 100)}
                  aria-valuenow={Math.round((leftWidth / room) * 100)}
                  tabIndex={0}
                  data-testid="tab-separator"
                  style={{ order: 1, flex: `0 0 ${SEPARATOR}px` }}
                  className="flex cursor-col-resize touch-none items-center justify-center outline-offset-[-2px]"
                  onPointerDown={onSeparatorDown}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    tabs.ratio(leftWidth / room + (event.key === 'ArrowRight' ? 0.05 : -0.05))
                  }}
                >
                  <span aria-hidden className="h-11 w-1 rounded-sm bg-ink-600" />
                </div>
              )}
              {dropping && (
                <div
                  aria-hidden
                  data-testid="drop-beside"
                  className="pointer-events-none absolute inset-y-2 right-2 flex w-1/4 min-w-[120px] items-center justify-center rounded-[12px] border border-dashed border-accent-500 bg-accent-wash px-3 text-center text-[13px] text-accent-400"
                >
                  {t('tabs.dropBeside')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
