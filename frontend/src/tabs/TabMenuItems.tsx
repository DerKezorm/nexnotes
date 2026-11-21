/** "In neuem Tab öffnen" and "Daneben öffnen" in the menu of a note in a list (NOTES-8 AC-1, AC-3); not on a phone. */
import { Columns2, SquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useCurrentFolder } from '../folders/store'
import { useDesktop } from './desktop'
import { openNoteBeside, openNoteInNewTab } from './open'

export function TabMenuItems({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const desktop = useDesktop()
  const { openFolderId } = useCurrentFolder()
  if (!desktop) return null
  const folder = openFolderId ?? undefined
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="nn-menu-item"
        data-testid="menu-open-tab"
        onClick={() => {
          onDone()
          openNoteInNewTab(noteId, folder)
        }}
      >
        <SquarePlus aria-hidden className="h-4 w-4" />
        {t('tabs.openInNewTab')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="nn-menu-item"
        data-testid="menu-open-beside"
        onClick={() => {
          onDone()
          openNoteBeside(noteId, folder)
        }}
      >
        <Columns2 aria-hidden className="h-4 w-4" />
        {t('tabs.openBeside')}
      </button>
    </>
  )
}
