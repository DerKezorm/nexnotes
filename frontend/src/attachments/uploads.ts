/**
 * The uploads of this tab (NOTES-10): at most `AT_ONCE` at the same time, the rest wait in turn (EC-6). Each one is
 * known by the id of its block in the note, so the block shows its progress, "wartet", a cancel button (AC-10) or, when
 * the connection broke, "Hochladen abgebrochen … Der Anhang fehlt noch" with "Erneut hochladen" (EC-2). Writing goes on
 * meanwhile: nothing here touches the editor.
 *
 * The store lives outside React; the blocks read it with `useUpload`. A done upload leaves the store, and the block
 * then shows the attachment the server describes (`info.ts`).
 */
import { useSyncExternalStore } from 'react'

import { ApiError } from '../api/client'
import { onAccountChange } from '../state/account'
import { sendFile, type AttachmentInfo, type Sending } from './api'

/** Uploads at the same moment (the spec: 3). */
export const AT_ONCE = 3

export type UploadState = 'waiting' | 'uploading' | 'failed'

export type Upload = {
  id: string
  noteId: string
  name: string
  size: number
  state: UploadState
  /** 0 to 1 while uploading. */
  progress: number
  /** Why it failed: `network` (the connection was gone) or the server's code. */
  error?: string
  values?: Record<string, unknown>
}

type Entry = Upload & { file: Blob; sending?: Sending }

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const finished = new Set<(noteId: string, info: AttachmentInfo) => void>()
let snapshot: Map<string, Upload> = new Map()

function publish(): void {
  snapshot = new Map([...entries].map(([id, { file: _file, sending: _sending, ...shown }]) => [id, { ...shown }]))
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Heard when an upload is through: the note's attachments are read again. */
export function onUploaded(listener: (noteId: string, info: AttachmentInfo) => void): () => void {
  finished.add(listener)
  return () => finished.delete(listener)
}

function running(): number {
  return [...entries.values()].filter((entry) => entry.state === 'uploading').length
}

function pump(): void {
  for (const entry of entries.values()) {
    if (running() >= AT_ONCE) return
    if (entry.state === 'waiting') start(entry)
  }
}

function start(entry: Entry): void {
  entry.state = 'uploading'
  entry.progress = 0
  entry.error = undefined
  entry.values = undefined
  const sending = sendFile(entry.noteId, entry.id, entry.file, entry.name, (part) => {
    if (entries.get(entry.id) !== entry) return
    entry.progress = part
    publish()
  })
  entry.sending = sending
  publish()
  sending.done.then(
    (info) => {
      if (entries.get(entry.id) === entry) entries.delete(entry.id)
      publish()
      for (const listener of finished) listener(entry.noteId, info)
      pump()
    },
    (error: unknown) => {
      if (entries.get(entry.id) !== entry) return pump()
      const code = error instanceof ApiError ? error.code : 'network'
      if (code === 'cancelled') entries.delete(entry.id)
      else {
        entry.state = 'failed'
        entry.error = code
        entry.values = error instanceof ApiError ? error.values : undefined
        entry.sending = undefined
      }
      publish()
      pump()
    },
  )
}

/** Puts a file in line for the block `id` of the note; it starts at once while fewer than `AT_ONCE` run. */
export function enqueue(noteId: string, id: string, file: Blob, name: string): void {
  entries.set(id, { id, noteId, name, size: file.size, state: 'waiting', progress: 0, file })
  publish()
  pump()
}

/** Stops an upload (or takes a waiting one out of the line); the block goes from the note with it. */
export function cancelUpload(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  entry.sending?.cancel()
  publish()
  pump()
}

/** The same file once more, after the connection broke (EC-2). */
export function retryUpload(id: string): void {
  const entry = entries.get(id)
  if (!entry || entry.state !== 'failed') return
  entry.state = 'waiting'
  entry.error = undefined
  publish()
  pump()
}

/** What this tab knows of the upload of block `id`, or nothing (not uploaded here, or through). */
export function useUpload(id: string | null | undefined): Upload | undefined {
  const all = useSyncExternalStore(subscribe, () => snapshot)
  return id ? all.get(id) : undefined
}

/** For tests: every upload of the tab, and a way to forget them. */
export function uploadsNow(): Upload[] {
  return [...snapshot.values()]
}

export function forgetUploads(): void {
  for (const entry of entries.values()) entry.sending?.cancel()
  entries.clear()
  publish()
}

onAccountChange(forgetUploads)
