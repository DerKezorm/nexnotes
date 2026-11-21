/**
 * The lines sent to nextasks and their marks in the text (NOTES-19 AC-3, EC-3, EC-5).
 *
 * A mark is not part of the note: it is the member's own (EC-5), kept by the server, and drawn here as a decoration at
 * the end of its line. It sits on the line by the id Yjs gave the line's block (`<client>.<clock>` of the paragraph,
 * heading, list or checklist item): the id stays while the text inside changes (EC-3), and when the line is deleted
 * its block is gone and so is the mark. The note's format stays as it is.
 *
 * Yjs blocks and ProseMirror nodes are paired by y-prosemirror's mapping (`ySyncPluginKey`), which it brings up to date
 * in its view's update. The marks are therefore placed in this plugin's view update (after it), and in between moved
 * along with every change (`DecorationSet.map`).
 */
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

import type { SendLine, TaskMark } from './api'

/** The most lines one sending holds (the server's limit). */
export const MAX_LINES = 50
/** Blocks a line belongs to as a whole: the item of a list or a checklist, not the paragraph inside it. */
const ITEMS = new Set(['taskItem', 'listItem'])

type MarkState = { links: TaskMark[]; decos: DecorationSet }

export const marksKey = new PluginKey<MarkState>('nextasksMarks')

type Mapping = Map<Y.AbstractType<unknown>, PMNode | PMNode[]>

function mappingOf(state: EditorState): Mapping | null {
  const sync = ySyncPluginKey.getState(state) as { binding?: { mapping?: Mapping } } | undefined
  return sync?.binding?.mapping ?? null
}

function idOf(type: { _item: Y.Item | null }): string | null {
  const item = type._item
  return item ? `${item.id.client}.${item.id.clock}` : null
}

/** The block a line belongs to (a list or checklist item, else the text block itself) and where it starts. */
function blockAt(doc: PMNode, inside: number): { node: PMNode; pos: number; text: PMNode } | null {
  const $pos = doc.resolve(inside)
  if (!$pos.parent.isTextblock) return null
  if ($pos.depth >= 2) {
    const item = $pos.node($pos.depth - 1)
    if (ITEMS.has(item.type.name) && item.firstChild === $pos.parent) return { node: item, pos: $pos.before($pos.depth - 1), text: $pos.parent }
  }
  return { node: $pos.parent, pos: $pos.before(), text: $pos.parent }
}

/** The Yjs id of a block node, from the mapping; `null` while the editor has not paired it (no live document). */
export function anchorOf(state: EditorState, node: PMNode): string | null {
  const mapping = mappingOf(state)
  if (!mapping) return null
  for (const [type, mapped] of mapping) {
    if (mapped === node && type instanceof Y.XmlElement) return idOf(type)
  }
  return null
}

/**
 * The lines to send from the selection (AC-1, EC-2): one per line touched, each with its block's id. A part of a
 * single line selected goes as that part; without a selection the line of the cursor goes.
 */
export function linesToSend(state: EditorState): SendLine[] {
  const { from, to, empty } = state.selection
  const blocks: Array<{ node: PMNode; text: string }> = []
  const seen = new Set<PMNode>()
  const add = (inside: number) => {
    const block = blockAt(state.doc, inside)
    if (!block || seen.has(block.node)) return
    seen.add(block.node)
    blocks.push({ node: block.node, text: block.text.textContent })
  }
  if (empty) add(from)
  else {
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) {
        add(pos + 1)
        return false
      }
      return true
    })
  }
  if (!empty && blocks.length === 1) {
    const part = state.doc.textBetween(from, to, ' ').trim()
    if (part) blocks[0].text = part
  }
  const lines: SendLine[] = []
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, ' ').trim()
    const anchor = anchorOf(state, block.node)
    if (text && anchor) lines.push({ text, anchor })
    if (lines.length >= MAX_LINES) break
  }
  return lines
}

/** Where each mark stands now: at the end of the first text of its block. Blocks gone (a deleted line) have none. */
export function placeMarks(state: EditorState, links: TaskMark[]): Array<{ mark: TaskMark; pos: number }> {
  const mapping = mappingOf(state)
  if (!mapping || links.length === 0) return []
  const byAnchor = new Map<string, TaskMark>()
  // Sent twice from the same line: the newest mark.
  for (const link of links) byAnchor.set(link.anchor, link)
  const wanted = new Map<PMNode, TaskMark>()
  for (const [type, node] of mapping) {
    if (Array.isArray(node) || !(type instanceof Y.XmlElement)) continue
    const id = idOf(type)
    const mark = id ? byAnchor.get(id) : undefined
    if (mark) wanted.set(node, mark)
  }
  if (wanted.size === 0) return []
  const placed: Array<{ mark: TaskMark; pos: number }> = []
  state.doc.descendants((node, pos) => {
    const mark = wanted.get(node)
    if (!mark) return true
    let end = -1
    node.descendants((inner, offset) => {
      if (end >= 0) return false
      if (inner.isTextblock) {
        end = pos + 1 + offset + 1 + inner.content.size
        return false
      }
      return true
    })
    if (node.isTextblock) end = pos + 1 + node.content.size
    if (end >= 0) placed.push({ mark, pos: end })
    return false
  })
  return placed
}

function sameMarks(decos: DecorationSet, placed: Array<{ mark: TaskMark; pos: number }>): boolean {
  const now = decos.find().map((deco) => `${(deco.spec as { key: string }).key}@${deco.from}`)
  const wanted = placed.map(({ mark, pos }) => `${markKey(mark)}@${pos}`)
  return now.length === wanted.length && now.every((entry, index) => entry === wanted[index])
}

function markKey(mark: TaskMark): string {
  return `nextasks-${mark.id}-${mark.due_date ?? ''}-${mark.task_url}`
}

/** The plugin drawing the marks; `draw` makes the element of one (a link with the due day). */
export function marksPlugin(draw: (mark: TaskMark) => HTMLElement): Plugin<MarkState> {
  return new Plugin<MarkState>({
    key: marksKey,
    state: {
      init: () => ({ links: [], decos: DecorationSet.empty }),
      apply: (tr, old) => {
        const meta = tr.getMeta(marksKey) as Partial<MarkState> | undefined
        const next = { ...old, decos: old.decos.map(tr.mapping, tr.doc) }
        return meta ? { ...next, ...meta } : next
      },
    },
    props: {
      decorations: (state) => marksKey.getState(state)?.decos ?? DecorationSet.empty,
    },
    view: (view: EditorView) => {
      let waiting = false
      let gone = false
      const place = () => {
        waiting = false
        if (gone) return
        const current = marksKey.getState(view.state)
        if (!current) return
        const placed = placeMarks(view.state, current.links)
        if (sameMarks(current.decos, placed)) return
        const decos = DecorationSet.create(
          view.state.doc,
          placed.map(({ mark, pos }) => Decoration.widget(pos, () => draw(mark), { side: 1, key: markKey(mark), ignoreSelection: true })),
        )
        view.dispatch(view.state.tr.setMeta(marksKey, { decos }).setMeta('addToHistory', false))
      }
      // Never dispatched inside another view update: a moment later, once.
      const later = () => {
        if (waiting) return
        waiting = true
        queueMicrotask(place)
      }
      later()
      return {
        update: (_view, previous) => {
          if (previous.doc !== view.state.doc || marksKey.getState(previous)?.links !== marksKey.getState(view.state)?.links) later()
        },
        destroy: () => {
          gone = true
        },
      }
    },
  })
}

/** The member's marks of the note handed to the editor; they are placed at once. */
export function showMarks(view: EditorView, links: TaskMark[]): void {
  view.dispatch(view.state.tr.setMeta(marksKey, { links }).setMeta('addToHistory', false))
}
