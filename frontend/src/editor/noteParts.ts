/**
 * Where features dock onto an open note without the editor knowing them:
 *
 * - `LOCKED_VIEW`: what a locked note shows instead of the live editor (NOTES-16, the vault): the password, then the
 *   note opened in this browser. Without it a locked note says only that it is locked.
 * - `NOTE_MENU_ITEMS`: entries of the note's menu ("Sperren", "Sperre aufheben").
 * - `NOTE_HEAD_PARTS`: parts in the head of an open note that work with its text ("An nextasks", NOTES-19).
 * - `SELECTION_ACTIONS`: buttons at the end of the bar at the selection that do something with the selected text
 *   ("Als nextasks-Aufgabe"); each says for an editor whether it is offered there now.
 */
import type { Editor } from '@tiptap/react'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import type { NoteHead } from '../notes/api'
import type { LeaveGuard } from '../notes/context'
import type { LiveStatus } from './provider'

export type LockedViewProps = {
  noteId: string
  fresh?: boolean
  onDeleted?: () => void
  guarded?: boolean
  onGuard?: (guard: LeaveGuard | null) => void
  stoppedExtra?: (status: LiveStatus) => ReactNode
  /** The lock was taken off ("Sperre aufheben"): the live editor again. */
  onUnlocked: () => void
}

export const LOCKED_VIEW: { render: ((props: LockedViewProps) => ReactNode) | null } = { render: null }

export type NoteMenuContext = {
  noteId: string
  head: NoteHead | null
  /** The note is open locked (from the vault). */
  sealed: boolean
  /** The account owns the note. */
  mine: boolean
  close: () => void
}

export const NOTE_MENU_ITEMS: ComponentType<NoteMenuContext>[] = []

export type NoteHeadPartProps = {
  noteId: string
  editor: Editor
  head: NoteHead | null
  /** The note is open locked (from the vault): nothing of its text goes anywhere but encrypted. */
  sealed: boolean
}

export const NOTE_HEAD_PARTS: ComponentType<NoteHeadPartProps>[] = []

export type SelectionAction = { key: string; label: string; icon: LucideIcon; run: () => void }

export const SELECTION_ACTIONS: ((editor: Editor, t: TFunction) => SelectionAction | null)[] = []
