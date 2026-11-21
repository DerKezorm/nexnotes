import { createElement } from 'react'

import type { Folder } from './api'
import { symbolIcon } from '../lib/symbolLook'
import { colorOf } from './palette'

/** A folder's look: its symbol in its color; without a symbol of its own the folder symbol, so every folder reads as
 *  one (NOTES-4 AC-10, review of 21.11.2026). */
export function FolderMark({ folder, size = 14 }: { folder: Pick<Folder, 'icon' | 'color'>; size?: number }) {
  const icon = symbolIcon(folder.icon) ?? symbolIcon(DEFAULT_SYMBOL)
  const color = colorOf(folder.color)
  const props = { 'aria-hidden': true, className: 'shrink-0', style: { width: size, height: size, color }, strokeWidth: 2, 'data-symbol': folder.icon || DEFAULT_SYMBOL }
  return createElement(icon!, props as Parameters<typeof createElement>[1])
}

/** What a folder without a symbol of its own shows. */
export const DEFAULT_SYMBOL = 'folder'
