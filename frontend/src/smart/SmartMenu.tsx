/**
 * The menu of a smart folder in the sidebar and on the phone's page "Ordner" (fifth review), as a folder's menu
 * (`folders/FolderMenu.tsx`, the same `Menu`): edit, one place up or down (the keyboard's way to the order the mouse
 * drags), delete. Deleting asks first, with the same question as the menu of its list head (AC-6: no trash, the
 * notes stay).
 */
import { ArrowDown, ArrowUp, Pencil, Trash2, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Menu, type MenuAnchor } from '../components/Menu'
import { problemText } from '../lib/errors'
import { smartApi, type SmartFolder } from './api'
import { smartName } from './conditions'
import { FolderMark } from '../folders/FolderMark'
import { refreshSmartFolders } from './store'

export type SmartAction = 'edit' | 'up' | 'down' | 'delete'

/** The symbol a smart folder falls back to without one of its own. */
const SMART_SYMBOL = 'filter'

/** A smart folder's look: its symbol in its color, as a folder's (`FolderMark`), the filter when it has none. */
export function SmartMark({ folder, size = 14 }: { folder: Pick<SmartFolder, 'icon' | 'color'>; size?: number }) {
  return <FolderMark folder={{ icon: folder.icon ?? SMART_SYMBOL, color: folder.color ?? '' }} size={size} fallback={SMART_SYMBOL} />
}

type Entry = { key: SmartAction; icon: LucideIcon; text: string; danger?: boolean }

const ENTRIES: Entry[] = [
  { key: 'edit', icon: Pencil, text: 'smart.edit' },
  { key: 'up', icon: ArrowUp, text: 'smart.moveUp' },
  { key: 'down', icon: ArrowDown, text: 'smart.moveDown' },
  { key: 'delete', icon: Trash2, text: 'smart.delete', danger: true },
]

export function SmartMenu({
  folder,
  anchor,
  first,
  last,
  onAction,
  onClose,
}: {
  folder: SmartFolder
  /** The element it opens beside; focus goes back there. */
  anchor: MenuAnchor
  /** At the top or the bottom of the list: that way it cannot move. */
  first: boolean
  last: boolean
  onAction: (action: SmartAction) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const name = smartName(folder, t)
  return (
    <Menu anchor={anchor} onClose={onClose} label={t('smart.menu', { name })} align="start" width={220} testId="smart-folder-menu">
      {ENTRIES.map((entry) => {
        const Icon = entry.icon
        const off = (entry.key === 'up' && first) || (entry.key === 'down' && last)
        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            aria-disabled={off || undefined}
            data-testid={`smart-folder-menu-${entry.key}`}
            onClick={() => {
              if (off) return
              onClose()
              onAction(entry.key)
            }}
            className={'nn-menu-item ' + (off ? 'cursor-not-allowed opacity-50 not-disabled:hover:bg-transparent' : entry.danger ? 'text-bad-500 not-disabled:hover:text-bad-500' : '')}
          >
            <Icon aria-hidden className="h-4 w-4" strokeWidth={1.8} />
            {t(entry.text)}
          </button>
        )
      })}
    </Menu>
  )
}

/** "Delete …?" (AC-6): only the smart folder goes, without the trash; the notes stay where they are. */
export function SmartDeleteDialog({ folder, onClose, onDeleted }: { folder: SmartFolder; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const name = smartName(folder, t)
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await smartApi.remove(folder.id)
      await refreshSmartFolders()
      onDeleted()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('smart.deleteTitle', { name })} onClose={onClose}>
      <div className="space-y-3" data-testid="smart-delete">
        <p className="text-[13px] leading-normal text-mist-400">{t('smart.deleteSays')}</p>
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-danger" onClick={() => void remove()} disabled={busy} data-testid="smart-delete-confirm">
            {t('smart.delete')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
