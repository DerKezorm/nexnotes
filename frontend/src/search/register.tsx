/**
 * The search docks onto the frame (`extensions.ts`): the field "Suchen" in the sidebar right after "Neue Notiz"
 * (drawing "Seitenleiste") and the page `/search`. The shortcuts work everywhere in the app: Ctrl/⌘ + Shift + F, and
 * `/` while no text is being written.
 */
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { SearchPage } from './SearchPage'
import { installShortcuts, SEARCH_PATH } from './shortcuts'
import './search.css'

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function SearchEntry() {
  const { t } = useTranslation()
  return (
    <NavLink
      to={SEARCH_PATH}
      data-testid="sidebar-search"
      aria-keyshortcuts={isMac() ? 'Meta+K Meta+Shift+F' : 'Control+K Control+Shift+F'}
      className={({ isActive }) =>
        'mb-2 flex h-9 items-center gap-2 rounded-[9px] border px-2.5 text-[13.5px] ' +
        (isActive ? 'border-accent-500 text-accent-400' : 'border-ink-700 text-mist-500 hover:bg-ink-800 hover:text-mist-100')
      }
    >
      <Search className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
      <span className="flex-1">{t('search.field')}</span>
      <kbd className="hidden md:inline" data-testid="search-key">
        {isMac() ? '⌘ K' : t('search.key')}
      </kbd>
    </NavLink>
  )
}

const after = SIDEBAR_SECTIONS.findIndex((section) => section.key === 'new-note')
SIDEBAR_SECTIONS.splice(after + 1, 0, { key: 'search', render: () => <SearchEntry /> })
FEATURE_ROUTES.push({ path: 'search', element: <SearchPage />, list: true })
installShortcuts()
