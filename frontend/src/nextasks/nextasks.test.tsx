/**
 * NOTES-19 An nextasks schicken on the page: the card in Settings, Connections (how to connect, connecting checked at
 * once, another interface), "An nextasks" in an open note with its dialog (list used last, due day, several lines,
 * one sending per opening, failures), and the marks beside the lines sent (where they stand, that they follow the line
 * and go with it, a task gone in nextasks). The server's side is in `backend/tests/test_notes19.py`.
 */
import { Editor } from '@tiptap/core'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import * as Y from 'yjs'

import { editorExtensions, editorProps } from '../editor/extensions'
import { NOTE_HEAD_PARTS } from '../editor/noteParts'
import { presenceUser } from '../editor/presence'
import { NoteProvider } from '../editor/provider'
import { CONNECTION_SECTIONS } from '../extensions'
import { hideNotice, useNotice } from '../folders/notice'
import i18n from '../i18n'
import { forgetPrefs } from '../lib/devicePref'
import type { NoteHead } from '../notes/api'
import { setNextasks, type AreaChoice, type NextasksStatus, type TaskList, type TaskMark } from './api'
import { dueText } from './hooks'
import { anchorOf, linesToSend, marksKey, showMarks } from './marks'
import { NextasksSection } from './NextasksSection'
import { NoteTaskHost, NoteTaskItem, SendToNextasks } from './SendToNextasks'
import { SelectionBar } from '../editor/SelectionBar'
import './register'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let status: NextasksStatus
let marks: TaskMark[]
let sendAnswer: (call: Call) => Response
let openAnswer: () => Response
let areas: AreaChoice[]
let standard: string | null
let offered: TaskList[] | null
let root: Root
let box: HTMLDivElement
const editors: Editor[] = []

const LIST = '11111111-1111-4111-8111-111111111111'
const SECTION = '22222222-2222-4222-8222-222222222222'
const SHOPPING = '33333333-3333-4333-8333-333333333333'
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FAMILY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function startAreas(): AreaChoice[] {
  return [
    { id: HOME, name: 'Zuhause', icon: 'house', color: 'orange', whole: true, lists: [{ id: LIST, name: 'Renovierung', icon: 'hammer', color: 'red', chosen: true }] },
    { id: FAMILY, name: 'Familie', icon: 'heart', color: '#3a86ff', whole: true, lists: [{ id: SHOPPING, name: 'Einkauf', icon: 'shopping-cart', color: 'green', chosen: true }] },
  ]
}
const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/nextasks') return reply(200, status)
  if (method === 'PUT' && path === '/api/nextasks') {
    if (body!.token === 'ntk_old') return reply(409, { detail: { code: 'nextasks_too_old', message: 'other API' } })
    status = { connected: true, local_allowed: true, url: String(body!.url), host: new URL(String(body!.url)).hostname, name: 'Robin', last_list: null }
    return reply(200, status)
  }
  if (method === 'DELETE' && path === '/api/nextasks') {
    status = { connected: false, local_allowed: true }
    return reply(204, null)
  }
  if (method === 'GET' && path === '/api/nextasks/areas') return reply(200, { areas, default: standard })
  if (method === 'PUT' && path === '/api/nextasks/areas') {
    // As the server: whole areas take their lists, a standard list not among the chosen ones counts as none.
    const whole = body!.areas as string[]
    const single = body!.lists as string[]
    areas = areas.map((area) => ({ ...area, whole: whole.includes(area.id), lists: area.lists.map((one) => ({ ...one, chosen: whole.includes(area.id) || single.includes(one.id) })) }))
    const chosen = areas.flatMap((area) => area.lists.filter((one) => one.chosen).map((one) => one.id))
    standard = typeof body!.default === 'string' && chosen.includes(body!.default) ? body!.default : null
    return reply(200, { areas, default: standard })
  }
  if (method === 'GET' && path === '/api/nextasks/lists' && offered) return reply(200, { lists: offered, last: `${LIST}/${SECTION}` })
  if (method === 'GET' && path === '/api/nextasks/lists')
    return reply(200, {
      lists: [
        { id: LIST, name: 'Zuhause › Renovierung', hidden: false },
        { id: `${LIST}/${SECTION}`, name: 'Zuhause › Renovierung › Bad', hidden: false },
      ],
      last: `${LIST}/${SECTION}`,
    })
  if (method === 'POST' && path === '/api/nextasks/send') return sendAnswer(call)
  if (method === 'GET' && path === '/api/nextasks/links') return reply(200, { links: marks })
  if (method === 'GET' && /^\/api\/nextasks\/links\/\d+\/open$/.test(path)) return openAnswer()
  if (method === 'DELETE' && /^\/api\/nextasks\/links\/\d+$/.test(path)) {
    marks = marks.filter((mark) => `/api/nextasks/links/${mark.id}` !== path)
    return reply(204, null)
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

function NoticeLine() {
  const notice = useNotice()
  return <p data-testid="notice">{notice?.text ?? ''}</p>
}

async function render(node: ReactNode): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/notes/n1']}>
        {node}
        <NoticeLine />
      </MemoryRouter>,
    ),
  )
  await settle()
}

function makeEditor(html: string): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const doc = new Y.Doc()
  const provider = new NoteProvider('n1', doc, { socket: () => { throw new Error('offline in tests') } })
  const editor = new Editor({ element, extensions: editorExtensions({ doc, provider, me: presenceUser(1, 'Robin'), t, placeholder: '' }), editorProps })
  editor.commands.setContent(html)
  editors.push(editor)
  return editor
}

const head = (extra: Partial<NoteHead> = {}) => ({ id: 'n1', title: 'Handwerker Bad', can_write: true, ...extra }) as unknown as NoteHead

/** The position inside the text block holding `text`. */
function inside(editor: Editor, text: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent.includes(text)) found = pos + 1
    return found < 0
  })
  expect(found).toBeGreaterThan(0)
  return found
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function select(element: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(async () => {
  await i18n.changeLanguage('de')
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  marks = []
  areas = startAreas()
  standard = null
  offered = null
  forgetPrefs()
  localStorage.clear()
  status = { connected: true, local_allowed: true, url: 'http://nextasks.home:8510', host: 'nextasks.home', name: 'Robin', last_list: null }
  setNextasks(status)
  sendAnswer = (call) => {
    const lines = call.body!.lines as Array<{ anchor: string }>
    marks = lines.map((line, index) => ({ id: index + 1, note_id: 'n1', anchor: line.anchor, task_url: 'https://tasks.example.com/t', list_name: String(call.body!.list_name), due_date: (call.body!.due_date as string) ?? null, created_at: null }))
    return reply(200, { sent: lines.length, links: marks })
  }
  openAnswer = () => reply(200, { url: 'https://tasks.example.com/t' })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const call = { method: init?.method ?? 'GET', path: url.pathname, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    return answer(call)
  })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  for (const editor of editors.splice(0)) editor.destroy()
  for (const leftover of document.querySelectorAll('[role="dialog"]')) leftover.closest('.fixed')?.remove()
  hideNotice()
  setNextasks(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NOTES-19 nextasks in Settings, Connections', () => {
  it('stands after the devices and before the MCP keys, and an open note has the button', () => {
    const keys = CONNECTION_SECTIONS.map((section) => section.key)
    if (keys.includes('mcp')) expect(keys.indexOf('nextasks')).toBeLessThan(keys.indexOf('mcp'))
    expect(NOTE_HEAD_PARTS).toContain(SendToNextasks)
  })

  it('NOTES-19 AC-4 without nextasks connected the note has no button and Connections says how to connect', async () => {
    status = { connected: false, local_allowed: false }
    setNextasks(status)
    const editor = makeEditor('<p>Waschbecken abbauen lassen</p>')
    await render(
      <>
        <SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />
        <NextasksSection />
      </>,
    )
    expect($('nextasks-send')).toBeNull()
    expect($('nextasks-how')!.textContent).toContain('API-Schlüssel mit Lesen und Schreiben')
    // nextasks in the own network needs the operator first: said beside the form.
    expect($('nextasks-local')!.textContent).toContain('Betreiber')
    expect(calls.some((call) => call.path === '/api/nextasks/links')).toBe(false)
  })

  it('NOTES-19 AC-5 connecting sends address and key, says connected with whom, changes the key and disconnects', async () => {
    status = { connected: false, local_allowed: true }
    setNextasks(status)
    await render(<NextasksSection />)
    const [url, key] = [...document.querySelectorAll<HTMLInputElement>('[data-testid="nextasks-form"] input')]
    act(() => type(url, 'http://nextasks.home:8510'))
    act(() => type(key, 'ntk_good'))
    await click($('nextasks-connect'))
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ url: 'http://nextasks.home:8510', token: 'ntk_good' })
    // Just connected here, the card stays open: "verbunden", the address, as whom.
    expect($('nextasks-connected')!.textContent).toBe('verbundennextasks.home · als Robin')
    expect($('card-fold')).toBeNull()
    // The key changed: the address stays filled in, only the key is typed.
    await click($('nextasks-change'))
    const [again, newKey] = [...document.querySelectorAll<HTMLInputElement>('[data-testid="nextasks-form"] input')]
    expect(again.value).toBe('http://nextasks.home:8510')
    act(() => type(newKey, 'ntk_new'))
    await click($('nextasks-connect'))
    expect(calls.filter((call) => call.method === 'PUT').at(-1)!.body!.token).toBe('ntk_new')
    await click($('nextasks-disconnect'))
    await click($('nextasks-disconnect-confirm'))
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/nextasks')).toBe(true)
    expect($('nextasks-form')).not.toBeNull()
  })

  it('NOTES-19 EC-7 a nextasks with another interface is said when connecting', async () => {
    status = { connected: false, local_allowed: true }
    setNextasks(status)
    await render(<NextasksSection />)
    const [url, key] = [...document.querySelectorAll<HTMLInputElement>('[data-testid="nextasks-form"] input')]
    act(() => type(url, 'http://nextasks.home:8510'))
    act(() => type(key, 'ntk_old'))
    await click($('nextasks-connect'))
    expect(document.body.textContent).toContain(t('errors.nextasks_too_old'))
    expect($('nextasks-connected')).toBeNull()
  })
})

describe('NOTES-19 the nextasks card as in nextime: folding, areas and lists, the standard list', () => {
  const area = (name: string) => $$('nextasks-area-group').find((group) => group.textContent!.includes(name))!
  const tick = (group: HTMLElement, testId: string) => group.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
  const puts = () => calls.filter((call) => call.method === 'PUT' && call.path === '/api/nextasks/areas').map((call) => call.body)

  it('NOTES-19 connected, the card is folded to its head with nextasks logo, "verbunden" and the address; opened it stays open', async () => {
    await render(<NextasksSection />)
    const head = $('card-fold')!
    expect(head.tagName).toBe('BUTTON')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect($('card-logo')!.getAttribute('src')).toBe('/apps/nextasks.svg')
    expect($('nextasks-summary')!.textContent).toBe('verbundennextasks.home')
    expect($('nextasks-areas')).toBeNull()
    expect(calls.some((call) => call.path === '/api/nextasks/areas')).toBe(false)
    await click(head)
    expect($('card-fold')!.getAttribute('aria-expanded')).toBe('true')
    expect($('card-fold')!.getAttribute('aria-controls')).toBe($('nextasks-connected')!.parentElement!.id)
    expect($('nextasks-summary')).toBeNull()
    expect($('nextasks-address')!.textContent).toBe('nextasks.home · als Robin')
    expect($('nextasks-change')).not.toBeNull()
    // Kept on this device: drawn again, it is open.
    await act(async () => root.unmount())
    root = createRoot(box)
    await render(<NextasksSection />)
    expect($('card-fold')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('NOTES-19 all areas are ticked from the start, their lists ticked and locked, each with symbol and colour from nextasks', async () => {
    localStorage.setItem('nexnotes.fold.nextasks.0', '0')
    await render(<NextasksSection />)
    expect($('nextasks-areas')!.querySelector('legend')!.textContent).toBe('Bereiche und Listen')
    const home = area('Zuhause')
    expect(tick(home, 'nextasks-area').checked).toBe(true)
    expect(tick(home, 'nextasks-list').checked).toBe(true)
    expect(tick(home, 'nextasks-list').disabled).toBe(true)
    const marks = [...home.querySelectorAll<HTMLElement>('[data-testid="area-mark"]')]
    expect(marks.map((mark) => [mark.dataset.symbol, mark.dataset.color])).toEqual([['house', 'orange'], ['hammer', 'red']])
    expect(marks[1].getAttribute('aria-hidden')).toBe('true')
    // The ticks are nexnotes' own (components/Check), each named by its row.
    expect(tick(home, 'nextasks-area').className).toContain('accent-[var(--color-accent-500)]')
    expect(tick(home, 'nextasks-area').closest('label')!.textContent).toBe('Zuhause')
    expect(($('nextasks-standard') as HTMLSelectElement).value).toBe('')
  })

  it('NOTES-19 an area unticked leaves single lists to tick, the area then half; ticked again it takes all its lists', async () => {
    localStorage.setItem('nexnotes.fold.nextasks.0', '0')
    await render(<NextasksSection />)
    await click(tick(area('Familie'), 'nextasks-area'))
    expect(puts().at(-1)).toEqual({ areas: [HOME], lists: [], default: null })
    const family = area('Familie')
    expect(tick(family, 'nextasks-list').disabled).toBe(false)
    expect(tick(family, 'nextasks-list').checked).toBe(false)
    await click(tick(family, 'nextasks-list'))
    expect(puts().at(-1)).toEqual({ areas: [HOME], lists: [SHOPPING], default: null })
    expect(tick(area('Familie'), 'nextasks-area').indeterminate).toBe(true)
    expect(tick(area('Familie'), 'nextasks-area').getAttribute('aria-checked')).toBe('mixed')
    await click(tick(area('Familie'), 'nextasks-area'))
    expect(puts().at(-1)).toEqual({ areas: [HOME, FAMILY], lists: [], default: null })
  })

  it('NOTES-19 one of the chosen lists becomes the standard list; chosen away it is none, quietly', async () => {
    localStorage.setItem('nexnotes.fold.nextasks.0', '0')
    await render(<NextasksSection />)
    const choice = $('nextasks-standard') as HTMLSelectElement
    // A named field with the chosen lists and "Keine", reachable by keyboard as any select.
    expect(document.querySelector(`label[for="${choice.id}"]`)!.textContent).toBe('Standardliste')
    expect([...choice.options].map((option) => option.textContent)).toEqual(['Keine', 'Zuhause › Renovierung', 'Familie › Einkauf'])
    act(() => select(choice, SHOPPING))
    await settle()
    expect(puts().at(-1)).toEqual({ areas: [HOME, FAMILY], lists: [], default: SHOPPING })
    expect(($('nextasks-standard') as HTMLSelectElement).value).toBe(SHOPPING)
    await click(tick(area('Familie'), 'nextasks-area'))
    expect(puts().at(-1)).toEqual({ areas: [HOME], lists: [], default: null })
    expect(($('nextasks-standard') as HTMLSelectElement).value).toBe('')
    expect([...($('nextasks-standard') as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Keine', 'Zuhause › Renovierung'])
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('NOTES-19 An nextasks in an open note', () => {
  it('NOTES-19 the dialog offers the lists chosen in Connections and chooses the standard list before the one used last', async () => {
    offered = [
      { id: LIST, name: 'Zuhause › Renovierung', hidden: false, default: false },
      { id: SHOPPING, name: 'Familie › Einkauf', hidden: false, default: true },
    ]
    const editor = makeEditor('<p>Milch</p>')
    editor.commands.setTextSelection(2)
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    const list = $('nextasks-list') as HTMLSelectElement
    expect([...list.options].map((option) => option.value)).toEqual([LIST, SHOPPING])
    expect(list.value).toBe(SHOPPING)
    await click($('nextasks-submit'))
    expect(calls.find((call) => call.path === '/api/nextasks/send')!.body!.list_id).toBe(SHOPPING)
  })

  it('NOTES-19 AC-1 AC-6 the line of the cursor goes, to the list used last, with a due day', async () => {
    const editor = makeEditor('<p>Silikonfarbe grau bestätigen</p><p>Waschbecken abbauen lassen</p>')
    editor.commands.setTextSelection(inside(editor, 'Waschbecken') + 3)
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    expect($$('nextasks-line').map((line) => line.textContent)).toEqual(['Waschbecken abbauen lassen'])
    expect(($('nextasks-list') as HTMLSelectElement).value).toBe(`${LIST}/${SECTION}`)
    act(() => type($('nextasks-due') as HTMLInputElement, '2026-11-27'))
    await click($('nextasks-submit'))
    const sent = calls.find((call) => call.path === '/api/nextasks/send')!.body!
    expect(sent.list_id).toBe(`${LIST}/${SECTION}`)
    expect(sent.list_name).toBe('Zuhause › Renovierung › Bad')
    expect(sent.due_date).toBe('2026-11-27')
    expect(sent.note_id).toBe('n1')
    const lines = sent.lines as Array<{ text: string; anchor: string }>
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('Waschbecken abbauen lassen')
    expect(lines[0].anchor).toMatch(/^\d+\.\d+$/)
    expect($('notice')!.textContent).toBe('Aufgabe in nextasks angelegt.')
    // The mark stands at that line, not at the other.
    await settle()
    const mark = $('nextasks-mark')
    expect(mark).not.toBeNull()
    expect(mark!.closest('p')!.textContent).toContain('Waschbecken')
    expect(mark!.textContent).toMatch(/^in nextasks · fällig /)
  })

  it('NOTES-19 EC-2 several lines selected: the dialog names how many, one task per line', async () => {
    const editor = makeEditor('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Silikon</p></li><li data-type="taskItem" data-checked="false"><p>Waschbecken</p></li></ul><p></p><p>Termin</p>')
    editor.commands.selectAll()
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    expect($('nextasks-count')!.textContent).toBe('3 Zeilen werden zu 3 Aufgaben:')
    expect($('nextasks-submit')!.textContent).toBe('3 schicken')
    // Another list than the one used last.
    act(() => select($('nextasks-list') as HTMLSelectElement, LIST))
    await click($('nextasks-submit'))
    const body = calls.find((call) => call.path === '/api/nextasks/send')!.body!
    expect([body.list_id, body.list_name]).toEqual([LIST, 'Zuhause › Renovierung'])
    expect(body.due_date).toBeUndefined()
    const lines = body.lines as Array<{ text: string; anchor: string }>
    expect(lines.map((line) => line.text)).toEqual(['Silikon', 'Waschbecken', 'Termin'])
    // A checklist item is anchored as the item, not as the paragraph inside it.
    let item: import('@tiptap/pm/model').Node | null = null
    editor.state.doc.descendants((node) => {
      if (!item && node.type.name === 'taskItem') item = node
    })
    expect(lines[0].anchor).toBe(anchorOf(editor.state, item!))
    expect(new Set(lines.map((line) => line.anchor)).size).toBe(3)
    expect($('notice')!.textContent).toBe('3 Aufgaben in nextasks angelegt.')
  })

  it('NOTES-19 EC-6 one opening of the dialog is one sending: a retry sends the same id', async () => {
    let first = true
    sendAnswer = () => {
      if (first) {
        first = false
        return reply(502, { detail: { code: 'nextasks_unreachable', message: 'away', sent: 0 } })
      }
      return reply(200, { sent: 1, links: [] })
    }
    const editor = makeEditor('<p>Einmal</p>')
    editor.commands.setTextSelection(2)
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    await click($('nextasks-submit'))
    expect($('nextasks-problem')!.textContent).toContain(t('errors.nextasks_unreachable'))
    await click($('nextasks-submit'))
    const ids = calls.filter((call) => call.path === '/api/nextasks/send').map((call) => call.body!.request_id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(String(ids[0])).toMatch(/^[0-9a-f]{32}$/)
  })

  it('NOTES-19 EC-1 a key nextasks refuses is said and leads to Connections; the note stays as it was', async () => {
    sendAnswer = () => reply(409, { detail: { code: 'nextasks_token_invalid', message: 'no' } })
    const editor = makeEditor('<p>Silikon</p>')
    const before = JSON.stringify(editor.getJSON())
    editor.commands.setTextSelection(2)
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    await click($('nextasks-submit'))
    expect($('nextasks-problem')!.textContent).toContain(t('errors.nextasks_token_invalid'))
    expect($('nextasks-fix')!.getAttribute('href')).toBe('/settings/connections')
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect($('nextasks-mark')).toBeNull()
  })

  it('NOTES-19 a line without text sends nothing, a locked note and one opened from the vault have no button', async () => {
    const editor = makeEditor('<p></p><p>Text</p>')
    editor.commands.setTextSelection(1)
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-send'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect($('notice')!.textContent).toBe(t('nextasks.send.nothing'))
    await render(<SendToNextasks noteId="n1" editor={editor} head={head({ locked: true } as Partial<NoteHead>)} sealed={false} />)
    expect($('nextasks-send')).toBeNull()
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed />)
    expect($('nextasks-send')).toBeNull()
  })
})

describe("nextasks from the bar at the selection and from the note's menu (24.11.2026)", () => {
  const later = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 200))))
  const tool = (key: string) => document.querySelector<HTMLButtonElement>(`[data-testid="selection-bar"] [data-testid="selection-tool-${key}"]`)

  beforeAll(() => {
    // jsdom knows no layout; the bar asks where the selection stands.
    const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
    Range.prototype.getClientRects = noRects
    Range.prototype.getBoundingClientRect = () => new DOMRect()
    Element.prototype.getClientRects = noRects
  })

  it('"Als nextasks-Aufgabe" at the selection sends the selected lines as the head button does, only where that one stands', async () => {
    const editor = makeEditor('<p>Silikon</p><p>Waschbecken</p><p>Termin</p>')
    await render(
      <>
        <SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />
        <SelectionBar editor={editor} onLink={() => undefined} />
      </>,
    )
    await act(async () => void editor.chain().focus().setTextSelection({ from: inside(editor, 'Silikon'), to: inside(editor, 'Waschbecken') + 4 }).run())
    await later()
    const button = tool('nextasks')!
    expect(button.getAttribute('aria-label')).toBe('Als nextasks-Aufgabe')
    expect(button.title).toBe('Als nextasks-Aufgabe')
    expect(button.hasAttribute('data-tool')).toBe(true)
    await click(button)
    expect($$('nextasks-line').map((line) => line.textContent)).toEqual(['Silikon', 'Waschbecken'])
    await click($('nextasks-submit'))
    const body = calls.find((call) => call.path === '/api/nextasks/send')!.body!
    expect((body.lines as Array<{ text: string }>).map((line) => line.text)).toEqual(['Silikon', 'Waschbecken'])
    // A locked note has no head button and so none at the selection either.
    await render(
      <>
        <SendToNextasks noteId="n1" editor={editor} head={head({ locked: true })} sealed={false} />
        <SelectionBar editor={editor} onLink={() => undefined} />
      </>,
    )
    await act(async () => void editor.chain().focus().setTextSelection({ from: 2, to: 6 }).run())
    await later()
    expect(tool('copy')).not.toBeNull()
    expect(tool('nextasks')).toBeNull()
  })

  it('"Als nextasks-Aufgabe" in the note menu makes the whole note one task, to the standard list, and says the limit', async () => {
    offered = [
      { id: LIST, name: 'Zuhause › Renovierung', hidden: false, default: false },
      { id: SHOPPING, name: 'Familie › Einkauf', hidden: false, default: true },
    ]
    sendAnswer = () => reply(200, { sent: 1, links: [], cut: true })
    const close = vi.fn()
    await render(
      <>
        <NoteTaskItem noteId="n1" head={head()} sealed={false} mine close={close} />
        <NoteTaskHost />
      </>,
    )
    expect($('note-nextasks')!.textContent).toBe('Als nextasks-Aufgabe')
    await click($('note-nextasks'))
    expect(close).toHaveBeenCalled()
    expect($('nextasks-note-title')!.textContent).toBe('Handwerker Bad')
    expect($('nextasks-note-limit')!.textContent).toContain('20.000 Zeichen')
    expect(($('nextasks-list') as HTMLSelectElement).value).toBe(SHOPPING)
    await click($('nextasks-submit'))
    const body = calls.find((call) => call.path === '/api/nextasks/send')!.body!
    expect(body).toMatchObject({ note_id: 'n1', whole: true, list_id: SHOPPING, list_name: 'Familie › Einkauf' })
    expect(body.lines).toBeUndefined()
    expect($('notice')!.textContent).toBe('Aufgabe in nextasks angelegt, der Text gekürzt.')
    expect($('nextasks-note-title')).toBeNull()
    // Not for a locked note, not from the vault, not without nextasks connected.
    await render(<NoteTaskItem noteId="n1" head={head({ locked: true })} sealed={false} mine close={close} />)
    expect($('note-nextasks')).toBeNull()
    await render(<NoteTaskItem noteId="n1" head={head()} sealed mine close={close} />)
    expect($('note-nextasks')).toBeNull()
    act(() => setNextasks({ connected: false, local_allowed: true }))
    await render(<NoteTaskItem noteId="n1" head={head()} sealed={false} mine close={close} />)
    expect($('note-nextasks')).toBeNull()
  })
})

describe('NOTES-19 the marks beside the lines', () => {
  it('NOTES-19 AC-3 EC-3 a mark stands at the end of its line, stays when the line changes and goes with it', async () => {
    const editor = makeEditor('<p>Silikonfarbe grau</p><p>Waschbecken</p>')
    editor.commands.setTextSelection(2)
    const [line] = linesToSend(editor.state)
    marks = [{ id: 9, note_id: 'n1', anchor: line.anchor, task_url: 'https://tasks.example.com/t9', list_name: 'Zuhause › Renovierung', due_date: null, created_at: null }]
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    const mark = () => $('nextasks-mark')
    expect(mark()).not.toBeNull()
    expect(mark()!.textContent).toBe('in nextasks')
    expect(mark()!.title).toBe('Aufgabe in nextasks, Liste Zuhause › Renovierung')
    expect(mark()!.closest('p')!.textContent).toBe('Silikonfarbe grauin nextasks')
    // The text of the line changes: the mark stays at it (EC-3).
    await act(async () => {
      editor.commands.insertContentAt(inside(editor, 'Silikonfarbe') + 'Silikonfarbe grau'.length, ' und weiß')
    })
    await settle()
    expect(mark()!.closest('p')!.textContent).toBe('Silikonfarbe grau und weißin nextasks')
    // A line typed above it does not take the mark.
    await act(async () => {
      editor.commands.insertContentAt(0, '<p>Neu oben</p>')
    })
    await settle()
    expect($$('nextasks-mark')).toHaveLength(1)
    expect(mark()!.closest('p')!.textContent).toContain('Silikonfarbe')
    // The line deleted: its mark goes, none jumps to the next line.
    await act(async () => {
      const at = inside(editor, 'Silikonfarbe') - 1
      editor.view.dispatch(editor.state.tr.delete(at, at + editor.state.doc.resolve(at + 1).parent.nodeSize))
    })
    await settle()
    expect(editor.getText()).not.toContain('Silikonfarbe')
    expect($('nextasks-mark')).toBeNull()
  })

  it('NOTES-19 EC-5 the marks come from the server for this member only, and a mark is no part of the note', async () => {
    const editor = makeEditor('<p>Milch</p>')
    editor.commands.setTextSelection(2)
    const [line] = linesToSend(editor.state)
    marks = [{ id: 3, note_id: 'n1', anchor: line.anchor, task_url: '', list_name: '', due_date: null, created_at: null }]
    const before = JSON.stringify(editor.getJSON())
    await render(<SendToNextasks noteId="n1" editor={editor} head={head({ can_write: false })} sealed={false} />)
    expect(calls.find((call) => call.path === '/api/nextasks/links')!.query).toBe('?note_id=n1')
    expect($('nextasks-mark')).not.toBeNull()
    // Read only: still a button (the line goes to the member's own nextasks), and the text is untouched.
    expect($('nextasks-send')).not.toBeNull()
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect(marksKey.getState(editor.state)!.links).toHaveLength(1)
  })

  it('NOTES-19 EC-4 a task deleted in nextasks is said when its mark is tapped, and the mark can go', async () => {
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    const editor = makeEditor('<p>Silikon</p>')
    editor.commands.setTextSelection(2)
    const [line] = linesToSend(editor.state)
    marks = [{ id: 4, note_id: 'n1', anchor: line.anchor, task_url: 'https://tasks.example.com/t4', list_name: '', due_date: null, created_at: null }]
    await render(<SendToNextasks noteId="n1" editor={editor} head={head()} sealed={false} />)
    await click($('nextasks-mark'))
    expect(opened).toHaveBeenCalledWith('https://tasks.example.com/t', '_blank', 'noopener,noreferrer')
    openAnswer = () => reply(404, { detail: { code: 'nextasks_task_gone', message: 'gone', trashed: false } })
    await click($('nextasks-mark'))
    expect($('nextasks-gone')!.textContent).toBe('Diese Aufgabe gibt es in nextasks nicht mehr. Die Zeile bleibt, wie sie ist.')
    expect(opened).toHaveBeenCalledTimes(1)
    await click($('nextasks-gone-remove'))
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/nextasks/links/4')).toBe(true)
    expect($('nextasks-mark')).toBeNull()
  })

  it('showMarks places nothing for an anchor no block has', () => {
    const editor = makeEditor('<p>x</p>')
    act(() => showMarks(editor.view, [{ id: 1, note_id: 'n1', anchor: '1.999999', task_url: '', list_name: '', due_date: null, created_at: null }]))
    expect(editor.view.dom.querySelector('.nn-task-mark')).toBeNull()
  })
})

describe('the due day of a mark', () => {
  it('reads as the weekday within the next week, else as the date', () => {
    const today = new Date(2026, 10, 21)
    expect(dueText('2026-11-27', 'de', today)).toBe('Fr')
    expect(dueText('2026-11-21', 'de', today)).toBe('Sa')
    expect(dueText('2026-12-24', 'de', today)).toBe('24. Dez.')
    expect(dueText('2026-11-20', 'en', today)).toBe('Nov 20')
  })
})
