/**
 * The symbol before the title of an open note (NOTES-3 AC-18). Without one, a pale "Choose a symbol" always holds its
 * place, as large as a symbol, and grows clearer when pointed at or focused (fourth review: the empty place said
 * nothing, and a touch screen never points); with one, the symbol itself is the button. Both open the picker of the
 * folders, with "Remove" for a note that has one. Who may only read sees no placeholder.
 */
import { SmilePlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { NoteIcon } from '../components/NoteIcon'
import { SymbolPicker } from '../components/SymbolPicker'
import { colorOf } from '../folders/palette'

export function TitleIcon({ icon, color, editable, onChange }: { icon: string; color: string; editable: boolean; onChange: (icon: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!editable && !icon) return null
  return (
    <>
      {icon ? (
        <button
          type="button"
          onClick={() => editable && setOpen(true)}
          disabled={!editable}
          aria-label={t('editor.icon.change')}
          title={t('editor.icon.change')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-ink-800 disabled:hover:bg-transparent"
          data-testid="title-icon"
        >
          <NoteIcon icon={icon} color={color} size={24} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('editor.icon.add')}
          title={t('editor.icon.add')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-mist-600 transition-colors group-focus-within:text-mist-300 group-hover:text-mist-300 hover:bg-ink-800 hover:text-mist-100 focus-visible:text-mist-100"
          data-testid="title-icon-add"
        >
          <SmilePlus aria-hidden className="h-6 w-6" />
        </button>
      )}
      {open && (
        <Dialog title={t('editor.icon.title')} onClose={() => setOpen(false)}>
          <div className="space-y-3" data-testid="note-icon-dialog">
            <SymbolPicker
              value={icon}
              color={color ? colorOf(color) : undefined}
              onChange={(name) => {
                setOpen(false)
                onChange(name)
              }}
            />
            <div className="flex justify-end gap-2">
              {icon && (
                <button
                  type="button"
                  className="nn-btn nn-btn-ghost"
                  onClick={() => {
                    setOpen(false)
                    onChange('')
                  }}
                >
                  {t('editor.icon.remove')}
                </button>
              )}
              <button type="button" className="nn-btn nn-btn-accent" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  )
}
