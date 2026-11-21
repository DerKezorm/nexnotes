/**
 * The tools of the sheet itself beside a second note (NOTES-8, 21.11.2026): the text width (NOTES-3 AC-14) and the
 * outline (AC-15). They stand in the small bar at the top right of each sheet and always work on their own note,
 * whichever side was used last; they work on a note one only reads too. One note alone keeps them in its toolbar.
 */
import { MoveHorizontal, PanelRight } from 'lucide-react'
import { useContext, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../components/Menu'
import { OutlineToggleContext, useOutlineShown } from './outlineData'
import { TEXT_WIDTHS, useTextWidth } from './textWidth'

const TOOL = 'flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors'

export function NoteViewTools() {
  const { t } = useTranslation()
  const [textWidth, setTextWidth] = useTextWidth()
  const [widthOpen, setWidthOpen] = useState(false)
  const widthButton = useRef<HTMLButtonElement>(null)
  const outlineToggle = useContext(OutlineToggleContext)
  const [outlineSetting, setOutlineSetting] = useOutlineShown()
  const outlineShown = outlineToggle ? outlineToggle.shown : outlineSetting
  const flipOutline = outlineToggle ? outlineToggle.toggle : () => setOutlineSetting(!outlineSetting)
  const tone = (active: boolean) => (active ? 'nn-chosen' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100')
  return (
    <span className="flex items-center gap-1" data-testid="note-view-tools">
      <button
        ref={widthButton}
        type="button"
        data-testid="tool-width"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setWidthOpen(!widthOpen)}
        aria-label={t('editor.tools.width')}
        aria-haspopup="menu"
        aria-expanded={widthOpen}
        title={t('editor.tools.width')}
        className={`${TOOL} ${tone(textWidth !== 'narrow')}`}
      >
        <MoveHorizontal className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="tool-outline"
        data-outline-toggle={outlineToggle?.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={flipOutline}
        aria-label={t('editor.tools.outline')}
        aria-pressed={outlineShown}
        title={t('editor.tools.outline')}
        className={`${TOOL} ${tone(outlineShown)}`}
      >
        <PanelRight className="h-4 w-4" aria-hidden />
      </button>
      {widthOpen && widthButton.current && (
        <Menu anchor={widthButton.current} onClose={() => setWidthOpen(false)} label={t('editor.tools.width')} align="end">
          {TEXT_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              role="menuitemradio"
              aria-checked={textWidth === width}
              className="nn-menu-item"
              data-testid={`width-${width}`}
              onClick={() => {
                setWidthOpen(false)
                setTextWidth(width)
              }}
            >
              <span aria-hidden className="w-4 text-accent-400">{textWidth === width ? '✓' : ''}</span>
              {t(`editor.width.${width}`)}
            </button>
          ))}
        </Menu>
      )}
    </span>
  )
}
