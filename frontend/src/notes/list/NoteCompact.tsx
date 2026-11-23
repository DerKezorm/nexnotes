/**
 * A note as one line (the look "Kompakt"): its color as a dot, its symbol, the title and behind it the start of its
 * text in gray, small numbers for its checklists and attachments when the hints are on, the time of its last change at
 * the right. The marks (pinned, locked, "Titel prüfen", shared) shrink to their signs. In "All notes" the folder's
 * stripe at the left and its name before the text. On a touch screen the line is a finger high (`layout.ts`).
 */
import { NoteIcon } from '../../components/NoteIcon'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { anyHints, hintKinds } from './hintKinds'
import { MiniHints } from './Hints'
import { boxProps, ItemActions, MoreButton, TitleMarks, type ItemProps } from './ItemParts'
import { noteColor } from './marks'

export function NoteCompact(props: ItemProps) {
  const { item, href, chosen, date, folder, hints, onOpen, onMenu, mark, actions } = props
  const { t } = useTranslation()
  const locked = Boolean(item.locked)
  const dot = noteColor(item)
  const title = item.title || t('notes.untitled')
  const rest = [folder?.name, locked ? t('noteList.lockedBody') : item.preview].filter(Boolean).join(' · ')
  return (
    <div
      {...boxProps(props)}
      className={
        'group relative flex h-full items-center gap-2 rounded-[8px] px-3 outline-accent-600 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 ' +
        (chosen ? 'bg-accent-wash' : 'hover:bg-ink-800')
      }
      data-testid="note-compact-box"
    >
      {folder?.color && <span aria-hidden className="h-4 w-1 shrink-0 rounded-sm" style={{ background: folder.color }} />}
      {chosen && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-[3px] bg-accent-500" />}
      <Link
        to={href}
        onClick={onOpen}
        aria-current={chosen ? 'page' : undefined}
        data-testid="note-compact"
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch focus-visible:outline-none"
      >
        {dot && <span aria-label={t('noteList.colorMark')} role="img" className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} data-testid="note-color" />}
        {item.icon ? <NoteIcon icon={item.icon} color={item.color} size={14} /> : (mark ?? <span aria-hidden className="w-3.5 shrink-0" />)}
        <span className="min-w-0 flex-1 truncate text-[13.5px]" title={item.title || undefined}>
          <span className="font-medium text-mist-100" data-testid="note-title">
            {title}
          </span>
          {rest && (
            <span className="text-mist-600" data-testid={locked ? undefined : 'note-preview'}>
              {' · '}
              {rest}
            </span>
          )}
        </span>
        <TitleMarks item={item} small scan={false} />
        {anyHints(hints) && <MiniHints item={item} kinds={hintKinds(hints)} />}
        {date && <span className="shrink-0 text-[12px] text-mist-600 tabular-nums">{date}</span>}
      </Link>
      <ItemActions item={item} actions={actions} small />
      <MoreButton item={item} onMenu={onMenu} className="h-7 w-7" />
    </div>
  )
}
