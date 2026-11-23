/**
 * What every way of drawing a note in a list shares (rows, cards, compact rows, tiles): the outer box that is dragged
 * into folders and tabs and opens the menu on a right click, the "…" button, and the marks beside the title (pinned,
 * locked, "Titel prüfen", shared, a scan). The note itself is always a link (`noteHref`), so a middle click, Ctrl
 * click and Alt click on it open it in a new tab or beside the open note like every note link (`tabs/links.ts`).
 */
import { Image, Lock, MoreHorizontal, PenLine, Pin, ScanText, Users, Video, type LucideIcon } from 'lucide-react'
import type { DragEvent, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ListItem, ListMedia } from './api'
import type { HintKinds } from './hintKinds'
import { mediaText, sharedText } from './marks'

/** "All notes": the folder a note lies in, with its color (a stripe). Without a color only the words: where a note of
 * the inbox came from. */
export type RowFolder = { name: string; color?: string }

/** A button a list gives each of its notes besides the "…" (the inbox: "Einsortieren", "Titel ok"). A row shows it
 * with its words, the other looks as its sign with the words as label and tooltip. */
export type ItemAction = { key: string; label: string; icon: LucideIcon; onAct: (item: ListItem) => void; testId?: string }

/** What a list adds to the notes it shows (the inbox, the page of a tag): the sign before the title of a note without
 * a symbol of its own, the place shown instead of its folder, buttons. */
export type ItemDecor = { mark?: ReactNode; folder?: RowFolder | null; actions?: ItemAction[] }

/** What a list hands each of its notes, whatever the look. */
export type ItemProps = {
  item: ListItem
  href: string
  /** The open note. */
  chosen?: boolean
  /** The date shown (formatted); by default nothing. */
  date?: string
  /** "All notes": the note's folder and a stripe in its color. */
  folder?: RowFolder | null
  /** The hints shown, each kind on or off (checklists, attachments, tags); `true` all, left out none. */
  hints?: HintKinds | boolean
  /** The first of its group: no line above it. */
  first?: boolean
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void
  /** Opens the note's menu (pin, color, tabs) at a point of the screen. */
  onMenu?: (item: ListItem, point: { x: number; y: number }) => void
  onDragStart?: (event: DragEvent) => void
  onDragEnd?: () => void
  /** The sign before the title when the note has no symbol (the inbox: where it came from). */
  mark?: ReactNode
  /** Buttons besides the "…". */
  actions?: ItemAction[]
}

/** The outer box of a note: dragged as a whole, the right click opens its menu. */
// eslint-disable-next-line react-refresh/only-export-components
export function boxProps({ item, onMenu, onDragStart, onDragEnd }: ItemProps): HTMLAttributes<HTMLDivElement> & { draggable: boolean; 'data-note': string } {
  return {
    draggable: Boolean(onDragStart),
    onDragStart,
    onDragEnd,
    onContextMenu: onMenu
      ? (event) => {
          event.preventDefault()
          onMenu(item, { x: event.clientX, y: event.clientY })
        }
      : undefined,
    'data-note': item.id,
  }
}

/** The "…" of a note: shown on hover and in focus, always on a touch screen (`list.css`). */
export function MoreButton({ item, onMenu, className = '' }: { item: ListItem; onMenu?: ItemProps['onMenu']; className?: string }) {
  const { t } = useTranslation()
  if (!onMenu) return null
  const title = item.title || t('notes.untitled')
  return (
    <button
      type="button"
      aria-label={t('noteList.menu.label', { title })}
      className={'nn-row-more flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mist-500 hover:bg-ink-700 hover:text-mist-100 ' + className}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        onMenu(item, { x: box.right, y: box.bottom })
      }}
    >
      <MoreHorizontal aria-hidden className="h-4 w-4" />
    </button>
  )
}

/** The list's own buttons of a note: with words in a row, as signs in the other looks. */
export function ItemActions({ item, actions, small = false }: { item: ListItem; actions?: ItemAction[]; small?: boolean }) {
  if (!actions?.length) return null
  return (
    <>
      {actions.map(({ key, label, icon: Icon, onAct, testId }) => (
        <button
          key={key}
          type="button"
          aria-label={small ? label : undefined}
          title={small ? label : undefined}
          data-testid={testId}
          onClick={() => onAct(item)}
          className={
            'flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-mist-400 hover:bg-ink-700 hover:text-mist-100 ' +
            (small ? 'h-7 w-7' : 'h-8 border border-ink-700 px-2.5 text-[12.5px] font-medium')
          }
        >
          <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2.1} />
          {!small && label}
        </button>
      ))}
    </>
  )
}

export function MediaIcon({ media, className }: { media: ListMedia; className?: string }) {
  const Icon = media.kind === 'scan' ? ScanText : media.kind === 'drawing' ? PenLine : media.kind === 'video' ? Video : Image
  return <Icon aria-hidden className={className} strokeWidth={1.8} />
}

/** The marks beside a title: pinned, locked, "Titel prüfen", shared (or whose), a scan. `small` leaves out the words of
 * "Titel prüfen" and the shared mark's names for a compact row. */
export function TitleMarks({ item, small = false, scan = true }: { item: ListItem; small?: boolean; scan?: boolean }) {
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const shared = sharedText(item, t)
  const media = !locked && item.media && item.media.count > 0 ? item.media : null
  return (
    <>
      {item.pinned && <Pin role="img" aria-label={t('noteList.pinned')} className="h-3.5 w-3.5 shrink-0 text-accent-400" strokeWidth={2.2} />}
      {locked && <Lock role="img" aria-label={t('noteList.locked')} className="h-3.5 w-3.5 shrink-0 text-mist-500" strokeWidth={2.2} />}
      {item.title_check && !locked && (
        <span className="shrink-0 rounded-md bg-warn-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn-500" title={small ? t('notes.titleCheck') : undefined}>
          {small ? '!' : t('notes.titleCheck')}
        </span>
      )}
      {shared && (
        <span
          className="inline-flex min-w-0 shrink items-center gap-1 rounded-md bg-ink-800 px-1.5 py-0.5 text-[11.5px] text-mist-300"
          data-testid="note-shared"
          title={small ? shared : undefined}
          aria-label={small ? shared : undefined}
        >
          <Users aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2.2} />
          {!small && <span className="truncate">{shared}</span>}
        </span>
      )}
      {scan && media?.kind === 'scan' && <ScanText role="img" aria-label={mediaText(item, t)} className="h-3.5 w-3.5 shrink-0 text-mist-500" />}
    </>
  )
}
