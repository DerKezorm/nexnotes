/**
 * A note as a tile (NOTES-6 AC-3): title, the first lines, the first picture, scan or sketch with how many there are,
 * the progress of its checklists ("3 von 8"), tags, the shared mark and its color as a stripe on top (AC-8). Pin, lock
 * and "Titel prüfen" as marks (AC-9). A locked note shows its title and the lock only (EC-3); everything is cut to the
 * tile (EC-4).
 */
import { Lock, MoreHorizontal, Pin } from 'lucide-react'
import type { DragEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { ListItem } from './api'
import { mediaText, noteColor, sharedText, tagsText, tasksText } from './marks'
import { MediaIcon } from './NoteRow'

type Props = {
  item: ListItem
  href: string
  chosen?: boolean
  date?: string
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void
  onMenu?: (item: ListItem, point: { x: number; y: number }) => void
  onDragStart?: (event: DragEvent) => void
  onDragEnd?: () => void
}

export function NoteTile({ item, href, chosen, date, onOpen, onMenu, onDragStart, onDragEnd }: Props) {
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const stripe = noteColor(item)
  const shared = sharedText(item, t)
  const tags = locked ? '' : tagsText(item)
  const tasks = locked ? '' : tasksText(item, t)
  const media = !locked && item.media && item.media.count > 0 ? item.media : null
  const title = item.title || t('notes.untitled')
  const foot = [date, tasks, shared].filter(Boolean).join(' · ')
  const progress = !locked && item.tasks && item.tasks.total > 0 ? Math.round((item.tasks.done / item.tasks.total) * 100) : null
  return (
    <div
      className="group relative h-full min-w-0"
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
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-tile"
        className={
          'flex h-full min-w-0 flex-col gap-[7px] overflow-hidden rounded-[12px] border bg-ink-850 p-3 hover:bg-ink-800 ' +
          (chosen ? 'border-accent-600' : 'border-ink-700')
        }
        style={stripe ? { borderTop: `4px solid ${stripe}` } : undefined}
      >
        <span className="flex min-w-0 items-start justify-between gap-2 pr-6">
          <span className="line-clamp-2 min-w-0 text-[14.5px] leading-[1.3] font-semibold break-words text-mist-100" title={item.title || undefined}>
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-1 pt-0.5">
            {item.pinned && <Pin role="img" aria-label={t('noteList.pinned')} className="h-3.5 w-3.5 text-accent-400" strokeWidth={2.2} />}
            {locked && <Lock role="img" aria-label={t('noteList.locked')} className="h-3.5 w-3.5 text-mist-500" strokeWidth={2.2} />}
          </span>
        </span>
        {item.title_check && !locked && (
          <span className="self-start rounded-md bg-warn-500/15 px-[7px] py-0.5 text-[11px] font-semibold text-warn-500">{t('notes.titleCheck')}</span>
        )}
        {locked && (
          <span className="flex min-h-0 flex-1 items-center justify-center rounded-lg bg-ink-800 text-[12px] text-mist-500">{t('noteList.lockedBody')}</span>
        )}
        {media && (
          <span className="flex min-h-14 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-ink-800 text-[12px] text-mist-500" data-testid="note-media">
            {media.url ? (
              <img src={media.url} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <>
                <MediaIcon media={media} className="h-[18px] w-[18px]" />
                <span className="truncate">{mediaText(item, t)}</span>
              </>
            )}
          </span>
        )}
        {!locked && item.preview && (
          <span className={'min-w-0 overflow-hidden text-[12.5px] leading-normal break-words text-mist-500 ' + (media ? 'line-clamp-1' : 'line-clamp-3')} data-testid="note-preview">
            {item.preview}
          </span>
        )}
        <span className="mt-auto flex min-w-0 flex-col gap-1.5">
          {progress !== null && (
            <span className="flex h-[5px] rounded-[3px] bg-ink-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={tasks}>
              <span className="rounded-[3px] bg-accent-500" style={{ width: `${progress}%` }} />
            </span>
          )}
          <span className="flex min-w-0 justify-between gap-2 text-[11.5px] text-mist-500">
            <span className="min-w-0 truncate">{foot}</span>
            {tags && <span className="min-w-0 shrink truncate text-accent-400">{tags}</span>}
          </span>
        </span>
      </Link>
      {onMenu && (
        <button
          type="button"
          aria-label={t('noteList.menu.label', { title })}
          className="nn-row-more absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-ink-850 text-mist-500 hover:bg-ink-700 hover:text-mist-100"
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
