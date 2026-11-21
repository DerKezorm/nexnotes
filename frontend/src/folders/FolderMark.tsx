import { createElement } from 'react'

import type { Folder } from './api'
import { symbolIcon } from '../lib/symbolLook'
import { colorOf } from './palette'

/** A folder's look: its symbol in its color; without a symbol of its own the folder symbol, so every folder reads as
 *  one (NOTES-4 AC-10, review of 21.11.2026). A smart folder shows its look the same way, with the filter as the
 *  symbol it falls back to (`fallback`). */
export function FolderMark({ folder, size = 14, fallback = DEFAULT_SYMBOL }: { folder: Pick<Folder, 'icon' | 'color'>; size?: number; fallback?: string }) {
  const icon = symbolIcon(folder.icon) ?? symbolIcon(fallback)
  const color = colorOf(folder.color)
  const props = { 'aria-hidden': true, className: 'shrink-0', style: { width: size, height: size, color }, strokeWidth: 2, 'data-symbol': symbolIcon(folder.icon) ? folder.icon : fallback }
  return createElement(icon!, props as Parameters<typeof createElement>[1])
}

/** What a folder without a symbol of its own shows. */
export const DEFAULT_SYMBOL = 'folder'
