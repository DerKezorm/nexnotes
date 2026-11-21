/**
 * The twelve colors and the fixed row of symbols a folder can carry (NOTES-4 AC-10). The server knows the same keys
 * (`FOLDER_COLORS`, `FOLDER_ICONS` in `backend/app/services/folders.py`); a test there reads this file and compares.
 */
import {
  Baby,
  BookOpen,
  Briefcase,
  Calendar,
  Camera,
  Car,
  ChefHat,
  Code,
  Dumbbell,
  Folder,
  Gift,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Lightbulb,
  Music,
  Palette,
  PawPrint,
  Plane,
  Receipt,
  ShoppingCart,
  Star,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

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

export const FOLDER_ICONS: [string, LucideIcon][] = [
  ['folder', Folder],
  ['briefcase', Briefcase],
  ['house', House],
  ['heart', Heart],
  ['star', Star],
  ['chef-hat', ChefHat],
  ['book', BookOpen],
  ['receipt', Receipt],
  ['plane', Plane],
  ['car', Car],
  ['music', Music],
  ['camera', Camera],
  ['gift', Gift],
  ['graduation-cap', GraduationCap],
  ['leaf', Leaf],
  ['wrench', Wrench],
  ['baby', Baby],
  ['dumbbell', Dumbbell],
  ['shopping-cart', ShoppingCart],
  ['lightbulb', Lightbulb],
  ['code', Code],
  ['palette', Palette],
  ['paw-print', PawPrint],
  ['calendar', Calendar],
]

const HEX = new Map(FOLDER_COLORS.map((color) => [color.key, color.hex]))
const ICON = new Map(FOLDER_ICONS)

/** The color of a folder as CSS; a folder without one in the dimmed text color. */
export function colorOf(key: string): string {
  return HEX.get(key) ?? 'var(--color-mist-500)'
}

export function iconOf(key: string): LucideIcon | null {
  return ICON.get(key) ?? null
}
