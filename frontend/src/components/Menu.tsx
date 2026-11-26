/**
 * The one menu of the app: over everything (a portal on `body`, so no box with a scroll bar cuts it off or grows one),
 * fixed beside the button or the point that opened it, upward when there is no room below, always inside the window.
 * The arrow keys go through the entries, Home and End to the first and last, Escape and Tab close it and give the
 * focus back to the button, a click outside closes it. Scrolling, a new window size or the menu growing (entries that
 * come a moment later, as a note's own in the list) moves it along. A menu that hangs off another element (the
 * selection bar's) takes the same place through `usePlaceInside`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type MenuAnchor = HTMLElement | { x: number; y: number }

const GAP = 4
const EDGE = 8

/** Where a menu of `size` stands for `anchor` in a window of `view`: below (or above), at the start or end. */
// eslint-disable-next-line react-refresh/only-export-components
export function menuPlace(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  align: 'start' | 'end',
): { left: number; top: number; up: boolean } {
  let left = align === 'end' ? anchor.right - size.width : anchor.left
  left = Math.max(EDGE, Math.min(left, view.width - size.width - EDGE))
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - size.height
  const up = below + size.height > view.height - EDGE && above >= EDGE
  const top = up ? above : Math.max(EDGE, Math.min(below, view.height - size.height - EDGE))
  return { left, top, up }
}

/** Calls `measure` again whenever `element` changes its size or its content (where the browser can tell). */
function useFollowSize(element: RefObject<HTMLElement | null>, measure: () => void, active: unknown): void {
  useEffect(() => {
    const target = element.current
    if (!target || !active) return
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    sized?.observe(target)
    const changed = new MutationObserver(() => measure())
    changed.observe(target, { childList: true, subtree: true })
    return () => {
      sized?.disconnect()
      changed.disconnect()
    }
  }, [element, measure, active])
}

/**
 * The place of a menu that stands in its parent (`position: absolute`, as the selection bar's): the same rule as the
 * menus over everything (`menuPlace`: beside the parent, upward without room below, inside the window), as `left` and
 * `top` within the parent. Hidden until measured.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePlaceInside(panel: RefObject<HTMLElement | null>, open: unknown, align: 'start' | 'end' = 'start'): { style: CSSProperties; up: boolean } {
  const [place, setPlace] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const measure = useCallback(() => {
    const element = panel.current
    const parent = element?.offsetParent
    if (!element || !(parent instanceof HTMLElement)) return
    const box = parent.getBoundingClientRect()
    const at = menuPlace(box, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align)
    const next = { left: at.left - box.left, top: at.top - box.top, up: at.up }
    setPlace((before) => (before && before.left === next.left && before.top === next.top && before.up === next.up ? before : next))
  }, [panel, align])
  useLayoutEffect(() => {
    if (open) measure()
    else setPlace(null)
  }, [open, measure])
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, measure])
  useFollowSize(panel, measure, open)
  return {
    style: place ? { left: place.left, top: place.top } : { left: 0, top: '100%', visibility: 'hidden' },
    up: place?.up ?? false,
  }
}

export function Menu({
  anchor,
  onClose,
  label,
  children,
  align = 'end',
  width,
  className = '',
  testId,
}: {
  anchor: MenuAnchor
  onClose: () => void
  label: string
  children: ReactNode
  align?: 'start' | 'end'
  width?: number
  className?: string
  testId?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  const measure = useCallback(() => {
    const element = panel.current
    if (!element) return
    const box =
      anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y - GAP }
    setPlace(menuPlace(box, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align))
  }, [anchor, align])

  useLayoutEffect(measure, [measure])
  // Entries that come later (a note's own in the list) make it taller: placed again, never off the screen.
  useFollowSize(panel, measure, true)

  // The first entry takes the focus once the menu stands where it belongs (a hidden one cannot).
  const placed = place !== null
  useEffect(() => {
    if (placed) panel.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [placed])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target)) return
      // The button that opened it toggles it itself.
      if (anchor instanceof HTMLElement && anchor.contains(target)) return
      close.current()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchor, measure])

  const keys = (event: React.KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => items[(index + items.length) % items.length]?.focus()
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(items.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') {
      close.current()
      if (anchor instanceof HTMLElement) anchor.focus()
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      data-testid={testId}
      data-up={place?.up || undefined}
      onKeyDown={keys}
      className={'nn-menu fixed z-[60] max-h-[calc(100dvh-16px)] overflow-y-auto ' + className}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, width, visibility: place ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
