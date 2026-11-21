/**
 * Sizes of the tabs and the sides (NOTES-8 AC-2, AC-8, EC-2, EC-4), and the little state the bar and the page share.
 */
import { isMac } from './desktop'

/** A tab's width while there is room. */
export const TAB_MAX = 200
/**
 * The least of a title a tab keeps (EC-4): 56 px are about seven letters of the tabs' 13 px Inter and the ellipsis,
 * the first word of most titles ("Einkauf…", "Monday…"), which is what tells two tabs apart; the whole title is in
 * the tooltip. Less, and tabs of notes that start alike ("Lagerliste", "Lastenrad") read the same ("La…"). More, and
 * six tabs with two of them beside each other no longer fit in two rows on an iPad held upright (484 px of bar).
 */
export const TITLE_MIN = 56
/** Everything of a tab but its title: the paddings (12 + 4), the color (8), two gaps (6 + 6), the cross (22), the
 * border (2). */
export const TAB_CHROME = 60
/** The narrowest a tab gets before the row breaks into two: the color, the start of the title and the cross. */
export const TAB_MIN = TAB_CHROME + TITLE_MIN
/** What "links"/"rechts" ("left"/"right") takes in the two tabs on show beside each other (AC-4): the longest of
 * them, "rechts" in 11 px, and its gap. A tab with it needs this much more for the same start of the title. */
export const SIDE_LABEL = 42
/** The gap between two tabs, and between the last tab and the buttons after it. */
export const TAB_GAP = 2
export const TAB_DRAG = 'application/x-nexnotes-tab'

/** The narrowest a side gets: a line of text still reads. */
export const MIN_PANE = 340
export const SEPARATOR = 12
/**
 * Beside two notes the list stands as a column while each side keeps its least width (`MIN_PANE`) and the line between
 * them; a side's outline opens as a panel over its text then. With less room the list is a drawer over the left note,
 * opened by the sidebar or the button "List" (21.11.2026).
 */
export const SPLIT_ROOM = 2 * MIN_PANE + SEPARATOR

/** How the list stands beside the open notes: a column, a drawer over the left note, or not at all (one note and too
 * little room: it gives way to the note, as before). */
export type ListStand = 'column' | 'drawer' | 'none'

/** Where the list goes beside the notes in `width` pixels of page, the list `listWidth` wide. */
export function listStand(split: boolean, width: number, listWidth: number): ListStand {
  if (!split) return width - listWidth >= MIN_PANE ? 'column' : 'none'
  return width - listWidth >= SPLIT_ROOM ? 'column' : 'drawer'
}

/** The narrowest a tab gets: `TAB_MIN`, and the side's label on top for the two on show beside each other. */
export function tabMin(labelled: boolean): number {
  return TAB_MIN + (labelled ? SIDE_LABEL : 0)
}

/** How the tabs stand: in one row or two, how many in the first, which row has the buttons (new tab, end split, the
 * count), and whether every tab keeps its least width (`tabMin`). */
export type TabRows = { rows: 1 | 2; first: number; extrasFirst: boolean; fits: boolean }

/**
 * One row while every tab still gets its least width (`mins`, from `tabMin`), else two (AC-8, EC-4). The tabs are
 * cut between the rows near the middle, where both rows hold their tabs at least width, the buttons (`extras` wide)
 * at the end of the second row or, if only that fits, of the first. When not even that fits (a window narrower than
 * nexnotes is made for), the middle, and the tabs share what there is. Unknown width (no layout yet) counts as wide.
 */
export function tabRows(mins: number[], width: number, extras: number): TabRows {
  const count = mins.length
  const need = (from: number, to: number, withExtras: boolean) =>
    mins.slice(from, to).reduce((sum, min) => sum + min, 0) + TAB_GAP * Math.max(0, to - from - 1 + (withExtras ? 1 : 0)) + (withExtras ? extras : 0)
  if (width <= 0 || count <= 1 || need(0, count, true) <= width) return { rows: 1, first: count, extrasFirst: false, fits: width <= 0 || need(0, count, true) <= width }
  const middle = Math.ceil(count / 2)
  const cuts = Array.from({ length: count - 1 }, (_, index) => index + 1).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || b - a)
  for (const first of cuts) {
    for (const extrasFirst of [false, true]) {
      if (need(0, first, extrasFirst) <= width && need(first, count, !extrasFirst) <= width) return { rows: 2, first, extrasFirst, fits: true }
    }
  }
  return { rows: 2, first: middle, extrasFirst: false, fits: false }
}

/** One row or two for `count` tabs, `labelled` of them with the side's label. */
export function rowsFor(count: number, width: number, extras: number, labelled = 0): 1 | 2 {
  const mins = Array.from({ length: count }, (_, index) => tabMin(index < labelled))
  return tabRows(mins, width, extras).rows
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
