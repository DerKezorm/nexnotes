/**
 * The twelve colors a folder can carry (NOTES-4 AC-10); its symbols are those of `lib/symbols.ts`. The server knows the
 * same keys (`FOLDER_COLORS` in `backend/app/services/folders.py`); a test there reads this file and compares.
 */
export type FolderColor = { key: string; hex: string }

export const FOLDER_COLORS: FolderColor[] = [
  { key: 'honey', hex: '#f2c14e' },
  { key: 'orange', hex: '#fb923c' },
  { key: 'red', hex: '#fb7185' },
  { key: 'berry', hex: '#e36fd8' },
  { key: 'violet', hex: '#a78bfa' },
  { key: 'blue', hex: '#60a5fa' },
  { key: 'sky', hex: '#38bdf8' },
  { key: 'teal', hex: '#2dd4bf' },
  { key: 'green', hex: '#4ade80' },
  { key: 'lime', hex: '#a3e635' },
  { key: 'gray', hex: '#9a9aa8' },
  { key: 'silver', hex: '#d4d4d8' },
]

const HEX = new Map(FOLDER_COLORS.map((color) => [color.key, color.hex]))

/** The color of a folder as CSS; a folder without one in the dimmed text color. */
export function colorOf(key: string): string {
  return HEX.get(key) ?? 'var(--color-mist-500)'
}
