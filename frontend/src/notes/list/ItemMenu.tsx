/**
 * The menu of a note in a list (right click, or its "…" button): pin or unpin (AC-6), open it in a new tab or beside
 * the open note (NOTES-8), and its color from the fixed row of the folders' twelve colors, or none (AC-8).
 */
import { Pin, PinOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../../components/Menu'
import { TabMenuItems } from '../../tabs/TabMenuItems'
import type { ListItem } from './api'
import { ColorSwatches } from './EditorMarks'

type Props = {
  item: ListItem
  point: { x: number; y: number }
  onPin: (pinned: boolean) => void
  onColor: (color: string) => void
  onClose: () => void
}

export function ItemMenu({ item, point, onPin, onColor, onClose }: Props) {
  const { t } = useTranslation()
  const title = item.title || t('notes.untitled')
  const current = item.color ?? ''
  return (
    <Menu anchor={point} onClose={onClose} label={t('noteList.menu.label', { title })} align="start" width={248} testId="note-item-menu">
      <button
        type="button"
        role="menuitem"
        className="nn-menu-item"
        onClick={() => {
          onPin(!item.pinned)
          onClose()
        }}
      >
        {item.pinned ? <PinOff aria-hidden className="h-4 w-4" /> : <Pin aria-hidden className="h-4 w-4" />}
        {item.pinned ? t('noteList.menu.unpin') : t('noteList.menu.pin')}
      </button>
      <TabMenuItems noteId={item.id} onDone={onClose} />
      <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('noteList.menu.color')}</p>
      <div className="px-2.5 pb-2">
        <ColorSwatches
          current={current}
          onChoose={(value) => {
            onColor(value)
            onClose()
          }}
        />
      </div>
    </Menu>
  )
}
