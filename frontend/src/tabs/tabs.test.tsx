/**
 * NOTES-8 in the page: tabs opened from the list's menu, with the middle button and with Ctrl (AC-3), two notes side
 * by side with the honey line and "links"/"rechts" (AC-1, AC-4), the line between them (AC-2), the tabs of last time
 * after a reload (AC-5), the seventh tab (AC-7), the same note twice (EC-1), a narrow window (EC-2), a note deleted or
 * no longer there (EC-3, EC-6), the lock (EC-5), the keys (EC-7), and at most two live connections for six tabs
 * without losing what still waits.
 *
 * A stand-in for the server answers the routes, one for the live room answers the y-websocket sync with a Yjs
 * document per note; `matchMedia` says "wide screen".
 */
import { act, Fragment, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { hideNotice } from '../folders/notice'
import { forgetPrefs, prefKey } from '../lib/devicePref'
import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import type { NoteHead } from '../notes/api'
import { tryLeave } from '../notes/context'
import { NotesPage } from '../notes/NotesPage'
import { SIGNED_OUT_EVENT } from '../api/client'
import { SessionDialog } from '../components/SessionDialog'
import { AuthProvider, useAuth } from '../state/auth'
import { tabCommand } from './keys'
import { acquireProvider, BRIDGE, forgetParked, parkedProviders, releaseProvider } from './live'
import { accountChanged, followAccount, waitingChanges } from '../state/account'
import { forgetMeta, metaOf, refreshMeta } from './meta'
import { openNoteBeside, openNoteInNewTab } from './open'
import * as rules from './state'
import { forgetTabs, storageKey, tabs, tabsNow } from './store'
import { forgetRestored, rowsFor, SIDE_LABEL, TAB_CHROME, TAB_GAP, TAB_MIN, tabMin, tabRows, TITLE_MIN } from './layout'

// ---- The stand-in server -------------------------------------------------------------------------------------------

let notes: Map<string, NoteHead & { locked?: boolean }>
const rooms = new Map<string, Y.Doc>()
const sockets: RoomSocket[] = []
let me = 1
/** The account a note belongs to (1 unless named): any other gets 404 for it, and its room refuses them. */
const belongs = new Map<string, number>()
/** The network is away: the room refuses every new connection, as a dead line does. */
let networkDown = false
/** Answers of the stand-in server whose callers may still be busy with them. */
let inFlight = 0
/** The body of the last request to the stand-in server. */
let lastBody: string | null = null
/** Every request to the stand-in server, as "METHOD /path". */
const requests: string[] = []
const INBOX = 'inbox-1'
const NOW = new Date().toISOString()

function note(id: string, title: string, folder = 'garden', extra: Partial<NoteHead> = {}): NoteHead {
  return {
    id,
    folder_id: folder,
    title,
    title_check: false,
    origin: '',
    preview: '',
    created_at: '2026-11-14T08:00:00Z',
    updated_at: NOW,
    path: [{ id: folder, name: folder === 'garden' ? 'Garden' : 'Kitchen', kind: 'folder', inbox: false }],
    updated_by: { id: 1, name: 'Me' },
    // Own notes: no owner named (only shared ones have one).
    owner: null,
    deleted_at: null,
    can_write: true,
    ...extra,
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function answer(method: string, path: string): Promise<Response> {
  if (path === '/api/setup') return reply(200, { needs_setup: false, signed_in: true, version: '1', min_password: 12, code_required: false })
  if (method === 'POST' && path === '/api/auth/logout') return reply(204, null)
  if (path === '/api/auth/me') return reply(200, { id: me, name: 'me', display_name: 'Me', role: 'member', language: 'en', version: '1', whats_new_seen: '1' })
  if (path === '/api/folders')
    return reply(200, {
      inbox: { id: INBOX, count: 0 },
      folders: [
        { id: 'garden', name: 'Garden', parent_id: null, icon: '', color: 'green', position: null, count: 0 },
        { id: 'kitchen', name: 'Kitchen', parent_id: null, icon: '', color: 'red', position: null, count: 0 },
      ],
    })
  if (method === 'GET' && path === '/api/note-list') {
    const alive = [...notes.values()].filter((n) => !n.deleted_at && (belongs.get(n.id) ?? 1) === me)
    return reply(200, { key: 'all', view: { mode: 'list', sort: 'title', direction: 'asc', grouped: false }, counts: { own: alive.length, shared: 0 }, items: alive })
  }
  if (method === 'GET' && path === '/api/note-list/stamp') return reply(200, { stamp: String(notes.size) })
  const one = /^\/api\/notes\/([^/]+)(\/.*)?$/.exec(path)
  if (one) {
    const [, id, tail = ''] = one
    const found = notes.get(id)
    if (!found || (belongs.get(id) ?? 1) !== me) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET' && !tail) return reply(200, found)
    if (method === 'PUT' && tail === '/paper') {
      const paper = String(JSON.parse(lastBody ?? '{}').paper)
      notes.set(id, { ...found, paper })
      return reply(200, notes.get(id))
    }
    if (method === 'POST' && tail === '/title/suggestion') return reply(200, found)
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

class RoomSocket {
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  doc: Y.Doc
  id: string
  constructor(url: string) {
    this.id = decodeURIComponent(/\/api\/notes\/([^/]+)\/live/.exec(url)![1])
    if (!rooms.has(this.id)) rooms.set(this.id, new Y.Doc())
    this.doc = rooms.get(this.id)!
    sockets.push(this)
    setTimeout(() => {
      if (networkDown) {
        this.readyState = 3
        this.onclose?.({ code: 1006 } as CloseEvent)
        return
      }
      const found = notes.get(this.id)
      if (!found || found.deleted_at || (belongs.get(this.id) ?? 1) !== me) {
        this.readyState = 3
        this.onclose?.({ code: 4404 } as CloseEvent)
        return
      }
      this.readyState = 1
      this.onopen?.(new Event('open'))
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.deliver(encoding.toUint8Array(encoder))
    }, 0)
  }
  deliver(data: Uint8Array) {
    this.onmessage?.({ data: data.slice().buffer } as MessageEvent)
  }
  send(data: Uint8Array) {
    const decoder = decoding.createDecoder(data)
    if (decoding.readVarUint(decoder) !== 0) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 0)
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'room')
    if (encoding.length(encoder) > 1) {
      const out = encoding.toUint8Array(encoder)
      setTimeout(() => this.readyState === 1 && this.deliver(out), 0)
    }
  }
  close() {
    this.readyState = 3
  }
}

const openSockets = () => sockets.filter((socket) => socket.readyState === 1)

/** A paragraph of text in the room of a note, so that leaving it without a title would ask for one. */
function withText(id: string, text: string): void {
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  rooms.get(id)!.getXmlFragment('body').insert(0, [paragraph])
}

/** What would have written a title, or thrown the note away, on leaving it. */
const titleWrites = () => requests.filter((line) => /\/title\/suggestion$|\/discard$|^PUT .*\/title$/.test(line))

// ---- Rendering -----------------------------------------------------------------------------------------------------

let root: Root | null = null
let box: HTMLDivElement
let where = ''
let width = 1400

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname + location.search
  }, [location])
  return null
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/**
 * Waits a few milliseconds at a time until `check` holds (returns anything but `false` and throws no failed
 * expectation): no longer than needed on a fast machine, as long as needed on a busy one, within the test's time.
 */
async function until(check: () => unknown, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (check() !== false) return
      if (Date.now() > end) throw new Error('the page never got there')
    } catch (error) {
      if (Date.now() > end) throw error
    }
    await settle(5)
  }
}

/** The page has nothing more on its way: every answer of the stand-in server handled, no editor still connecting,
 * the list drawn. */
function quiet(): boolean {
  if (inFlight > 0 || !$('notes-page')) return false
  if ($$('note-editor').some((editor) => editor.dataset.status === 'connecting')) return false
  if ($('note-list') && !$('note-row') && !$('list-empty')) return false
  return true
}

/** Waits until the page is quiet (see `quiet`). */
async function idle(): Promise<void> {
  await until(quiet)
}

/** As `App.tsx`: the signed-in part drawn anew for every account. */
function PerAccount({ children }: { children: ReactNode }) {
  const { me: who } = useAuth()
  return <Fragment key={who?.id ?? 'nobody'}>{children}</Fragment>
}

async function render(path: string): Promise<void> {
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root!.render(
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <SessionDialog />
          <PerAccount>
            <Routes>
              <Route path="/" element={<NotesPage />} />
              <Route path="/notes/:noteId" element={<NotesPage />} />
              <Route path="/trash" element={<div data-testid="trash-page" />} />
            </Routes>
          </PerAccount>
        </MemoryRouter>
      </AuthProvider>,
    )
  })
  await idle()
}

/** A reload: the page goes, everything in memory with it, only `localStorage` stays. */
async function reload(path: string): Promise<void> {
  await act(async () => root?.unmount())
  root = null
  box.remove()
  forgetTabs()
  forgetMeta()
  forgetRestored()
  await render(path)
}

const $ = (testId: string, inside: ParentNode = box) => inside.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
const $$ = (testId: string, inside: ParentNode = box) => [...inside.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
const tabTitles = () => $$('tab-title').map((element) => element.textContent)
const pane = (side: 'left' | 'right') => box.querySelector(`[data-testid="tab-pane"][data-side="${side}"]`) as HTMLElement | null

function typeTitle(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(code: string, extra: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra }))
}

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
})

beforeEach(() => {
  notes = new Map(
    [
      note('soup', 'Lentil soup', 'kitchen'),
      note('shop', 'Saturday shopping'),
      note('bath', 'Bathroom works'),
      note('meet', 'Monday meeting'),
      note('pack', 'Packing list'),
      note('gift', 'Gift ideas'),
      note('cost', 'Running costs'),
    ].map((one) => [one.id, one]),
  )
  rooms.clear()
  // The room's title is the note's title, as on the server.
  for (const one of notes.values()) {
    const doc = new Y.Doc()
    doc.getText('title').insert(0, one.title)
    rooms.set(one.id, doc)
  }
  sockets.length = 0
  belongs.clear()
  networkDown = false
  me = 1
  width = 1400
  localStorage.clear()
  forgetPrefs()
  forgetFolders()
  forgetTabs()
  forgetMeta()
  forgetRestored()
  vi.stubGlobal('WebSocket', RoomSocket)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  requests.length = 0
  inFlight = 0
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    lastBody = typeof init?.body === 'string' ? init.body : null
    inFlight += 1
    // Counted until the caller had a turn to read the answer.
    setTimeout(() => (inFlight -= 1), 5)
    return answer(init?.method ?? 'GET', url.pathname)
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  hideNotice()
  box?.remove()
  forgetParked()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 50))
})

// ---- The tests -----------------------------------------------------------------------------------------------------

describe('tabs in the page', () => {
  it('NOTES-8 AC-3 a note opened in a new tab keeps the first one open; each tab shows its folder color, title and a cross', async () => {
    await render('/notes/soup')
    expect(tabTitles()).toEqual(['Lentil soup'])
    // From the list's menu.
    const row = box.querySelector('[data-note="shop"]') as HTMLElement
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    await act(async () => $('menu-open-tab')!.click())
    await until(() => expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping']))
    expect(where).toBe('/notes/shop')
    // In its own tab, not beside.
    expect(pane('right')).toBeNull()
    expect(pane('left')!.dataset.note).toBe('shop')
    // The middle button on a row, and Ctrl with a click: tabs too, not the browser's.
    const link = (id: string) => box.querySelector(`[data-note="${id}"] [data-testid="note-row"]`) as HTMLAnchorElement
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    await act(async () => {
      link('bath').dispatchEvent(middle)
      link('meet').dispatchEvent(ctrl)
    })
    expect(middle.defaultPrevented).toBe(true)
    expect(ctrl.defaultPrevented).toBe(true)
    await until(() => expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping', 'Bathroom works', 'Monday meeting']))
    // Each with color, title and cross.
    const first = $$('tab')[0]
    expect((first.querySelector('span[aria-hidden]') as HTMLElement).style.background).not.toBe('')
    expect(first.getAttribute('title')).toContain('Lentil soup')
    expect($$('tab-close')).toHaveLength(4)
    expect($('tab-count')!.textContent).toBe('4 of 6')
    // A plain click opens in place of the note on show.
    await act(async () => link('pack').click())
    await until(() => expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping', 'Bathroom works', 'Packing list']))
    // The cross closes.
    await act(async () => $$('tab-close')[0].click())
    await until(() => expect(tabTitles()).toEqual(['Saturday shopping', 'Bathroom works', 'Packing list']))
  })

  it('NOTES-8 AC-1 AC-4 "Open beside" puts two notes side by side, the side used last has the honey line, the tabs say left and right', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await settle(80)
    expect(pane('left')!.dataset.note).toBe('soup')
    expect(pane('right')!.dataset.note).toBe('shop')
    expect($$('note-editor')).toHaveLength(2)
    expect(pane('right')!.style.borderTopColor).toBe('var(--color-accent-500)')
    expect(pane('left')!.style.borderTopColor).toBe('transparent')
    expect($$('tab-side').map((element) => element.textContent)).toEqual(['left', 'right'])
    // Each side on its own: a title typed left stays left.
    typeTitle(pane('left')!.querySelector('[data-testid="note-title"]') as HTMLInputElement, 'Lentil soup for four')
    await settle(30)
    expect(rooms.get('soup')!.getText('title').toString()).toBe('Lentil soup for four')
    expect(rooms.get('shop')!.getText('title').toString()).toBe('Saturday shopping')
    // Using the left side moves the line there, and the address with it.
    await act(async () => pane('left')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    await settle(20)
    expect(pane('left')!.style.borderTopColor).toBe('var(--color-accent-500)')
    expect(where).toBe('/notes/soup')
  })

  it('NOTES-8 AC-1 a note dragged onto the right edge opens beside', async () => {
    await render('/notes/soup')
    const row = box.querySelector('[data-note="cost"]') as HTMLElement
    const kept = new Map<string, string>()
    const data = { setData: (type: string, value: string) => kept.set(type, value), getData: (type: string) => kept.get(type) ?? '', effectAllowed: '', dropEffect: '' }
    const start = new Event('dragstart', { bubbles: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: data })
    await act(async () => row.dispatchEvent(start))
    const area = pane('left')!.parentElement!
    area.getBoundingClientRect = () => new DOMRect(300, 0, 1000, 800)
    const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(over, { dataTransfer: { value: data }, clientX: { value: 1250 } })
    await act(async () => pane('left')!.dispatchEvent(over))
    expect($('drop-beside')).not.toBeNull()
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(drop, { dataTransfer: { value: data }, clientX: { value: 1250 } })
    await act(async () => pane('left')!.dispatchEvent(drop))
    await settle(60)
    expect(pane('right')!.dataset.note).toBe('cost')
    await act(async () => window.dispatchEvent(new Event('dragend')))
  })

  it('NOTES-8 AC-2 the line between the sides moves both widths, never below a readable width', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
    const separator = $('tab-separator')!
    const leftWidth = () => parseInt(pane('left')!.style.flex.split(' ')[2], 10)
    // By keyboard, a step at a time.
    const before = Number(separator.getAttribute('aria-valuenow'))
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(before)
    // With the mouse, all the way to either end: 1400 px less the list (300 px) is the area of the two sides.
    const area = pane('left')!.parentElement!
    area.getBoundingClientRect = () => new DOMRect(300, 0, 1100, 800)
    const drag = async (clientX: number) => {
      await act(async () => separator.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })))
      await act(async () => separator.dispatchEvent(new MouseEvent('pointermove', { clientX })))
      await act(async () => separator.dispatchEvent(new MouseEvent('pointerup', {})))
    }
    await drag(1400)
    // The list stays beside two notes of 480 px or more; the right side keeps 340 px.
    expect($('note-list')).not.toBeNull()
    expect(1400 - 300 - 12 - leftWidth()).toBe(340)
    await drag(300)
    expect(leftWidth()).toBe(340)
  })

  it('NOTES-6 AC-10 the list beside a note is as wide as set on this device, and still gives way to the notes', async () => {
    await render('/notes/soup')
    const handle = $('column-handle-list')!
    const column = () => handle.parentElement!
    expect(column().style.width).toBe('300px')
    expect(handle.getAttribute('aria-label')).toBe(i18n.t('columns.list'))
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    expect(column().style.width).toBe('316px')
    await act(async () => handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 316, button: 0 })))
    await act(async () => handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 2000 })))
    await act(async () => handle.dispatchEvent(new MouseEvent('pointerup', {})))
    expect(column().style.width).toBe('560px')
    expect(localStorage.getItem(prefKey('column.list', 1))).toBe('560')
    // Two notes beside it would get less than 480 px each: the list gives way, the notes keep their widths (NOTES-8).
    await act(async () => openNoteBeside('shop'))
    await idle()
    expect($('note-list')).toBeNull()
    expect(pane('right')).not.toBeNull()
    // One note again: the list comes back as wide as set; a double click on its edge resets it.
    await act(async () => tabs.endSplit())
    await idle()
    const again = $('column-handle-list')!
    expect(again.parentElement!.style.width).toBe('560px')
    await act(async () => again.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(again.parentElement!.style.width).toBe('300px')
    expect(localStorage.getItem(prefKey('column.list', 1))).toBeNull()
  })

  it('NOTES-3 AC-14 AC-15 the text runs as wide as chosen, and the outline stands beside it only where there is room', async () => {
    await render('/notes/soup')
    const page = () => $('note-page')!
    expect(page().style.maxWidth).toBe('760px')
    expect($('outline')).toBeNull()
    await act(async () => $('tool-width')!.click())
    await act(async () => $('width-wide')!.click())
    expect(page().style.maxWidth).toBe('1100px')
    await act(async () => $('tool-width')!.click())
    await act(async () => $('width-full')!.click())
    expect(page().style.maxWidth).toBe('none')
    // A wide screen: the side has room for the outline.
    width = 2560
    await reload('/notes/soup')
    expect($('outline')).not.toBeNull()
    expect($('note-page')!.style.maxWidth).toBe('none')
    // Turned off, it stays off.
    await act(async () => $('tool-outline')!.click())
    expect($('outline')).toBeNull()
  })

  it('NOTES-3 AC-17 the note menu chooses the paper; the sheet shows it, and another window follows within 5 s', async () => {
    // The 5 s of the head are counted by hand.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await render('/notes/soup')
    const paper = () => $('note-paper')!.dataset.paper
    expect(paper()).toBe('blank')
    await act(async () => $('note-menu')!.click())
    const choices = $$('paper-picker')[0].querySelectorAll('[role="menuitemradio"]')
    expect([...choices].map((one) => one.textContent)).toEqual(['Blank', 'Lined', 'Grid', 'Dotted'])
    await act(async () => $('paper-lined')!.click())
    expect(paper()).toBe('lined')
    expect(requests).toContain('PUT /api/notes/soup/paper')
    await idle()
    expect(paper()).toBe('lined')
    // Changed somewhere else: the open editor reads the head again within 5 s.
    try {
      await act(async () => void notes.set('soup', { ...notes.get('soup')!, paper: 'grid' } as NoteHead))
      await act(async () => void vi.advanceTimersByTime(5000))
      await idle()
      expect(paper()).toBe('grid')
    } finally {
      vi.useRealTimers()
    }
  })

  it('NOTES-8 AC-5 open tabs and the split are back after a reload on the same device, for the same account only', async () => {
    await render('/notes/soup')
    await act(async () => {
      openNoteInNewTab('shop')
      openNoteInNewTab('bath')
      openNoteBeside('meet')
    })
    await idle()
    expect(localStorage.getItem(storageKey(1))).toContain('"meet"')
    await reload('/')
    expect(where).toBe('/notes/meet')
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping', 'Bathroom works', 'Monday meeting'])
    expect(pane('left')!.dataset.note).toBe('bath')
    expect(pane('right')!.dataset.note).toBe('meet')
    // Another account on this device has tabs of its own.
    me = 2
    await reload('/')
    expect(where).toBe('/')
    expect($('tab-bar')).toBeNull()
  })

  it('NOTES-8 AC-7 a seventh tab closes the one not used for the longest, never one on show, and says so', async () => {
    await render('/notes/soup')
    // "soup" stays on the left, used first of all; the others open one after the other on the right.
    await act(async () => {
      openNoteBeside('shop')
      for (const id of ['bath', 'meet', 'pack', 'gift']) openNoteInNewTab(id)
    })
    await idle()
    expect($$('tab')).toHaveLength(6)
    expect($('tab-count')!.textContent).toBe('6 of 6')
    await act(async () => openNoteInNewTab('cost'))
    await idle()
    const open = $$('tab').map((tab) => tab.dataset.note)
    expect(open).toEqual(['soup', 'bath', 'meet', 'pack', 'gift', 'cost'])
    expect(document.querySelector('[data-testid="folder-notice"]')?.textContent).toContain('“Saturday shopping” was closed because 6 tabs were open already.')
    // On show, though the oldest of all: the left side.
    const state = tabsNow()
    expect(rules.tabOf(state, state.left)?.note).toBe('soup')
    expect(rules.tabOf(state, state.right)?.note).toBe('cost')
  })

  it('NOTES-8 AC-8 EC-4 six tabs stay in one row while each keeps its minimum, else in two, never more', () => {
    expect(rowsFor(6, 1200, 150)).toBe(1)
    expect(rowsFor(6, 6 * TAB_MIN + 150 - 1, 150)).toBe(2)
    expect(rowsFor(1, 200, 150)).toBe(1)
  })

  it('NOTES-8 EC-4 the two tabs on show keep the start of their title beside "left" and "right": the labels count, else two rows', async () => {
    // Room for six tabs in a row, but not with the labels of the two on show.
    const room = 6 * TAB_MIN + 6 * TAB_GAP + 90
    expect(rowsFor(6, room, 90)).toBe(1)
    expect(rowsFor(6, room, 90, 2)).toBe(2)
    expect(tabMin(true) - tabMin(false)).toBe(SIDE_LABEL)
    expect(TAB_MIN - TAB_CHROME).toBe(TITLE_MIN)
    // An iPad held upright: 768 px less the sidebar (260) and the bar's paddings (24); the two on show at the end.
    const mins = [0, 1, 2, 3, 4, 5].map((index) => tabMin(index >= 4))
    const layout = tabRows(mins, 484, 124)
    expect(layout.rows).toBe(2)
    expect(layout.fits).toBe(true)
    const sum = (from: number, to: number) => mins.slice(from, to).reduce((a, b) => a + b, 0) + (to - from) * TAB_GAP
    expect(sum(0, layout.first) + (layout.extrasFirst ? 124 : 0)).toBeLessThanOrEqual(484)
    expect(sum(layout.first, 6) + (layout.extrasFirst ? 0 : 124)).toBeLessThanOrEqual(484)

    // In the page: the tabs on show hold their least width, the others shrink first.
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await settle(60)
    const shown = $$('tab').filter((tab) => tab.dataset.side)
    expect(shown.map((tab) => tab.style.minWidth)).toEqual([`${tabMin(true)}px`, `${tabMin(true)}px`])
  })

  it('NOTES-8 EC-1 the same note twice side by side: what is typed on one side shows on the other at once, offline too', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('soup'))
    await settle(80)
    expect(pane('left')!.dataset.note).toBe('soup')
    expect(pane('right')!.dataset.note).toBe('soup')
    // Two connections, as two windows.
    expect(openSockets().filter((socket) => socket.id === 'soup')).toHaveLength(2)
    await act(async () => window.dispatchEvent(new Event('offline')))
    const left = pane('left')!.querySelector('[data-testid="note-title"]') as HTMLInputElement
    const right = pane('right')!.querySelector('[data-testid="note-title"]') as HTMLInputElement
    await act(async () => typeTitle(left, 'Lentil soup, spicy'))
    expect(right.value).toBe('Lentil soup, spicy')
  })

  it('NOTES-8 EC-1 the same note twice: ending the split or closing the right side asks for no title and keeps it on the server', async () => {
    withText('soup', 'red lentils, onion')
    await render('/notes/soup')
    await act(async () => openNoteBeside('soup'))
    await idle()
    expect(pane('right')!.dataset.note).toBe('soup')
    // Both tabs know the title from the start, never "Untitled" for a moment.
    expect(tabTitles()).toEqual(['Lentil soup', 'Lentil soup'])
    await act(async () => $('tab-end-split')!.click())
    await settle(60)
    expect($('leave-dialog')).toBeNull()
    expect(pane('right')).toBeNull()
    // Beside again, then its tab closed.
    await act(async () => openNoteBeside('soup'))
    await idle()
    expect(pane('right')!.dataset.note).toBe('soup')
    const right = $$('tab').find((tab) => tab.dataset.side === 'right')!
    await act(async () => $('tab-close', right)!.click())
    await settle(60)
    expect($('leave-dialog')).toBeNull()
    expect($$('tab')).toHaveLength(1)
    expect(titleWrites()).toEqual([])
    expect(rooms.get('soup')!.getText('title').toString()).toBe('Lentil soup')
    expect(tabTitles()).toEqual(['Lentil soup'])
  })

  it('NOTES-8 EC-1 a parked tab opened again knows its title: leaving it asks for none', async () => {
    withText('soup', 'red lentils, onion')
    await render('/notes/soup')
    networkDown = true
    await act(async () => window.dispatchEvent(new Event('offline')))
    const title = pane('left')!.querySelector('[data-testid="note-title"]') as HTMLInputElement
    await act(async () => typeTitle(title, 'Lentil soup, spicy'))
    // Out of view with its change still waiting: parked.
    await act(async () => openNoteInNewTab('shop'))
    // The line is dead: "shop" keeps connecting; wait for what this is about.
    await until(() => expect(parkedProviders().map((provider) => provider.noteId)).toEqual(['soup']))
    const soup = $$('tab').find((tab) => tab.dataset.note === 'soup')!
    await act(async () => soup.click())
    await until(() => expect(pane('left')!.dataset.note).toBe('soup'))
    expect(parkedProviders()).toEqual([])
    expect(tabTitles()).toEqual(['Lentil soup, spicy', 'Saturday shopping'])
    await act(async () => $('tab-close', $$('tab').find((tab) => tab.dataset.note === 'soup')!)!.click())
    await settle(60)
    expect($('leave-dialog')).toBeNull()
    expect($$('tab').map((tab) => tab.dataset.note)).toEqual(['shop'])
    expect(titleWrites()).toEqual([])
  })

  it('NOTES-8 EC-1 two editors of one note: their documents meet at once and keep their own presence', () => {
    vi.stubGlobal('WebSocket', function () {
      return { send() {}, close() {}, readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null }
    })
    const a = acquireProvider('soup')
    a.doc.getText('title').insert(0, 'typed before')
    const b = acquireProvider('soup')
    expect(b.doc.getText('title').toString()).toBe('typed before')
    expect(b.doc.clientID).not.toBe(a.doc.clientID)
    b.doc.getText('title').insert(0, '> ')
    expect(a.doc.getText('title').toString()).toBe('> typed before')
    // What came over the bridge counts as the other side's own: it goes out over its connection too.
    expect(a.pending).toBeGreaterThan(0)
    let origin: unknown = null
    a.doc.on('update', (_update: Uint8Array, from: unknown) => (origin = from))
    b.doc.getText('title').insert(0, '!')
    expect(origin).toBe(BRIDGE)
    releaseProvider(a)
    releaseProvider(b)
  })

  it('NOTES-8 EC-2 a window too narrow for two shows one with a switcher, and the split comes back when it widens', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await settle(40)
    expect($('side-switch')).toBeNull()
    await act(async () => root!.unmount())
    width = 600
    box.remove()
    await render('/notes/shop')
    expect($('side-switch')).not.toBeNull()
    expect(pane('left')!.className).toContain('hidden')
    expect(pane('right')!.className).not.toContain('hidden')
    const [leftButton] = [...$('side-switch')!.querySelectorAll('button')]
    await act(async () => leftButton.click())
    await settle(20)
    expect(pane('left')!.className).not.toContain('hidden')
    expect(pane('right')!.className).toContain('hidden')
    await act(async () => root!.unmount())
    width = 1400
    box.remove()
    await render('/notes/soup')
    expect($('side-switch')).toBeNull()
    expect(pane('left')!.className).not.toContain('hidden')
    expect(pane('right')!.className).not.toContain('hidden')
  })

  it('NOTES-8 EC-3 a note in a tab deleted elsewhere: the tab says so, the side offers the trash', async () => {
    await render('/notes/soup')
    await act(async () => openNoteInNewTab('shop'))
    await settle(40)
    // Another device puts "soup" into the trash.
    notes.set('soup', { ...notes.get('soup')!, deleted_at: NOW })
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle(40)
    const soupTab = $$('tab').find((tab) => tab.dataset.note === 'soup')!
    expect(soupTab.dataset.state).toBe('deleted')
    expect(soupTab.getAttribute('title')).toContain('in the trash')
    // Looking at it.
    await act(async () => soupTab.click())
    await settle(80)
    expect($('stopped-bar')!.textContent).toContain('This note was deleted and is in the trash.')
    await act(async () => $('tab-open-trash')!.click())
    await settle(20)
    expect(where).toBe('/trash')
  })

  it('NOTES-8 EC-6 a tab whose note is no longer shared says it is not available, without a connection', async () => {
    await render('/notes/soup')
    await act(async () => openNoteInNewTab('shop'))
    await settle(40)
    notes.delete('soup')
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle(40)
    const soupTab = $$('tab').find((tab) => tab.dataset.note === 'soup')!
    expect(soupTab.dataset.state).toBe('gone')
    const before = sockets.length
    await act(async () => soupTab.click())
    await settle(60)
    expect($('tab-gone')!.textContent).toContain('This note is no longer available.')
    expect($('note-editor')).toBeNull()
    expect(sockets.filter((socket) => socket.id === 'soup').length).toBe(sockets.slice(0, before).filter((socket) => socket.id === 'soup').length)
  })

  it('NOTES-8 EC-6 a note on show whose sharing ends: the room refuses, the side says it is no longer available', async () => {
    await render('/notes/soup')
    await settle(40)
    expect($('note-editor')).not.toBeNull()
    notes.delete('soup')
    const socket = openSockets().find((one) => one.id === 'soup')!
    await act(async () => {
      socket.readyState = 3
      socket.onclose?.({ code: 4403 } as CloseEvent)
    })
    await settle(60)
    expect($('tab-gone')!.textContent).toContain('This note is no longer available.')
    expect($$('tab')[0].dataset.state).toBe('gone')
    expect($('note-editor')).toBeNull()
  })

  it('NOTES-8 EC-5 a locked note shows the lock in its tab', async () => {
    notes.set('soup', { ...notes.get('soup')!, locked: true })
    await render('/notes/shop')
    await act(async () => openNoteInNewTab('soup'))
    await act(async () => openNoteInNewTab('shop'))
    await settle(60)
    const soupTab = $$('tab').find((tab) => tab.dataset.note === 'soup')!
    expect(soupTab.dataset.state).toBe('locked')
    expect($('tab-lock', soupTab)).not.toBeNull()
  })

  it('NOTES-8 EC-7 tabs and sides by keyboard', async () => {
    await render('/notes/soup')
    await act(async () => {
      for (const id of ['shop', 'bath']) openNoteInNewTab(id)
    })
    await until(() => expect(where).toBe('/notes/bath'))
    await act(async () => key('Digit1'))
    await until(() => expect(where).toBe('/notes/soup'))
    await act(async () => key('ArrowRight'))
    await until(() => expect(where).toBe('/notes/shop'))
    await act(async () => key('ArrowLeft'))
    await until(() => expect(where).toBe('/notes/soup'))
    await act(async () => openNoteBeside('bath'))
    await until(() => expect(where).toBe('/notes/bath'))
    await act(async () => key('KeyS'))
    await until(() => expect(where).toBe('/notes/soup'))
    await act(async () => key('KeyW'))
    await until(() => expect(tabTitles()).toEqual(['Saturday shopping', 'Bathroom works']))
    expect(where).toBe('/notes/bath')
    // Inside the row: arrows move, Enter opens, Delete closes.
    const tabs = $$('tab')
    tabs[1].focus()
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(document.activeElement).toBe(tabs[0])
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await until(() => expect(where).toBe('/notes/shop'))
    await act(async () => $$('tab')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    await until(() => expect(tabTitles()).toEqual(['Bathroom works']))
    // The keys themselves: Alt and Shift, never with Ctrl (AltGr on a German keyboard).
    expect(tabCommand({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'Digit6' })).toEqual({ kind: 'nth', index: 5 })
    expect(tabCommand({ altKey: true, shiftKey: true, ctrlKey: true, metaKey: false, code: 'Digit1' })).toBeNull()
    expect(tabCommand({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, code: 'ArrowLeft' })).toBeNull()
  })

  it('NOTES-8 six tabs keep at most the two notes on show connected', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    for (const id of ['bath', 'meet', 'pack', 'gift']) await act(async () => openNoteInNewTab(id))
    await idle()
    expect($$('tab')).toHaveLength(6)
    expect(openSockets()).toHaveLength(2)
  })

  it('NOTES-8 a tab going out of view keeps its waiting changes until the room has them, and opens with them again', async () => {
    // A connection that never opens: offline.
    vi.stubGlobal('WebSocket', function () {
      return { send() {}, close() {}, readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null }
    })
    const first = acquireProvider('soup')
    first.doc.getText('title').insert(0, 'typed offline')
    expect(first.pending).toBe(1)
    releaseProvider(first)
    expect(parkedProviders()).toEqual([first])
    const again = acquireProvider('soup')
    expect(again).toBe(first)
    expect(again.doc.getText('title').toString()).toBe('typed offline')
    expect(parkedProviders()).toEqual([])
    releaseProvider(again)
    // Nothing waits: closed at once.
    const clean = acquireProvider('shop')
    releaseProvider(clean)
    expect(parkedProviders()).toEqual([first])
  })

  it('NOTES-2 a parked connection of the account before is gone when the account of the tab changes', () => {
    vi.stubGlobal('WebSocket', function () {
      return { send() {}, close() {}, readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null }
    })
    const first = acquireProvider('soup')
    first.doc.getText('title').insert(0, 'typed offline')
    releaseProvider(first)
    expect(parkedProviders()).toEqual([first])
    accountChanged()
    expect(parkedProviders()).toEqual([])
  })

  it('NOTES-8 NOTES-2 another account in the same browser tab sees nothing of the notes of the one before, not even what waited offline', async () => {
    notes.set('mine', note('mine', 'Bea list'))
    belongs.set('mine', 2)
    rooms.set('mine', new Y.Doc())
    rooms.get('mine')!.getText('title').insert(0, 'Bea list')
    withText('soup', 'the secret recipe')
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
    // Offline, A types into both sides: the changes wait.
    networkDown = true
    await act(async () => window.dispatchEvent(new Event('offline')))
    await act(async () => typeTitle(pane('left')!.querySelector('[data-testid="note-title"]') as HTMLInputElement, 'Lentil soup SECRET'))
    await act(async () => typeTitle(pane('right')!.querySelector('[data-testid="note-title"]') as HTMLInputElement, 'Saturday SECRET'))
    expect(waitingChanges()).toBe(2)
    expect(where).toBe('/notes/shop')

    // Another browser tab signs in as B (the cookie is shared); this one follows when it comes into view.
    me = 2
    networkDown = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await until(() => expect(where).toBe('/'))
    await idle()
    // The line comes back: nothing of A may arrive late.
    await act(async () => window.dispatchEvent(new Event('online')))
    await settle(60)
    await idle()

    expect(where).toBe('/')
    expect($('tab-bar')).toBeNull()
    expect($$('tab-pane')).toHaveLength(0)
    for (const secret of ['Lentil soup', 'Saturday', 'SECRET', 'secret recipe']) expect(box.textContent).not.toContain(secret)
    // Nothing of A in B's tabs on this device, and nothing of A parked for B.
    expect(localStorage.getItem(storageKey(2)) ?? '').not.toMatch(/soup|shop/)
    expect(parkedProviders()).toEqual([])
    expect(metaOf('soup')).toBeUndefined()
    // The notice says what was lost, without a word of it.
    const notice = document.querySelector('[data-testid="folder-notice"]')?.textContent ?? ''
    expect(notice).toContain('2 changes of the account before were not saved yet and are lost.')
    expect(notice).not.toContain('SECRET')

    // B opens a note of its own beside nothing of A's: the tab is B's alone.
    await act(async () => openNoteInNewTab('mine'))
    await until(() => expect(tabTitles()).toEqual(['Bea list']))
    for (const secret of ['Lentil soup', 'SECRET']) expect(box.textContent).not.toContain(secret)
    expect(localStorage.getItem(storageKey(2)) ?? '').not.toMatch(/soup|shop/)
  })

  it('NOTES-8 NOTES-2 a connection of the account before never goes on to the next one: not parked, not bridged', () => {
    vi.stubGlobal('WebSocket', function () {
      return { send() {}, close() {}, readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null }
    })
    followAccount(1)
    const first = acquireProvider('soup')
    first.doc.getText('title').insert(0, 'typed offline by A')
    // Another account in the tab before A's editor went: B's editor of the same note meets nothing of A's.
    followAccount(2)
    const theirs = acquireProvider('soup')
    expect(theirs).not.toBe(first)
    expect(theirs.doc.getText('title').toString()).toBe('')
    first.doc.getText('title').insert(0, '> ')
    expect(theirs.doc.getText('title').toString()).toBe('')
    // A's editor goes only now: its connection closes instead of waiting in B's place.
    releaseProvider(first)
    expect(parkedProviders()).toEqual([])
    releaseProvider(theirs)
    const again = acquireProvider('soup')
    expect(again).not.toBe(first)
    expect(again.doc.getText('title').toString()).toBe('')
    releaseProvider(again)
    followAccount(1)
  })

  it('NOTES-8 NOTES-2 the heads of the tabs are forgotten with the account, a late answer is dropped, a note not handed out keeps no title', async () => {
    const held: Array<() => void> = []
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input, 'http://localhost')
      const id = url.pathname.split('/').pop()!
      if (id === 'late') await new Promise<void>((resolve) => held.push(resolve))
      const found = notes.get(id)
      if (!found || (belongs.get(id) ?? 1) !== me) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
      return reply(200, found)
    })
    notes.set('late', note('late', 'Payroll of A'))
    await refreshMeta(['soup'])
    expect(metaOf('soup')?.title).toBe('Lentil soup')
    const asking = refreshMeta(['late'])
    accountChanged()
    expect(metaOf('soup')).toBeUndefined()
    held.forEach((resolve) => resolve())
    await asking
    expect(metaOf('late')).toBeUndefined()
    // The note is not handed out (any more): "not available", and no title of it stays.
    await refreshMeta(['soup'])
    me = 2
    await refreshMeta(['soup'])
    expect(metaOf('soup')).toMatchObject({ state: 'gone', title: '' })
  })

  it('NOTES-8 NOTES-2 signing out while changes still wait asks first: "Sign out anyway" or "Wait"', async () => {
    await render('/notes/soup')
    networkDown = true
    await act(async () => window.dispatchEvent(new Event('offline')))
    await act(async () => typeTitle(pane('left')!.querySelector('[data-testid="note-title"]') as HTMLInputElement, 'Lentil soup, more'))
    expect(waitingChanges()).toBe(1)
    // The operator blocked the account: the way out is signing out.
    await act(async () => window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { detail: { code: 'account_blocked' } })))
    await act(async () => $('session-leave', document.body)!.click())
    expect($('sign-out-waiting', document.body)!.textContent).toContain('1 change is not saved yet. If you sign out now, it is lost.')
    expect(requests).not.toContain('POST /api/auth/logout')
    // "Wait": nothing happens, the page stays.
    await act(async () => $('sign-out-wait', document.body)!.click())
    expect($('sign-out-waiting', document.body)).toBeNull()
    expect(requests).not.toContain('POST /api/auth/logout')
    expect(pane('left')).not.toBeNull()
    // "Sign out anyway".
    await act(async () => $('session-leave', document.body)!.click())
    await act(async () => $('sign-out-anyway', document.body)!.click())
    await settle(30)
    expect(requests).toContain('POST /api/auth/logout')
    // In German too.
    await act(async () => i18n.changeLanguage('de'))
    expect(i18n.t('session.waitingText', { count: 2 })).toBe('2 Änderungen sind noch nicht gespeichert. Meldest du dich jetzt ab, gehen sie verloren.')
    expect(i18n.t('session.signOutAnyway')).toBe('Trotzdem abmelden')
    expect(i18n.t('session.wait')).toBe('Warten')
    await act(async () => i18n.changeLanguage('en'))
  })

  /** Text arrives in the note "blank" (another window typed it), its title stays empty. */
  async function textWithoutTitle() {
    const room = rooms.get('blank')!
    const theirs = new Y.Doc()
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(room))
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('call the plumber')])
    theirs.getXmlFragment('body').insert(0, [paragraph])
    Y.applyUpdate(room, Y.encodeStateAsUpdate(theirs))
    await act(async () => window.dispatchEvent(new Event('offline')))
    await act(async () => window.dispatchEvent(new Event('online')))
    await settle(80)
  }

  it('NOTES-8 only the side used last guards the ways out of the page; the other is not asked', async () => {
    notes.set('blank', note('blank', ''))
    await render('/notes/soup')
    await act(async () => openNoteBeside('blank'))
    await settle(80)
    await textWithoutTitle()
    // The left side used again: leaving the page replaces the left note, the right one stays.
    await act(async () => pane('left')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    await settle(30)
    let left = false
    await act(async () => tryLeave(() => (left = true)))
    expect(left).toBe(true)
    expect($('leave-dialog')).toBeNull()
  })

  it('NOTES-8 closing a tab whose note has text but no title asks first, as leaving does', async () => {
    notes.set('blank', note('blank', ''))
    await render('/notes/soup')
    await act(async () => openNoteInNewTab('blank'))
    await settle(80)
    const editor = pane('left')!.querySelector('.ProseMirror') as HTMLElement
    expect(editor).not.toBeNull()
    await textWithoutTitle()
    const blankTab = $$('tab').find((tab) => tab.dataset.note === 'blank')!
    await act(async () => $('tab-close', blankTab)!.click())
    expect($('leave-dialog')).not.toBeNull()
    expect($$('tab')).toHaveLength(2)
  })
})

describe('the rules of the tabs', () => {
  it('NOTES-8 AC-7 the tab not used for the longest goes, never one on show', () => {
    // "a" on the left, used first of all; "b" to "f" one after the other on the right.
    let state = rules.openInNewTab(rules.EMPTY, 'a').state
    state = rules.openBeside(state, 'b').state
    for (const id of ['c', 'd', 'e', 'f']) state = rules.openInNewTab(state, id).state
    const step = rules.openInNewTab(state, 'g')
    expect(step.closed?.note).toBe('b')
    expect(step.state.tabs.map((tab) => tab.note)).toEqual(['a', 'c', 'd', 'e', 'f', 'g'])
    expect(rules.tabOf(step.state, step.state.left)?.note).toBe('a')
  })

  it('NOTES-8 AC-5 what is kept is read back, and anything odd counts as no tabs', () => {
    let state = rules.openInNewTab(rules.EMPTY, 'a', 'garden').state
    state = rules.openBeside(state, 'b').state
    expect(rules.parse(rules.serialize(state))).toEqual(state)
    expect(rules.parse('{')).toEqual(rules.EMPTY)
    expect(rules.parse(JSON.stringify({ v: 2, tabs: [] }))).toEqual(rules.EMPTY)
    const odd = rules.parse(JSON.stringify({ v: 1, tabs: [{ key: 'x', note: 'n', used: 1 }, { key: 'x', note: 'm', used: 2 }], left: 'y', right: 'x', focus: 'right', ratio: 9 }))
    expect(odd.tabs).toHaveLength(1)
    expect(odd.left).toBe('x')
    expect(odd.right).toBeNull()
    expect(odd.ratio).toBe(rules.MAX_RATIO)
  })

  it('NOTES-8 AC-5 AC-7 more than six tabs kept on the device come back as the first six', () => {
    const tabs = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, note: `n${index}`, used: index + 1 }))
    const read = rules.parse(JSON.stringify({ v: 1, tabs, left: 'k7', right: 'k1', focus: 'right', ratio: 0.5, seq: 8 }))
    expect(read.tabs.map((tab) => tab.note)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'])
    // The left one went with the seventh and eighth: the right one takes its place, alone.
    expect(read.left).toBe('k1')
    expect(read.right).toBeNull()
  })

  it('NOTES-8 EC-1 the same note may stand on both sides', () => {
    let state = rules.openInNewTab(rules.EMPTY, 'a').state
    state = rules.openBeside(state, 'a').state
    expect(rules.tabOf(state, state.left)?.note).toBe('a')
    expect(rules.tabOf(state, state.right)?.note).toBe('a')
    expect(state.left).not.toBe(state.right)
  })

  it('NOTES-8 AC-3 a note with a tab opened in a new tab brings its tab, never a second one', () => {
    let state = rules.openInNewTab(rules.EMPTY, 'a').state
    state = rules.openInNewTab(state, 'b').state
    state = rules.openInNewTab(state, 'a').state
    expect(state.tabs.map((tab) => tab.note)).toEqual(['a', 'b'])
    expect(rules.tabOf(state, state.left)?.note).toBe('a')
  })

  it('NOTES-8 AC-3 opening the ordinary way replaces the note on show, a note with a tab brings its tab', () => {
    let state = rules.openHere(rules.EMPTY, 'a').state
    state = rules.openInNewTab(state, 'b').state
    state = rules.openHere(state, 'c').state
    expect(state.tabs.map((tab) => tab.note)).toEqual(['a', 'c'])
    state = rules.openHere(state, 'a').state
    expect(rules.tabOf(state, state.left)?.note).toBe('a')
    expect(state.tabs).toHaveLength(2)
  })
})
