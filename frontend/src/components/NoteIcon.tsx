/**
 * The symbol of a note before its title (NOTES-3 AC-18): in the note's color (NOTES-6 AC-8) when it has one, else in
 * the color of the text around it. Nothing for a note without a symbol.
 */
import { createElement } from 'react'

import { colorOf } from '../folders/palette'
import { symbolIcon } from '../lib/symbolLook'

export function NoteIcon({ icon, color, size = 15, className = '' }: { icon?: string | null; color?: string | null; size?: number; className?: string }) {
  const Drawing = symbolIcon(icon)
  if (!Drawing) return null
  return (
    <span aria-hidden className={'inline-flex shrink-0 ' + className} data-testid="note-icon" data-icon={icon ?? ''}>
      {createElement(Drawing, { style: { width: size, height: size, color: color ? colorOf(color) : 'currentColor' }, strokeWidth: 2 })}
    </span>
  )
}
