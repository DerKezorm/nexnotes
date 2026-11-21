/**
 * The menu of a folder (NOTES-4 AC-12): new subfolder, rename, symbol and color, move, share, export, trash. Sharing
 * and export come with their own features (NOTES-13, NOTES-17); until then they stand there greyed with a note.
 *
 * Over everything (a portal on `body`, the sidebar would cut it off), next to the button or row that opened it. Arrow
 * keys go through the entries, Escape and a click outside close it, focus returns where it came from (EC-11).
 */
import { FolderInput, FolderPlus, Palette, Pencil, Share2, Trash2, Upload, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { Folder } from './api'

export type MenuAction = 'newSubfolder' | 'rename' | 'style' | 'move' | 'trash'

type Entry = { key: MenuAction | 'share' | 'export'; icon: LucideIcon; later?: string; danger?: boolean }

const ENTRIES: Entry[] = [
  { key: 'newSubfolder', icon: FolderPlus },
  { key: 'rename', icon: Pencil },
  { key: 'style', icon: Palette },
  { key: 'move', icon: FolderInput },
  { key: 'share', icon: Share2, later: 'folders.menu.shareLater' },
  { key: 'export', icon: Upload, later: 'folders.menu.exportLater' },
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
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect()
    const height = panel.current?.offsetHeight ?? 300
    const left = Math.max(8, Math.min(box.right + 4, window.innerWidth - WIDTH - 8))
    const top = Math.max(8, Math.min(box.top, window.innerHeight - height - 8))
    setPlace({ left: box.right + 4 + WIDTH > window.innerWidth ? Math.max(8, box.left) : left, top })
  }, [anchor])

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [onClose])

  const close = () => {
    onClose()
    anchor.focus()
  }

  const keys = (event: React.KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => items[(index + items.length) % items.length]?.focus()
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(items.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') close()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={t('folders.menu.label', { name: folder.name })}
      data-testid="folder-menu"
      onKeyDown={keys}
      className="nn-menu fixed"
      style={{ left: place.left, top: place.top, width: WIDTH }}
    >
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
    </div>,
    document.body,
  )
}
