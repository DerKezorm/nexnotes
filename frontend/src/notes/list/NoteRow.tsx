/**
 * A note as a row (NOTES-6 AC-2): title, the date of its last change, the start of its text, its tags, the shared mark
 * (with the owner for a note of somebody else) and, when there is one, a small picture. Its color as a dot (AC-8),
 * "Titel prüfen", the lock and a scan as marks (AC-9). In "All notes" also its folder with a stripe in the folder's
 * color (AC-7). A locked note shows its title and the lock only (EC-3). Everything is cut to one line (EC-4).
 *
 * Other lists (the search's hits) can draw their notes with it: only `item` and `href` are needed.
 */
import { Image, Lock, MoreHorizontal, PenLine, Pin, ScanText, Users } from 'lucide-react'
import type { DragEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { ListItem, ListMedia } from './api'
import { mediaText, noteColor, sharedText, tagsText, tasksText } from './marks'

export type RowFolder = { name: string; color: string }

export type NoteRowProps = {
  item: ListItem
  href: string
  /** The open note. */
  chosen?: boolean
  /** The date shown (formatted); by default nothing. */
  date?: string
  /** "All notes": the note's folder as a column and a stripe in its color. */
  folder?: RowFolder | null
  /** Wide enough for tags and the folder as columns of their own. */
  wide?: boolean
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void
  /** Opens the note's menu (pin, color) at a point of the screen. */
  onMenu?: (item: ListItem, point: { x: number; y: number }) => void
  onDragStart?: (event: DragEvent) => void
  onDragEnd?: () => void
}

export function MediaIcon({ media, className }: { media: ListMedia; className?: string }) {
  const Icon = media.kind === 'scan' ? ScanText : media.kind === 'drawing' ? PenLine : Image
  return <Icon aria-hidden className={className} strokeWidth={1.8} />
}

export function NoteRow({ item, href, chosen, date, folder, wide, onOpen, onMenu, onDragStart, onDragEnd }: NoteRowProps) {
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const dot = noteColor(item)
  const shared = sharedText(item, t)
  const tags = locked ? '' : tagsText(item)
  const tasks = locked ? '' : tasksText(item, t)
  const media = !locked && item.media && item.media.count > 0 ? item.media : null
  const title = item.title || t('notes.untitled')
  return (
    <div
      className={'group relative flex h-full items-center gap-3 rounded-[10px] px-2.5 ' + (chosen ? 'nn-chosen' : 'hover:bg-ink-800')}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault()
              onMenu(item, { x: event.clientX, y: event.clientY })
            }
          : undefined
      }
      data-note={item.id}
    >
      {folder && <span aria-hidden className="w-1 self-stretch rounded-sm my-2.5" style={{ background: folder.color }} />}
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-row"
        className="flex min-w-0 flex-1 flex-col gap-1 py-2 outline-offset-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          {dot && <span aria-label={t('noteList.colorMark')} role="img" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} data-testid="note-color" />}
          <span className={'min-w-0 truncate text-[14.5px] font-semibold ' + (chosen ? 'text-accent-400' : 'text-mist-100')} title={item.title || undefined}>
            {title}
          </span>
          {item.pinned && <Pin role="img" aria-label={t('noteList.pinned')} className="h-3.5 w-3.5 shrink-0 text-accent-400" strokeWidth={2.2} />}
          {locked && <Lock role="img" aria-label={t('noteList.locked')} className="h-3.5 w-3.5 shrink-0 text-mist-500" strokeWidth={2.2} />}
          {item.title_check && !locked && (
            <span className="shrink-0 rounded-md bg-warn-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn-500">{t('notes.titleCheck')}</span>
          )}
          {shared && (
            <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-md bg-ink-800 px-1.5 py-0.5 text-[11.5px] text-mist-300" data-testid="note-shared">
              <Users aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2.2} />
              <span className="truncate">{shared}</span>
            </span>
          )}
          {media?.kind === 'scan' && <ScanText role="img" aria-label={mediaText(item, t)} className="h-3.5 w-3.5 shrink-0 text-mist-500" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-mist-500">
          {date && <span className="shrink-0">{date}</span>}
          {tasks && (
            <>
              {date && <span aria-hidden>·</span>}
              <span className="shrink-0">{tasks}</span>
            </>
          )}
          {locked ? (
            <span className="min-w-0 truncate">{t('noteList.lockedBody')}</span>
          ) : (
            item.preview && (
              <>
                {(date || tasks) && <span aria-hidden>·</span>}
                <span className="min-w-0 truncate" data-testid="note-preview">
                  {item.preview}
                </span>
              </>
            )
          )}
          {!wide && tags && <span className="ml-auto shrink-0 pl-2 text-accent-400">{tags}</span>}
        </span>
      </Link>
      {wide && <span className="w-[120px] shrink-0 truncate text-[12.5px] text-accent-400">{tags}</span>}
      {wide && folder && (
        <span className="w-[120px] shrink-0 truncate text-[12.5px] text-mist-300" title={folder.name}>
          {folder.name}
        </span>
      )}
      {media?.url && <img src={media.url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" loading="lazy" />}
      {media && !media.url && media.kind !== 'scan' && <MediaIcon media={media} className="h-4 w-4 shrink-0 text-mist-500" />}
      {onMenu && (
        <button
          type="button"
          aria-label={t('noteList.menu.label', { title })}
          className="nn-row-more flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mist-500 hover:bg-ink-700 hover:text-mist-100"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            onMenu(item, { x: box.right, y: box.bottom })
          }}
        >
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
