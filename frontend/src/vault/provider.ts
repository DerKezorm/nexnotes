/**
 * The connection of an open locked note (NOTES-16): no live room (NOTES-12 leaves locked notes out), the whole Yjs
 * state encrypted here and saved as one piece.
 *
 * - **Saving:** every change counts as waiting; a moment after the last one the state is encrypted with the note's
 *   key and sent with the revision it started from. The server keeps the latest save; one made on an older revision
 *   still wins, and what it replaced stays in the history (EC-5).
 * - **Another device:** every few seconds the revision is asked; a newer one with nothing waiting here is loaded
 *   (`onNewer`). A changed vault (`epoch`) closes the vault here (EC-7).
 * - **Closing:** before the vault closes (five minutes without use, the last locked note gone), what waits is saved.
 * The editor sees the same surface as the live room's provider (`EditorConnection`).
 */
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'

import { ApiError } from '../api/client'
import type { LiveStatus } from '../editor/provider'
import { vaultApi } from './api'
import { noteAad, seal, toB64 } from './crypto'
import { epochSeen, lockVault, onBeforeLock } from './session'

export type SealedOptions = { saveDelay?: number; pollEvery?: number }

export class SealedProvider {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status: LiveStatus = 'online'
  synced = true
  pending = 0
  rev: number
  /** Another device saved a newer revision while nothing waited here. */
  onNewer: ((rev: number) => void) | null = null

  private listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private saving: Promise<void> | null = null
  private again = false
  private stopBeforeLock: () => void
  private readonly saveDelay: number

  constructor(
    readonly noteId: string,
    doc: Y.Doc,
    rev: number,
    private readonly key: CryptoKey,
    private readonly epoch: number,
    options: SealedOptions = {},
  ) {
    this.doc = doc
    this.rev = rev
    this.awareness = new awarenessProtocol.Awareness(doc)
    this.saveDelay = options.saveDelay ?? 700
    this.doc.on('update', this.onUpdate)
    this.stopBeforeLock = onBeforeLock(() => this.flush())
    const every = options.pollEvery ?? 5000
    if (every > 0) this.pollTimer = setInterval(() => void this.poll(), every)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  retryNow(): void {
    void this.flush()
  }

  /** Saves what waits, now. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.saving) {
      this.again = true
      await this.saving
      return
    }
    if (this.pending === 0) return
    this.saving = this.save().finally(() => {
      this.saving = null
    })
    await this.saving
    if (this.again) {
      this.again = false
      await this.flush()
    }
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.saveTimer = this.pollTimer = null
    this.stopBeforeLock()
    this.doc.off('update', this.onUpdate)
    this.awareness.destroy()
    this.listeners.clear()
  }

  private onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === this) return
    this.pending += 1
    this.emit()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, this.saveDelay)
  }

  private async save(): Promise<void> {
    const sending = this.pending
    const state = Y.encodeStateAsUpdate(this.doc) as Uint8Array<ArrayBuffer>
    try {
      const sealed = await seal(this.key, state, noteAad(this.noteId))
      const answer = await vaultApi.save({
        note: this.noteId,
        content: toB64(sealed),
        base_rev: this.rev,
        epoch: this.epoch,
        title: this.doc.getText('title').toString(),
      })
      this.rev = answer.rev
      this.pending = Math.max(0, this.pending - sending)
      this.status = 'online'
    } catch (error) {
      if (error instanceof ApiError && error.code === 'vault_changed') {
        this.status = 'locked'
        this.emit()
        epochSeen(Number(error.values.epoch ?? -1))
        void lockVault('changed')
        return
      }
      if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'note_not_locked')) {
        this.status = error.code === 'not_found' ? 'gone' : 'locked'
      } else {
        // The connection is away: what waits stays here and goes with the next try.
        this.status = 'offline'
        if (!this.saveTimer) this.saveTimer = setTimeout(() => void this.flush(), 3000)
      }
    }
    this.emit()
  }

  private async poll(): Promise<void> {
    if (document.visibilityState === 'hidden' || this.saving) return
    try {
      const found = await vaultApi.sealed(this.noteId)
      epochSeen(found.epoch)
      if (found.rev > this.rev && this.pending === 0 && !this.saving) this.onNewer?.(found.rev)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'note_not_locked') {
        this.status = 'locked'
        this.emit()
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
