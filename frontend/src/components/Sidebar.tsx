/**
 * The sidebar, after the drawing "Seitenleiste": the name at the top, the account with the way to the settings at the
 * bottom. The places of the notes (new note, search, inbox, all notes, folders, smart folders, tags, trash) come with
 * the features that bring them; they register their entries in `SIDEBAR_SECTIONS` (`extensions.ts`) and appear
 * between the two.
 */
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { SIDEBAR_SECTIONS } from '../extensions'
import { useAuth } from '../state/auth'
import { Avatar } from './Avatar'
import { Logo } from './Logo'

/** `width`: the one set on this device (`lib/columns.ts`); the drawer on a phone keeps the drawing's 260 px. */
export function Sidebar({ onNavigate, width = 260 }: { onNavigate?: () => void; width?: number }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const shown = me?.display_name || me?.name || ''
  return (
    <nav aria-label={t('app.mainMenu')} style={{ width }} className="flex h-full flex-col border-r border-ink-700 bg-ink-900">
      <div className="px-4 pt-4 pb-3">
        <NavLink to="/" onClick={onNavigate} aria-label={t('app.home')} className="inline-flex">
          <Logo size={30} withWordmark />
        </NavLink>
      </div>
      <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-2" data-testid="sidebar-places">
        {SIDEBAR_SECTIONS.map((section) => (
          <div key={section.key}>{section.render()}</div>
        ))}
      </div>
      <div className="border-t border-ink-700 p-2">
        <NavLink
          to="/settings"
          onClick={onNavigate}
          aria-label={`${shown} · ${t('nav.settings')}`}
          title={`${shown} · ${t('nav.settings')}`}
          className={({ isActive }) =>
            'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm transition-colors ' + (isActive ? 'nn-chosen' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100')
          }
        >
          <Avatar accountId={me?.id ?? 0} name={shown} stamp={me?.avatar} />
          {/* The gear says "settings"; the word stays only for screen readers and the tooltip. */}
          <span className="min-w-0 flex-1 truncate">{shown}</span>
          <Settings className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
        </NavLink>
      </div>
    </nav>
  )
}
