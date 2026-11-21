/**
 * Where features dock onto an open note without the editor knowing them:
 *
 * - `LOCKED_VIEW`: what a locked note shows instead of the live editor (NOTES-16, the vault): the password, then the
 *   note opened in this browser. Without it a locked note says only that it is locked.
 * - `NOTE_MENU_ITEMS`: entries of the note's menu ("Sperren", "Sperre aufheben").
 */
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
