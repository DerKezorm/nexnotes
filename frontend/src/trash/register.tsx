/** The trash docks onto the frame (`extensions.ts`): its entry at the end of the sidebar's places, the page `/trash`. */
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { TrashPage } from './TrashPage'

export function TrashEntry() {
  const { t } = useTranslation()
  return (
    <div className="mt-3 border-t border-ink-700 pt-2 pb-2">
      <NavLink
        to="/trash"
        data-testid="trash-entry"
        className={({ isActive }) =>
          'flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] ' + (isActive ? 'nn-chosen font-semibold' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100')
        }
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        {t('trash.title')}
      </NavLink>
    </div>
  )
}

SIDEBAR_SECTIONS.push({ key: 'trash', render: () => <TrashEntry /> })
FEATURE_ROUTES.push({ path: 'trash', element: <TrashPage /> })
