/**
 * What the blocks of a note know of their attachments (NOTES-10): the server's description of each (kind, name, size,
 * pages, preview), read once per note and again when an upload of this tab is through or a block names an attachment
 * not known yet (somebody else is uploading it: asked again every few seconds for a while). And the limits before an
 * upload (the operator's limit per file, the account's storage).
 */
import { useEffect, useSyncExternalStore } from 'react'

import { onAccountChange } from '../state/account'
import { attachmentsApi, type AttachmentInfo, type Limits } from './api'
import { onUploaded } from './uploads'

/** How often a note with a block whose attachment is not there yet asks again, and for how long. */
export const ASK_AGAIN_MS = 3000
const ASK_FOR_MS = 120_000

type NoteInfo = { items: Map<string, AttachmentInfo>; loaded: boolean; loading: Promise<void> | null; missingSince: number | null }

const notes = new Map<string, NoteInfo>()
const listeners = new Set<() => void>()
let version = 0
let limitsNow: Limits | null = null
let limitsLoading: Promise<Limits | null> | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function publish(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function noteInfo(noteId: string): NoteInfo {
  let found = notes.get(noteId)
  if (!found) {
    found = { items: new Map(), loaded: false, loading: null, missingSince: null }
    notes.set(noteId, found)
  }
  return found
}

/** Reads the note's attachments from the server (once at a time). */
export function loadNote(noteId: string): Promise<void> {
  const info = noteInfo(noteId)
  if (info.loading) return info.loading
  info.loading = attachmentsApi
    .ofNote(noteId)
    .then(({ items }) => {
      for (const item of items) info.items.set(item.id, item)
      info.loaded = true
    })
    .catch(() => {
      info.loaded = true
    })
    .finally(() => {
      info.loading = null
      publish()
    })
  return info.loading
}

/** A block names an attachment the note does not know (yet): ask again in a moment, for a while. */
function missing(noteId: string): void {
  const info = noteInfo(noteId)
  info.missingSince ??= Date.now()
  if (Date.now() - info.missingSince > ASK_FOR_MS || timer) return
  timer = setTimeout(() => {
    timer = null
    void loadNote(noteId)
  }, ASK_AGAIN_MS)
}

/** What a block asks for: the note read once, asked again while the attachment is not there yet. */
function want(noteId: string, id: string): void {
  const info = noteInfo(noteId)
  if (!info.loaded && !info.loading) void loadNote(noteId)
  else if (info.loaded && !info.items.has(id)) missing(noteId)
  else if (info.items.has(id)) info.missingSince = null
}

/** The server's description of attachment `id` in note `noteId`; `undefined` while not known (`loaded` says whether
 * the note was read at all). */
export function useAttachment(noteId: string, id: string | null | undefined): { info: AttachmentInfo | undefined; loaded: boolean } {
  useSyncExternalStore(subscribe, () => version)
  const found = id ? notes.get(noteId)?.items.get(id) : undefined
  const loaded = notes.get(noteId)?.loaded ?? false
  useEffect(() => {
    if (noteId && id) want(noteId, id)
  }, [noteId, id, found, loaded])
  return { info: found, loaded }
}

/** Puts a description in by hand (the answer of an upload, a gallery entry). */
export function learn(noteId: string, item: AttachmentInfo): void {
  noteInfo(noteId).items.set(item.id, item)
  publish()
}

/** The limits, read at most once a minute (`fresh` asks now). */
export function loadLimits(fresh = false): Promise<Limits | null> {
  if (limitsLoading) return limitsLoading
  if (limitsNow && !fresh) return Promise.resolve(limitsNow)
  limitsLoading = attachmentsApi
    .limits()
    .then((found) => {
      limitsNow = found
      setTimeout(() => {
        limitsNow = null
      }, 60_000)
      return found
    })
    .catch(() => limitsNow)
    .finally(() => {
      limitsLoading = null
      publish()
    })
  return limitsLoading
}

export function useLimits(): Limits | null {
  useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    if (!limitsNow) void loadLimits()
  }, [])
  return limitsNow
}

export function forgetAttachments(): void {
  notes.clear()
  limitsNow = null
  if (timer) clearTimeout(timer)
  timer = null
  publish()
}

onUploaded((noteId, info) => {
  learn(noteId, info)
  void loadLimits(true)
})
onAccountChange(forgetAttachments)
