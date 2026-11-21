/**
 * The menu of a folder (NOTES-4 AC-12): new subfolder, rename, symbol and color, move, share, export, trash. Sharing
 * comes with its own feature (NOTES-13); until then it stands there greyed with a note. Export opens the dialog of
 * NOTES-17 with this folder.
 *
 * Over everything (a portal on `body`, the sidebar would cut it off), next to the button or row that opened it. Arrow
 * keys go through the entries, Escape and a click outside close it, focus returns where it came from (EC-11).
 */
import { FolderInput, FolderPlus, Palette, Pencil, Share2, Trash2, Upload, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../components/Menu'
import type { Folder } from './api'

export type MenuAction = 'newSubfolder' | 'rename' | 'style' | 'move' | 'export' | 'trash'

type Entry = { key: MenuAction | 'share' | 'export'; icon: LucideIcon; later?: string; danger?: boolean }

const ENTRIES: Entry[] = [
  { key: 'newSubfolder', icon: FolderPlus },
  { key: 'rename', icon: Pencil },
  { key: 'style', icon: Palette },
  { key: 'move', icon: FolderInput },
  { key: 'share', icon: Share2, later: 'folders.menu.shareLater' },
  { key: 'export', icon: Upload },
  { key: 'trash', icon: Trash2, danger: true },
]

const WIDTH = 236

export function FolderMenu({
  folder,
  anchor,
  onAction,
  onClose,
}: {
  folder: Folder
  /** The element it opens beside; focus goes back there. */
  anchor: HTMLElement
  onAction: (action: MenuAction) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Menu anchor={anchor} onClose={onClose} label={t('folders.menu.label', { name: folder.name })} align="start" width={WIDTH} testId="folder-menu">
      {ENTRIES.map((entry) => {
        const Icon = entry.icon
        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            aria-disabled={entry.later ? true : undefined}
            title={entry.later ? t(entry.later) : undefined}
            onClick={() => {
              if (entry.later) return
              onClose()
              onAction(entry.key as MenuAction)
            }}
            className={
              'nn-menu-item justify-between ' +
              (entry.later ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : entry.danger ? 'text-bad-500 hover:text-bad-500' : '')
            }
          >
            <span className="flex items-center gap-2.5">
              <Icon aria-hidden className="h-4 w-4" strokeWidth={1.8} />
              {t(`folders.menu.${entry.key}`)}
            </span>
            {entry.later && <span className="text-[11px] text-mist-500">{t(entry.later)}</span>}
          </button>
        )
      })}
    </Menu>
  )
}
