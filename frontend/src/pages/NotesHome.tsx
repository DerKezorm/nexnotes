/**
 * The start area of the signed-in app. Empty in the frame: the note features fill it (the list or tiles of the notes,
 * the editor beside them). Until then it says, in the words of the empty state, what the place is for.
 */
import { useTranslation } from 'react-i18next'

import { LogoMark } from '../components/Logo'
import { useTitle } from '../lib/title'

export function NotesHome() {
  const { t } = useTranslation()
  useTitle(t('home.title'))
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="notes-home">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-[12px] border border-dashed border-ink-600 px-8 py-10 text-center">
        <LogoMark size={44} />
        <p className="text-sm text-mist-400">{t('home.empty')}</p>
      </div>
    </div>
  )
}
