/**
 * Sizes of the tabs and the sides (NOTES-8 AC-2, AC-8, EC-2, EC-4), and the little state the bar and the page share.
 */
import { isMac } from './desktop'

/** A tab's width while there is room. */
export const TAB_MAX = 200
/** The narrowest a tab gets before the row breaks into two: room for the color, the start of the title and the cross. */
export const TAB_MIN = 120
export const TAB_DRAG = 'application/x-nexnotes-tab'

/** The narrowest a side gets: a line of text still reads. */
export const MIN_PANE = 340
export const SEPARATOR = 12
export const LIST_WIDTH = 300
/** Beside two notes the list stays only while each of them keeps this much. */
export const ROOMY_PANE = 480

/** One row while every tab still gets `TAB_MIN`, else two. Unknown width (no layout yet) counts as wide. */
export function rowsFor(count: number, width: number, extras: number): 1 | 2 {
  if (width <= 0 || count <= 1) return 1
  return count * TAB_MIN + extras <= width ? 1 : 2
}

export function shortcutText(key: string): string {
  return isMac() ? `⌥⇧${key}` : `Alt+Shift+${key}`
}

let dragging: string | null = null

/** The tab being dragged right now, if any (for the drop on the right edge of the notes). */
export function draggedTab(): string | null {
  return dragging
}

export function setDraggedTab(key: string | null): void {
  dragging = key
}

let restored = false

/** The tabs of last time come back once per page load (AC-5); true the first time it is asked. */
export function firstVisit(): boolean {
  if (restored) return false
  restored = true
  return true
}

/** For tests: as after a fresh page load. */
export function forgetRestored(): void {
  restored = false
}
