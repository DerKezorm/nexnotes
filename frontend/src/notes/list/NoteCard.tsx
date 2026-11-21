/**
 * A note as a card (the look "Karten"): a small band in its color on top (AC-8), its symbol and title with the marks
 * (AC-9), two lines of its text, at the bottom its hints when they are on and the time of its last change (AC-2). In
 * "All notes" its folder before the text, with the folder's stripe at the left (AC-7). The open one has a honey edge.
 * A locked note shows its title and the lock only (EC-3); everything is cut to the card (EC-4).
 */
import { NoteIcon } from '../../components/NoteIcon'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { HintLine } from './Hints'
import { boxProps, MoreButton, TitleMarks, type ItemProps } from './ItemParts'
import { noteColor } from './marks'

export function NoteCard(props: ItemProps) {
  const { item, href, chosen, date, folder, hints, onOpen, onMenu } = props
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const band = noteColor(item)
  const title = item.title || t('notes.untitled')
  const time = date ? <span className="text-[12px] text-mist-600 tabular-nums">{date}</span> : null
  return (
    <div {...boxProps(props)} className="group relative h-full min-w-0" data-testid="note-card-box">
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-card"
        className={
          // The whole card is the link: the keyboard's focus ring follows its rounding, never after a click.
          'relative flex h-full min-w-0 flex-col gap-1 overflow-hidden rounded-[12px] border bg-ink-850 px-3.5 pt-3 pb-2.5 outline-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
          (chosen ? 'border-accent-500 shadow-[0_0_0_3px_var(--color-accent-wash)]' : 'border-ink-700 hover:border-ink-600')
        }
      >
        {band && <span aria-label={t('noteList.colorMark')} role="img" className="absolute top-0 left-3.5 h-[3px] w-9 rounded-b-[3px]" style={{ background: band }} data-testid="note-color" />}
        <span className="flex min-w-0 items-center gap-[7px] pr-7">
          {folder && <span aria-hidden className="h-3.5 w-1 shrink-0 rounded-sm" style={{ background: folder.color }} />}
          <NoteIcon icon={item.icon} color={item.color} />
          <span className="min-w-0 truncate text-[14px] font-semibold text-mist-100" title={item.title || undefined}>
            {title}
          </span>
          <TitleMarks item={item} />
        </span>
        <span className="line-clamp-2 min-w-0 text-[13px] leading-[1.4] break-words text-mist-500" data-testid={locked ? undefined : 'note-preview'}>
          {folder?.name && (
            <>
              <span className="text-mist-300" data-testid="note-folder">
                {folder.name}
              </span>
              {' · '}
            </>
          )}
          {locked ? t('noteList.lockedBody') : item.preview}
        </span>
        <span className="mt-auto flex min-w-0 items-center">
          {hints ? <HintLine item={item} end={time} className="w-full" /> : <span className="ml-auto">{time}</span>}
        </span>
      </Link>
      <MoreButton item={item} onMenu={onMenu} className="absolute top-2 right-2 h-7 w-7 bg-ink-850" />
    </div>
  )
}
