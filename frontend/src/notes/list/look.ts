/**
 * How every list of notes of the account looks: the style (list, cards, compact, tiles) and whether rows carry their
 * hints (checklist progress, attachments, tags). One choice for all lists (every folder, all notes, smart folders, the
 * list beside an open note), kept on the server for every device (`PUT /api/me/list-look`). The signed-in account
 * brings it (`/api/auth/me`, `state/auth.tsx` hands it here); a change shows at once and is saved behind it, and goes
 * back with a notice when the server says no.
 *
 * Outside React's tree, so that the lists, their menu "Ansicht" and the settings read the same: `useListLook`.
 */
import { useSyncExternalStore } from 'react'

import { authApi, type Me } from '../../api/client'
import { showNotice } from '../../folders/notice'
import { problemText } from '../../lib/errors'
import { onAccountChange } from '../../state/account'
import { LIST_STYLES, type ListStyle } from './api'

export type ListLook = { style: ListStyle; hints: boolean }

export const DEFAULT_LOOK: ListLook = { style: 'list', hints: true }

let look: ListLook = DEFAULT_LOOK
const listeners = new Set<() => void>()
/** Changes on their way to the server: an account answer that left before them does not undo them. */
let asked = 0

function set(next: ListLook): void {
  if (next.style === look.style && next.hints === look.hints) return
  look = next
  for (const listener of [...listeners]) listener()
}

function lookOf(me: Pick<Me, 'list_style' | 'list_hints'>): ListLook {
  const style = LIST_STYLES.includes(me.list_style as ListStyle) ? (me.list_style as ListStyle) : DEFAULT_LOOK.style
  return { style, hints: typeof me.list_hints === 'boolean' ? me.list_hints : DEFAULT_LOOK.hints }
}

/** The account as the server sent it: its look counts, unless a change made here is still on its way. */
export function takeListLook(me: Pick<Me, 'list_style' | 'list_hints'>): void {
  if (asked === 0) set(lookOf(me))
}

export function currentListLook(): ListLook {
  return look
}

/** Changes the look of every list, at once here, then on the server for the other devices. */
export function saveListLook(change: Partial<ListLook>): Promise<void> {
  const before = look
  set({ ...look, ...change })
  asked++
  return authApi
    .listLook(change)
    .then((me) => {
      asked--
      if (asked === 0) set(lookOf(me))
    })
    .catch((error: unknown) => {
      asked--
      set(before)
      showNotice({ text: problemText(error) })
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useListLook(): ListLook {
  return useSyncExternalStore(subscribe, currentListLook, currentListLook)
}

/** For tests, and when the account changes: back to the default until the next account says otherwise. */
export function forgetListLook(): void {
  asked = 0
  set(DEFAULT_LOOK)
}

onAccountChange(forgetListLook)
