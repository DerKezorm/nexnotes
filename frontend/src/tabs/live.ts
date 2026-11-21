/**
 * The live connections of the open editors (NOTES-8, NOTES-12).
 *
 * - **Only what is on show is connected.** An editor takes its connection with `acquireProvider` and gives it back
 *   with `releaseProvider`. A connection without waiting changes closes at once; one with changes the room has not
 *   confirmed yet (typed offline, say) stays open, parked, until everything is stored, and opening the note again
 *   takes exactly that connection and its document back. Six tabs never mean six connections, and a tab that goes
 *   out of view or is pushed out by a seventh loses nothing.
 * - **The same note twice in this window** (EC-1): two connections, as two windows would have (each with its own
 *   presence, "du, anderes Fenster", and its own undo), and a bridge between their documents here, so that what is
 *   typed on one side shows on the other at once, offline too. When a second one joins, both hand each other their
 *   whole state; afterwards each change typed on one side goes into the other document and out over both
 *   connections (the room takes an update twice without harm).
 */
import * as Y from 'yjs'

import { NoteProvider, type LiveStatus } from '../editor/provider'
import { onAccountChange } from '../state/account'

/** The origin of an update brought over by the bridge: its document counts it as its own and sends it too. */
export const BRIDGE = Symbol('nexnotes-tab-bridge')

const STOPPED: LiveStatus[] = ['gone', 'tooLarge', 'broken']

type Parked = { provider: NoteProvider; stop: () => void }

const members = new Map<string, Set<NoteProvider>>()
const bridges = new Map<NoteProvider, () => void>()
const parked = new Map<string, Parked[]>()
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
  const set = members.get(note) ?? new Set<NoteProvider>()
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
      for (const other of members.get(note) ?? []) if (other !== provider) Y.applyUpdate(other.doc, update, BRIDGE)
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
  members.set(note, set)
  bridges.set(provider, () => {
    provider.doc.off('update', onUpdate)
    watch()
    set.delete(provider)
    if (!set.size) members.delete(note)
  })
}

function leave(provider: NoteProvider): void {
  bridges.get(provider)?.()
  bridges.delete(provider)
}

/** The connection for an editor of this note: the parked one with its waiting changes, or a new one. */
export function acquireProvider(noteId: string): NoteProvider {
  const waiting = parked.get(noteId)?.shift()
  if (waiting && !parked.get(noteId)?.length) parked.delete(noteId)
  let provider: NoteProvider
  if (waiting) {
    waiting.stop()
    provider = waiting.provider
  } else {
    provider = new NoteProvider(noteId, new Y.Doc())
    provider.connect()
  }
  join(provider)
  return provider
}

/** Gives a connection back: closed at once, or kept until the room confirmed what still waits. */
export function releaseProvider(provider: NoteProvider): void {
  leave(provider)
  if (provider.pending === 0 || STOPPED.includes(provider.status)) {
    provider.destroy()
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
    provider.destroy()
  })
  entry.stop = unsubscribe
  const list = parked.get(provider.noteId) ?? []
  list.push(entry)
  parked.set(provider.noteId, list)
}

function unpark(entry: Parked): void {
  entry.stop()
  const list = parked.get(entry.provider.noteId)
  if (!list) return
  const rest = list.filter((one) => one !== entry)
  if (rest.length) parked.set(entry.provider.noteId, rest)
  else parked.delete(entry.provider.noteId)
}

/** Connections parked with changes still waiting (for the warning when the browser tab closes, and for tests). */
export function parkedProviders(): NoteProvider[] {
  return [...parked.values()].flat().map((entry) => entry.provider)
}

/** How many other editors of the same note are open in this window. */
export function othersOpen(provider: NoteProvider): number {
  return [...(members.get(provider.noteId) ?? [])].filter((other) => other !== provider).length
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
    entry.provider.destroy()
  }
  parked.clear()
}

// A parked connection holds a note of the account before: gone with it, never carried over to the next one.
onAccountChange(forgetParked)
