/**
 * The bell in the head of a shared note (drawing "N14-Mitteilungen"): pressed while notifications are on; a tap opens
 * the panel beside it. Only on a shared note: notifications are about what others change (AC-1).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { BellIcon, NotifyPanel } from './NotifyPanel'

export function NotifyBell({ noteId, on, shared }: { noteId: string; on: boolean; shared: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(on)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => setPressed(on), [on])

  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    const outside = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', outside, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', outside, true)
    }
  }, [open])

  if (!shared) return null
  return (
    <span className="relative" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={'nn-btn nn-btn-ghost h-[34px] w-[34px] border-transparent px-0 ' + (pressed ? 'nn-bell-on' : '')}
        aria-label={t('notify.bell')}
        aria-pressed={pressed}
        aria-expanded={open}
        data-testid="notify-bell"
        onClick={() => setOpen(!open)}
      >
        <BellIcon on={pressed} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('notify.titleNote')}
          className="absolute top-[42px] right-0 z-40 w-[min(380px,calc(100vw-24px))] rounded-[14px] border border-ink-600 bg-ink-800 p-[18px] shadow-2xl shadow-black/40"
          data-testid="notify-popover"
        >
          <NotifyPanel kind="note" id={noteId} onChange={setPressed} />
        </div>
      )}
    </span>
  )
}

/** The same panel for a folder, as a dialog (from the folder's menu or the page of a folder shared with one). */
export function NotifyFolderDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog title={t('notify.dialogFolder', { name })} onClose={onClose}>
      <NotifyPanel kind="folder" id={id} />
    </Dialog>
  )
}

/** The bell on the page of a folder shared with one. */
export function FolderBell({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="nn-btn nn-btn-ghost h-8 text-[13px]" onClick={() => setOpen(true)} data-testid="notify-folder-bell">
        <BellIcon on={false} />
        {t('notify.folderButton')}
      </button>
      {open && <NotifyFolderDialog id={id} name={name} onClose={() => setOpen(false)} />}
    </>
  )
}
