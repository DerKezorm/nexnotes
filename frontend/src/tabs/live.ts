/**
 * The live connections of the open editors (NOTES-8, NOTES-12).
 *
 * - **Only what is on show is connected.** An editor takes its connection with `acquireProvider` and gives it back
 *   with `releaseProvider`. A connection without waiting changes closes at once; one with changes the room has not
 *   confirmed yet (typed offline, say) stays open, parked, until everything is stored, and opening the note again
 *   takes exactly that connection and its document back. Six tabs never mean six connections, and a tab that goes
 *   out of view or is pushed out by a seventh loses nothing.
 * - **The same note twice in this window** (EC-1): two connections, as two windows would have (each with its own
 *   presence and its own undo; neither shows the other as "du, anderes Fenster", `presence.ts`), and a bridge between
 *   their documents here, so that what is typed on one side shows on the other at once, offline too. When a second one joins, both hand each other their
 *   whole state; afterwards each change typed on one side goes into the other document and out over both
 *   connections (the room takes an update twice without harm).
 * - **Each connection belongs to the account it was opened for.** Bridges and parked connections are kept per account
 *   and note: an editor of another account never takes a parked connection of the one before, nor meets its document
 *   over a bridge. Signing out or another account in the tab closes what was parked; an editor of the account before
 *   that goes only afterwards (the page is drawn anew a moment later) closes its connection instead of parking it in
 *   the next account's place. What still waited is lost then; the page says so (`state/auth.tsx`).
 */
import * as Y from 'yjs'

import { NoteProvider, type LiveStatus } from '../editor/provider'
import { currentAccount, onAccountChange, onWaiting } from '../state/account'

/** The origin of an update brought over by the bridge: its document counts it as its own and sends it too. */
export const BRIDGE = Symbol('nexnotes-tab-bridge')

const STOPPED: LiveStatus[] = ['gone', 'tooLarge', 'broken', 'locked']

type Parked = { provider: NoteProvider; stop: () => void }

/** Members and parked connections are kept under the account and the note: `<account>:<note>`. */
const members = new Map<string, Set<NoteProvider>>()
const bridges = new Map<NoteProvider, () => void>()
const parked = new Map<string, Parked[]>()
/** The account each connection was opened for. */
const owners = new Map<NoteProvider, number | null>()

function placeOf(provider: NoteProvider): string {
  return `${owners.get(provider) ?? 'none'}:${provider.noteId}`
}
const stoppedListeners = new Set<(note: string) => void>()
let forwarding = false
let unloadWatched = false

/** Called when a connection of a note stops for good (deleted, no access): its tab reads the head again. */
export function onLiveStopped(listener: (note: string) => void): () => void {
  stoppedListeners.add(listener)
  return () => stoppedListeners.delete(listener)
}

function join(provider: NoteProvider): void {
  const note = provider.noteId
  const place = placeOf(provider)
  const set = members.get(place) ?? new Set<NoteProvider>()
  forwarding = true
  try {
    for (const other of set) {
      // Each takes the other's state as if it came from its room: nothing is sent twice for it.
      Y.applyUpdate(provider.doc, Y.encodeStateAsUpdate(other.doc), provider)
      Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(provider.doc), other)
    }
  } finally {
    forwarding = false
  }
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    // What came from a room arrives at every connection by itself; only what was typed here crosses.
    if (forwarding || origin instanceof NoteProvider) return
    forwarding = true
    try {
      for (const other of members.get(place) ?? []) if (other !== provider) Y.applyUpdate(other.doc, update, BRIDGE)
    } finally {
      forwarding = false
    }
  }
  provider.doc.on('update', onUpdate)
  let last = provider.status
  const watch = provider.subscribe(() => {
    if (provider.status === last) return
    last = provider.status
    if (STOPPED.includes(last) || last === 'forbidden') for (const listener of [...stoppedListeners]) listener(note)
  })
  set.add(provider)
  members.set(place, set)
  bridges.set(provider, () => {
    provider.doc.off('update', onUpdate)
    watch()
    set.delete(provider)
    if (!set.size && members.get(place) === set) members.delete(place)
  })
}

function leave(provider: NoteProvider): void {
  bridges.get(provider)?.()
  bridges.delete(provider)
}

/** The connection for an editor of this note: the parked one of this account with its waiting changes, or a new
 * one. */
export function acquireProvider(noteId: string): NoteProvider {
  const account = currentAccount()
  const place = `${account ?? 'none'}:${noteId}`
  const waiting = parked.get(place)?.shift()
  if (waiting && !parked.get(place)?.length) parked.delete(place)
  let provider: NoteProvider
  if (waiting) {
    waiting.stop()
    provider = waiting.provider
  } else {
    provider = new NoteProvider(noteId, new Y.Doc())
    owners.set(provider, account)
    provider.connect()
  }
  join(provider)
  return provider
}

function close(provider: NoteProvider): void {
  owners.delete(provider)
  provider.destroy()
}

/** Gives a connection back: closed at once, or kept until the room confirmed what still waits. */
export function releaseProvider(provider: NoteProvider): void {
  leave(provider)
  // Given back after the account of the tab changed: it belongs to the account before and goes with it.
  if (provider.pending === 0 || STOPPED.includes(provider.status) || owners.get(provider) !== currentAccount()) {
    close(provider)
    return
  }
  watchUnload()
  const entry: Parked = {
    provider,
    stop: () => undefined,
  }
  const unsubscribe = provider.subscribe(() => {
    if (provider.pending > 0 && !STOPPED.includes(provider.status)) return
    unpark(entry)
    close(provider)
  })
  entry.stop = unsubscribe
  const place = placeOf(provider)
  const list = parked.get(place) ?? []
  list.push(entry)
  parked.set(place, list)
}

function unpark(entry: Parked): void {
  entry.stop()
  const place = placeOf(entry.provider)
  const list = parked.get(place)
  if (!list) return
  const rest = list.filter((one) => one !== entry)
  if (rest.length) parked.set(place, rest)
  else parked.delete(place)
}

/** Connections parked with changes still waiting (for the warning when the browser tab closes, and for tests). */
export function parkedProviders(): NoteProvider[] {
  return [...parked.values()].flat().map((entry) => entry.provider)
}

/** How many other editors of the same note are open in this window. */
export function othersOpen(provider: NoteProvider): number {
  return [...(members.get(placeOf(provider)) ?? [])].filter((other) => other !== provider).length
}

/** Changes still waiting in every connection of this window, open or parked (for the question before signing out). */
export function waitingInConnections(): number {
  const all = new Set<NoteProvider>([...[...members.values()].flatMap((set) => [...set]), ...parkedProviders()])
  return [...all].reduce((sum, provider) => sum + (STOPPED.includes(provider.status) ? 0 : provider.pending), 0)
}

function watchUnload(): void {
  if (unloadWatched || typeof window === 'undefined') return
  unloadWatched = true
  window.addEventListener('beforeunload', (event) => {
    if (parkedProviders().some((provider) => provider.pending > 0)) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
}

/** For tests: every parked connection closed. */
export function forgetParked(): void {
  for (const entry of [...parked.values()].flat()) {
    entry.stop()
    close(entry.provider)
  }
  parked.clear()
}

// A parked connection holds a note of the account before: gone with it, never carried over to the next one.
onAccountChange(forgetParked)
onWaiting(waitingInConnections)
