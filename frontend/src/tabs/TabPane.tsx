/**
 * One side of the notes: the editor of its tab, or what the tab has to say instead.
 *
 * - The side used last guards the ways out of the page and names the browser tab; the other hands its guard to the
 *   tabs, which ask it before it closes. A click or the keyboard's focus in a side makes it the side used last, with
 *   the honey line on top while two stand side by side (AC-1).
 * - Deleted, here or anywhere (EC-3): the editor says so and offers the note back, the side adds the way to the trash
 *   and closing the tab. No longer there for this account at all (deleted for good, sharing ended, EC-6): the side
 *   says so instead of an editor. Ended while the note was on show here, the side keeps the editor's sentence that
 *   names who ended it (NOTES-13 AC-5); only on this page, never in what the tabs remember.
 * - Two sides on show: the sheet of the side used last has a honey frame, the other side is clearly set back (its sheet
 *   sunk to the page's gray, its text, title and small bar one dimmed gray, `index.css`); a click or the focus in it
 *   makes it the side used last at once (21.11.2026, fifth review).
 * - Two sides on show: the note hands its editor to the one bar over both sides (`SharedToolbar.tsx`) and keeps only the
 *   tools of the whole note in its own small bar, at the top right inside its sheet (21.11.2026, fifth review).
 */
import { Ban } from 'lucide-react'
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { NoteEditor } from '../editor/NoteEditor'
import { SharedToolsContext, type ToolsEntry, type ToolsSlot } from '../editor/sharedTools'
import type { LeaveGuard } from '../notes/context'
import type { TabMeta } from './meta'
import { closeDeletedTab, closeTab, focusSide, setTabGuard } from './open'
import type { Side, Tab } from './state'

type Props = {
  tab: Tab
  side: Side
  meta: TabMeta | undefined
  /** The side used last. */
  focused: boolean
  /** The honey line on top: two sides on show, this the one used last. */
  line: boolean
  /** Two sides on show: this one used last (`active`, framed) or the other (`passive`, dimmed). */
  standing?: 'active' | 'passive'
  /** Out of view for now (a narrow window shows one side with the switcher, EC-2); the editor stays connected. */
  hidden: boolean
  fresh: boolean
  style: CSSProperties
  /** Two sides on show: where the note hands its editor to the bar over both sides. */
  registerTools?: (key: string, entry: ToolsEntry | null) => void
}

export function TabPane({ tab, side, meta, focused, line, standing, hidden, fresh, style, registerTools }: Props) {
  const { t } = useTranslation()
  const shared = Boolean(standing && registerTools)
  const tabKey = tab.key
  const slot = useMemo<ToolsSlot | null>(
    () => (shared && registerTools ? { register: (entry) => registerTools(tabKey, entry) } : null),
    [shared, registerTools, tabKey],
  )
  const onGuard = useCallback((guard: LeaveGuard | null) => setTabGuard(tab.key, guard), [tab.key])
  const [ended, setEnded] = useState<{ note: string; said: string } | null>(null)
  const note = tab.note
  const onEnded = useCallback((said: string) => setEnded({ note, said }), [note])
  const endedSaid = ended?.note === note ? ended.said : ''
  const take = () => {
    if (!focused && !hidden) focusSide(side)
  }
  const reveal = useCallback(() => focusSide(side), [side])
  return (
    <section
      aria-label={t(`tabs.${side}`)}
      data-testid="tab-pane"
      data-side={side}
      data-note={tab.note}
      data-focused={focused}
      data-split={standing}
      onPointerDownCapture={take}
      onFocusCapture={take}
      style={{ ...style, borderTopColor: line ? 'var(--color-accent-500)' : 'transparent' }}
      className={'nn-scroll min-h-0 min-w-0 overflow-y-auto border-t-2 ' + (hidden ? 'hidden' : '')}
    >
      {meta?.state === 'gone' ? (
        <div role="alert" data-testid="tab-gone" className="mx-auto flex max-w-[460px] flex-col items-center gap-3 px-6 py-20 text-center">
          <Ban aria-hidden className="h-10 w-10 text-warn-500" strokeWidth={1.5} />
          <p className="text-lg font-semibold text-mist-100">{t('tabs.gone.title')}</p>
          {endedSaid ? (
            <p className="text-sm leading-relaxed font-medium text-warn-500" data-testid="tab-gone-said">
              {endedSaid}
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-mist-500">{t('tabs.gone.text')}</p>
          )}
          <button type="button" className="nn-btn nn-btn-ghost" onClick={() => closeTab(tab.key)}>
            {t('tabs.closeTab')}
          </button>
        </div>
      ) : (
        <SharedToolsContext.Provider value={slot}>
        <NoteEditor
          noteId={tab.note}
          fresh={fresh}
          guarded={focused}
          onGuard={onGuard}
          onDeleted={() => closeDeletedTab(tab.key)}
          onEnded={onEnded}
          reveal={reveal}
          stoppedExtra={(status) =>
            status === 'gone' ? (
              <>
                <Link to="/trash" className="nn-btn nn-btn-ghost h-8 px-3" data-testid="tab-open-trash">
                  {t('tabs.openTrash')}
                </Link>
                <button type="button" className="nn-btn nn-btn-quiet h-8 px-2" onClick={() => closeTab(tab.key)}>
                  {t('tabs.closeTab')}
                </button>
              </>
            ) : status === 'forbidden' ? (
              <button type="button" className="nn-btn nn-btn-quiet h-8 px-2" onClick={() => closeTab(tab.key)}>
                {t('tabs.closeTab')}
              </button>
            ) : null
          }
        />
        </SharedToolsContext.Provider>
      )}
    </section>
  )
}
