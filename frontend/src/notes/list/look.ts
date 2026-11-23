/**
 * How every list of notes of the account looks: the style (list, cards, compact, tiles) and which hints rows carry
 * (checklist progress, attachments, tags; each kind on or off, NOTES-6, NOTESIOS-6 AC-1). One choice for all lists
 * (every folder, all notes, smart folders, the list beside an open note), kept on the server for every device (`PUT /api/me/list-look`). The signed-in account
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
import { ALL_HINTS, hintKinds, sameKinds, type HintKinds } from './hintKinds'

export { ALL_HINTS, HINT_KINDS, NO_HINTS, anyHints, hintKinds, type HintKind, type HintKinds } from './hintKinds'

export type ListLook = { style: ListStyle; hints: HintKinds }
/** A change of the look: the style, the kinds it names. */
export type ListLookChange = { style?: ListStyle; hints?: Partial<HintKinds> }

export const DEFAULT_LOOK: ListLook = { style: 'list', hints: ALL_HINTS }

let look: ListLook = DEFAULT_LOOK
const listeners = new Set<() => void>()
/** Changes on their way to the server: an account answer that left before them does not undo them. */
let asked = 0

function set(next: ListLook): void {
  if (next.style === look.style && sameKinds(next.hints, look.hints)) return
  look = next
  for (const listener of [...listeners]) listener()
}

type LookOfMe = Pick<Me, 'list_style' | 'list_hints' | 'list_hint_kinds'>

/** The kinds as the server sent them; a server from before the kinds sends the one switch for all three. */
function kindsOf(me: LookOfMe): HintKinds {
  const sent = me.list_hint_kinds
  if (sent && typeof sent === 'object') {
    return { checklist: sent.checklist !== false, attachments: sent.attachments !== false, tags: sent.tags !== false }
  }
  return typeof me.list_hints === 'boolean' ? hintKinds(me.list_hints) : DEFAULT_LOOK.hints
}

function lookOf(me: LookOfMe): ListLook {
  const style = LIST_STYLES.includes(me.list_style as ListStyle) ? (me.list_style as ListStyle) : DEFAULT_LOOK.style
  return { style, hints: kindsOf(me) }
}

/** The account as the server sent it: its look counts, unless a change made here is still on its way. */
export function takeListLook(me: LookOfMe): void {
  if (asked === 0) set(lookOf(me))
}

export function currentListLook(): ListLook {
  return look
}

/** Changes the look of every list, at once here, then on the server for the other devices. */
export function saveListLook(change: ListLookChange): Promise<void> {
  const before = look
  set({ style: change.style ?? look.style, hints: { ...look.hints, ...change.hints } })
  asked++
  return authApi
    .listLook({ ...(change.style ? { style: change.style } : {}), ...(change.hints ? { hint_kinds: change.hints } : {}) })
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
