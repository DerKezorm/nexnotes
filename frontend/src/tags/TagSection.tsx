/**
 * The tags in the sidebar (drawing "Seitenleiste", NOTES-5 AC-2): every tag of the account and of the notes shared with
 * it (EC-4), the most frequent first; with very many only the first twenty and "Alle anzeigen" (EC-5).
 */
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { tagHref } from './rules'
import { useTags } from './store'

/** Tags the sidebar shows before "Alle anzeigen" (EC-5). */
export const SIDEBAR_TAGS = 20

export function TagSection({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { tags } = useTags()
  if (tags.length === 0) return null
  const shown = tags.slice(0, SIDEBAR_TAGS)
  return (
    <section aria-label={t('tags.heading')} className="pb-2" data-testid="sidebar-tags">
      <h2 className="px-2.5 pt-3.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('tags.heading')}</h2>
      <ul className="flex flex-wrap gap-1.5 px-2.5 py-0.5">
        {shown.map((tag) => (
          <li key={tag.key}>
            <NavLink
              to={tagHref(tag.label)}
              onClick={onNavigate}
              title={t('tags.countNotes', { count: tag.count })}
              data-testid="sidebar-tag"
              className={({ isActive }) =>
                'block max-w-[220px] truncate rounded-md px-2 py-[3px] text-[12.5px] ' + (isActive ? 'nn-chosen font-semibold' : 'bg-ink-800 text-accent-400 hover:bg-ink-700')
              }
            >
              #{tag.label}
            </NavLink>
          </li>
        ))}
      </ul>
      {tags.length > SIDEBAR_TAGS && (
        <NavLink to="/tags" onClick={onNavigate} className="mx-2.5 mt-1 inline-block text-[12.5px] text-accent-400 hover:underline" data-testid="sidebar-tags-all">
          {t('tags.showAll', { count: tags.length })}
        </NavLink>
      )}
    </section>
  )
}
