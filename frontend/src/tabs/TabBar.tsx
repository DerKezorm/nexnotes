/**
 * The row of open tabs (drawings "N8-Nebeneinander" and "N8-Tabs-Probe"): each with the color of its folder, its title
 * and a cross; the two on show say "links" and "rechts" (AC-3, AC-4). At most six, and never a scroll bar (AC-8,
 * EC-4): the tabs grow narrower and cut their titles short, and when even that does not fit, they stand in two rows.
 * The full title is in the tooltip.
 *
 * Tabs can be dragged into another order or onto the right edge of the notes (AC-1), and the keyboard moves through
 * them as through any row of tabs (EC-7).
 */
import { Ban, Lock, PanelRightClose, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { NoteIcon } from '../components/NoteIcon'
import { colorOf } from '../folders/palette'
import { useCurrentFolder, useFolders } from '../folders/store'
import { createNote } from '../notes/newNote'
import { isMac } from './desktop'
import { draggedTab as draggedTabNow, setDraggedTab, shortcutText, SIDE_LABEL, TAB_DRAG, TAB_MAX, tabMin, tabRows } from './layout'
import type { TabMeta } from './meta'
import { closeTab, endSplit, openNoteInNewTab, showTab } from './open'
import { focusedKey, focusSide, MAX_TABS, type Tab, type TabsState } from './state'
import { tabs as store } from './store'

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
  state: TabsState
  metas: Map<string, TabMeta>
  /** The page shows notes beside each other (both, or one with the switcher). */
  split: boolean
  /** A note is open on the page (not the list alone at "/"). */
  open: boolean
}

export function TabBar({ state, metas, split, open }: Props) {
  const { t } = useTranslation()
  const tree = useFolders()
  const { openFolderId, targetFolderId } = useCurrentFolder()
  const [box, width] = useWidth()
  const list = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<string | null>(null)
  const focused = focusedKey(state)
  // The buttons after the tabs: their padding (4), "new tab" (30), "end split" (4 + 30), and the count with its gap
  // ("6 von 6" in 12 px with its padding, 4 + 52). When the tabs would not keep their least width in two rows
  // otherwise, the count goes (it is in the tooltip of "new tab" then) before the titles do.
  const buttons = 4 + 30 + (state.right ? 34 : 0)
  const mins = state.tabs.map((tab) => tabMin(split && (tab.key === state.left || tab.key === state.right)))
  const full = tabRows(mins, width, buttons + 56)
  const compact = full.fits ? full : tabRows(mins, width, buttons)
  const layout = compact.fits ? compact : full
  const showCount = layout === full
  const { rows, first: firstRow } = layout
  const mod = isMac() ? '⌥⇧' : t('tabs.keys.mod')

  const titleOf = (tab: Tab) => metas.get(tab.note)?.title || t('notes.untitled')
  const colorFor = (meta: TabMeta | undefined) => {
    if (!meta || meta.inbox || !meta.folder) return 'var(--color-mist-500)'
    return colorOf(tree.byId.get(meta.folder)?.color ?? '')
  }

  const tabElements = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]

  const onKey = (event: KeyboardEvent<HTMLDivElement>, tab: Tab, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const all = tabElements()
    const moveFocus = (to: number) => all[(to + all.length) % all.length]?.focus()
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      if (event.shiftKey) {
        store.move(tab.key, index + step)
        requestAnimationFrame(() => tabElements()[Math.max(0, Math.min(index + step, all.length - 1))]?.focus())
      } else moveFocus(index + step)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveFocus(event.key === 'Home' ? 0 : all.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      showTab(tab.key)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      closeTab(tab.key)
    }
  }

  const onDragOver = (event: DragEvent, tab: Tab) => {
    if (!draggedTabNow() || draggedTabNow() === tab.key) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(tab.key)
  }

  const onDrop = (event: DragEvent, index: number) => {
    const key = event.dataTransfer.getData(TAB_DRAG)
    setOver(null)
    if (!key) return
    event.preventDefault()
    store.move(key, index)
  }

  const newTab = () => {
    createNote(targetFolderId)
      .then((note) => openNoteInNewTab(note.id, openFolderId ?? undefined, { fresh: true }))
      .catch(() => undefined)
  }

  const renderTab = (tab: Tab, index: number) => {
    const meta = metas.get(tab.note)
    const title = titleOf(tab)
    const side = tab.key === state.left ? 'left' : tab.key === state.right ? 'right' : null
    const shown = open && side !== null
    // The tab of the side used last (NOTES-8 AC-1): honey along its top and bold, so it stands out by shape and
    // weight too, not by color alone.
    const active = shown && side === focusSide(state)
    const mark = meta?.state === 'deleted' ? 'deleted' : meta?.state === 'gone' ? 'gone' : meta?.locked ? 'locked' : null
    const hint = [title, mark ? t(`tabs.state.${mark}`) : '', index < MAX_TABS ? shortcutText(String(index + 1)) : ''].filter(Boolean).join(' · ')
    return (
      <div
        key={tab.key}
        role="tab"
        aria-selected={shown}
        aria-current={active ? 'true' : undefined}
        data-active={active || undefined}
        aria-keyshortcuts={`Alt+Shift+${index + 1}`}
        tabIndex={tab.key === (focused ?? state.tabs[0]?.key) ? 0 : -1}
        title={hint}
        data-testid="tab"
        data-note={tab.note}
        data-side={side ?? ''}
        data-state={mark ?? ''}
        draggable
        onDragStart={(event) => {
          setDraggedTab(tab.key)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(TAB_DRAG, tab.key)
          event.dataTransfer.setData('text/plain', title)
        }}
        onDragEnd={() => {
          setDraggedTab(null)
          setOver(null)
        }}
        onDragOver={(event) => onDragOver(event, tab)}
        onDragLeave={() => setOver(null)}
        onDrop={(event) => onDrop(event, index)}
        onClick={() => showTab(tab.key)}
        onAuxClick={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          closeTab(tab.key)
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onKeyDown={(event) => onKey(event, tab, index)}
        style={{
          flex: `0 1 ${TAB_MAX + (split && side ? SIDE_LABEL : 0)}px`,
          // The start of the title stays readable (EC-4) wherever the rows can hold it; else the tabs share alike.
          minWidth: layout.fits ? tabMin(Boolean(split && side)) : undefined,
        }}
        className={
          'group flex h-[38px] min-w-0 cursor-default items-center gap-1.5 rounded-t-[9px] border border-b-0 pr-1 pl-3 text-[13px] outline-offset-[-2px] select-none ' +
          (active
            ? 'border-ink-700 bg-ink-850 font-semibold text-mist-100 shadow-[inset_0_3px_0_var(--color-accent-500)]'
            : shown
              ? 'border-ink-700 bg-ink-850 text-mist-300'
              : 'border-transparent text-mist-500 hover:bg-ink-900 hover:text-mist-300') +
          (over === tab.key ? ' shadow-[inset_2px_0_0_var(--color-accent-500)]' : '')
        }
      >
        {meta?.icon ? <NoteIcon icon={meta.icon} color={meta.color} size={13} /> : <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: colorFor(meta) }} />}
        <span className={'min-w-0 flex-1 truncate' + (mark === 'deleted' || mark === 'gone' ? ' line-through decoration-mist-500' : '')} data-testid="tab-title">
          {title}
        </span>
        {mark === 'deleted' && <Trash2 aria-label={t('tabs.state.deleted')} className="h-3.5 w-3.5 shrink-0 text-warn-500" />}
        {mark === 'gone' && <Ban aria-label={t('tabs.state.gone')} className="h-3.5 w-3.5 shrink-0 text-warn-500" />}
        {mark === 'locked' && <Lock aria-label={t('tabs.state.locked')} className="h-3.5 w-3.5 shrink-0 text-mist-400" data-testid="tab-lock" />}
        {split && side && (
          <span className="shrink-0 text-[11px] text-mist-500" data-testid="tab-side">
            {t(`tabs.${side}`)}
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('tabs.close', { title })}
          title={t('tabs.close', { title })}
          data-testid="tab-close"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-mist-500 hover:bg-ink-700 hover:text-mist-100"
          onClick={(event) => {
            event.stopPropagation()
            closeTab(tab.key)
          }}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    )
  }

  const extrasRow = (
    <div className="ml-auto flex shrink-0 items-center gap-1 pb-1 pl-1">
      <button
        type="button"
        aria-label={t('tabs.newTab')}
        title={showCount ? t('tabs.newTab') : `${t('tabs.newTab')} · ${t('tabs.count', { count: state.tabs.length, max: MAX_TABS })}`}
        data-testid="tab-new"
        className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-mist-300 hover:bg-ink-800 hover:text-mist-100"
        onClick={newTab}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
      {state.right && (
        <button
          type="button"
          aria-label={t('tabs.endSplit')}
          title={t('tabs.endSplit')}
          data-testid="tab-end-split"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-mist-300 hover:bg-ink-800 hover:text-mist-100"
          onClick={endSplit}
        >
          <PanelRightClose className="h-4 w-4" aria-hidden />
        </button>
      )}
      {showCount && (
        <span className="px-1 text-[12px] whitespace-nowrap text-mist-500" title={t('tabs.keys.help', { mod })} data-testid="tab-count">
          {t('tabs.count', { count: state.tabs.length, max: MAX_TABS })}
        </span>
      )}
    </div>
  )

  const rowsOfTabs = rows === 1 ? [state.tabs] : [state.tabs.slice(0, firstRow), state.tabs.slice(firstRow)]
  return (
    <div ref={box} className="shrink-0 overflow-hidden border-b border-ink-700 px-3 pt-2" data-testid="tab-bar" data-rows={rows}>
      <div ref={list} role="tablist" aria-label={t('tabs.label')} className="flex min-w-0 flex-col gap-0.5">
        {rowsOfTabs.map((row, rowIndex) => (
          <div key={rowIndex} className="flex min-w-0 items-end gap-0.5" data-testid="tab-row">
            {row.map((tab, index) => renderTab(tab, rowIndex === 0 ? index : firstRow + index))}
            {rowIndex === (layout.extrasFirst ? 0 : rowsOfTabs.length - 1) && extrasRow}
          </div>
        ))}
      </div>
    </div>
  )
}
