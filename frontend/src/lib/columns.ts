/**
 * How wide the sidebar and the list beside an open note are on this device (NOTES-4 AC-15, NOTES-6 AC-10):
 * dragged at their edge or moved with the arrow keys, a double click goes back to the default.
 */
import { useDevicePref } from './devicePref'

export type Column = 'sidebar' | 'list'

export const COLUMNS: Record<Column, { fallback: number; min: number; max: number }> = {
  // The drawing "Seitenleiste": 260 px. Narrower, the folder names and the account line no longer read.
  sidebar: { fallback: 260, min: 200, max: 440 },
  // The drawing "N3-Editor": 300 px. The notes beside it keep their least widths of NOTES-8 in any case: a list
  // that leaves them too little gives way, as before.
  list: { fallback: 300, min: 240, max: 560 },
}

/** One press of an arrow key on the handle. */
export const COLUMN_STEP = 16

export function clampColumn(column: Column, width: number): number {
  const { min, max } = COLUMNS[column]
  return Math.round(Math.min(max, Math.max(min, width)))
}

export function parseColumn(column: Column, raw: string | null): number {
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) ? clampColumn(column, value) : COLUMNS[column].fallback
}

/** The width of `column` and how to set it (clamped); `null` back to the default. */
export function useColumnWidth(column: Column): [number, (width: number | null) => void] {
  const [width, set] = useDevicePref(`column.${column}`, (raw) => parseColumn(column, raw))
  return [width, (next) => set(next === null ? null : String(clampColumn(column, next)))]
}
