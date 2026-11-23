/**
 * The button "Ansicht" above a list and its menu: sorting (last changed, created, title A–Z, and the direction; per
 * folder, NOTES-6 AC-4), grouping (by date or none; per folder, AC-5; none while sorted by title), the look of every
 * list (list, cards, compact, tiles) and the hints (checklist progress, attachments, tags, each kind on or off); the
 * last two are the account's, the same in every list and on every device (`look.ts`). A list that offers its attachments as well (a
 * smart folder with "Anhang") names `gallery` in `modes`: then the menu begins with "Zeigen" (notes or attachments);
 * the gallery sorts itself, so the rest stays away while it shows.
 *
 * Keyboard: the arrow keys go through the entries, Escape closes it and gives the focus back to the button
 * (`components/Menu.tsx`). A choice keeps the menu open, so several can be made in one go.
 */
import { ArrowDown, ArrowUp, Check, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../../components/Menu'
import { LIST_STYLES, type ListMode, type ListSort, type ListView } from './api'
import { HINT_KINDS, type ListLook, type ListLookChange } from './look'
import { STYLE_ICONS } from './styleIcons'

const SORTS: ListSort[] = ['updated', 'created', 'title']

type Props = {
  view: ListView
  onChange: (change: Partial<ListView>) => void
  look: ListLook
  onLook: (change: ListLookChange) => void
  /** `gallery` among them: the list can show its attachments instead of its notes. */
  modes?: readonly ListMode[]
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="pb-1">
      <p aria-hidden className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-600 uppercase">
        {label}
      </p>
      {children}
    </div>
  )
}

function Choice({ on, onPick, testId, icon: Icon, children, disabled }: { on: boolean; onPick: () => void; testId: string; icon?: LucideIcon; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={'nn-menu-item ' + (on ? 'font-semibold text-accent-400' : '') + (disabled ? ' cursor-not-allowed opacity-45' : '')}
      onClick={() => {
        if (!disabled && !on) onPick()
      }}
    >
      {Icon && <Icon aria-hidden className="h-4 w-4 shrink-0 text-mist-500" strokeWidth={2} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Check aria-hidden className={'h-4 w-4 shrink-0 ' + (on ? '' : 'invisible')} />
    </button>
  )
}

export function ViewMenu({ view, onChange, look, onLook, modes }: Props) {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const byTitle = view.sort === 'title'
  const withGallery = Boolean(modes?.includes('gallery'))
  const gallery = withGallery && view.mode === 'gallery'
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-label={t('noteList.view.label')}
        title={t('noteList.view.label')}
        data-testid="list-view"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        className={
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ' +
          (anchor ? 'border-transparent bg-accent-wash text-accent-400' : 'border-transparent text-mist-500 hover:bg-ink-800 hover:text-mist-100')
        }
      >
        <SlidersHorizontal aria-hidden className="h-4 w-4" strokeWidth={2.1} />
      </button>
      {anchor && (
        <Menu anchor={anchor} onClose={() => setAnchor(null)} label={t('noteList.view.label')} width={264} testId="list-view-menu">
          {withGallery && (
            <Section label={t('noteList.view.show')}>
              {(['list', 'gallery'] as const).map((mode) => (
                <Choice key={mode} on={view.mode === mode} onPick={() => onChange({ mode })} testId={`list-mode-${mode}`}>
                  {t(mode === 'list' ? 'noteList.view.notes' : 'noteList.view.gallery')}
                </Choice>
              ))}
            </Section>
          )}
          {!gallery && (
            <>
              <Section label={t('noteList.sort.label')}>
                {SORTS.map((sort) => (
                  // Titles read best from A; dates from the newest.
                  <Choice key={sort} on={view.sort === sort} onPick={() => onChange({ sort, direction: sort === 'title' ? 'asc' : 'desc' })} testId={`list-sort-${sort}`}>
                    {t(`noteList.sort.${sort}`)}
                  </Choice>
                ))}
                <div className="mx-2 my-1 h-px bg-ink-700" role="separator" />
                {(['desc', 'asc'] as const).map((direction) => (
                  <Choice
                    key={direction}
                    on={view.direction === direction}
                    onPick={() => onChange({ direction })}
                    testId={`list-direction-${direction}`}
                    icon={direction === 'asc' ? ArrowUp : ArrowDown}
                  >
                    {t(byTitle ? `noteList.sort.${direction}Title` : `noteList.sort.${direction}`)}
                  </Choice>
                ))}
              </Section>
              <Section label={t('noteList.groupLabel')}>
                <Choice on={view.grouped && !byTitle} onPick={() => onChange({ grouped: true })} testId="list-group-on" disabled={byTitle}>
                  {t('noteList.group')}
                </Choice>
                <Choice on={!view.grouped || byTitle} onPick={() => onChange({ grouped: false })} testId="list-group-off" disabled={byTitle}>
                  {t('noteList.groupNone')}
                </Choice>
                {byTitle && <p className="px-2.5 pt-0.5 pb-1 text-[11.5px] text-mist-600">{t('noteList.groupOffByTitle')}</p>}
              </Section>
              <Section label={t('noteList.style.label')}>
                {LIST_STYLES.map((style) => (
                  <Choice key={style} on={look.style === style} onPick={() => onLook({ style })} testId={`list-style-${style}`} icon={STYLE_ICONS[style]}>
                    {t(`noteList.style.${style}`)}
                  </Choice>
                ))}
              </Section>
              <Section label={t('noteList.hints.label')}>
                {/* Each kind on or off by itself (NOTES-6, NOTESIOS-6 AC-1), with a tick like every on and off. */}
                {HINT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={look.hints[kind]}
                    data-testid={`list-hints-${kind}`}
                    className="nn-menu-item"
                    onClick={() => onLook({ hints: { [kind]: !look.hints[kind] } })}
                  >
                    <span className="min-w-0 flex-1 truncate">{t(`noteList.hints.kind.${kind}`)}</span>
                    <Check aria-hidden className={'h-4 w-4 shrink-0 ' + (look.hints[kind] ? '' : 'invisible')} />
                  </button>
                ))}
              </Section>
            </>
          )}
        </Menu>
      )}
    </>
  )
}
