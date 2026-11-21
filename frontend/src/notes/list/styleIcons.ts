/** The sign of each look of a list, the same in the menu "Ansicht" and under Einstellungen › Darstellung. */
import { AlignJustify, GalleryVerticalEnd, LayoutGrid, LayoutList, type LucideIcon } from 'lucide-react'

import type { ListStyle } from './api'

export const STYLE_ICONS: Record<ListStyle, LucideIcon> = {
  list: LayoutList,
  cards: GalleryVerticalEnd,
  compact: AlignJustify,
  tiles: LayoutGrid,
}
