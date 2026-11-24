/**
 * The menu of a note in a list (right click, or its "…" button, in every look of the list): pin or unpin (AC-6), open
 * it in a new tab or beside the open note (NOTES-8), then the entries of the note's own menu as an open note has them
 * (`useNoteMenu`: Teilen …, Duplizieren, Exportieren …, Sperren, Als nextasks-Aufgabe, Verlauf, Löschen, the paper),
 * shown once the note's head is there, and its color from the fixed row of the folders' twelve colors, or none (AC-8).
 * A dialog opened from it stays after the menu has closed.
 */
import { Pin, PinOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../../components/Menu'
import { useNoteMenu } from '../../editor/NoteMenu'
import { showNotice } from '../../folders/notice'
import { useAccountId } from '../../state/auth'
import { TabMenuItems } from '../../tabs/TabMenuItems'
import { notesApi, type NoteHead } from '../api'
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
  const myId = useAccountId() ?? 0
  const [head, setHead] = useState<NoteHead | null>(null)
  const [shown, setShown] = useState(true)
  const noteMenu = useNoteMenu({
    noteId: item.id,
    head,
    // A locked note in the list is what an open note is from the vault: nothing of its text goes anywhere.
    sealed: Boolean(head?.locked ?? item.locked),
    myId,
    onHead: setHead,
    onProblem: (text) => showNotice({ text }),
  })
  const title = item.title || t('notes.untitled')
  const current = item.color ?? ''

  useEffect(() => {
    let alive = true
    notesApi.get(item.id).then(
      (found) => {
        if (alive) setHead(found)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [item.id])

  // Gone once neither the menu nor a dialog of it is open.
  const { dialogOpen } = noteMenu
  useEffect(() => {
    if (!shown && !dialogOpen) onClose()
  }, [shown, dialogOpen, onClose])
  const close = () => setShown(false)

  return (
    <>
      {shown && (
        <Menu anchor={point} onClose={close} label={t('noteList.menu.label', { title })} align="start" width={248} testId="note-item-menu">
          <button
            type="button"
            role="menuitem"
            className="nn-menu-item"
            onClick={() => {
              onPin(!item.pinned)
              close()
            }}
          >
            {item.pinned ? <PinOff aria-hidden className="h-4 w-4" /> : <Pin aria-hidden className="h-4 w-4" />}
            {item.pinned ? t('noteList.menu.unpin') : t('noteList.menu.pin')}
          </button>
          <TabMenuItems noteId={item.id} onDone={close} />
          {head && (
            <div className="border-t border-ink-700 pt-1" data-testid="note-item-note-entries">
              {noteMenu.entries(close, { color: false })}
            </div>
          )}
          <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('noteList.menu.color')}</p>
          <div className="px-2.5 pb-2">
            <ColorSwatches
              current={current}
              onChoose={(value) => {
                onColor(value)
                close()
              }}
            />
          </div>
        </Menu>
      )}
      {noteMenu.dialogs}
    </>
  )
}
