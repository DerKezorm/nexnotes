/**
 * Attachments in the editor (NOTES-10): the blocks drawn as React views, and the ways a file comes in.
 *
 * - **Dropped, pasted or chosen** (AC-1): each file becomes a block at that place at once, with an id made here, and
 *   goes into the line of uploads (`uploads.ts`, at most three at a time, EC-6). A file over the operator's limit, or
 *   any file while the storage is full, never becomes a block: the note says so with name, size and limit, until put
 *   away (AC-6, EC-1).
 * - **A link pasted** on its own line stays a plain link at once; when the server sends a card (AC-5) and the line is
 *   still just that link, it becomes the card. Switched off by the operator (AC-9), a page that cannot be reached or an
 *   address at home (EC-5, EC-11): it stays the link, nobody waits.
 * - A note one only reads takes nothing (EC-10): drops are swallowed, nothing is pasted.
 *
 * The views (`NodeView.tsx`) extend the schema's nodes (`schema.mjs`) without changing them: only how they are drawn.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { useSyncExternalStore } from 'react'

import { onAccountChange } from '../state/account'
import { attachmentsApi, newAttachmentId, type LinkCard } from './api'
import { loadLimits } from './info'
import { BlockView } from './NodeView'
import { enqueue } from './uploads'

export const MB = 1024 * 1024
/** The schema's nodes that name an attachment; sketches and recordings (NOTES-18) come from the iOS app. */
export const ATTACHMENT_NODES = ['image', 'attachment', 'linkPreview', 'drawing', 'recording']
/** Endings of pictures a browser may not call `image/*` (HEIC from an iPhone on Windows). */
const PICTURE_ENDINGS = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i

// --- Refused files ----------------------------------------------------------------------------------------------------

export type Refusal = { key: number; name: string; size: number; reason: 'too_large' | 'full'; maxMb?: number; used?: number; limit?: number | null }

const refusals = new Map<string, Refusal[]>()
const refusalListeners = new Set<() => void>()
let refusalVersion = 0
let refusalKey = 0

function publishRefusals(): void {
  refusalVersion += 1
  for (const listener of refusalListeners) listener()
}

export function refuse(noteId: string, refusal: Omit<Refusal, 'key'>): void {
  refusalKey += 1
  refusals.set(noteId, [...(refusals.get(noteId) ?? []), { ...refusal, key: refusalKey }])
  publishRefusals()
}

export function dismissRefusal(noteId: string, key: number): void {
  refusals.set(noteId, (refusals.get(noteId) ?? []).filter((refusal) => refusal.key !== key))
  publishRefusals()
}

export function useRefusals(noteId: string): Refusal[] {
  useSyncExternalStore(
    (listener) => {
      refusalListeners.add(listener)
      return () => refusalListeners.delete(listener)
    },
    () => refusalVersion,
  )
  return refusals.get(noteId) ?? []
}

onAccountChange(() => {
  refusals.clear()
  publishRefusals()
})

// --- Files in -----------------------------------------------------------------------------------------------------------

export function isPicture(file: File): boolean {
  return file.type.startsWith('image/') || PICTURE_ENDINGS.test(file.name)
}

/** The files as blocks at `at` (the selection without it), each one uploading or in line; returns the ids. */
export async function attachFiles(editor: Editor, noteId: string, files: FileList | File[], at?: number): Promise<string[]> {
  const list = Array.from(files)
  if (!list.length || !editor.isEditable || editor.isDestroyed) return []
  const limits = await loadLimits()
  const accepted: File[] = []
  for (const file of list) {
    if (limits && file.size > limits.max_mb * MB) refuse(noteId, { name: file.name, size: file.size, reason: 'too_large', maxMb: limits.max_mb })
    else if (limits?.full) refuse(noteId, { name: file.name, size: file.size, reason: 'full', used: limits.used, limit: limits.limit })
    else accepted.push(file)
  }
  if (!accepted.length || editor.isDestroyed) return []
  const blocks = accepted.map((file) => ({ file, id: newAttachmentId(), type: isPicture(file) ? 'image' : 'attachment' }))
  const size = editor.state.doc.content.size
  const where = Math.max(0, Math.min(at ?? editor.state.selection.to, size))
  editor
    .chain()
    .insertContentAt(
      where,
      blocks.map((block) => ({ type: block.type, attrs: { id: block.id, name: block.file.name || null } })),
    )
    .run()
  for (const block of blocks) enqueue(noteId, block.id, block.file, block.file.name || 'file')
  return blocks.map((block) => block.id)
}

// --- Links in -----------------------------------------------------------------------------------------------------------

/** An address pasted on its own: http or https, no spaces. */
export function pastedLink(text: string | undefined | null): string | null {
  const value = (text ?? '').trim()
  if (!value || /\s/.test(value) || value.length > 2048 || !/^https?:\/\/[^/]/i.test(value)) return null
  try {
    new URL(value)
  } catch {
    return null
  }
  return value
}

/** The top-level paragraph that holds nothing but the link `href` with itself as its words. */
function lonelyLink(doc: PMNode, href: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  doc.forEach((node, offset) => {
    if (found || node.type.name !== 'paragraph' || node.childCount !== 1) return
    const text = node.firstChild
    if (!text?.isText || text.text?.trim() !== href) return
    if (!text.marks.some((mark) => mark.type.name === 'link' && mark.attrs.href === href)) return
    found = { from: offset, to: offset + node.nodeSize }
  })
  return found
}

/** Asks the server for the card of `href`; when it comes and the link still stands alone in its line, the line
 * becomes the card. Returns whether it did. */
export async function previewLink(editor: Editor, noteId: string, href: string): Promise<boolean> {
  const limits = await loadLimits()
  if (limits && !limits.link_previews) return false
  let card: LinkCard | null
  try {
    card = (await attachmentsApi.linkPreview(noteId, href)).preview
  } catch {
    return false
  }
  if (!card || editor.isDestroyed || !editor.isEditable) return false
  const place = lonelyLink(editor.state.doc, href)
  if (!place) return false
  const node = editor.schema.nodes.linkPreview.create({ ...card })
  editor.view.dispatch(editor.state.tr.replaceWith(place.from, place.to, node))
  return true
}

/** A link put in by hand (the phone's "Link"): a line of its own at the end, then its card. */
export function insertLink(editor: Editor, noteId: string, href: string): void {
  const end = editor.state.doc.content.size
  editor
    .chain()
    .insertContentAt(end, { type: 'paragraph', content: [{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }] })
    .run()
  void previewLink(editor, noteId, href)
}

// --- The editor's extension -------------------------------------------------------------------------------------------

export function attachmentEditing(noteId: string): AnyExtension {
  return Extension.create({
    name: 'noteAttachments',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: new PluginKey('noteAttachments'),
          props: {
            handleDrop: (view, event, _slice, moved) => {
              const files = (event as DragEvent).dataTransfer?.files
              if (moved || !files || files.length === 0) return false
              event.preventDefault()
              if (!view.editable || !noteId) return true
              const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos
              void attachFiles(editor, noteId, files, at)
              return true
            },
            handlePaste: (view, event) => {
              const files = event.clipboardData?.files
              if (files && files.length > 0) {
                if (!view.editable || !noteId) return true
                event.preventDefault()
                void attachFiles(editor, noteId, files)
                return true
              }
              const href = pastedLink(event.clipboardData?.getData('text/plain'))
              const { selection, schema } = view.state
              if (!href || !selection.empty || !noteId || !view.editable || selection.$from.parent.type.spec.code) return false
              event.preventDefault()
              view.dispatch(view.state.tr.replaceSelectionWith(schema.text(href, [schema.marks.link.create({ href })]), false))
              void previewLink(editor, noteId, href)
              return true
            },
          },
        }),
      ]
    },
  })
}

/** The schema's node with its view; the schema stays as it is. */
export function withAttachmentView(extension: AnyExtension, noteId: string): AnyExtension {
  return (extension as unknown as { extend: (config: object) => AnyExtension }).extend({
    addOptions() {
      return { noteId }
    },
    addNodeView() {
      return ReactNodeViewRenderer(BlockView)
    },
  })
}
