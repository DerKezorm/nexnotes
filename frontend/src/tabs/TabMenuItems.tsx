/**
 * "In neuem Tab öffnen" and "Daneben öffnen" in the menu of a note in a list (NOTES-8 AC-1, AC-3); not on a phone.
 * No choice may seem to do nothing: a note that has a tab already says "Go to tab", and the tab it brings to the
 * front pulses in honey for a moment; the note that is the front tab already, or stands beside already, is greyed
 * with "already open".
 */
import { Columns2, SquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { useCurrentFolder } from '../folders/store'
import { noteOf } from '../notes/workspace'
import { isMac, useDesktop } from './desktop'
import { openNoteBeside, openNoteInNewTab } from './open'
import { pulseTab } from './pulse'
import { focusedKey, tabOf } from './state'
import { useTabs } from './store'

export function TabMenuItems({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const desktop = useDesktop()
  const { openFolderId } = useCurrentFolder()
  const state = useTabs()
  const location = useLocation()
  if (!desktop) return null
  const folder = openFolderId ?? undefined
  // A note is on screen only while the page shows notes; on a list page alone every tab is "behind".
  const showing = noteOf(location.pathname, location.search) !== null
  const tab = state.tabs.find((one) => one.note === noteId)
  const front = showing && tabOf(state, focusedKey(state))?.note === noteId
  const beside = showing && Boolean(state.right) && tabOf(state, state.right)?.note === noteId
  const entry = (props: { testId: string; icon: typeof SquarePlus; label: string; done: boolean; hint?: string; run: () => void }) => {
    const Icon = props.icon
    return (
      <button
        type="button"
        role="menuitem"
        aria-disabled={props.done || undefined}
        className={'nn-menu-item ' + (props.done ? 'cursor-default opacity-50 hover:bg-transparent' : '')}
        data-testid={props.testId}
        onClick={() => {
          if (props.done) return
          onDone()
          props.run()
        }}
      >
        <Icon aria-hidden className="h-4 w-4" />
        <span className="flex-1">{props.label}</span>
        {props.done ? (
          <span className="text-[11px] text-mist-500">{t('tabs.alreadyOpen')}</span>
        ) : (
          props.hint && (
            <span className="text-[11px] text-mist-500" data-testid={`${props.testId}-hint`}>
              {props.hint}
            </span>
          )
        )}
      </button>
    )
  }
  return (
    <>
      {entry({
        testId: 'menu-open-tab',
        icon: SquarePlus,
        label: tab ? t('tabs.goToTab') : t('tabs.openInNewTab'),
        done: front,
        // The way without the menu: Alt-click (⌥-click), besides the middle button and Ctrl or ⌘ (third review).
        hint: isMac() ? t('tabs.altClickMac') : t('tabs.altClick'),
        run: () => {
          openNoteInNewTab(noteId, folder)
          if (tab) pulseTab(tab.key)
        },
      })}
      {entry({
        testId: 'menu-open-beside',
        icon: Columns2,
        label: t('tabs.openBeside'),
        done: beside,
        run: () => {
          const before = state.tabs.find((one) => one.note === noteId && one.key !== state.left)
          openNoteBeside(noteId, folder)
          if (before) pulseTab(before.key)
        },
      })}
    </>
  )
}
