/**
 * The mark of an area or a list of nextasks in "Bereiche und Listen": its symbol in its colour as nextasks stores them
 * (as nextime draws it), a line drawing without a tile. The names are nextasks' own (`lib/symbols.ts` holds the same
 * list); an unknown name draws a list, none the symbol of tasks. An own colour `#rrggbb` is held readable in both looks.
 */
import { List, ListChecks, type LucideIcon } from 'lucide-react'
import { createElement } from 'react'

import { hexOf, readableColor } from '../lib/color'
import { SYMBOLS } from '../lib/symbols'

const BY_NAME = new Map(SYMBOLS.map((entry) => [entry.name, entry.icon]))

/** nextasks' own list colours, by the names of its data model. */
const HEX: Record<string, string> = {
  red: '#d9534f',
  orange: '#dd7a2e',
  yellow: '#d39b12',
  green: '#4f9e3f',
  teal: '#22a08a',
  blue: '#3a84d0',
  indigo: '#5b68cc',
  purple: '#8a59c0',
  pink: '#d65a7c',
  brown: '#9a7550',
  gray: '#7a8890',
}

function symbolOf(name: string | undefined): LucideIcon {
  if (!name) return ListChecks
  return BY_NAME.get(name) ?? List
}

function colorOf(name: string | undefined): string | null {
  if (!name) return null
  const own = name.startsWith('#') ? hexOf(name) : null
  if (own) return readableColor(own)
  return HEX[name] ?? HEX.blue
}

export function AreaMark({ area, size = 14 }: { area: { icon?: string; color?: string }; size?: number }) {
  const color = colorOf(area.color)
  return createElement(symbolOf(area.icon), {
    'aria-hidden': true,
    className: 'shrink-0 ' + (color ? '' : 'text-mist-400'),
    style: { width: size + 2, height: size + 2, color: color ?? undefined },
    strokeWidth: 2.2,
    'data-testid': 'area-mark',
    'data-symbol': area.icon || undefined,
    'data-color': area.color || undefined,
  } as Parameters<typeof createElement>[1])
}
