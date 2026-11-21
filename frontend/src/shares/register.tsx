/**
 * Sharing (NOTES-13) docks onto the frame (`extensions.ts`): "Mit mir geteilt" among the places of the sidebar, with
 * how many things others shared (drawing "Seitenleiste"), its pages, the read links in "Mein Konto", and the question
 * before a note leaves a shared folder (EC-2).
 */
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { ACCOUNT_SECTIONS, FEATURE_ROUTES, SHELL_PARTS, SIDEBAR_SECTIONS } from '../extensions'
import { registerNoteMoveCheck } from '../folders/actions'
import { MoveQuestion } from './MoveQuestion'
import { askMoveOut } from './moveAsk'
import { ReadLinksCard } from './ReadLinksCard'
import { SharedFolderPage, SharedPage } from './SharedPage'
import { useWithMe } from './withMe'

export function SharedEntry() {
  const { t } = useTranslation()
  const { data } = useWithMe()
  const count = data?.count ?? 0
  return (
    <NavLink
      to="/shared"
      data-testid="shared-entry"
      className={({ isActive }) =>
        'flex h-[34px] items-center justify-between gap-2 rounded-lg px-2.5 text-[13.5px] ' + (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800')
      }
    >
      <span className="flex items-center gap-2">
        <Users aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        {t('shares.page.title')}
      </span>
      {count > 0 && (
        <span className="text-xs text-mist-500" data-testid="shared-count">
          {count}
        </span>
      )}
    </NavLink>
  )
}

const inbox = SIDEBAR_SECTIONS.findIndex((section) => section.key === 'inbox')
SIDEBAR_SECTIONS.splice(inbox >= 0 ? inbox + 1 : SIDEBAR_SECTIONS.length, 0, { key: 'shared', render: () => <SharedEntry /> })
FEATURE_ROUTES.push({ path: 'shared', element: <SharedPage />, list: true }, { path: 'shared/folder/:id', element: <SharedFolderPage />, list: true })
ACCOUNT_SECTIONS.push({ key: 'read-links', render: () => <ReadLinksCard /> })
SHELL_PARTS.push({ key: 'share-move-question', render: () => <MoveQuestion /> })
registerNoteMoveCheck(askMoveOut)
