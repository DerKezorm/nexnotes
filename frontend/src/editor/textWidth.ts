/**
 * How wide the text of a note runs on this device (NOTES-3 AC-14): narrow as in the drawing "N3-Editor", wide, or the
 * whole width of its side. Chosen in the toolbar, kept per device and account, the same for every note.
 */
import { useDevicePref } from '../lib/devicePref'

export const TEXT_WIDTHS = ['narrow', 'wide', 'full'] as const
export type TextWidth = (typeof TEXT_WIDTHS)[number]

/** The greatest width of the page of a note, paddings included; none for the whole width. */
export const TEXT_MAX: Record<TextWidth, number | null> = { narrow: 760, wide: 1100, full: null }

export function parseTextWidth(raw: string | null): TextWidth {
  return (TEXT_WIDTHS as readonly string[]).includes(raw ?? '') ? (raw as TextWidth) : 'narrow'
}

export function useTextWidth(): [TextWidth, (width: TextWidth) => void] {
  const [width, set] = useDevicePref('textWidth', parseTextWidth)
  return [width, (next) => set(next === 'narrow' ? null : next)]
}
