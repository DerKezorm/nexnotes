/** What the outline beside the text (NOTES-3 AC-15) reads from a note, and whether it shows on this device. */
import type { Node as PMNode } from '@tiptap/pm/model'

import { useDevicePref } from '../lib/devicePref'

/** The free width of a note's side from which the outline stands beside the text. */
export const OUTLINE_FROM = 1800

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
