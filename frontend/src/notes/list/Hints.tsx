/**
 * The hints a note carries in a list (switched off and on in the menu "Ansicht", kept for the account, `look.ts`): the
 * progress of its checklists with a small bar ("3 von 8"; all done in green), how many attachments it holds, its tags.
 * `mini` is the compact row's way: small numbers only ("3/8", the clip and a number).
 */
import { Check, CheckCheck, Paperclip } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ListItem } from './api'
import { tagName, tasksText } from './marks'

export function TasksHint({ item }: { item: ListItem }) {
  const { t } = useTranslation()
  const tasks = item.tasks
  if (!tasks || tasks.total < 1) return null
  const done = tasks.done >= tasks.total
  const text = tasksText(item, t)
  const share = Math.round((tasks.done / tasks.total) * 100)
  return (
    <span
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[11.5px] whitespace-nowrap ' +
        (done ? 'border-ok-500/60 text-ok-500' : 'border-ink-700 text-mist-500')
      }
      data-testid="hint-tasks"
    >
      {done ? <CheckCheck aria-hidden className="h-3 w-3" strokeWidth={2.4} /> : <Check aria-hidden className="h-3 w-3" strokeWidth={2.4} />}
      {text}
      {!done && (
        <span className="ml-0.5 inline-block h-[3px] w-[34px] overflow-hidden rounded-sm bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-label={text}>
          <span className="block h-full bg-accent-500" style={{ width: `${share}%` }} />
        </span>
      )}
    </span>
  )
}

export function AttachmentsHint({ item }: { item: ListItem }) {
  const { t } = useTranslation()
  const count = item.attachments ?? 0
  if (count < 1) return null
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ink-700 px-2 py-px text-[11.5px] whitespace-nowrap text-mist-500"
      aria-label={t('noteList.hints.attachments', { count })}
      data-testid="hint-attachments"
    >
      <Paperclip aria-hidden className="h-3 w-3" strokeWidth={2.2} />
      <span aria-hidden>{count}</span>
    </span>
  )
}

export function TagsHint({ item }: { item: ListItem }) {
  if (!item.tags?.length) return null
  return (
    <span className="min-w-0 truncate text-[12px] text-accent-400" data-testid="hint-tags">
      {item.tags.map((tag) => `#${tagName(tag)}`).join(' ')}
    </span>
  )
}

/** The hint line of a row, card or tile; nothing for a locked note or one without hints. `end` stands at its end
 * (the time of a card). */
export function HintLine({ item, end, className = '' }: { item: ListItem; end?: ReactNode; className?: string }) {
  const any = !item.locked && ((item.tasks?.total ?? 0) > 0 || (item.attachments ?? 0) > 0 || (item.tags?.length ?? 0) > 0)
  if (!any && !end) return null
  return (
    <span className={'flex min-w-0 items-center gap-1.5 overflow-hidden ' + className} data-testid="note-hints">
      {any && (
        <>
          <TasksHint item={item} />
          <AttachmentsHint item={item} />
          <TagsHint item={item} />
        </>
      )}
      {end && <span className="ml-auto shrink-0 pl-1">{end}</span>}
    </span>
  )
}

/** The compact row's hints: "✓ 3/8" and the clip with a number. */
export function MiniHints({ item }: { item: ListItem }) {
  const { t } = useTranslation()
  if (item.locked) return null
  const tasks = item.tasks && item.tasks.total > 0 ? item.tasks : null
  const count = item.attachments ?? 0
  if (!tasks && count < 1) return null
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-mist-500 tabular-nums" data-testid="note-hints">
      {tasks && (
        <span className={'inline-flex items-center gap-0.5 ' + (tasks.done >= tasks.total ? 'text-ok-500' : '')} aria-label={tasksText(item, t)} data-testid="hint-tasks">
          <Check aria-hidden className="h-[11px] w-[11px]" strokeWidth={2.6} />
          <span aria-hidden>
            {tasks.done}/{tasks.total}
          </span>
        </span>
      )}
      {count > 0 && (
        <span className="inline-flex items-center gap-0.5" aria-label={t('noteList.hints.attachments', { count })} data-testid="hint-attachments">
          <Paperclip aria-hidden className="h-[11px] w-[11px]" strokeWidth={2.4} />
          <span aria-hidden>{count}</span>
        </span>
      )}
    </span>
  )
}
