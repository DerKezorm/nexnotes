/**
 * NOTES-13 EC-2: a note moved out of a shared folder stops being shared with the people of that folder. Before the
 * move nexnotes asks; "Verschieben" moves, "Abbrechen" leaves everything as it was. Registered as the folders' move
 * check (`registerNoteMoveCheck`); the question stands over every page (`SHELL_PARTS`).
 */
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { useMoveQuestion } from './moveAsk'

export function MoveQuestion() {
  const { t } = useTranslation()
  const shown = useMoveQuestion()
  if (!shown) return null
  const people = [...new Set(shown.notes.flatMap((note) => note.people))].join(', ')
  const first = shown.notes[0]
  return (
    <Dialog title={t('shares.move.title')} onClose={() => shown.answer(false)}>
      <div className="flex flex-col gap-4" data-testid="share-move-question">
        <p className="text-sm text-mist-200">
          {shown.notes.length === 1
            ? t('shares.move.one', { title: first.title || t('notes.untitled'), people })
            : t('shares.move.many', { count: shown.notes.length, people })}
        </p>
        <span className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={() => shown.answer(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-accent" onClick={() => shown.answer(true)} data-testid="share-move-go">
            {t('shares.move.go')}
          </button>
        </span>
      </div>
    </Dialog>
  )
}
