/**
 * The editor of a note: the schema from `schema.mjs` (taken over unchanged from `interop/schema.mjs`) and what only the
 * editor needs on top. Nothing here changes the schema, or the server and the iOS app would no longer read the same
 * document:
 *
 * - writing together (`Collaboration` on the `body` of the Yjs document, `CollaborationCaret` for the others' carets);
 *   undo and redo come from the collaboration and touch only one's own changes (NOTES-3 AC-13); setting or taking away
 *   a format (highlighter, bold, a link …) is always one step of its own, however soon after typing;
 * - tables inside a box that scrolls sideways (AC-5), with columns as wide as one sets them (AC-19);
 * - headings that fold (AC-12), checklists with "x von y" and "Erledigtes nach unten" (AC-4);
 * - pasted HTML without scripts, forms and styles (EC-3); links open with Ctrl or ⌘ in a new tab without access to
 *   nexnotes (EC-8);
 * - the placeholder and a few shortcuts (link, table, folding);
 * - tags painted in the accent colour, with suggestions while one is typed (`tags.ts`, NOTES-5);
 * - attachments drawn as cards, pictures and players, and files and links taken in by dropping and pasting
 *   (`attachments/editing.tsx`, NOTES-10).
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'
// The commands of the schema's extensions (toggleBold, insertTable, setHighlight …) for the type checker.
import type {} from '@tiptap/extension-heading'
import type {} from '@tiptap/extension-highlight'
import type {} from '@tiptap/extension-list'
import type {} from '@tiptap/extension-table'
import type {} from '@tiptap/starter-kit'

import { ATTACHMENT_NODES, attachmentEditing, withAttachmentView } from '../attachments/editing'
import { ChangeFound } from '../notify/hooks'
import { caretLook, presentAccounts, type PresenceUser } from './presence'
import type { EditorConnection } from './provider'
import { HIGHLIGHT_COLORS, LINK_PROTOCOLS, noteExtensions } from './schema.mjs'
import { COLUMN_MIN, columnWidthPlugin } from './table'
import { noteTags } from './tags'

export { HIGHLIGHT_COLORS }

type T = (key: string, values?: Record<string, unknown>) => string

// --- Links ----------------------------------------------------------------------------------------------------------

/** A link target that may be a link (http, https with a host, mailto), the same rule as the server's `safe_href`. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const value = href.trim()
  if (!value || value.length > 2048) return null
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  if (!LINK_PROTOCOLS.includes(scheme)) return null
  if ((scheme === 'http' || scheme === 'https') && !url.host) return null
  if (scheme === 'mailto' && value.length <= 'mailto:'.length) return null
  return value
}

/** Opens a link in a new tab that cannot reach back into nexnotes (`noopener`, no referrer). */
export function openLink(href: string): boolean {
  const safe = safeHref(href)
  if (!safe) return false
  window.open(safe, '_blank', 'noopener,noreferrer')
  return true
}

const LinkOpener = Extension.create({
  name: 'noteLinkOpener',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('noteLinkOpener'),
        props: {
          handleDOMEvents: {
            click: (_view, event) => {
              const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
              if (!anchor) return false
              // A plain click puts the caret into the link; Ctrl or ⌘ opens it. Never does the page itself follow it.
              event.preventDefault()
              if (event.ctrlKey || event.metaKey) openLink(anchor.getAttribute('href') ?? '')
              return true
            },
            auxclick: (_view, event) => {
              const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
              if (!anchor || event.button !== 1) return false
              event.preventDefault()
              openLink(anchor.getAttribute('href') ?? '')
              return true
            },
          },
        },
      }),
    ]
  },
})

// --- Pasting ----------------------------------------------------------------------------------------------------------

/** Elements whose content never belongs in a note (scripts, styles, forms, embedded pages). */
const DROPPED = 'script, style, link, meta, title, head, template, noscript, iframe, frame, frameset, object, embed, applet, form, input, button, select, option, textarea, label, fieldset, legend, datalist, output, svg, math, canvas, video, audio, source, track, img, picture, map, area, dialog'
/** Attributes the schema reads; every other one goes (styles, classes, event handlers). */
const KEPT: Record<string, string[]> = {
  a: ['href', 'title'],
  mark: ['data-color'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start', 'type'],
  ul: ['data-type', 'data-done-to-bottom'],
  li: ['data-type', 'data-checked'],
  pre: [],
  code: [],
  h1: ['data-collapsed'],
  h2: ['data-collapsed'],
  h3: ['data-collapsed'],
  // Attachments copied from a note (NOTES-10): their blocks name the attachment by its id, nothing else.
  figure: ['data-type', 'data-id', 'data-size', 'data-name'],
  div: ['data-type', 'data-id', 'data-name', 'data-href', 'data-title', 'data-description', 'data-site', 'data-image'],
}

/** What is pasted keeps the formatting nexnotes knows; the rest becomes plain text; scripts, forms and styles always go
 * (NOTES-3 EC-3). Links that are not safe lose their target. */
export function cleanPastedHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  parsed.querySelectorAll(DROPPED).forEach((element) => element.remove())
  // Word's own tags (<o:p>) and comments carry nothing.
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  comments.forEach((comment) => comment.parentNode?.removeChild(comment))
  parsed.body.querySelectorAll('*').forEach((element) => {
    const name = element.tagName.toLowerCase()
    if (name.includes(':')) {
      element.replaceWith(...Array.from(element.childNodes))
      return
    }
    const kept = KEPT[name] ?? []
    for (const attribute of Array.from(element.attributes)) {
      if (!kept.includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name)
    }
    if (name === 'a') {
      const href = element.getAttribute('href')
      if (href !== null && !safeHref(href)) element.removeAttribute('href')
    }
  })
  return parsed.body.innerHTML
}

// --- Folding headings -------------------------------------------------------------------------------------------------

export const collapseKey = new PluginKey<DecorationSet>('noteCollapse')

/** The top-level blocks a folded heading hides: everything up to the next heading of the same or a higher level. */
export function foldedRanges(doc: PMNode): Array<{ heading: number; from: number; to: number; count: number }> {
  const ranges: Array<{ heading: number; from: number; to: number; count: number }> = []
  let open: { heading: number; level: number; from: number; to: number; count: number } | null = null
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      const level = Number(node.attrs.level) || 1
      if (open && level <= open.level) {
        ranges.push(open)
        open = null
      }
      if (!open && node.attrs.collapsed) {
        open = { heading: offset, level, from: offset + node.nodeSize, to: offset + node.nodeSize, count: 0 }
        return
      }
    }
    if (open) {
      open.to = offset + node.nodeSize
      open.count++
    }
  })
  if (open) ranges.push(open)
  return ranges
}

export function toggleFold(view: EditorView, headingPos: number): boolean {
  const node = view.state.doc.nodeAt(headingPos)
  if (!node || node.type.name !== 'heading') return false
  view.dispatch(view.state.tr.setNodeMarkup(headingPos, undefined, { ...node.attrs, collapsed: !node.attrs.collapsed }))
  return true
}

function foldDecorations(state: EditorState, t: T): DecorationSet {
  const decorations: Decoration[] = []
  const ranges = foldedRanges(state.doc)
  const byHeading = new Map(ranges.map((range) => [range.heading, range]))
  state.doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return
    const collapsed = Boolean(node.attrs.collapsed)
    decorations.push(
      Decoration.widget(
        offset + 1,
        (view: EditorView, getPos: () => number | undefined) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.contentEditable = 'false'
          button.className = 'nn-fold'
          button.setAttribute('aria-expanded', String(!collapsed))
          button.setAttribute('aria-label', collapsed ? t('editor.fold.open') : t('editor.fold.close'))
          button.setAttribute('data-testid', 'fold')
          button.textContent = collapsed ? '▸' : '▾'
          button.addEventListener('mousedown', (event) => {
            event.preventDefault()
            const at = getPos()
            if (at !== undefined) toggleFold(view, at - 1)
          })
          return button
        },
        { side: -1, ignoreSelection: true, key: `fold-${offset}-${collapsed}` },
      ),
    )
    const range = byHeading.get(offset)
    if (collapsed && range) {
      decorations.push(
        Decoration.widget(
          offset + node.nodeSize - 1,
          () => {
            const note = document.createElement('span')
            note.contentEditable = 'false'
            note.className = 'nn-folded-count'
            note.textContent = t('editor.fold.folded', { count: range.count })
            return note
          },
          { side: 1, ignoreSelection: true, key: `folded-${offset}-${range.count}` },
        ),
      )
    }
  })
  for (const range of ranges) {
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (pos >= range.from && pos + node.nodeSize <= range.to) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'nn-hidden' }))
      return false
    })
  }
  return DecorationSet.create(state.doc, decorations)
}

function foldingPlugin(t: T): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: collapseKey,
    state: {
      init: (_config, state) => foldDecorations(state, t),
      apply: (tr, old, _before, state) => (tr.docChanged ? foldDecorations(state, t) : old),
    },
    props: {
      decorations: (state) => collapseKey.getState(state),
    },
  })
}

// --- Checklists ---------------------------------------------------------------------------------------------------------

export const tasksKey = new PluginKey<DecorationSet>('noteTasks')

/** Done and all items of a checklist, its own items only (a nested checklist counts for itself). */
export function taskCount(list: PMNode): { done: number; all: number } {
  let done = 0
  let all = 0
  list.forEach((item) => {
    if (item.type.name !== 'taskItem') return
    all++
    if (item.attrs.checked) done++
  })
  return { done, all }
}

export function toggleDoneToBottom(view: EditorView, listPos: number): boolean {
  const node = view.state.doc.nodeAt(listPos)
  if (!node || node.type.name !== 'taskList') return false
  view.dispatch(view.state.tr.setNodeMarkup(listPos, undefined, { ...node.attrs, doneToBottom: !node.attrs.doneToBottom }))
  return true
}

function taskDecorations(state: EditorState, t: T): DecorationSet {
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskList') return true
    const { done, all } = taskCount(node)
    const bottom = Boolean(node.attrs.doneToBottom)
    decorations.push(
      Decoration.widget(
        pos + node.nodeSize,
        (view: EditorView) => {
          const bar = document.createElement('div')
          bar.contentEditable = 'false'
          bar.className = 'nn-task-summary'
          bar.setAttribute('data-testid', 'task-summary')
          const toggle = document.createElement('button')
          toggle.type = 'button'
          toggle.className = 'nn-task-toggle'
          toggle.setAttribute('aria-pressed', String(bottom))
          toggle.textContent = t('editor.tasks.doneToBottom')
          toggle.addEventListener('mousedown', (event) => {
            event.preventDefault()
            // The list's place may have moved since the widget was drawn: look it up anew.
            let at = -1
            view.state.doc.descendants((candidate, candidatePos) => {
              if (at >= 0) return false
              if (candidate.type.name === 'taskList' && candidatePos + candidate.nodeSize === Number(bar.dataset.end)) at = candidatePos
              return true
            })
            if (at >= 0) toggleDoneToBottom(view, at)
          })
          bar.dataset.end = String(pos + node.nodeSize)
          const count = document.createElement('span')
          count.className = 'nn-task-count'
          count.textContent = t('editor.tasks.count', { done, count: all })
          bar.append(toggle, document.createTextNode(' · '), count)
          return bar
        },
        { side: -1, ignoreSelection: true, key: `tasks-${pos}-${done}-${all}-${bottom}` },
      ),
    )
    return true
  })
  return DecorationSet.create(state.doc, decorations)
}

function taskPlugin(t: T): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tasksKey,
    state: {
      init: (_config, state) => taskDecorations(state, t),
      apply: (tr, old, _before, state) => (tr.docChanged ? taskDecorations(state, t) : old),
    },
    props: {
      decorations: (state) => tasksKey.getState(state),
    },
  })
}

// --- Undo steps -------------------------------------------------------------------------------------------------------

/** Whether a transaction only sets or takes away formatting (no text, no blocks). */
function onlyFormats(tr: Transaction): boolean {
  return tr.steps.length > 0 && tr.steps.every((step) => step instanceof AddMarkStep || step instanceof RemoveMarkStep)
}

/**
 * The undo manager joins what happens within half a second into one step. A format set right after typing would go
 * with the typing, and typing right after it with the format: one undo would take back more than the marker
 * (NOTES-3 AC-11, AC-13). So a change of formats starts a step of its own, and so does the next change after it.
 */
const formatStepsKey = new PluginKey<boolean>('noteFormatSteps')

function formatStepsPlugin(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: formatStepsKey,
    state: {
      init: () => false,
      // Whether the last own change of the text only changed formats.
      apply: (tr, last) => (tr.docChanged && !tr.getMeta(ySyncPluginKey) ? onlyFormats(tr) : last),
    },
    appendTransaction: (transactions, before) => {
      const own = transactions.filter((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey))
      if (own.length === 0) return null
      const lastWasFormat = formatStepsKey.getState(before) ?? false
      if (lastWasFormat || own.some(onlyFormats)) yUndoPluginKey.getState(before)?.undoManager?.stopCapturing()
      return null
    },
  })
}

// --- The editor's own extension ----------------------------------------------------------------------------------------

export type EditorHooks = {
  /** Ctrl/⌘ K: the link dialog. */
  onLink?: () => void
}

function noteEditing(t: T, hooks: EditorHooks): AnyExtension {
  return Extension.create({
    name: 'noteEditing',
    addKeyboardShortcuts() {
      return {
        // Ctrl/⌘+K is the search everywhere, as in the other nex apps; the link sits beside the table and code keys.
        'Mod-Alt-k': () => {
          hooks.onLink?.()
          return true
        },
        'Mod-Alt-t': () => this.editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        'Mod-Shift-.': () => {
          const { $from } = this.editor.state.selection
          const top = $from.depth >= 1 ? $from.before(1) : -1
          const node = top >= 0 ? this.editor.state.doc.nodeAt(top) : null
          return node?.type.name === 'heading' ? toggleFold(this.editor.view, top) : false
        },
      }
    },
    addProseMirrorPlugins() {
      return [foldingPlugin(t), taskPlugin(t), formatStepsPlugin(), columnWidthPlugin()]
    },
  })
}

/**
 * The schema's extensions, with the table drawn inside a box that scrolls and columns that one drags wider or
 * narrower (NOTES-3 AC-19; `colwidth` of the cells, already part of the schema). The schema itself is unchanged.
 */
export function schemaExtensions(): AnyExtension[] {
  return noteExtensions().map((extension) =>
    extension.name === 'table'
      ? (extension.configure({ ...extension.options, renderWrapper: true, resizable: true, cellMinWidth: COLUMN_MIN, handleWidth: 6, lastColumnResizable: true }) as AnyExtension)
      : extension,
  )
}

export type EditorSetup = {
  doc: Y.Doc
  provider: EditorConnection
  me: PresenceUser
  t: T
  placeholder: string
  hooks?: EditorHooks
  /** The note the editor writes, for its attachments (NOTES-10); without it nothing can be attached. */
  noteId?: string
}

/** A checklist's checkbox read out in the page's language (NOTES-3 EC-11), not TipTap's English. */
function withCheckboxLabel(extension: AnyExtension, t: T): AnyExtension {
  return extension.configure({
    ...extension.options,
    a11y: { checkboxLabel: (node: PMNode) => t('editor.tasks.checkbox', { text: node.textContent.trim() || t('editor.tasks.empty') }) },
  }) as AnyExtension
}

/** Everything the editor of one note runs with. */
export function editorExtensions({ doc, provider, me, t, placeholder, hooks = {}, noteId = '' }: EditorSetup): AnyExtension[] {
  return [
    ...schemaExtensions().map((extension) =>
      extension.name === 'taskItem' ? withCheckboxLabel(extension, t) : ATTACHMENT_NODES.includes(extension.name) ? withAttachmentView(extension, noteId) : extension,
    ),
    Collaboration.configure({ document: doc, field: 'body' }),
    CollaborationCaret.configure({
      provider,
      user: me,
      render: (user: Partial<PresenceUser>) => {
        const look = caretLook(user, me.accountId, t('presence.otherWindow'), presentAccounts(provider.awareness))
        const caret = document.createElement('span')
        caret.className = 'collaboration-carets__caret'
        caret.style.borderColor = look.color
        const label = document.createElement('div')
        label.className = 'collaboration-carets__label'
        label.style.backgroundColor = look.color
        label.textContent = look.label
        // The same note on the other side of this window: the caret alone, no name.
        if (look.label) caret.append(label)
        return caret
      },
      selectionRender: (user: Partial<PresenceUser>) => {
        const look = caretLook(user, me.accountId, t('presence.otherWindow'), presentAccounts(provider.awareness))
        return { nodeName: 'span', class: 'collaboration-carets__selection', style: `background-color: ${look.color}40`, 'data-user': look.label }
      },
    }),
    // "Start writing …" only in a note whose text is empty: never on an empty paragraph between written ones.
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? placeholder : ''), showOnlyCurrent: true, includeChildren: false }),
    LinkOpener,
    noteEditing(t, hooks),
    // Tags (NOTES-5): painted and suggested, never a node or a mark of their own.
    noteTags(t),
    // Attachments (NOTES-10): files dropped and pasted, links that become cards.
    attachmentEditing(noteId),
    // Notifications (NOTES-14 AC-5): the line a tapped notification named, marked for a few seconds.
    ChangeFound,
  ]
}

/** The editor's props for pasting. */
export const editorProps = {
  transformPastedHTML: (html: string) => cleanPastedHtml(html),
}

/** Whether the note's text is empty (nothing but an empty paragraph). */
export function bodyIsEmpty(editor: Editor | null): boolean {
  if (!editor) return true
  return editor.state.doc.textContent.trim() === '' && editor.state.doc.childCount <= 1 && editor.state.doc.firstChild?.type.name === 'paragraph'
}
