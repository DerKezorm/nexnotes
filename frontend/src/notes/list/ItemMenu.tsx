/**
 * The menu of a note in a list (right click, or its "…" button): pin or unpin (AC-6), and its color from the fixed row
 * of the folders' twelve colors, or none (AC-8).
 */
import { Pin, PinOff } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(point)

  // Inside the window, also near its right and bottom edge.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPlace({
      x: Math.max(8, Math.min(point.x - (point.x + width > window.innerWidth - 8 ? width : 0), window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - height - 8)),
    })
  }, [point])

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const title = item.title || t('notes.untitled')
  const current = item.color ?? ''
  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('noteList.menu.label', { title })}
      className="nn-menu fixed w-[248px]"
      style={{ left: place.x, top: place.y }}
      data-testid="note-item-menu"
    >
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
    </div>
  )
}
