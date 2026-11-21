/**
 * The four papers as small previews (NOTES-3 AC-17): in the note's menu, and in "My account" for new notes. Each
 * preview is the pattern itself (`editor.css`), so what one picks is what the sheet shows.
 */
import { useTranslation } from 'react-i18next'

import { PAPERS, type Paper } from './paper'

export function PaperPicker({ value, onChange, role = 'radio' }: { value: Paper; onChange: (paper: Paper) => void; role?: 'radio' | 'menuitemradio' }) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-2" role={role === 'radio' ? 'radiogroup' : 'group'} aria-label={t('editor.paper.label')} data-testid="paper-picker">
      {PAPERS.map((paper) => (
        <button
          key={paper}
          type="button"
          role={role}
          aria-checked={value === paper}
          onClick={() => onChange(paper)}
          className={'flex flex-col items-center gap-1 rounded-lg p-1 text-[11.5px] outline-offset-2 ' + (value === paper ? 'text-accent-400' : 'text-mist-400 hover:text-mist-100')}
          data-testid={`paper-${paper}`}
        >
          <span
            aria-hidden
            className={'nn-paper-preview block h-10 w-12 rounded-md border bg-ink-850 ' + (value === paper ? 'border-accent-500 ring-1 ring-accent-500' : 'border-ink-600')}
            data-paper={paper}
          />
          {t(`editor.paper.${paper}`)}
        </button>
      ))}
    </div>
  )
}
