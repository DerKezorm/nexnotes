import { createElement } from 'react'

import type { Folder } from './api'
import { symbolIcon } from '../lib/symbolLook'
import { colorOf } from './palette'

/** A folder's look: its symbol in its color, or a small square in its color when it has no symbol (NOTES-4 AC-10). */
export function FolderMark({ folder, size = 14 }: { folder: Pick<Folder, 'icon' | 'color'>; size?: number }) {
  const icon = symbolIcon(folder.icon)
  const color = colorOf(folder.color)
  if (icon) return createElement(icon, { 'aria-hidden': true, className: 'shrink-0', style: { width: size, height: size, color }, strokeWidth: 2 })
  const square = Math.round(size * 0.72)
  return <span aria-hidden className="shrink-0 rounded-[3px]" style={{ width: square, height: square, background: color }} />
}
