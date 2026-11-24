/**
 * The entries of a note's menu and what they do, in one place for the "…" of an open note and for the menu of a note
 * in the list (its "…" and the right click, in every look of the list): Teilen …, Duplizieren, Exportieren …, what
 * features add (`NOTE_MENU_ITEMS`: Sperren or Sperre aufheben, Als nextasks-Aufgabe), Verlauf, Löschen, the color and
 * the paper. Same conditions and words everywhere; the dialogs stay open after the menu has closed.
 */
import { Copy, History, Share2, Trash2, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import { ExportDialog } from '../export'
import { showNotice } from '../folders/notice'
import { refreshFolders } from '../folders/store'
import { historyHref } from '../history/href'
import { problemText } from '../lib/errors'
import { notesApi, notesChanged, type NoteHead } from '../notes/api'
import { NoteColorRow } from '../notes/list/EditorMarks'
import { noteHref } from '../notes/newNote'
import { ShareDialog } from '../shares/ShareDialog'
import { NOTE_MENU_ITEMS } from './noteParts'
import { paperOf } from './paper'
import { PaperPicker } from './PaperPicker'

export type NoteMenuOptions = {
  noteId: string
  head: NoteHead | null
  /** The note is open locked (from the vault), or a locked note in the list: nothing of its text goes anywhere. */
  sealed: boolean
  /** The signed-in account. */
  myId: number
  /** The title as it shows now (the open note's typed one); else the head's. */
  title?: string
  onHead: (head: NoteHead) => void
  onProblem: (text: string) => void
  /** The note goes to the trash (`true`), or that failed (`false`): the open note knows it left. */
  onDeleting?: (going: boolean) => void
  /** After the note went to the trash; the open note leaves it. */
  onDeleted?: () => void
  /** The share dialog closed: the open note asks for its head again. */
  onShared?: () => void
}

export function useNoteMenu({ noteId, head, sealed, myId, title, onHead, onProblem, onDeleting, onDeleted, onShared }: NoteMenuOptions) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<'share' | 'export' | null>(null)
  const mine = Boolean(head && head.owner?.id === myId)

  const remove = async () => {
    try {
      onDeleting?.(true)
      await notesApi.remove(noteId)
      notesChanged()
      void refreshFolders()
      showNotice({
        text: t('notes.deleted'),
        undo: async () => {
          await notesApi.restore(noteId)
          notesChanged()
          void refreshFolders()
          navigate(noteHref(noteId))
        },
      })
      onDeleted?.()
    } catch (error) {
      onDeleting?.(false)
      onProblem(problemText(error))
    }
  }

  const duplicate = async () => {
    try {
      const copy = await notesApi.duplicate(noteId)
      notesChanged()
      void refreshFolders()
      navigate(noteHref(copy.id))
    } catch (error) {
      onProblem(problemText(error))
    }
  }

  /** The entries; `color` false where the menu has its own color row (the list's). */
  const entries = (close: () => void, { color = true }: { color?: boolean } = {}): ReactNode => (
    <>
      {head?.can_share && !sealed && (
        <button
          type="button"
          role="menuitem"
          className="nn-menu-item"
          data-testid="note-share"
          onClick={() => {
            close()
            setDialog('share')
          }}
        >
          <Share2 className="h-4 w-4" aria-hidden />
          {t('shares.menu')}
        </button>
      )}
      {!sealed && (
        <button
          type="button"
          role="menuitem"
          className="nn-menu-item"
          data-testid="note-duplicate"
          onClick={() => {
            close()
            void duplicate()
          }}
        >
          <Copy className="h-4 w-4" aria-hidden />
          {t('editor.duplicate')}
        </button>
      )}
      {!sealed && (
        <button
          type="button"
          role="menuitem"
          className="nn-menu-item"
          data-testid="note-export"
          onClick={() => {
            close()
            setDialog('export')
          }}
        >
          <Upload className="h-4 w-4" aria-hidden />
          {t('export.menu')}
        </button>
      )}
      {NOTE_MENU_ITEMS.map((Item, index) => (
        <Item key={index} noteId={noteId} head={head} sealed={sealed} mine={mine} close={close} />
      ))}
      <Link to={historyHref(noteId)} role="menuitem" className="nn-menu-item" data-testid="note-history" onClick={close}>
        <History className="h-4 w-4" aria-hidden />
        {t('history.menu')}
      </Link>
      <button
        type="button"
        role="menuitem"
        className="nn-menu-item not-disabled:text-bad-500"
        data-testid="note-delete"
        onClick={() => {
          close()
          void remove()
        }}
        disabled={!head?.can_write}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {t('editor.delete')}
      </button>
      {color && head?.can_write && <NoteColorRow noteId={noteId} head={head} onDone={close} />}
      {head?.can_write && (
        <div className="border-t border-ink-700 px-2 pt-2 pb-1">
          <p className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.paper.label')}</p>
          <PaperPicker
            value={paperOf(head.paper)}
            role="menuitemradio"
            onChange={(paper) => {
              close()
              onHead({ ...head, paper })
              notesApi.setPaper(noteId, paper).then(onHead, (error) => onProblem(problemText(error)))
            }}
          />
        </div>
      )}
    </>
  )

  const lastStep = head?.path.length ? head.path[head.path.length - 1] : null
  const dialogs = (
    <>
      {dialog === 'share' && head && (
        <ShareDialog
          kind="note"
          id={noteId}
          title={title || head.title}
          onClose={() => {
            setDialog(null)
            onShared?.()
          }}
        />
      )}
      {dialog === 'export' && head && (
        <ExportDialog
          note={{ id: noteId, title: head.title }}
          // The note's own folder, when it is one of the member's (a shared note's folder is not theirs to export).
          folder={head.owner?.id === myId && lastStep ? { id: lastStep.id, name: lastStep.name, inbox: lastStep.inbox } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )

  return { entries, dialogs, dialogOpen: dialog !== null }
}
