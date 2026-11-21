/**
 * Tags in the editor (NOTES-5 AC-1, AC-3). A tag is plain text; this plugin only paints it and helps typing it. The
 * document gets no node and no mark, so the server and the iOS app read the same text.
 *
 * - Every tag in the text is shown in the accent colour (a decoration, `.nn-tag`), found by the same rule as the
 *   server's (`tags/rules.ts`); code blocks, inline code and links hold none (EC-1).
 * - Typing `#` and letters shows the account's tags that start so (the most frequent first); arrows choose, Enter or
 *   Tab takes one, Escape closes. With the caret in a tag that exists, the list offers "Alle Notizen mit #…".
 * - Ctrl or ⌘ and a click on a tag opens its page (AC-3); in a note one may only read, a plain click does.
 */
import { Extension, type AnyExtension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import { goTo, tryLeave } from '../notes/context'
import type { TagInfo } from '../tags/api'
import { findTags, isTagChar, keyOf, tagHref, typedTag } from '../tags/rules'
import { currentTags, refreshTagsSoon } from '../tags/store'
import './tags.css'

type T = (key: string, values?: Record<string, unknown>) => string

/** Marks whose text holds no tags. */
const NO_TAG_MARKS = new Set(['code', 'link'])
/** Suggestions shown at most. */
export const MAX_SUGGESTIONS = 6

export type TagMatch = { from: number; to: number; label: string }

/** The text of a text block for the rule: one character per position, code and links blanked, a hard break a line
 * break, any other inline leaf a blank. */
function blockText(block: PMNode): string {
  let text = ''
  block.forEach((child) => {
    if (child.isText) {
      const value = child.text ?? ''
      text += child.marks.some((mark) => NO_TAG_MARKS.has(mark.type.name)) ? ' '.repeat(value.length) : value
    } else {
      text += child.type.name === 'hardBreak' ? '\n' : ' '.repeat(child.nodeSize)
    }
  })
  return text
}

/** Every tag of a document with its place. */
export function tagsInDoc(doc: PMNode): TagMatch[] {
  const out: TagMatch[] = []
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isTextblock) return true
    if (!node.textContent.includes('#')) return false
    for (const found of findTags(blockText(node))) out.push({ from: pos + 1 + found.start, to: pos + 1 + found.end, label: found.label })
    return false
  })
  return out
}

// --- What is being typed ----------------------------------------------------------------------------------------------

export type Typing = {
  /** Where the `#` stands. */
  from: number
  /** The end of the tag's word (the caret may stand inside it). */
  to: number
  prefix: string
}

/** The tag the caret stands in or right after, from just `#` on; `null` elsewhere. */
export function typingAt(state: EditorState): Typing | null {
  const { selection } = state
  if (!selection.empty) return null
  const $at = selection.$from
  const block = $at.parent
  if (!block.isTextblock || block.type.spec.code) return null
  if ($at.marks().some((mark) => NO_TAG_MARKS.has(mark.type.name))) return null
  const text = blockText(block)
  const before = typedTag(text.slice(0, $at.parentOffset))
  if (!before) return null
  // The rest of the word after the caret belongs to it.
  let after = ''
  for (const char of Array.from(text.slice($at.parentOffset))) {
    if (!isTagChar(char)) break
    after += char
  }
  const start = $at.start()
  return { from: start + before.start, to: $at.pos + after.length, prefix: before.prefix + after }
}

export type MenuItem = { kind: 'complete'; tag: TagInfo } | { kind: 'open'; tag: TagInfo }

/** The suggestions for what is typed: tags that start with it, the most frequent first; and the way to the tag's page
 * when it is one that exists. */
export function menuItems(typing: Typing, tags: TagInfo[]): MenuItem[] {
  const wanted = keyOf(typing.prefix)
  const exact = tags.find((tag) => tag.key === wanted)
  const completions = tags.filter((tag) => tag.key !== wanted && tag.key.startsWith(wanted)).slice(0, MAX_SUGGESTIONS)
  const items: MenuItem[] = completions.map((tag) => ({ kind: 'complete', tag }))
  if (exact && wanted) items.push({ kind: 'open', tag: exact })
  return items
}

// --- The plugin -------------------------------------------------------------------------------------------------------

type TagsState = {
  decorations: DecorationSet
  /** The tags of the text, joined: a change says the list may have to follow. */
  keys: string
  typing: Typing | null
  /** The chosen suggestion; -1: none (Enter stays a line break). */
  index: number
  /** Escape closed the list for the tag that starts here. */
  closedAt: number | null
  /** The editor has the focus; without it the list is away. */
  focused: boolean
}

type Meta = { index?: number; close?: boolean; focused?: boolean }

export const tagsKey = new PluginKey<TagsState>('noteTags')

function decorate(doc: PMNode): { decorations: DecorationSet; keys: string } {
  const found = tagsInDoc(doc)
  const decorations = DecorationSet.create(
    doc,
    found.map((tag) => Decoration.inline(tag.from, tag.to, { class: 'nn-tag', 'data-tag': tag.label })),
  )
  return { decorations, keys: [...new Set(found.map((tag) => keyOf(tag.label)))].sort().join('\n') }
}

function defaultIndex(typing: Typing | null): number {
  if (!typing) return -1
  return menuItems(typing, currentTags())[0]?.kind === 'complete' ? 0 : -1
}

/** Opens a tag's page; an open note without a title asks first (NOTES-3 AC-9). */
export function openTag(label: string): void {
  tryLeave(() => goTo(tagHref(label)), tagHref(label))
}

/** Puts the chosen tag in place of what was typed, with a blank after it. */
export function completeTag(view: EditorView, typing: Typing, label: string): void {
  const next = view.state.doc.textBetween(typing.to, Math.min(typing.to + 1, view.state.doc.content.size), '\n', ' ')
  const insert = label + (next === ' ' ? '' : ' ')
  const tr = view.state.tr.insertText(insert, typing.from + 1, typing.to)
  view.dispatch(tr.scrollIntoView())
}

function choose(view: EditorView, item: MenuItem, typing: Typing): void {
  if (item.kind === 'open') openTag(item.tag.label)
  else completeTag(view, typing, item.tag.label)
}

class Menu {
  private readonly box: HTMLDivElement
  private shown = ''

  constructor(
    private readonly view: EditorView,
    private readonly t: T,
  ) {
    this.box = document.createElement('div')
    this.box.className = 'nn-tag-menu'
    this.box.setAttribute('role', 'listbox')
    this.box.setAttribute('aria-label', t('tags.suggestions'))
    this.box.dataset.testid = 'tag-suggestions'
    this.box.hidden = true
    document.body.append(this.box)
  }

  update(view: EditorView): void {
    const state = tagsKey.getState(view.state)
    const typing = state?.typing ?? null
    const items = typing && state?.focused && state.closedAt !== typing.from ? menuItems(typing, currentTags()) : []
    if (!typing || items.length === 0) {
      this.box.hidden = true
      this.shown = ''
      return
    }
    const look = JSON.stringify([items.map((item) => item.kind + item.tag.key), state?.index])
    if (look !== this.shown) {
      this.shown = look
      this.box.replaceChildren(
        ...items.map((item, position) => {
          const option = document.createElement('div')
          option.className = 'nn-tag-option'
          option.setAttribute('role', 'option')
          option.setAttribute('aria-selected', String(position === state?.index))
          option.dataset.testid = item.kind === 'open' ? 'tag-open' : 'tag-suggestion'
          const name = document.createElement('span')
          name.className = 'nn-tag-option-name'
          name.textContent = item.kind === 'open' ? this.t('tags.openTag', { tag: `#${item.tag.label}` }) : `#${item.tag.label}`
          option.append(name)
          if (item.kind === 'complete') {
            const count = document.createElement('span')
            count.className = 'nn-tag-option-count'
            count.textContent = String(item.tag.count)
            option.append(count)
          }
          option.addEventListener('mousedown', (event) => {
            // The editor keeps its focus and its caret.
            event.preventDefault()
            const now = tagsKey.getState(this.view.state)?.typing
            if (now) choose(this.view, item, now)
          })
          return option
        }),
      )
    }
    this.box.hidden = false
    const at = view.coordsAtPos(typing.from)
    this.box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - 248))}px`
    this.box.style.top = `${at.bottom + 4}px`
  }

  destroy(): void {
    this.box.remove()
  }
}

function tagsPlugin(t: T): Plugin<TagsState> {
  return new Plugin<TagsState>({
    key: tagsKey,
    state: {
      init: (_config, state) => {
        const typing = typingAt(state)
        return { ...decorate(state.doc), typing, index: defaultIndex(typing), closedAt: null, focused: true }
      },
      apply: (tr: Transaction, old, _before, state) => {
        const meta = tr.getMeta(tagsKey) as Meta | undefined
        const painted = tr.docChanged ? decorate(state.doc) : { decorations: old.decorations, keys: old.keys }
        const typing = typingAt(state)
        const sameTag = typing !== null && old.typing !== null && typing.from === tr.mapping.map(old.typing.from)
        let index = sameTag && typing.prefix === old.typing?.prefix ? old.index : defaultIndex(typing)
        if (meta?.index !== undefined) index = meta.index
        let closedAt = sameTag && old.closedAt !== null ? typing.from : null
        if (meta?.close && typing) closedAt = typing.from
        return { ...painted, typing, index, closedAt, focused: meta?.focused ?? old.focused }
      },
    },
    view: (view) => {
      const menu = new Menu(view, t)
      return {
        update: (next, before) => {
          menu.update(next)
          const was = tagsKey.getState(before)?.keys
          if (was !== undefined && was !== tagsKey.getState(next.state)?.keys) refreshTagsSoon()
        },
        destroy: () => menu.destroy(),
      }
    },
    props: {
      decorations: (state) => tagsKey.getState(state)?.decorations,
      handleKeyDown: (view, event) => {
        const state = tagsKey.getState(view.state)
        const typing = state?.typing
        if (!state || !typing || !state.focused || state.closedAt === typing.from) return false
        const items = menuItems(typing, currentTags())
        if (items.length === 0) return false
        const move = (index: number) => {
          view.dispatch(view.state.tr.setMeta(tagsKey, { index } satisfies Meta))
          return true
        }
        if (event.key === 'ArrowDown') return move((state.index + 1) % items.length)
        if (event.key === 'ArrowUp') return move(state.index <= 0 ? items.length - 1 : state.index - 1)
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(tagsKey, { close: true } satisfies Meta))
          return true
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && state.index >= 0 && state.index < items.length && !event.shiftKey) {
          choose(view, items[state.index], typing)
          return true
        }
        return false
      },
      handleDOMEvents: {
        click: (view, event) => {
          const tag = (event.target as HTMLElement | null)?.closest?.('[data-tag]') as HTMLElement | null
          if (!tag) return false
          if (!(event.ctrlKey || event.metaKey) && view.editable) return false
          event.preventDefault()
          openTag(tag.dataset.tag ?? '')
          return true
        },
        focus: (view) => {
          view.dispatch(view.state.tr.setMeta(tagsKey, { focused: true } satisfies Meta))
          return false
        },
        blur: (view) => {
          // The list goes with the focus; a click into it keeps the focus (mousedown above).
          view.dispatch(view.state.tr.setMeta(tagsKey, { focused: false } satisfies Meta))
          return false
        },
      },
    },
  })
}

/** The editor's extension for tags. */
export function noteTags(t: T): AnyExtension {
  return Extension.create({
    name: 'noteTags',
    // Before the keys of lists and paragraphs: Enter takes a suggestion while the list is open.
    priority: 1000,
    addProseMirrorPlugins() {
      return [tagsPlugin(t)]
    },
  })
}
