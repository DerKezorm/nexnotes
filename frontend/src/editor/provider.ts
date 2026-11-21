/**
 * The live connection of one note: the y-websocket protocol over `WS /api/notes/{id}/live`.
 *
 * - **Sync:** on connect it sends its state (sync step 1) and answers the room's step 1 at once with step 2, so the
 *   room has everything written offline before it sends anything of others (the room waits for that answer).
 * - **Saved, waiting:** every own change counts as waiting until the room confirms it. The room stores an update before
 *   it reads the next message of the same connection, so the answer (step 2) to a step 1 sent after some changes
 *   means they are stored. `pending` is the number of own changes not yet confirmed (NOTES-12 AC-8).
 * - **Closing codes** of the room: 4409 (writing became reading or back) reconnects at once, 1012 (server restart)
 *   and 1011 (storing failed) reconnect, 4403 (no right, session ended), 4404 (note deleted) and 4413 (too large)
 *   stop and say so; a sign-in again (`SIGNED_IN_AGAIN_EVENT`) starts once more.
 * - **Reconnecting** after a break with a growing wait (a quarter second up to five), at once when the browser says it
 *   is online again; nothing typed meanwhile is lost while the page stays open (EC-3).
 * - **Awareness:** who is here and where their caret is (y-protocols).
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { SIGNED_IN_AGAIN_EVENT } from '../state/auth'

export const MESSAGE_SYNC = 0
export const MESSAGE_AWARENESS = 1

export const CLOSE_RESTART = 1012
export const CLOSE_ERROR = 1011
export const CLOSE_BAD = 4400
export const CLOSE_FORBIDDEN = 4403
export const CLOSE_GONE = 4404
export const CLOSE_RIGHTS = 4409
export const CLOSE_TOO_LARGE = 4413
/** The note is locked in the vault, or being locked (NOTES-16): no live room; the page opens it with the password. */
export const CLOSE_LOCKED = 4423

/**
 * - `connecting`: the first connection is being made.
 * - `online`: connected and in sync.
 * - `offline`: the connection broke; changes wait in this window.
 * - `gone`: the note was deleted (EC-2). `forbidden`: no right any more (EC-5). `tooLarge`, `broken`: the room refused
 *   the content. `locked`: the note is locked in the vault (NOTES-16), or its vault closed.
 */
export type LiveStatus = 'connecting' | 'online' | 'offline' | 'gone' | 'forbidden' | 'tooLarge' | 'broken' | 'locked'

/** What an editor needs of its connection: the live room's (`NoteProvider`), or a locked note's (`vault/provider.ts`). */
export type EditorConnection = Pick<NoteProvider, 'noteId' | 'doc' | 'awareness' | 'status' | 'pending' | 'synced' | 'subscribe' | 'retryNow'>

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'binaryType'> & {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
}

export type ProviderOptions = {
  /** Makes the socket (tests hand in their own). */
  socket?: (url: string) => SocketLike
  /** The address; by default the page's host. */
  url?: string
  /** Milliseconds before an own change is confirmed with a sync step 1. */
  confirmDelay?: number
  /** Milliseconds without the answer to a confirmation before the connection counts as broken. */
  answerTimeout?: number
}

const OPEN = 1

export function liveUrl(noteId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/notes/${encodeURIComponent(noteId)}/live`
}

export class NoteProvider {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status: LiveStatus = 'connecting'
  /** The room confirmed this connection's state at least once since it was opened. */
  synced = false
  /** Has been online once: a later break is "Verbindung unterbrochen". */
  wasOnline = false

  private socket: SocketLike | null = null
  private readonly url: string
  private readonly makeSocket: (url: string) => SocketLike
  private readonly confirmDelay: number
  private readonly answerTimeout: number
  private listeners = new Set<() => void>()
  private wanted = false
  private tries = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private confirmTimer: ReturnType<typeof setTimeout> | null = null
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  /** Own changes made so far, and how many of them the room confirmed. */
  private made = 0
  private confirmed = 0
  /** The count of own changes at each sync step 1 still waiting for its answer, oldest first. */
  private asked: number[] = []

  constructor(
    readonly noteId: string,
    doc?: Y.Doc,
    options: ProviderOptions = {},
  ) {
    this.doc = doc ?? new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.url = options.url ?? liveUrl(noteId)
    this.makeSocket = options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    this.confirmDelay = options.confirmDelay ?? 250
    this.answerTimeout = options.answerTimeout ?? 10_000
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  /** Own changes the room has not confirmed yet. */
  get pending(): number {
    return this.made - this.confirmed
  }

  /** Called on every change of status, sync or the waiting count. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connect(): void {
    this.wanted = true
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline)
      window.addEventListener('offline', this.onOffline)
      window.addEventListener(SIGNED_IN_AGAIN_EVENT, this.onSignedInAgain)
    }
    this.open()
  }

  /** Leaves the note: the others learn that this window went, the connection closes, nothing reconnects. */
  disconnect(): void {
    this.wanted = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline)
      window.removeEventListener('offline', this.onOffline)
      window.removeEventListener(SIGNED_IN_AGAIN_EVENT, this.onSignedInAgain)
    }
    this.clearTimers()
    if (this.socket && this.socket.readyState === OPEN) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'leaving')
    }
    this.drop()
  }

  destroy(): void {
    this.disconnect()
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    this.awareness.destroy()
    this.listeners.clear()
  }

  /** After the note came back from the trash, or a right came back: try again. */
  retryNow(): void {
    this.wanted = true
    this.tries = 0
    this.setStatus(this.wasOnline ? 'offline' : 'connecting')
    this.open()
  }

  // --- the socket -----------------------------------------------------------------------------------------------

  private open(): void {
    if (!this.wanted || this.socket) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    let socket: SocketLike
    try {
      socket = this.makeSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.asked = []
    socket.onopen = () => {
      if (socket !== this.socket) return
      this.tries = 0
      this.sendStep1()
      if (this.awareness.getLocalState() !== null) {
        this.send(this.awarenessMessage([this.doc.clientID]))
      }
    }
    socket.onmessage = (event) => {
      if (socket !== this.socket) return
      this.onMessage(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onclose = (event) => {
      if (socket !== this.socket) return
      this.onClosed(event.code)
    }
    socket.onerror = () => undefined
  }

  private drop(): void {
    const socket = this.socket
    this.socket = null
    this.asked = []
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.answerTimer = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close()
      } catch {
        // closed already
      }
    }
    this.removeOthers()
  }

  private onClosed(code: number): void {
    this.drop()
    if (!this.wanted) return
    if (code === CLOSE_GONE) return this.stop('gone')
    if (code === CLOSE_FORBIDDEN) return this.stop('forbidden')
    if (code === CLOSE_TOO_LARGE) return this.stop('tooLarge')
    if (code === CLOSE_BAD) return this.stop('broken')
    if (code === CLOSE_LOCKED) return this.stop('locked')
    this.setStatus(this.wasOnline ? 'offline' : 'connecting')
    if (code === CLOSE_RIGHTS) {
      this.open()
      return
    }
    this.scheduleReconnect()
  }

  private stop(status: LiveStatus): void {
    this.clearTimers()
    this.setStatus(status)
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.retry) return
    const wait = Math.min(5000, 250 * 2 ** this.tries) * (0.8 + Math.random() * 0.4)
    this.tries++
    this.retry = setTimeout(() => {
      this.retry = null
      this.open()
    }, wait)
  }

  private clearTimers(): void {
    for (const timer of [this.retry, this.confirmTimer, this.answerTimer]) if (timer) clearTimeout(timer)
    this.retry = this.confirmTimer = this.answerTimer = null
  }

  private send(data: Uint8Array): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    try {
      socket.send(data)
      return true
    } catch {
      return false
    }
  }

  // --- sync -----------------------------------------------------------------------------------------------------

  private sendStep1(): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    if (this.send(encoding.toUint8Array(encoder))) {
      this.asked.push(this.made)
      if (!this.answerTimer) {
        this.answerTimer = setTimeout(() => {
          // No answer: the connection is dead without having said so (a sleeping laptop, a lost network).
          this.answerTimer = null
          if (this.socket) this.onClosed(1006)
        }, this.answerTimeout)
      }
    }
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    const kind = decoding.readVarUint(decoder)
    if (kind === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder))
      if (step === syncProtocol.messageYjsSyncStep2) this.onConfirmed()
    } else if (kind === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this)
    }
  }

  private onConfirmed(): void {
    const upTo = this.asked.shift()
    if (upTo !== undefined) this.confirmed = Math.max(this.confirmed, upTo)
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.answerTimer = null
    if (this.asked.length) {
      this.answerTimer = setTimeout(() => {
        this.answerTimer = null
        if (this.socket) this.onClosed(1006)
      }, this.answerTimeout)
    }
    this.synced = true
    this.wasOnline = true
    this.status = 'online'
    if (this.pending > 0) this.scheduleConfirm()
    this.emit()
  }

  private scheduleConfirm(): void {
    if (this.confirmTimer || this.status !== 'online') return
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null
      if (this.pending > 0 && this.status === 'online' && !this.asked.length) this.sendStep1()
      else if (this.pending > 0) this.scheduleConfirm()
    }, this.confirmDelay)
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return
    this.made++
    // Sent whenever a connection is open: the room takes updates before the sync is through, too.
    if (this.socket && this.socket.readyState === OPEN) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.send(encoding.toUint8Array(encoder))
      this.scheduleConfirm()
    }
    this.emit()
  }

  // --- awareness ------------------------------------------------------------------------------------------------

  private awarenessMessage(clients: number[]): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients))
    return encoding.toUint8Array(encoder)
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin === this) return
    const changed = [...added, ...updated, ...removed]
    if (changed.length) this.send(this.awarenessMessage(changed))
  }

  /** Others' carets go with the connection; they come back with the next one. */
  private removeOthers(): void {
    const others = [...this.awareness.getStates().keys()].filter((client) => client !== this.doc.clientID)
    if (others.length) awarenessProtocol.removeAwarenessStates(this.awareness, others, this)
  }

  // --- the browser ----------------------------------------------------------------------------------------------

  private onOnline = (): void => {
    if (!this.wanted || this.socket || !['offline', 'connecting'].includes(this.status)) return
    this.tries = 0
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.open()
  }

  private onOffline = (): void => {
    if (this.socket) this.onClosed(1006)
  }

  private onSignedInAgain = (): void => {
    if (this.status === 'forbidden') this.retryNow()
  }

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
