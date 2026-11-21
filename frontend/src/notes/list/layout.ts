/**
 * Where everything of a list stands, before anything is drawn: headings, rows and rows of tiles, each with a fixed
 * height. With fixed heights only the part on screen needs to be in the page (EC-2, 10,000 notes), and a long title or
 * text is cut instead of stretching its row (EC-4). When the list loads anew, the note at the top of the screen keeps
 * its place (EC-6, `anchorOf` and `shiftFor`).
 */
import type { ListItem, ListMode } from './api'
import type { Section } from './order'

export const SIZES = {
  header: 38,
  row: 64,
  tile: 184,
  /** Tiles on a narrow screen (the phone). */
  smallTile: 168,
  gap: 12,
  smallGap: 10,
  /** The narrowest a tile gets: 220 px, 150 px on a phone. */
  tileMin: 220,
  smallTileMin: 150,
  /** Below this width the list is narrow (the phone, the column beside an open note). */
  narrow: 560,
} as const

export type Entry =
  | { kind: 'header'; key: string; section: Section['key']; top: number; height: number }
  | { kind: 'row'; key: string; item: ListItem; top: number; height: number }
  | { kind: 'tiles'; key: string; items: ListItem[]; top: number; height: number }

export type Layout = { entries: Entry[]; height: number; columns: number }

/** How many tiles fit side by side. */
export function tileColumns(width: number): number {
  const small = width < SIZES.narrow
  const min = small ? SIZES.smallTileMin : SIZES.tileMin
  const gap = small ? SIZES.smallGap : SIZES.gap
  return Math.max(1, Math.floor((width + gap) / (min + gap)))
}

/** The entries of a list: a heading per section (none for a list without groups), then its rows or rows of tiles. */
export function layout(sections: Section[], mode: ListMode, width: number): Layout {
  const entries: Entry[] = []
  let top = 0
  const small = width < SIZES.narrow
  const columns = mode === 'tiles' ? tileColumns(width) : 1
  const tileHeight = (small ? SIZES.smallTile : SIZES.tile) + (small ? SIZES.smallGap : SIZES.gap)
  for (const section of sections) {
    if (section.key !== 'all') {
      entries.push({ kind: 'header', key: `h:${section.key}`, section: section.key, top, height: SIZES.header })
      top += SIZES.header
    }
    // The gallery draws no rows; laid out as a list, the window is ready when switching back.
    if (mode !== 'tiles') {
      for (const item of section.items) {
        entries.push({ kind: 'row', key: item.id, item, top, height: SIZES.row })
        top += SIZES.row
      }
    } else {
      for (let start = 0; start < section.items.length; start += columns) {
        const items = section.items.slice(start, start + columns)
        entries.push({ kind: 'tiles', key: `t:${section.key}:${items[0].id}`, items, top, height: tileHeight })
        top += tileHeight
      }
    }
  }
  return { entries, height: top, columns }
}

/** The first entry whose bottom lies below `offset` (binary search over the tops). */
export function entryAt(entries: Entry[], offset: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    const entry = entries[middle]
    if (entry.top + entry.height <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** The entries to draw for the part of the list between `from` and `to` (pixels from its top), with some to spare. */
export function visibleRange(entries: Entry[], from: number, to: number, spare = 400): [number, number] {
  const start = entryAt(entries, Math.max(0, from - spare))
  let end = start
  while (end < entries.length && entries[end].top < to + spare) end++
  return [start, end]
}

/** What stands at the top of the screen: the first note there, or a heading, and how far above the top it begins. */
export type Anchor = { id: string; delta: number }

function firstId(entry: Entry): string {
  if (entry.kind === 'row') return entry.item.id
  if (entry.kind === 'tiles') return entry.items[0].id
  return entry.key
}

export function anchorOf(entries: Entry[], from: number): Anchor | null {
  if (from <= 0 || entries.length === 0) return null
  const index = entryAt(entries, from)
  const entry = entries[index]
  if (!entry) return null
  return { id: firstId(entry), delta: entry.top - from }
}

function topOf(entries: Entry[], id: string): number | null {
  for (const entry of entries) {
    if (entry.kind === 'row' && entry.item.id === id) return entry.top
    if (entry.kind === 'tiles' && entry.items.some((item) => item.id === id)) return entry.top
    if (entry.kind === 'header' && entry.key === id) return entry.top
  }
  return null
}

/** How far to scroll so that the anchored note stands where it stood before the list loaded anew; 0 when it is gone
 * or nothing was anchored. */
export function shiftFor(anchor: Anchor | null, entries: Entry[], from: number): number {
  if (!anchor) return 0
  const top = topOf(entries, anchor.id)
  if (top === null) return 0
  return top - anchor.delta - from
}
