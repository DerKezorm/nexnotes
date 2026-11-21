/**
 * NOTES-5 in the editor: tags are painted (AC-1) but stay plain text, code, links, addresses and numbers are not
 * (EC-1), the account's tags are suggested while one is typed (AC-1), and Ctrl or ⌘ with a click opens a tag's page
 * (AC-3). The editor runs on a Yjs document as in the app, without a live connection.
 */
import { Editor } from '@tiptap/core'
import * as Y from 'yjs'

import i18n from '../i18n'
import { forgetTags, refreshTags } from '../tags/store'
import { editorExtensions, editorProps } from './extensions'
import { presenceUser } from './presence'
import { NoteProvider } from './provider'
import { menuItems, tagsInDoc, typingAt } from './tags'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const made: Editor[] = []

function makeEditor(): Editor {
  const element = document.createElement('div')
  element.className = 'nn-editor'
  document.body.appendChild(element)
  const doc = new Y.Doc()
  const provider = new NoteProvider('note', doc, { socket: () => { throw new Error('offline in tests') } })
  const editor = new Editor({ element, extensions: editorExtensions({ doc, provider, me: presenceUser(1, 'me'), t, placeholder: '' }), editorProps })
  made.push(editor)
  return editor
}

function typeText(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (handler) => handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

function press(editor: Editor, key: string, modifiers: { shift?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: !!modifiers.shift, bubbles: true, cancelable: true })
  return Boolean(editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)))
}

function painted(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll('.nn-tag')).map((span) => span.textContent ?? '')
}

function menu(): HTMLElement | null {
  const box = document.querySelector<HTMLElement>('[data-testid="tag-suggestions"]')
  return box && !box.hidden ? box : null
}

const TAGS = [
  { key: 'einkauf', label: 'einkauf', count: 5 },
  { key: 'einkaufsliste', label: 'Einkaufsliste', count: 2 },
  { key: 'eis', label: 'eis', count: 1 },
  { key: 'bad', label: 'bad', count: 4 },
]

beforeAll(async () => {
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
})

beforeEach(async () => {
  forgetTags()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tags: TAGS, total: TAGS.length }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  await refreshTags()
  window.history.replaceState(null, '', '/notes/n1')
})

afterEach(() => {
  while (made.length) made.pop()?.destroy()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('tags in the editor', () => {
  it('NOTES-5 AC-1 a typed tag is painted in the accent colour and stays plain text', () => {
    const editor = makeEditor()
    typeText(editor, 'Milk #einkauf and #Bad. ')
    expect(painted(editor)).toEqual(['#einkauf', '#Bad'])
    expect(editor.view.dom.querySelector('.nn-tag')?.getAttribute('data-tag')).toBe('einkauf')
    // No node and no mark: the document is text, as the server and the iOS app read it.
    const json = JSON.stringify(editor.getJSON())
    expect(json).toContain('Milk #einkauf and #Bad. ')
    expect(json).not.toMatch(/"type":"(tag|hashtag)"/)
    expect(editor.getJSON().content?.[0].content).toEqual([{ type: 'text', text: 'Milk #einkauf and #Bad. ' }])
  })

  it('NOTES-5 EC-1 code, links, addresses, numbers and code blocks are no tags', () => {
    const editor = makeEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '#code', marks: [{ type: 'code' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: '#link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
            { type: 'text', text: ' https://example.com/#part #1 C#x #real' },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: '#block' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading #inheading' }] },
      ],
    })
    expect(painted(editor)).toEqual(['#real', '#inheading'])
    expect(tagsInDoc(editor.state.doc).map((tag) => tag.label)).toEqual(['real', 'inheading'])
  })

  it('NOTES-5 EC-3 umlauts, hyphens, underscores and emoji stay, a full stop does not', () => {
    const editor = makeEditor()
    typeText(editor, '#Gemüse-Garten_ #reise✈️ #bad.')
    expect(painted(editor)).toEqual(['#Gemüse-Garten', '#reise✈️', '#bad'])
  })

  it('NOTES-5 AC-1 suggests the existing tags while one is typed, and Enter takes one', () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, 'Milk #EIN')
    const typing = typingAt(editor.state)
    expect(typing?.prefix).toBe('EIN')
    // Case does not count (EC-2); the most frequent first.
    expect(menuItems(typing!, TAGS).map((item) => `${item.kind}:${item.tag.label}`)).toEqual(['complete:einkauf', 'complete:Einkaufsliste'])
    expect(menu()?.textContent).toContain('#einkauf')
    expect(press(editor, 'ArrowDown')).toBe(true)
    expect(press(editor, 'Enter')).toBe(true)
    expect(editor.getText()).toBe('Milk #Einkaufsliste ')
    expect(menu()).toBeNull()
  })

  it('NOTES-5 AC-1 Escape closes the suggestions and Enter stays a line break', () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, '#ei')
    expect(menu()).not.toBeNull()
    expect(press(editor, 'Escape')).toBe(true)
    expect(menu()).toBeNull()
    press(editor, 'Enter')
    expect(editor.state.doc.textContent).toBe('#ei')
    expect(editor.state.doc.childCount).toBe(2)
  })

  it('NOTES-5 AC-1 the list goes when the editor loses the focus', () => {
    const editor = makeEditor()
    typeText(editor, '#ei')
    expect(menu()).not.toBeNull()
    editor.view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(menu()).toBeNull()
    editor.view.dom.dispatchEvent(new FocusEvent('focus'))
    expect(menu()).not.toBeNull()
  })

  it('NOTES-5 AC-3 with the caret in a known tag the list offers its page, Enter does not jump there', () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, '#bad')
    expect(menuItems(typingAt(editor.state)!, TAGS).map((item) => item.kind)).toEqual(['open'])
    const open = document.querySelector('[data-testid="tag-open"]')
    expect(open?.textContent).toBe('All notes with #bad')
    open?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(window.location.pathname).toBe('/tags/bad')
    // Enter after a whole tag is a line break, not a jump to its page.
    window.history.replaceState(null, '', '/notes/n1')
    press(editor, 'Enter')
    expect(window.location.pathname).toBe('/notes/n1')
    expect(editor.state.doc.childCount).toBe(2)
  })

  it('NOTES-5 AC-3 Ctrl or ⌘ and a click on a tag opens its page, a plain click does not', () => {
    const editor = makeEditor()
    typeText(editor, 'Tiles #küche ok')
    const tag = editor.view.dom.querySelector('.nn-tag')!
    tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(window.location.pathname).toBe('/notes/n1')
    tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(window.location.pathname).toBe('/tags/k%C3%BCche')
  })
})
