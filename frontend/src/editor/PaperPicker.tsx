/**
 * The four papers as small previews (NOTES-3 AC-17): in the note's menu, and in "My account" for new notes. Each
 * preview is the pattern itself (`editor.css`), so what one picks is what the sheet shows. In a menu (`menuitemradio`)
 * two by two with the name beside a smaller preview, so the four fit any menu's width and it never scrolls sideways.
 */
import { useTranslation } from 'react-i18next'

import { PAPERS, type Paper } from './paper'

export function PaperPicker({ value, onChange, role = 'radio' }: { value: Paper; onChange: (paper: Paper) => void; role?: 'radio' | 'menuitemradio' }) {
  const { t } = useTranslation()
  const inMenu = role === 'menuitemradio'
  return (
    <div
      className={inMenu ? 'grid grid-cols-2 gap-1' : 'flex gap-2'}
      role={inMenu ? 'group' : 'radiogroup'}
      aria-label={t('editor.paper.label')}
      data-testid="paper-picker"
      data-compact={inMenu || undefined}
    >
      {PAPERS.map((paper) => (
        <button
          key={paper}
          type="button"
          role={role}
          aria-checked={value === paper}
          onClick={() => onChange(paper)}
          className={
            (inMenu ? 'flex min-w-0 items-center gap-2 rounded-lg p-1 text-left text-[12px] hover:bg-ink-800 ' : 'flex flex-col items-center gap-1 rounded-lg p-1 text-[11.5px] ') +
            'outline-offset-2 ' +
            (value === paper ? 'text-accent-400' : 'text-mist-400 hover:text-mist-100')
          }
          data-testid={`paper-${paper}`}
        >
          <span
            aria-hidden
            className={
              'nn-paper-preview block shrink-0 rounded-md border bg-ink-850 ' +
              (inMenu ? 'h-7 w-8 ' : 'h-10 w-12 ') +
              (value === paper ? 'border-accent-500 ring-1 ring-accent-500' : 'border-ink-600')
            }
            data-paper={paper}
          />
          <span className={inMenu ? 'min-w-0 truncate' : undefined}>{t(`editor.paper.${paper}`)}</span>
        </button>
      ))}
    </div>
  )
}
