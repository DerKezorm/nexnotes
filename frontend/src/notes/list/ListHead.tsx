/**
 * The head of a list, the same for every list: the path small above it (a folder's folders, each a link), one line
 * with its symbol, its name, how many notes, the button "Ansicht" and the list's own "…" (a folder's menu), and below a
 * small line that says how the list is sorted and grouped. It stays at the top while the list scrolls.
 */
import type { ReactNode } from 'react'

type Props = {
  heading: string
  /** The path above the name: links to the folders it lies in. */
  crumb?: ReactNode
  /** The list's symbol before its name. */
  icon?: ReactNode
  /** "12 Notizen", "2 eigene, 1 geteilt". */
  count?: string
  /** The button "Ansicht" (`ViewMenu`). */
  view?: ReactNode
  /** The list's own buttons after it: a folder's "…". */
  actions?: ReactNode
  /** "Zuletzt geändert · nach Datum gruppiert". */
  summary?: string
  narrow?: boolean
}

export function ListHead({ heading, crumb, icon, count, view, actions, summary, narrow }: Props) {
  return (
    <header className="sticky top-0 z-10 -mx-1 border-b border-ink-700 bg-ink-950 px-1 pt-1 pb-2.5" data-testid="list-head">
      {crumb && <div className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-mist-600">{crumb}</div>}
      <div className="flex min-w-0 items-center gap-2 pt-0.5">
        {icon}
        <h1 className={'min-w-0 truncate font-bold tracking-[-0.01em] text-mist-100 ' + (narrow ? 'text-[19px]' : 'text-[22px]')} title={heading}>
          {heading}
        </h1>
        {count && (
          <span className="shrink-0 text-[13px] text-mist-600" data-testid="list-counts">
            {count}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {view}
          {actions}
        </span>
      </div>
      {summary && (
        <p className="mt-1 min-w-0 truncate text-[12px] text-mist-600" data-testid="list-state">
          {summary}
        </p>
      )}
    </header>
  )
}
