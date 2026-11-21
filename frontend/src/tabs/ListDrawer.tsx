/**
 * The list as a drawer beside two notes (NOTES-8 AC-9, decision of 21.11.2026 "column, else drawer"): when the two
 * sides leave no room for the list's column, or the column is hidden, the list slides in right beside the sidebar,
 * over the left note, as wide as the list's column.
 *
 * - A list chosen in the sidebar (a folder, a tag, the inbox, all notes, a smart folder, the search) opens it, the same
 *   list chosen again too; so does the button "List" in the row of tabs.
 * - A note chosen in it opens on the side used last, as in the column, and closes it. Alt-click and the list's menu
 *   open tabs and keep it open.
 * - Escape closes it and gives the focus back to what opened it; a click beside it closes it too.
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ColumnHandle } from '../components/ColumnHandle'
import { ListPlaceContext } from '../notes/listPlace'
import { noteOf } from '../notes/workspace'
import type { ListDrawerState } from './drawerState'

type Props = {
  drawer: ListDrawerState
  width: number
  list: ReactNode
}

export function ListDrawer({ drawer, width, list }: Props) {
  const { t } = useTranslation()
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (drawer.focusInside) panel.current?.focus()
  }, [drawer.focusInside])

  // A note chosen with a plain click opens on the side used last (the list does that) and closes the drawer. Alt-click,
  // Ctrl/⌘ and the middle button open a tab and never get here (`links.ts` takes them first).
  const onClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const anchor = (event.target as Element).closest('a[href]') as HTMLAnchorElement | null
    if (!anchor || !panel.current?.contains(anchor)) return
    const url = new URL(anchor.href, window.location.href)
    if (noteOf(url.pathname, url.search)) drawer.close(false)
  }

  return (
    <aside
      ref={panel}
      id={drawer.id}
      aria-label={t('tabs.listDrawer')}
      tabIndex={-1}
      data-list-drawer=""
      data-testid="list-drawer"
      onClick={onClick}
      style={{ width }}
      className="absolute inset-y-0 left-0 z-30 flex min-h-0 border-r border-ink-700 bg-ink-950 shadow-[8px_0_24px_-8px_rgb(0_0_0/0.35)] outline-none"
    >
      <div className="nn-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <ListPlaceContext.Provider value="column">{list}</ListPlaceContext.Provider>
      </div>
      <ColumnHandle column="list" />
    </aside>
  )
}
