/**
 * A note as a row of the list (the look "Liste", NOTES-6 AC-2): its symbol and title with the time of its last change
 * at the right, below the start of its text, below that its hints (checklist progress, attachments, tags) when they
 * are on. Rows are parted by thin lines; the open one stands on the accent's wash with a narrow honey bar at the left.
 * Its color as a dot (AC-8), pinned, "Titel prüfen", the lock, shared and a scan as marks (AC-9). In "All notes" its
 * folder in the second line, with a stripe in the folder's color (AC-7). A locked note shows its title and the lock
 * only (EC-3). Everything is cut to its line (EC-4).
 */
import { NoteIcon } from '../../components/NoteIcon'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { anyHints, hintKinds } from './hintKinds'
import { HintLine } from './Hints'
import { boxProps, ItemActions, MoreButton, TitleMarks, type ItemProps } from './ItemParts'
import { noteColor } from './marks'

export { MediaIcon, type RowFolder } from './ItemParts'
export type NoteRowProps = ItemProps

export function NoteRow(props: ItemProps) {
  const { item, href, chosen, date, folder, hints, first, onOpen, onMenu, mark, actions } = props
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const dot = noteColor(item)
  const media = !locked && item.media && item.media.count > 0 ? item.media : null
  const title = item.title || t('notes.untitled')
  const place = folder?.name ?? ''
  return (
    <div
      {...boxProps(props)}
      // The keyboard's focus ring goes round the whole row with its rounding, the "…" included; never after a click.
      className={
        'group relative flex h-full items-center gap-2.5 rounded-[10px] px-3 outline-accent-600 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 ' +
        (chosen ? 'bg-accent-wash' : 'hover:bg-ink-800')
      }
      data-testid="note-row-box"
    >
      {folder?.color && <span aria-hidden className="my-3 w-1 self-stretch rounded-sm" style={{ background: folder.color }} />}
      {!first && !chosen && <span aria-hidden className="absolute top-0 right-3 left-3 h-px bg-ink-700 group-hover:opacity-0" />}
      {chosen && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-[3px] bg-accent-500" data-testid="note-chosen-bar" />}
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-row"
        className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-stretch py-2 focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-[7px]">
          {dot && <span aria-label={t('noteList.colorMark')} role="img" className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} data-testid="note-color" />}
          <NoteIcon icon={item.icon} color={item.color} />
          {!item.icon && mark}
          <span className="min-w-0 truncate text-[14px] font-semibold text-mist-100" title={item.title || undefined}>
            {title}
          </span>
          <TitleMarks item={item} />
          {date && <span className="ml-auto shrink-0 pl-2 text-[12px] text-mist-600 tabular-nums">{date}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-mist-500">
          {place && (
            <>
              <span className="max-w-[45%] shrink-0 truncate text-mist-300" title={place} data-testid="note-folder">
                {place}
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          {locked ? (
            <span className="min-w-0 truncate">{t('noteList.lockedBody')}</span>
          ) : (
            item.preview && (
              <span className="min-w-0 truncate" data-testid="note-preview">
                {item.preview}
              </span>
            )
          )}
        </span>
        {anyHints(hints) && <HintLine item={item} kinds={hintKinds(hints)} className="mt-1.5" />}
      </Link>
      {media?.url && <img src={media.url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" loading="lazy" />}
      <ItemActions item={item} actions={actions} />
      <MoreButton item={item} onMenu={onMenu} />
    </div>
  )
}
