/**
 * Pinning and the color from inside an open note (drawing N3-Editor: the pin beside "…"; NOTES-6 AC-6, AC-8). The
 * note's head (`GET /api/notes/<id>`) says whether it is pinned and which color it has; a change goes to the server and
 * every open list loads anew.
 */
import { Check, Pin, PinOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { showNotice } from '../../folders/notice'
import { FOLDER_COLORS } from '../../folders/palette'
import { problemText } from '../../lib/errors'
import { notesChanged } from '../api'
import { listApi } from './api'

/** The note's head: `GET /api/notes/<id>` carries `pinned` and `color` since NOTES-6. */
type Marks = { pinned?: boolean; color?: string }
type Head = object | null

export function NotePinButton({ noteId, head, disabled }: { noteId: string; head: Head; disabled?: boolean }) {
  const { t } = useTranslation()
  const [pinned, setPinned] = useState<boolean | null>(null)
  const shown = pinned ?? Boolean((head as Marks | null)?.pinned)
  const label = shown ? t('noteList.editorUnpin') : t('noteList.editorPin')
  return (
    <button
      type="button"
      className={'nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0 ' + (shown ? 'not-disabled:text-accent-400' : '')}
      aria-label={label}
      aria-pressed={shown}
      title={label}
      disabled={disabled || !head}
      data-testid="note-pin"
      onClick={() => {
        const next = !shown
        setPinned(next)
        listApi
          .pin(noteId, next)
          .then(() => notesChanged())
          .catch((error) => {
            setPinned(!next)
            showNotice({ text: problemText(error) })
          })
      }}
    >
      {shown ? <PinOff aria-hidden className="h-4 w-4" /> : <Pin aria-hidden className="h-4 w-4" />}
    </button>
  )
}

/** The color row of the note's menu: none, or one of the folders' twelve colors. */
export function NoteColorRow({ noteId, head, onDone }: { noteId: string; head: Head; onDone: () => void }) {
  const { t } = useTranslation()
  const [color, setColor] = useState<string | null>(null)
  const current = color ?? (head as Marks | null)?.color ?? ''
  const choose = (value: string) => {
    const before = current
    setColor(value)
    onDone()
    listApi
      .color(noteId, value)
      .then(() => notesChanged())
      .catch((error) => {
        setColor(before)
        showNotice({ text: problemText(error) })
      })
  }
  return (
    <div className="px-2.5 pt-1.5 pb-2" data-testid="note-colors">
      <p className="pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('noteList.menu.color')}</p>
      <ColorSwatches current={current} onChoose={choose} />
    </div>
  )
}

/** None, or one of the folders' twelve colors (the fixed row of NOTES-6 AC-8). Each circle is 24 px inside its button;
 * on a phone or a narrow window a button is 44 px to tap (`styles/index.css`), so the row wraps instead of running out
 * of the menu, which never scrolls sideways. */
export function ColorSwatches({ current, onChoose }: { current: string; onChoose: (color: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('noteList.menu.color')} data-testid="color-swatches">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === ''}
        aria-label={t('noteList.menu.noColor')}
        title={t('noteList.menu.noColor')}
        className="flex h-6 w-6 items-center justify-center rounded-full"
        onClick={() => onChoose('')}
      >
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full border border-edge text-mist-500">
          {current === '' ? <Check aria-hidden className="h-3.5 w-3.5" /> : <span aria-hidden className="h-px w-3 rotate-45 bg-mist-500" />}
        </span>
      </button>
      {FOLDER_COLORS.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="menuitemradio"
          aria-checked={current === entry.key}
          aria-label={t(`folders.colors.${entry.key}`)}
          title={t(`folders.colors.${entry.key}`)}
          className="flex h-6 w-6 items-center justify-center rounded-full"
          onClick={() => onChoose(entry.key)}
        >
          <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: entry.hex }} data-swatch={entry.key}>
            {current === entry.key && <Check aria-hidden className="h-3.5 w-3.5 text-on-accent" strokeWidth={3} />}
          </span>
        </button>
      ))}
    </div>
  )
}
