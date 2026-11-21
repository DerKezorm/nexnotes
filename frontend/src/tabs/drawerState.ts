/**
 * Whether the list's drawer beside two notes is open (`ListDrawer.tsx`): what opens it (a list chosen in the sidebar or
 * elsewhere, the button "List") and what closes it (Escape with the focus back to what opened it, a click beside it).
 */
import { useEffect, useId, useRef, useState } from 'react'

import { isListPath } from '../notes/workspace'

type Opened = { trigger: HTMLElement | null; focus: boolean }

export type ListDrawerState = {
  open: boolean
  id: string
  /** Opened by the button "List": the focus goes into the drawer. */
  focusInside: boolean
  toggle: (button: HTMLElement) => void
  /** `back`: the focus returns to what opened it (Escape). */
  close: (back: boolean) => void
}

/** A place of the sidebar that chooses a list: a link to one (all notes, the inbox, a tag, a smart folder, the
 * search), or a folder of the tree. */
function sidebarListPlace(target: EventTarget | null): HTMLElement | null {
  const element = target as Element | null
  const folder = element?.closest?.('nav [role="treeitem"][data-folder]') as HTMLElement | null
  if (folder) return folder
  const anchor = element?.closest?.('nav a[href]') as HTMLAnchorElement | null
  if (!anchor) return null
  const url = new URL(anchor.href, window.location.href)
  return url.origin === window.location.origin && isListPath(url.pathname) ? anchor : null
}

/** Places a click may land in without closing the drawer: the drawer, its button, the menus and dialogs it opens. */
const INSIDE = '[data-list-drawer], [data-list-toggle], [role="menu"], [role="dialog"], [role="alertdialog"]'

/**
 * Whether the drawer is open, for a page where it is `active` (two notes, no column) and shows the list at `listPath`.
 * Another list while it is active opens it; it closes when it is no longer active.
 */
export function useListDrawer(active: boolean, listPath: string): ListDrawerState {
  const id = useId()
  const [opened, setOpened] = useState<Opened | null>(null)
  const latest = useRef(opened)
  latest.current = opened
  // Adjusted while drawing, before anything shows: another list opens the drawer, the end of the split forgets it.
  const [was, setWas] = useState({ active, listPath })
  if (was.active !== active || was.listPath !== listPath) {
    setWas({ active, listPath })
    if (was.active !== active) setOpened(null)
    else if (active) setOpened((before) => before ?? { trigger: document.activeElement as HTMLElement | null, focus: false })
  }

  // The same list chosen again in the sidebar changes no address, and opens the drawer all the same; with the mouse,
  // or with Enter on a folder of the tree.
  useEffect(() => {
    if (!active) return
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const place = sidebarListPlace(event.target)
      if (place) setOpened((before) => before ?? { trigger: place, focus: false })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const place = sidebarListPlace(event.target)
      if (place?.getAttribute('role') === 'treeitem') setOpened((before) => before ?? { trigger: place, focus: false })
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [active])

  const open = active && opened !== null
  const close = (back: boolean) => {
    const trigger = latest.current?.trigger
    setOpened(null)
    if (back && trigger?.isConnected) trigger.focus()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest?.(INSIDE) || sidebarListPlace(target)) return
      closeRef.current(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current(true)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return {
    open,
    id,
    focusInside: Boolean(opened?.focus),
    toggle: (button) => (open ? close(false) : setOpened({ trigger: button, focus: true })),
    close,
  }
}
