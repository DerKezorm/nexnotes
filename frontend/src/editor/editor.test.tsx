/**
 * NOTES-3 in the editor itself: the tools, shortcuts and Markdown typing (AC-3), checklists (AC-4), tables (AC-5),
 * the highlighter (AC-11), folding (AC-12), undo of one's own changes only (AC-13), pasting (EC-3), links (EC-8),
 * every script (EC-10). The editor runs on a Yjs document as in the app; the live connection is not needed here.
 */
import { Editor } from '@tiptap/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Y from 'yjs'

import i18n from '../i18n'
import { bodyIsEmpty, cleanPastedHtml, collapseKey, editorExtensions, editorProps, foldedRanges, openLink, safeHref, taskCount, toggleDoneToBottom, toggleFold } from './extensions'
import { presenceUser } from './presence'
import { NoteProvider } from './provider'
import { tableActions } from './table'
import { TableControls } from './TableControls'
import { TitleField } from './TitleField'
import { Toolbar } from './Toolbar'
import { forgetPrefs, prefKey } from '../lib/devicePref'
import { Outline } from './Outline'
import { headingsOf, OUTLINE_FROM } from './outlineData'
import { parseTextWidth, TEXT_MAX } from './textWidth'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const made: Editor[] = []

function makeEditor(doc = new Y.Doc(), accountId = 1): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const provider = new NoteProvider('note', doc, { socket: () => { throw new Error('offline in tests') } })
  const editor = new Editor({
    element,
    extensions: editorExtensions({ doc, provider, me: presenceUser(accountId, `person ${accountId}`), t, placeholder: 'Start writing' }),
    editorProps,
  })
  made.push(editor)
  return editor
}

function typeText(editor: Editor, text: string): void {
  // Character by character, as typing does: the input rules see every one.
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (handler) => handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

function press(editor: Editor, key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt, bubbles: true, cancelable: true })
  return Boolean(editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)))
}

function types(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    out.push(node.type.name)
  })
  return out
}

function marksOf(editor: Editor): string[] {
  const out = new Set<string>()
  editor.state.doc.descendants((node) => node.marks.forEach((mark) => out.add(mark.type.name)))
  return [...out]
}

/** The editor's style sheet as text (vitest leaves CSS out of the page). */
type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const css = ((await import(/* @vite-ignore */ fsName)) as Files).readFileSync('src/editor/editor.css', 'utf-8')

beforeAll(async () => {
  await i18n.changeLanguage('en')
  // jsdom knows neither layout nor the clipboard; ProseMirror asks for both now and then.
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
  if (!('ClipboardEvent' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ClipboardEvent = class extends Event {
      clipboardData = null
    }
  }
})

afterEach(() => {
  while (made.length) made.pop()!.destroy()
  document.body.innerHTML = ''
})

describe('NOTES-3 AC-3 the toolbar, shortcuts and Markdown typing', () => {
  it('NOTES-3 AC-3 the toolbar offers every tool of the spec, each with its shortcut', async () => {
    const editor = makeEditor()
    const box = document.createElement('div')
    document.body.appendChild(box)
    let root: Root
    await act(async () => {
      root = createRoot(box)
      root.render(<Toolbar editor={editor} onLink={() => undefined} />)
    })
    const labels = Array.from(box.querySelectorAll('[data-tool]')).map((tool) => tool.getAttribute('aria-label') ?? tool.id)
    expect(labels).toEqual(['', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Highlighter', 'Bulleted list', 'Numbered list', 'Checklist', 'Table', 'Link', 'Quote', 'Code', 'Indent', 'Outdent', 'Divider', 'Undo', 'Redo', 'Text width', 'Outline'].map((label, index) => (index === 0 ? 'nn-text-style' : label)))
    const options = Array.from(box.querySelectorAll('option')).map((option) => option.textContent)
    expect(options).toEqual(['Heading', 'Subheading', 'Minor heading', 'Body text'])
    // Every formatting tool names its shortcut; the two of the screen (width, outline) have none.
    for (const tool of box.querySelectorAll('button[data-tool]:not([data-testid="tool-width"]):not([data-testid="tool-outline"])'))
      expect(tool.getAttribute('title')).toMatch(/\(.+\)$/)
    await act(async () => root.unmount())
  })

  it('NOTES-3 AC-3 every tool of the toolbar changes the text', async () => {
    const editor = makeEditor()
    const box = document.createElement('div')
    document.body.appendChild(box)
    let root: Root
    await act(async () => {
      root = createRoot(box)
      root.render(<Toolbar editor={editor} onLink={() => undefined} />)
    })
    const run = async (change: () => unknown) => {
      await act(async () => {
        change()
      })
    }
    const click = async (key: string) => {
      await act(async () => (box.querySelector(`[data-testid="tool-${key}"]`) as HTMLButtonElement).click())
    }
    await run(() => editor.commands.setContent('<p>word</p>'))
    for (const [key, mark] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strike', 'strike']] as const) {
      editor.commands.selectAll()
      await click(key)
      expect(marksOf(editor)).toContain(mark)
    }
    for (const [key, node] of [['bullet', 'bulletList'], ['ordered', 'orderedList'], ['task', 'taskList'], ['quote', 'blockquote']] as const) {
      editor.commands.setContent('<p>word</p>')
      editor.commands.setTextSelection(2)
      await click(key)
      expect(types(editor)).toContain(node)
    }
    await run(() => editor.commands.setContent('<p>word</p>'))
    await run(() => editor.commands.setTextSelection(2))
    await click('code')
    expect(types(editor)).toContain('codeBlock')
    await run(() => editor.commands.setContent('<p>word</p>'))
    await run(() => editor.commands.setTextSelection({ from: 1, to: 3 }))
    await click('code')
    expect(marksOf(editor)).toContain('code')
    await run(() => editor.commands.setContent('<p>word</p>'))
    await click('divider')
    expect(types(editor)).toContain('horizontalRule')
    await run(() => editor.commands.setContent('<p>word</p>'))
    await click('table')
    expect(types(editor)).toContain('table')
    // Indenting nests a list item, outdenting takes it back.
    await run(() => editor.commands.setContent('<ul><li><p>one</p></li><li><p>two</p></li></ul>'))
    await run(() => editor.commands.setTextSelection(10))
    await click('indent')
    expect(editor.getHTML()).toContain('<li><p>one</p><ul><li><p>two</p></li></ul></li>')
    await click('outdent')
    expect(editor.getHTML()).not.toContain('<ul><li><p>two</p></li></ul></li>')
    // The text style.
    await run(() => editor.commands.setContent('<p>word</p>'))
    await run(() => editor.commands.setTextSelection(2))
    const select = box.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'h2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    await act(async () => root.unmount())
  })

  it('NOTES-3 AC-3 the shortcuts', () => {
    const editor = makeEditor()
    const cases: Array<[string, { ctrl?: boolean; shift?: boolean; alt?: boolean }, (e: Editor) => boolean]> = [
      ['b', { ctrl: true }, (e) => marksOf(e).includes('bold')],
      ['i', { ctrl: true }, (e) => marksOf(e).includes('italic')],
      ['u', { ctrl: true }, (e) => marksOf(e).includes('underline')],
      ['s', { ctrl: true, shift: true }, (e) => marksOf(e).includes('strike')],
      ['h', { ctrl: true, shift: true }, (e) => marksOf(e).includes('highlight')],
      ['e', { ctrl: true }, (e) => marksOf(e).includes('code')],
      ['8', { ctrl: true, shift: true }, (e) => types(e).includes('bulletList')],
      ['7', { ctrl: true, shift: true }, (e) => types(e).includes('orderedList')],
      ['9', { ctrl: true, shift: true }, (e) => types(e).includes('taskList')],
      ['b', { ctrl: true, shift: true }, (e) => types(e).includes('blockquote')],
      ['1', { ctrl: true, alt: true }, (e) => e.isActive('heading', { level: 1 })],
      ['2', { ctrl: true, alt: true }, (e) => e.isActive('heading', { level: 2 })],
      ['c', { ctrl: true, alt: true }, (e) => types(e).includes('codeBlock')],
      ['t', { ctrl: true, alt: true }, (e) => types(e).includes('table')],
    ]
    for (const [key, modifiers, check] of cases) {
      editor.commands.setContent('<p>word</p>')
      editor.commands.selectAll()
      if (['8', '7', '9', '1', '2', 'c', 't'].includes(key) || (key === 'b' && modifiers.shift)) editor.commands.setTextSelection(2)
      press(editor, key, modifiers)
      expect(check(editor), `${key} ${JSON.stringify(modifiers)}`).toBe(true)
    }
    // Ctrl+Alt+K opens the link dialog (Ctrl+K is the search).
    let asked = false
    const hooks = { onLink: () => (asked = true) }
    const withHook = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions({ doc: new Y.Doc(), provider: new NoteProvider('x', undefined, { socket: () => { throw new Error('x') } }), me: presenceUser(1, 'a'), t, placeholder: '', hooks }),
    })
    made.push(withHook)
    press(withHook, 'k', { ctrl: true, alt: true })
    expect(asked).toBe(true)
  })

  it('NOTES-3 AC-3 Markdown signs while typing', () => {
    const editor = makeEditor()
    const cases: Array<[string, (e: Editor) => boolean]> = [
      ['# ', (e) => e.isActive('heading', { level: 1 })],
      ['## ', (e) => e.isActive('heading', { level: 2 })],
      ['- ', (e) => types(e).includes('bulletList')],
      ['1. ', (e) => types(e).includes('orderedList')],
      ['[ ] ', (e) => types(e).includes('taskList')],
      ['> ', (e) => types(e).includes('blockquote')],
      ['```', (e) => types(e).includes('codeBlock')],
      ['---', (e) => types(e).includes('horizontalRule')],
      ['**bold** ', (e) => marksOf(e).includes('bold')],
      ['*italic* ', (e) => marksOf(e).includes('italic')],
      ['~~gone~~ ', (e) => marksOf(e).includes('strike')],
      ['`code` ', (e) => marksOf(e).includes('code')],
      ['==marked== ', (e) => marksOf(e).includes('highlight')],
    ]
    for (const [typed, check] of cases) {
      editor.commands.setContent('<p></p>')
      editor.commands.setTextSelection(1)
      typeText(editor, typed)
      if (typed === '```') typeText(editor, ' ')
      expect(check(editor), typed).toBe(true)
    }
  })
})

describe('NOTES-3 AC-4 checklists', () => {
  it('NOTES-3 EC-11 a checkbox is read out in the language of the page, with its words', async () => {
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Milk</p></li><li data-type="taskItem" data-checked="true"><p></p></li></ul>'
    try {
      await i18n.changeLanguage('de')
      const german = makeEditor()
      german.commands.setContent(html)
      const labels = Array.from(german.view.dom.querySelectorAll('li input[type="checkbox"]')).map((box) => box.getAttribute('aria-label'))
      expect(labels).toEqual(['Punkt abhaken: Milk', 'Punkt abhaken: leerer Punkt'])
      await i18n.changeLanguage('en')
      const english = makeEditor()
      english.commands.setContent(html)
      expect(english.view.dom.querySelector('li input[type="checkbox"]')?.getAttribute('aria-label')).toBe('Tick off: Milk')
      expect(english.view.dom.innerHTML).not.toContain('Task item checkbox')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('NOTES-3 AC-4 a ticked item is ticked and struck through, "x of y" is counted, done items can go to the bottom', () => {
    const editor = makeEditor()
    editor.commands.setContent('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Milk</p></li><li data-type="taskItem" data-checked="false"><p>Bread</p></li><li data-type="taskItem" data-checked="false"><p>Eggs</p></li></ul>')
    const box = editor.view.dom
    const checkbox = box.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')[0]
    checkbox.click()
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    const list = editor.state.doc.firstChild!
    expect(taskCount(list)).toEqual({ done: 1, all: 3 })
    expect(box.querySelector('li[data-checked="true"] > div')?.textContent).toBe('Milk')
    expect(box.querySelector('[data-testid="task-summary"]')?.textContent).toContain('1 of 3')
    // The checked item is struck through by the editor's style.
    expect(css).toMatch(/li\[data-checked='true'\] > div \{ text-decoration: line-through/)
    expect(css).toMatch(/\[data-done-to-bottom='true'\] > li\[data-checked='true'\] \{ order: 1; \}/)
    // "Erledigtes nach unten" is the list's own choice, kept in the document.
    toggleDoneToBottom(editor.view, 0)
    expect(editor.state.doc.firstChild!.attrs.doneToBottom).toBe(true)
    expect(box.querySelector('ul[data-type="taskList"]')?.getAttribute('data-done-to-bottom')).toBe('true')
    const button = box.querySelector('[data-testid="task-summary"] button') as HTMLButtonElement
    expect(button.getAttribute('aria-pressed')).toBe('true')
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(editor.state.doc.firstChild!.attrs.doneToBottom).toBe(false)
    // Another list has its own choice.
    editor.commands.setContent('<ul data-type="taskList" data-done-to-bottom="true"><li data-type="taskItem" data-checked="true"><p>a</p></li></ul><p>x</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>b</p></li></ul>')
    const lists: boolean[] = []
    editor.state.doc.forEach((node) => node.type.name === 'taskList' && lists.push(node.attrs.doneToBottom))
    expect(lists).toEqual([true, false])
  })
})

describe('NOTES-3 AC-5 tables', () => {
  const cells = (editor: Editor) => {
    const rows: string[][] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') {
        const row: string[] = []
        node.forEach((cell) => row.push(cell.textContent))
        rows.push(row)
        return false
      }
      return true
    })
    return rows
  }

  it('NOTES-3 AC-5 the visible controls add, move and remove rows and columns, the other cells stay, the table scrolls in its box', async () => {
    const editor = makeEditor()
    editor.commands.setContent('<p>Before</p><table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>a1</p></td><td><p>b1</p></td></tr><tr><td><p>a2</p></td><td><p>b2</p></td></tr></table>')
    expect(editor.view.dom.querySelector('.tableWrapper > table')).not.toBeNull()
    const sheet = document.createElement('article')
    document.body.appendChild(sheet)
    sheet.appendChild(editor.view.dom.parentElement ?? editor.view.dom)
    const frame = { current: sheet }
    const host = document.createElement('div')
    sheet.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<TableControls editor={editor} frame={frame} />))
    const at = async (text: string) => {
      let found = -1
      editor.state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text === text) found = pos
      })
      await act(async () => void editor.commands.setTextSelection(found + 1))
    }
    const choose = async (action: string) => {
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="table-menu-button"]')!.click())
      const menu = document.querySelector<HTMLElement>('[data-testid="table-menu"]')!
      // The menu stands over everything, not inside the table's box that scrolls.
      expect(menu.parentElement).toBe(document.body)
      await act(async () => menu.querySelector<HTMLButtonElement>(`[data-testid="table-${action}"]`)!.click())
    }
    // Outside a table: no controls.
    await act(async () => void editor.commands.setTextSelection(2))
    expect(host.querySelector('[data-testid="table-menu-button"]')).toBeNull()
    await at('a1')
    expect(host.querySelector('[data-testid="table-menu-button"]')).not.toBeNull()
    await choose('addRowAfter')
    expect(cells(editor)).toEqual([['A', 'B'], ['a1', 'b1'], ['', ''], ['a2', 'b2']])
    await at('b1')
    await choose('addColumnAfter')
    expect(cells(editor)).toEqual([['A', 'B', ''], ['a1', 'b1', ''], ['', '', ''], ['a2', 'b2', '']])
    await at('a2')
    await choose('rowUp')
    expect(cells(editor)).toEqual([['A', 'B', ''], ['a1', 'b1', ''], ['a2', 'b2', ''], ['', '', '']])
    await at('b1')
    await choose('columnLeft')
    expect(cells(editor)).toEqual([['B', 'A', ''], ['b1', 'a1', ''], ['b2', 'a2', ''], ['', '', '']])
    await at('a1')
    await choose('columnRight')
    expect(cells(editor)).toEqual([['B', '', 'A'], ['b1', '', 'a1'], ['b2', '', 'a2'], ['', '', '']])
    await at('b1')
    await choose('rowDown')
    expect(cells(editor)).toEqual([['B', '', 'A'], ['b2', '', 'a2'], ['b1', '', 'a1'], ['', '', '']])
    await at('b2')
    await choose('deleteColumn')
    expect(cells(editor)).toEqual([['', 'A'], ['', 'a2'], ['', 'a1'], ['', '']])
    await at('a2')
    await choose('deleteRow')
    expect(cells(editor)).toEqual([['', 'A'], ['', 'a1'], ['', '']])
    // The quiet "+" along the edges append a column and a row at the end.
    await at('a1')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="table-add-column"]')!.click())
    expect(cells(editor)).toEqual([['', 'A', ''], ['', 'a1', ''], ['', '', '']])
    await at('a1')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="table-add-row"]')!.click())
    expect(cells(editor)).toEqual([['', 'A', ''], ['', 'a1', ''], ['', '', ''], ['', '', '']])
    // The header row on and off.
    await at('A')
    await choose('toggleHeaderRow')
    const headers = () => {
      let count = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableHeader') count++
      })
      return count
    }
    expect(headers()).toBe(0)
    await choose('toggleHeaderRow')
    expect(headers()).toBe(3)
    // A right click in a cell opens the same menu at the pointer.
    const cell = editor.view.dom.querySelector('td')!
    await act(async () => void cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    expect(document.querySelector('[data-testid="table-menu"] [data-testid="table-deleteTable"]')).not.toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="table-deleteTable"]')!.click())
    expect(types(editor)).not.toContain('table')
    await act(async () => root.unmount())
    sheet.remove()
  })

  it('NOTES-3 AC-5 Tab in the last cell adds a row', () => {
    const editor = makeEditor()
    editor.commands.setContent('<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>')
    let last = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'b') last = pos
    })
    editor.commands.setTextSelection(last + 1)
    press(editor, 'Tab')
    expect(cells(editor)).toEqual([['a', 'b'], ['', '']])
  })
})

describe('NOTES-3 AC-5 NOTES-12 a table changed by two at once', () => {
  it('NOTES-3 AC-5 one adds a row while the other adds a column: both stay, no cell loses its text', () => {
    const mine = new Y.Doc()
    const anna = makeEditor(mine, 1)
    anna.commands.setContent('<table><tr><td><p>a1</p></td><td><p>b1</p></td></tr><tr><td><p>a2</p></td><td><p>b2</p></td></tr></table>')
    const theirs = new Y.Doc()
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))
    const lena = makeEditor(theirs, 2)
    const at = (editor: Editor, text: string) => {
      let found = -1
      editor.state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text === text) found = pos
      })
      editor.commands.setTextSelection(found + 1)
    }
    // At the same time, before either hears of the other.
    at(anna, 'a2')
    tableActions(anna).addRowAfter()
    at(lena, 'b1')
    tableActions(lena).addColumnAfter()
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))
    const text = (editor: Editor) => editor.state.doc.textContent
    expect(text(anna)).toBe(text(lena))
    for (const word of ['a1', 'b1', 'a2', 'b2']) expect(text(anna)).toContain(word)
    let rows = 0
    anna.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') rows++
    })
    expect(rows).toBe(3)
    expect(anna.getHTML()).toBe(lena.getHTML())
  })
})

describe('NOTES-3 AC-11 highlighter', () => {
  it('NOTES-3 AC-11 a marked text gets one of five fixed colours, nothing else', () => {
    const editor = makeEditor()
    for (const color of ['honey', 'green', 'blue', 'rose', 'violet']) {
      editor.commands.setContent('<p>word</p>')
      editor.commands.selectAll()
      editor.commands.setHighlight({ color })
      expect(editor.view.dom.querySelector('mark')?.getAttribute('data-color')).toBe(color)
    }
    editor.commands.setContent('<p><mark data-color="red" style="background: red">word</mark></p>')
    expect(editor.view.dom.querySelector('mark')?.getAttribute('data-color')).toBeNull()
    expect(editor.view.dom.querySelector('mark')?.getAttribute('style')).toBeNull()
    for (const color of ['green', 'blue', 'rose', 'violet']) expect(css).toContain(`mark[data-color='${color}'] { background: var(--nn-mark-${color}); }`)
  })

  it('NOTES-3 AC-11 a marker sits in the line without padding or margin, the selection is never honey', () => {
    // The browser test (e2e/highlight.spec.ts) measures the letters; here the rules themselves.
    const rule = css.match(/\.nn-editor mark \{([^}]*)\}/)![1]
    expect(rule).toMatch(/padding:\s*0;/)
    expect(rule).toMatch(/margin:\s*0;/)
    expect(rule).not.toMatch(/padding:\s*0\s+\S/)
    expect(css).toMatch(/\.nn-editor \.ProseMirror ::selection \{ background: var\(--nn-select\); \}/)
    expect(css.match(/--nn-select: rgb\(([^)]*)\)/g)).not.toContain('--nn-select: rgb(242 193 78')
    for (const color of ['honey', 'green', 'blue', 'rose', 'violet']) expect(css).toMatch(new RegExp(`\\.ProseMirror mark${color === 'honey' ? '' : `\\[data-color='${color}'\\]`}::selection`))
  })

  it('NOTES-3 AC-11 AC-13 one undo takes back exactly the marker, however soon after typing; redo sets it again', () => {
    const editor = makeEditor()
    editor.commands.setContent('<p>fafasdfasdfaf</p>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    // Typed a moment ago (well inside the undo manager's 500 ms), then marked: two steps, not one.
    typeText(editor, 'x')
    editor.commands.setTextSelection({ from: 4, to: 11 })
    expect(editor.state.doc.textBetween(4, 11)).toBe('asdfasd')
    editor.chain().focus().setHighlight({ color: 'honey' }).run()
    expect(editor.view.dom.querySelector('mark')?.textContent).toBe('asdfasd')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.view.dom.querySelector('mark')).toBeNull()
    expect(editor.getText()).toBe('fafasdfasdfafx')
    expect(editor.commands.redo()).toBe(true)
    expect(editor.view.dom.querySelector('mark')?.textContent).toBe('asdfasd')
    expect(editor.view.dom.querySelector('mark')?.getAttribute('data-color')).toBe('honey')
    // Typing right after marking is a step of its own too: its undo leaves the marker.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    typeText(editor, 'y')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('fafasdfasdfafx')
    expect(editor.view.dom.querySelector('mark')?.textContent).toBe('asdfasd')
    // Taking the marker away is one step as well.
    editor.commands.setTextSelection({ from: 4, to: 11 })
    editor.chain().focus().unsetHighlight().run()
    expect(editor.view.dom.querySelector('mark')).toBeNull()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.view.dom.querySelector('mark')?.textContent).toBe('asdfasd')
    expect(editor.getText()).toBe('fafasdfasdfafx')
  })
})

describe('NOTES-3 AC-12 folding headings', () => {
  it('NOTES-3 AC-12 a folded heading hides everything up to the next heading of its size or larger, says how much, and stays folded', () => {
    const doc = new Y.Doc()
    const editor = makeEditor(doc)
    editor.commands.setContent('<h2>Before</h2><p>one</p><h3>Inner</h3><p>two</p><h2>Offers</h2><p>three</p>')
    toggleFold(editor.view, 0)
    expect(editor.state.doc.firstChild!.attrs.collapsed).toBe(true)
    expect(foldedRanges(editor.state.doc)).toEqual([expect.objectContaining({ heading: 0, count: 3 })])
    const hidden = Array.from(editor.view.dom.querySelectorAll('.nn-hidden')).map((node) => node.textContent?.replace(/[▾▸]/g, ''))
    expect(hidden).toEqual(['one', 'Inner', 'two'])
    expect(editor.view.dom.querySelector('.nn-folded-count')?.textContent).toBe('folded · 3 paragraphs')
    expect(collapseKey.getState(editor.state)).toBeTruthy()
    // The state is part of the document: another window, or the next opening, shows it folded too.
    const again = new Y.Doc()
    Y.applyUpdate(again, Y.encodeStateAsUpdate(doc))
    const reopened = makeEditor(again)
    expect(reopened.state.doc.firstChild!.attrs.collapsed).toBe(true)
    expect(Array.from(reopened.view.dom.querySelectorAll('.nn-hidden')).map((node) => node.textContent?.replace(/[▾▸]/g, ''))).toEqual(['one', 'Inner', 'two'])
    // Clicking the arrow unfolds.
    const arrow = reopened.view.dom.querySelector('[data-testid="fold"]') as HTMLElement
    arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(reopened.state.doc.firstChild!.attrs.collapsed).toBe(false)
    expect(reopened.view.dom.querySelectorAll('.nn-hidden')).toHaveLength(0)
  })
})

describe('NOTES-3 AC-13 undo touches one\'s own changes only', () => {
  it('NOTES-3 AC-13 undo and redo of two people writing the same note', () => {
    const one = new Y.Doc()
    const two = new Y.Doc()
    one.on('update', (update: Uint8Array, origin: unknown) => origin !== 'wire' && Y.applyUpdate(two, update, 'wire'))
    two.on('update', (update: Uint8Array, origin: unknown) => origin !== 'wire' && Y.applyUpdate(one, update, 'wire'))
    const mine = makeEditor(one, 1)
    const theirs = makeEditor(two, 2)
    mine.commands.setContent('<p>start</p>')
    expect(theirs.getText()).toBe('start')
    mine.commands.setTextSelection(6)
    typeText(mine, ' mine')
    theirs.commands.setTextSelection(theirs.state.doc.content.size - 1)
    typeText(theirs, ' theirs')
    expect(mine.getText()).toBe('start mine theirs')
    expect(mine.commands.undo()).toBe(true)
    expect(mine.getText()).not.toContain('mine')
    expect(mine.getText()).toContain('theirs')
    expect(theirs.getText()).toBe(mine.getText())
    expect(mine.commands.redo()).toBe(true)
    expect(mine.getText()).toContain('mine')
    expect(mine.getText()).toContain('theirs')
  })
})

describe('NOTES-3 AC-14 AC-15 room on a wide screen', () => {
  async function toolbar(editor: Editor) {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    await act(async () => root.render(<Toolbar editor={editor} onLink={() => undefined} />))
    return { box, root }
  }

  it('NOTES-3 AC-14 the toolbar chooses narrow, wide or full width, kept on this device for every note', async () => {
    localStorage.clear()
    forgetPrefs()
    const { box, root } = await toolbar(makeEditor())
    const button = box.querySelector<HTMLButtonElement>('[data-testid="tool-width"]')!
    expect(button.tabIndex).toBe(-1)
    expect(button.hasAttribute('data-tool')).toBe(true)
    await act(async () => button.click())
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((item) => [item.textContent?.replace('✓', ''), item.getAttribute('aria-checked')])).toEqual([['Narrow', 'true'], ['Wide', 'false'], ['Full width', 'false']])
    await act(async () => items[1].click())
    expect(localStorage.getItem(prefKey('textWidth', 0))).toBe('wide')
    expect(button.className).toContain('nn-chosen')
    // Another note's toolbar, and after a reload: the same width.
    forgetPrefs()
    const other = await toolbar(makeEditor())
    await act(async () => other.box.querySelector<HTMLButtonElement>('[data-testid="tool-width"]')!.click())
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')!.textContent).toContain('Wide')
    expect(parseTextWidth('full')).toBe('full')
    expect(parseTextWidth('enormous')).toBe('narrow')
    expect(TEXT_MAX).toEqual({ narrow: 760, wide: 1100, full: null })
    await act(async () => root.unmount())
    await act(async () => other.root.unmount())
  })

  it('NOTES-3 AC-15 the outline lists the headings by level, jumps, folds, and follows changes of others', async () => {
    localStorage.clear()
    forgetPrefs()
    const doc = new Y.Doc()
    const editor = makeEditor(doc)
    editor.commands.setContent('<h1>Trip</h1><p>Bring #passport</p><h2>Train</h2><p>at 8</p><h3>Seats</h3><p>12, 13</p><h2>Hotel</h2><p>two nights</p>')
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    await act(async () => root.render(<Outline editor={editor} info={[{ label: 'Folder', text: 'Inbox' }]} />))
    const headings = () => [...box.querySelectorAll<HTMLElement>('[data-testid="outline-heading"]')].map((row) => `${row.dataset.level} ${row.textContent}`)
    expect(headings()).toEqual(['1 Trip', '2 Train', '3 Seats', '2 Hotel'])
    expect([...box.querySelectorAll('[data-testid="outline-tag"]')].map((tag) => tag.textContent)).toEqual(['#passport'])
    expect(box.querySelector('[data-testid="outline-info"]')!.textContent).toContain('FolderInbox')
    // A click goes to the heading.
    const hotel = [...box.querySelectorAll<HTMLElement>('[data-testid="outline-heading"]')][3]
    await act(async () => hotel.querySelectorAll('button')[1].click())
    expect(editor.state.selection.$from.parent.textContent).toBe('Hotel')
    // The arrow folds the section, through the heading's own `collapsed`.
    const fold = [...box.querySelectorAll<HTMLButtonElement>('[data-testid="outline-fold"]')][1]
    await act(async () => fold.click())
    expect(headingsOf(editor.state.doc)[1]).toMatchObject({ text: 'Train', collapsed: true })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    // Somebody else adds a heading in another window: the outline follows.
    const theirs = new Y.Doc()
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(doc))
    const other = makeEditor(theirs, 2)
    other.commands.setContent(other.getHTML() + '<h2>Food</h2><p>pasta</p>')
    await act(async () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(theirs)))
    expect(headings()).toEqual(['1 Trip', '2 Train', '3 Seats', '2 Hotel', '2 Food'])
    await act(async () => root.unmount())
  })

  it('NOTES-3 AC-15 the outline can be turned off and on in the toolbar, kept on this device', async () => {
    localStorage.clear()
    forgetPrefs()
    const { box, root } = await toolbar(makeEditor())
    const button = box.querySelector<HTMLButtonElement>('[data-testid="tool-outline"]')!
    expect(button.getAttribute('aria-pressed')).toBe('true')
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem(prefKey('outline', 0))).toBe('off')
    expect(OUTLINE_FROM).toBe(1800)
    await act(async () => root.unmount())
  })
})

describe('NOTES-3 AC-1 the placeholder', () => {
  it('NOTES-3 AC-1 "Start writing" shows in an empty note only, never on an empty paragraph between written ones', () => {
    const editor = makeEditor()
    const shown = () => [...editor.view.dom.querySelectorAll('[data-placeholder]')].map((node) => node.getAttribute('data-placeholder')).filter(Boolean)
    editor.commands.focus()
    expect(shown()).toEqual(['Start writing'])
    editor.commands.setContent('<p>one</p><p></p><p>two</p>')
    // The cursor in the empty paragraph in the middle.
    editor.commands.setTextSelection(6)
    expect(editor.state.selection.$from.parent.textContent).toBe('')
    expect(shown()).toEqual([])
    editor.commands.setContent('<p></p>')
    editor.commands.focus()
    expect(shown()).toEqual(['Start writing'])
  })
})

describe('NOTES-3 EC-11 a short toolbar', () => {
  it('NOTES-3 EC-11 keeps one row: what does not fit goes into "More", where each tool still works', async () => {
    let width = 520
    const observers: { callback: ResizeObserverCallback; target: Element }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observers.push({ callback: this.callback, target })
          this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        disconnect() {}
        unobserve() {}
      },
    )
    try {
      const editor = makeEditor()
      const box = document.createElement('div')
      document.body.appendChild(box)
      const root = createRoot(box)
      await act(async () => root.render(<Toolbar editor={editor} onLink={() => undefined} />))
      const shownTools = () => [...box.querySelectorAll('button[data-tool]')].map((tool) => tool.getAttribute('data-testid'))
      // 520 px: the text style, eight tools and "More" (nine places of 38 px).
      expect(shownTools()).toHaveLength(8 + 1)
      expect(shownTools().at(-1)).toBe('tool-more')
      expect(shownTools()).toContain('tool-bold')
      expect(shownTools()).not.toContain('tool-outline')
      expect(box.querySelector('[data-testid="toolbar"]')!.className).toContain('flex-nowrap')
      await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="tool-more"]')!.click())
      const more = [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="more-"]')].map((item) => item.dataset.testid)
      expect(more).toContain('more-table')
      expect(more).toContain('more-outline')
      expect(more.length + 8).toBe(19)
      // A tool from "More" does what it does in the row: the table goes in.
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="more-table"]')!.click())
      expect(types(editor)).toContain('table')
      // Wide again: everything in the row, no "More".
      width = 1400
      await act(async () => observers.at(-1)!.callback([{ target: observers.at(-1)!.target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver))
      expect(shownTools()).not.toContain('tool-more')
      expect(shownTools()).toHaveLength(19)
      await act(async () => root.unmount())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('NOTES-3 AC-3 the link key', () => {
  it('NOTES-3 AC-3 the link is on Ctrl/Cmd+Alt+K; Ctrl/Cmd+K is left for the search', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const doc = new Y.Doc()
    const provider = new NoteProvider('note', doc, { socket: () => { throw new Error('offline in tests') } })
    const asked: string[] = []
    const editor = new Editor({
      element,
      extensions: editorExtensions({ doc, provider, me: presenceUser(1, 'person 1'), t, placeholder: 'Start writing', hooks: { onLink: () => asked.push('link') } }),
      editorProps,
    })
    made.push(editor)
    expect(press(editor, 'k', { ctrl: true })).toBe(false)
    expect(asked).toEqual([])
    expect(press(editor, 'k', { ctrl: true, alt: true })).toBe(true)
    expect(asked).toEqual(['link'])
  })
})

describe('NOTES-3 EC-3 pasting', () => {
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal { color: red }</style><script>alert('x')</script></head>
    <body><!--[if gte mso 9]>junk<![endif]--><h1 style="color:blue" class="MsoTitle">Plan</h1><p class="MsoNormal" style="font-size: 30pt"><b>bold</b> and <span style="font-family: Comic Sans">plain</span><o:p></o:p></p>
    <form action="https://evil.example"><input value="secret"><button>Send</button><textarea>typed</textarea></form>
    <ul><li>one</li><li>two</li></ul><img src="x" onerror="alert(1)"><p onclick="alert(2)">clicked</p>
    <script>window.pasted = 'run'</script><p>after<script>document.title = 'taken'</script></p></body></html>`

  it('NOTES-3 EC-3 what nexnotes knows stays, the rest becomes plain text, scripts, forms and styles go', () => {
    const cleaned = cleanPastedHtml(word)
    expect(cleaned).not.toMatch(/script|style=|class=|onclick|onerror|<form|<input|<button|<textarea|<img|o:p|alert/i)
    const editor = makeEditor()
    editor.commands.setContent('<p></p>')
    editor.view.pasteHTML(word)
    const json = JSON.stringify(editor.getJSON())
    expect(types(editor)).toEqual(expect.arrayContaining(['heading', 'paragraph', 'bulletList', 'listItem']))
    expect(marksOf(editor)).toEqual(['bold'])
    expect(editor.getText()).toContain('plain')
    expect(json).not.toMatch(/alert|secret|typed|Send|Comic|30pt|MsoNormal|pasted|taken/)
    // A script in the body (not only in the head, which the body leaves out anyway) goes with its text.
    expect(cleaned).not.toMatch(/pasted|taken/)
    expect(editor.getText()).toContain('after')
  })

  it('NOTES-3 EC-3 a page from the web and Apple Notes keep headings, lists, links and tables', () => {
    const editor = makeEditor()
    editor.commands.setContent('<p></p>')
    editor.view.pasteHTML('<div><h2>Title</h2><table><tr><td>a</td><td>b</td></tr></table><p><a href="https://example.com" target="_top" onclick="x()">site</a> <i>it</i></p><iframe src="https://evil.example"></iframe></div>')
    expect(types(editor)).toEqual(expect.arrayContaining(['heading', 'table', 'tableCell']))
    expect(editor.getHTML()).toContain('href="https://example.com"')
    expect(editor.getHTML()).not.toMatch(/onclick|iframe|_top/)
  })
})

describe('NOTES-3 EC-8 links', () => {
  it('NOTES-3 EC-8 javascript: and other dangerous targets never become links', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'https://', 'mailto:', 'java\tscript:alert(1)', 'https://exa mple.com']) {
      expect(safeHref(bad), bad).toBeNull()
    }
    for (const good of ['https://example.com/a?b=c', 'http://example.com', 'mailto:someone@example.com']) expect(safeHref(good)).toBe(good)
    const editor = makeEditor()
    editor.commands.setContent('<p></p>')
    editor.view.pasteHTML('<p><a href="javascript:alert(1)">click me</a> <a href="https://example.com">ok</a></p>')
    const anchors = Array.from(editor.view.dom.querySelectorAll('a'))
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(['https://example.com'])
    expect(editor.getText()).toContain('click me')
    editor.commands.setContent('<p></p>')
    typeText(editor, 'javascript:alert(1) ')
    expect(editor.view.dom.querySelector('a')).toBeNull()
  })

  it('NOTES-3 EC-8 links open in a new tab without access to nexnotes, and only with Ctrl or ⌘', () => {
    const opened: unknown[][] = []
    const spy = vi.spyOn(window, 'open').mockImplementation((...args: unknown[]) => {
      opened.push(args)
      return null
    })
    const editor = makeEditor()
    editor.commands.setContent('<p><a href="https://example.com">site</a></p>')
    const anchor = editor.view.dom.querySelector('a') as HTMLAnchorElement
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toContain('noopener')
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(opened).toEqual([])
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(opened).toEqual([['https://example.com', '_blank', 'noopener,noreferrer']])
    expect(openLink('javascript:alert(1)')).toBe(false)
    expect(opened).toHaveLength(1)
    spy.mockRestore()
  })
})

describe('NOTES-3 EC-10 every script', () => {
  it('NOTES-3 EC-10 umlauts, emoji and right-to-left text stay as they are in the shared document', () => {
    const doc = new Y.Doc()
    const editor = makeEditor(doc)
    const text = 'Grüße 👋🏽 مرحبا بالعالم שלום'
    editor.commands.setContent('<p></p>')
    editor.commands.setTextSelection(1)
    typeText(editor, text)
    expect(editor.getText()).toBe(text)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    expect(makeEditor(copy).getText()).toBe(text)
    expect(getComputedStyle(editor.view.dom).direction === 'rtl').toBe(false)
  })

  it('NOTES-3 EC-4 an empty body counts as empty, a body with anything in it does not', () => {
    const editor = makeEditor()
    editor.commands.setContent('<p></p>')
    expect(bodyIsEmpty(editor)).toBe(true)
    editor.commands.setContent('<p>   </p>')
    expect(bodyIsEmpty(editor)).toBe(true)
    editor.commands.setContent('<hr>')
    expect(bodyIsEmpty(editor)).toBe(false)
  })
})

describe('NOTES-15 AC-4 a restore while somebody writes', () => {
  it('NOTES-15 AC-4 the caret of somebody writing in a paragraph a restore replaces stands at the end of the one that took its place', () => {
    // The server puts the restored paragraph right after the one it replaces, then deletes that one; text typed into
    // it on the way goes to the end of the restored paragraph (backend `rescue.py`), where the caret is: one word.
    const mine = new Y.Doc()
    const editor = makeEditor(mine)
    editor.commands.setContent('<p>first session w7 w</p><p>second</p>')
    let end = 0
    editor.state.doc.forEach((node, offset, index) => {
      if (index === 0) end = offset + node.nodeSize - 1
    })
    editor.commands.setTextSelection(end)
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(mine))
    const body = server.getXmlFragment('body')
    server.transact(() => {
      const restored = new Y.XmlElement('paragraph')
      const text = new Y.XmlText()
      text.insert(0, 'first session')
      restored.insert(0, [text])
      body.insert(1, [restored])
      body.delete(0, 1)
    })
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(server))
    const caret = editor.state.doc.resolve(editor.state.selection.from)
    expect([caret.index(0), caret.parent.textContent, caret.parentOffset]).toEqual([0, 'first session', 13])
  })
})

describe('NOTES-8 EC-1 the title field', () => {
  it('NOTES-8 EC-1 a document that has its title before the field is drawn reports it at once, and every change after', async () => {
    const doc = new Y.Doc()
    doc.getText('title').insert(0, 'Grocery list')
    const seen: string[] = []
    const element = document.createElement('div')
    document.body.appendChild(element)
    const root = createRoot(element)
    await act(async () => root.render(<TitleField doc={doc} editable onEnter={() => undefined} onValue={(value) => seen.push(value)} />))
    expect(seen).toEqual(['Grocery list'])
    await act(async () => doc.getText('title').insert(0, 'Big '))
    expect(seen).toEqual(['Grocery list', 'Big Grocery list'])
    await act(async () => root.unmount())
    element.remove()
  })
})
