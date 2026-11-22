/**
 * A note as a tile (the look "Kacheln", NOTES-6 AC-3): a small band in its color on top (AC-8), its symbol and title
 * with the marks (AC-9), the first lines, the first picture, scan or sketch with how many there are, and at the bottom
 * the time of its last change and the shared mark; with the hints on also the progress of its checklists ("3 von 8"
 * with a bar), its attachments and tags. A locked note shows its title and the lock only (EC-3); everything is cut
 * to the tile (EC-4). Two side by side on a phone (`layout.ts`).
 */
import { NoteIcon } from '../../components/NoteIcon'
import { Lock, Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { AttachmentsHint } from './Hints'
import { boxProps, ItemActions, MediaIcon, MoreButton, type ItemProps } from './ItemParts'
import { mediaText, noteColor, sharedText, tagsText, tasksText } from './marks'

export function NoteTile(props: ItemProps) {
  const { item, href, chosen, date, hints = true, onOpen, onMenu, mark, actions } = props
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const band = noteColor(item)
  const shared = sharedText(item, t)
  const tags = locked || !hints ? '' : tagsText(item)
  const tasks = locked || !hints ? '' : tasksText(item, t)
  const media = !locked && item.media && item.media.count > 0 ? item.media : null
  const title = item.title || t('notes.untitled')
  const foot = [date, tasks, shared].filter(Boolean).join(' · ')
  const progress = !locked && hints && item.tasks && item.tasks.total > 0 ? Math.round((item.tasks.done / item.tasks.total) * 100) : null
  return (
    <div {...boxProps(props)} className="group relative h-full min-w-0">
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-tile"
        className={
          // The whole tile is the link: the keyboard's focus ring follows its rounding, never after a click.
          'relative flex h-full min-w-0 flex-col gap-[7px] overflow-hidden rounded-[12px] border bg-ink-850 p-3 outline-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
          (chosen ? 'border-accent-500 shadow-[0_0_0_3px_var(--color-accent-wash)]' : 'border-ink-700 hover:border-ink-600')
        }
      >
        {band && <span aria-label={t('noteList.colorMark')} role="img" className="absolute top-0 left-3 h-[3px] w-9 rounded-b-[3px]" style={{ background: band }} data-testid="note-color" />}
        <span className="flex min-w-0 items-start justify-between gap-2" style={{ paddingRight: 24 + 28 * (actions?.length ?? 0) }}>
          <span className="flex min-w-0 items-start gap-1.5">
            <NoteIcon icon={item.icon} color={item.color} className="mt-[3px]" />
            {!item.icon && mark && <span className="mt-[2px] shrink-0">{mark}</span>}
            <span className="nn-wrap line-clamp-2 min-w-0 text-[14px] leading-[1.3] font-semibold text-mist-100" title={item.title || undefined} data-testid="note-tile-title">
              {title}
            </span>
          </span>
          {(item.pinned || locked) && (
            // Only when there is a mark: an empty one would still take the gap from the title.
            <span className="flex shrink-0 items-center gap-1 pt-0.5">
              {item.pinned && <Pin role="img" aria-label={t('noteList.pinned')} className="h-3.5 w-3.5 text-accent-400" strokeWidth={2.2} />}
              {locked && <Lock role="img" aria-label={t('noteList.locked')} className="h-3.5 w-3.5 text-mist-500" strokeWidth={2.2} />}
            </span>
          )}
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
          <span className={'nn-wrap min-w-0 overflow-hidden text-[12.5px] leading-normal text-mist-500 ' + (media ? 'line-clamp-1' : 'line-clamp-3')} data-testid="note-preview">
            {item.preview}
          </span>
        )}
        <span className="mt-auto flex min-w-0 flex-col gap-1.5">
          {progress !== null && (
            <span className="flex h-[4px] rounded-[3px] bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={tasks}>
              <span className="rounded-[3px] bg-accent-500" style={{ width: `${progress}%` }} />
            </span>
          )}
          <span className="flex min-w-0 items-center justify-between gap-2 text-[11.5px] text-mist-500">
            <span className="min-w-0 truncate">{foot}</span>
            {hints && !locked && <AttachmentsHint item={item} />}
            {tags && <span className="min-w-0 shrink truncate text-accent-400">{tags}</span>}
          </span>
        </span>
      </Link>
      <span className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-ink-850">
        <ItemActions item={item} actions={actions} small />
        <MoreButton item={item} onMenu={onMenu} className="h-7 w-7" />
      </span>
    </div>
  )
}
