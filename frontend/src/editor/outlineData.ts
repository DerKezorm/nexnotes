/** What the outline beside the text (NOTES-3 AC-15) reads from a note, and whether it shows on this device. */
import type { Node as PMNode } from '@tiptap/pm/model'
import { createContext } from 'react'

import { useDevicePref } from '../lib/devicePref'

/** The narrowest the sheet gets so that the outline can stand beside it as a column (third review). */
export const TEXT_MIN = 560
/** The outline's column. */
export const OUTLINE_WIDTH = 240
/** What stands around them on a side: the gap between sheet and column and the side's padding (`md:gap-6`,
 * `md:px-6`). */
const AROUND = 24 + 2 * 24
/** The free width of a note's side from which the outline stands beside the text as a column: the sheet at its
 * narrowest, the column and the room around them. Below it the outline opens as a panel over the text's right edge. */
export const OUTLINE_COLUMN_FROM = TEXT_MIN + OUTLINE_WIDTH + AROUND

/** Whether a side of `width` free pixels holds the outline as a column beside the text. */
export function outlineFits(width: number): boolean {
  return width >= OUTLINE_COLUMN_FROM
}

/** The outline button of a note's toolbar, as the note's side sets it: `shown` says the outline is on the screen
 * (as a column or as a panel), never only allowed; `id` names the button so the panel knows it. */
export type OutlineToggle = { id: string; shown: boolean; toggle: () => void }
export const OutlineToggleContext = createContext<OutlineToggle | null>(null)

export type Heading = { pos: number; level: number; text: string; collapsed: boolean }

export function headingsOf(doc: PMNode): Heading[] {
  const out: Heading[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ pos, level: Number(node.attrs.level) || 1, text: node.textContent.trim(), collapsed: Boolean(node.attrs.collapsed) })
      return false
    }
    return node.type.name === 'doc'
  })
  return out
}

/** Whether the outline shows, on this device: on unless turned off. */
export function useOutlineShown(): [boolean, (on: boolean) => void] {
  const [shown, set] = useDevicePref('outline', (raw) => raw !== 'off')
  return [shown, (on) => set(on ? null : 'off')]
}
