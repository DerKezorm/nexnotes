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
import { Editor } from '@tiptap/core'
import { act as reactAct, Fragment, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { it as vitestIt } from 'vitest'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { schemaExtensions } from '../editor/extensions'
import { hideNotice } from '../folders/notice'
import { forgetPrefs, prefKey } from '../lib/devicePref'
import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import type { NoteHead } from '../notes/api'
import { tryLeave } from '../notes/context'
import { AllNotesList, NotesPage } from '../notes/NotesPage'
import { SIGNED_OUT_EVENT } from '../api/client'
import { SessionDialog } from '../components/SessionDialog'
import { AuthProvider, useAuth } from '../state/auth'
import { tabCommand } from './keys'
import { acquireProvider, BRIDGE, forgetParked, parkedProviders, releaseProvider } from './live'
import { accountChanged, followAccount, waitingChanges } from '../state/account'
import { forgetMeta, metaOf, refreshMeta } from './meta'
import { openNoteBeside, openNoteInNewTab, showTab } from './open'
import { startNewNote } from '../notes/newNote'
import * as rules from './state'
import { forgetTabs, storageKey, tabs, tabsNow } from './store'
import { COLUMN_PANE, LIST_STRIP, listStand, MIN_PANE, rowsFor, SEPARATOR, SIDE_LABEL, SPLIT_ROOM, TAB_CHROME, TAB_GAP, TAB_MIN, tabMin, tabRows, TITLE_MIN } from './layout'

// ---- The stand-in server -------------------------------------------------------------------------------------------

let notes: Map<string, NoteHead & { locked?: boolean }>
const rooms = new Map<string, Y.Doc>()
const sockets: RoomSocket[] = []
let me = 1
/** The account a note belongs to (1 unless named): any other gets 404 for it, and its room refuses them. */
const belongs = new Map<string, number>()
/** The stand-in server keeps an empty note left by the page and throws it away only later (its grace after the last
 * connection left). */
let discardLater = false
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
  if (method === 'POST' && path === '/api/notes') {
    const body = JSON.parse(lastBody ?? '{}') as { id: string; folder_id?: string }
    const made = note(body.id, '', body.folder_id ?? 'garden')
    notes.set(made.id, made)
    rooms.set(made.id, new Y.Doc())
    return reply(201, made)
  }
  if (method === 'GET' && path === '/api/note-list/stamp') return reply(200, { stamp: String(notes.size) })
  const one = /^\/api\/notes\/([^/]+)(\/.*)?$/.exec(path)
  if (one) {
    const [, id, tail = ''] = one
    const found = notes.get(id)
    if (!found || (belongs.get(id) ?? 1) !== me) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET' && !tail) return reply(200, found)
    if (method === 'DELETE' && !tail) {
      notes.set(id, { ...found, deleted_at: NOW })
      return reply(204, null)
    }
    if (method === 'PUT' && tail === '/icon') {
      notes.set(id, { ...found, icon: String(JSON.parse(lastBody ?? '{}').icon) })
      return reply(200, notes.get(id))
    }
    if (method === 'PUT' && tail === '/paper') {
      const paper = String(JSON.parse(lastBody ?? '{}').paper)
      notes.set(id, { ...found, paper })
      return reply(200, notes.get(id))
    }
    if (method === 'POST' && tail === '/title/suggestion') return reply(200, found)
    // As the server: a note without title and text goes for good; while `discardLater`, only later (after the grace).
    if (method === 'POST' && tail === '/discard') {
      const doc = rooms.get(id)
      const empty = !found.title && !doc?.getText('title').toString() && !doc?.getXmlFragment('body').toString().replace(/<\/?paragraph>/g, '')
      if (!empty || discardLater) return reply(200, { discarded: false })
      notes.delete(id)
      return reply(200, { discarded: true })
    }
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
/** Every page drawn in the running test, so that none of them outlives it. */
const roots = new Set<Root>()

/**
 * A test that runs out of time under a busy machine goes on in the background while the next one starts: it would draw
 * into the next test's page and keep its editors connecting, and every test after it would wait in vain. So every test
 * knows its number (`it` below), and each helper stops a test whose number is no longer the running one.
 */
type Store<T> = { run: <R>(store: T, body: () => R) => R; getStore: () => T | undefined }
const hooksName = 'node:async_hooks'
const { AsyncLocalStorage } = (await import(/* @vite-ignore */ hooksName)) as { AsyncLocalStorage: new <T>() => Store<T> }
const running = new AsyncLocalStorage<number>()
/** The app's style sheet as written (the test setup draws no CSS). */
const fsName = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (file: string, encoding: string) => string }
const sheetStyles = readFileSync('src/styles/index.css', 'utf-8')
let generation = 0

function stillRunning(): void {
  const mine = running.getStore()
  if (mine !== undefined && mine !== generation) throw new Error('this test is over')
}

/** The page goes (a reload, another account's turn). */
function unmountPage(): void {
  if (!root) return
  root.unmount()
  roots.delete(root)
}

/** React's `act` scopes still open: one left open by a test that ran out of time would muddle every later `act`. */
const openActs = new Set<Promise<unknown>>()

/** React's `act`, for the running test only. */
async function act(body: () => unknown): Promise<void> {
  stillRunning()
  const scope = reactAct(async () => {
    await body()
  })
  openActs.add(scope)
  try {
    await scope
  } finally {
    openActs.delete(scope)
  }
}

function it(name: string, body: () => Promise<void> | void): void {
  vitestIt(name, () => running.run(generation, body))
}
let where = ''
let width = 1400

/** A folder of the sidebar's tree, as `FolderTree.tsx` draws it: a treeitem that a click or Enter opens. */
function TreeFolder({ id }: { id: string }) {
  const navigate = useNavigate()
  return (
    <div
      role="treeitem"
      tabIndex={0}
      data-folder={id}
      data-testid={`tree-${id}`}
      onClick={() => navigate(`/folder/${id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') navigate(`/folder/${id}`)
      }}
    >
      {id}
    </div>
  )
}

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname + location.search
  }, [location])
  return null
}

async function settle(ms = 30): Promise<void> {
  stillRunning()
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
    stillRunning()
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
  stillRunning()
  document.body.appendChild(box)
  root = createRoot(box)
  roots.add(root)
  await act(async () => {
    root!.render(
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          {/* The places of the sidebar that choose a list (as `Sidebar.tsx`: links inside the main menu). */}
          <nav aria-label="Main menu" data-testid="places">
            <Link to="/folder/kitchen" data-testid="place-kitchen">
              Kitchen
            </Link>
            <Link to="/inbox" data-testid="place-inbox">
              Inbox
            </Link>
            <div role="tree">
              <TreeFolder id="garden" />
            </div>
          </nav>
          <SessionDialog />
          <PerAccount>
            <Routes>
              {/* As `App.tsx`: the lists inside the workspace, the trash a page of its own. */}
              <Route element={<NotesPage />}>
                <Route path="/" element={<AllNotesList />} />
                <Route path="/notes/:noteId" element={<AllNotesList />} />
                <Route path="/folder/:id" element={<div data-testid="folder-list" />} />
                <Route path="/inbox" element={<div data-testid="inbox-list" />} />
              </Route>
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
  await act(async () => unmountPage())
  root = null
  box.remove()
  forgetTabs()
  forgetMeta()
  await render(path)
}

const $ = (testId: string, inside: ParentNode = document.body) => inside.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
const $$ = (testId: string, inside: ParentNode = document.body) => [...inside.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
const tabTitles = () => $$('tab-title').map((element) => element.textContent)
const pane = (side: 'left' | 'right') => box.querySelector(`[data-testid="tab-pane"][data-side="${side}"]`) as HTMLElement | null

function typeTitle(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(code: string, extra: Partial<KeyboardEventInit> = {}) {
  stillRunning()
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra }))
}

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
  // The editor warmed once outside the tests' time: on a busy machine the first test would otherwise pay for it alone.
  const warm = new Editor({ element: document.createElement('div'), extensions: schemaExtensions(), content: '<p>warm</p><table><tr><td><p>x</p></td></tr></table>' })
  warm.destroy()
})

beforeEach(() => {
  // Nothing of a test before stays on the page (the notices' own host stays, as in the app).
  for (const element of [...document.body.children]) if (!element.hasAttribute('data-folder-notices')) element.remove()
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
  discardLater = false
  me = 1
  width = 1400
  localStorage.clear()
  forgetPrefs()
  forgetFolders()
  forgetTabs()
  forgetMeta()
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
  // The test is over: a part of it still running stops at its next step, once its open `act` has closed.
  generation += 1
  await Promise.allSettled([...openActs])
  await act(async () => {
    for (const one of roots) one.unmount()
  })
  roots.clear()
  root = null
  hideNotice()
  box?.remove()
  forgetParked()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 50))
})

// ---- The tests -----------------------------------------------------------------------------------------------------

describe('tabs in the page', () => {
  it('NOTES-8 AC-9 another list changes only the middle: the tabs and the editor stay, the address names both', async () => {
    await render('/notes/soup')
    await act(async () => openNoteInNewTab('shop'))
    await idle()
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping'])
    const editor = pane('left')!.querySelector('.ProseMirror')
    expect(editor).not.toBeNull()
    // The path over the note chooses its folder's list.
    const path = pane('left')!.querySelector('[data-testid="note-path"]') as HTMLAnchorElement
    expect(path.tagName).toBe('A')
    await act(async () => path.click())
    await idle()
    expect(where).toBe('/folder/garden?note=shop')
    expect($('folder-list')).not.toBeNull()
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping'])
    // The very same editor: not drawn anew, its connection kept.
    expect(pane('left')!.querySelector('.ProseMirror')).toBe(editor)
    // A tab chosen now keeps the list and names its note.
    const soup = tabsNow().tabs.find((one) => one.note === 'soup')
    await act(async () => showTab(soup?.key ?? ''))
    await idle()
    expect(where).toBe('/folder/garden?note=soup')
    expect($('folder-list')).not.toBeNull()
  })

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

  it('NOTES-8 AC-3 Alt-click on a note opens it in a new tab, never the browser\'s download; the menu names the way', async () => {
    await render('/notes/soup')
    const link = (id: string) => box.querySelector(`[data-note="${id}"] [data-testid="note-row"]`) as HTMLAnchorElement
    const alt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true })
    await act(async () => void link('shop').dispatchEvent(alt))
    // Chrome and Safari download a link's address on Alt-click: the click never reaches the browser.
    expect(alt.defaultPrevented).toBe(true)
    await until(() => expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping']))
    expect(where).toBe('/notes/shop')
    // A note that has its tab already: back to that tab, no second one.
    await act(async () => void link('soup').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true })))
    await until(() => expect(where).toBe('/notes/soup'))
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping'])
    // The list's menu says so beside "Open in new tab".
    const row = box.querySelector('[data-note="bath"]') as HTMLElement
    await act(async () => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    expect($('menu-open-tab-hint')!.textContent).toBe('Alt+click')
  })

  it('NOTES-8 AC-3 Alt-click while no note is open opens the note as a plain click does', async () => {
    await render('/')
    expect($$('tab')).toHaveLength(0)
    const link = box.querySelector('[data-note="shop"] [data-testid="note-row"]') as HTMLAnchorElement
    const alt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true })
    await act(async () => void link.dispatchEvent(alt))
    expect(alt.defaultPrevented).toBe(true)
    await until(() => expect(where).toBe('/notes/shop'))
    await idle()
    expect(tabTitles()).toEqual(['Saturday shopping'])
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

  it('NOTES-6 AC-10 the list beside a note is as wide as set on this device, and still leaves the notes their widths', async () => {
    width = 1600
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
    // Two notes beside it keep 514 px each, more than the 480 px a side keeps beside the column: the list stays as a
    // column (NOTES-8 AC-9).
    await act(async () => openNoteBeside('shop'))
    await idle()
    expect($('list-column')!.style.width).toBe('560px')
    expect(pane('right')).not.toBeNull()
    // Narrower, the two would get less: the list gives way to a drawer, the notes keep their widths.
    await act(async () => unmountPage())
    width = 1200
    box.remove()
    await render('/notes/shop')
    expect($('list-column')).toBeNull()
    expect($('list-drawer')).toBeNull()
    expect(pane('left')).not.toBeNull()
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
    // A side of 800 px: no room for the column, nothing stands beside the text until the button asks for it.
    width = 800
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
    expect($('outline')!.dataset.mode).toBe('column')
    expect($('note-page')!.style.maxWidth).toBe('none')
    // Turned off, it stays off.
    await act(async () => $('tool-outline')!.click())
    expect($('outline')).toBeNull()
  })

  /** The outline button of a side: in the toolbar, or in "More" when the side is narrow. */
  async function outlineButton(inside: ParentNode = document.body): Promise<HTMLElement> {
    const button = $('tool-outline', inside)
    if (button) return button
    await act(async () => $('tool-more', inside)!.click())
    return $('more-outline')!
  }

  it('NOTES-3 AC-15 the reviewed window (a side of 1170 px): the outline stands beside the text, the button pressed', async () => {
    width = 1170
    await render('/notes/soup')
    const button = $('tool-outline')!
    expect($('outline')!.dataset.mode).toBe('column')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Show or hide the outline')
    expect(button.title).toBe('Show or hide the outline')
    // Off: gone, and the button no longer pressed; on again.
    await act(async () => button.click())
    expect($('outline')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    await act(async () => button.click())
    expect($('outline')!.dataset.mode).toBe('column')
  })

  it('NOTES-3 AC-15 with too little room the button opens the outline as a panel over the text; Escape and a click beside it close it', async () => {
    width = 800
    await render('/notes/soup')
    const button = $('tool-outline')!
    expect($('outline')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    await act(async () => button.click())
    const panel = $('outline')!
    expect(panel.dataset.mode).toBe('panel')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    // Over the text's right edge, inside the note's side, with the focus.
    expect(panel.closest('[data-testid="note-editor"]')).not.toBeNull()
    expect(document.activeElement).toBe(panel)
    expect(panel.getAttribute('aria-label')).toBe(i18n.t('editor.outline.label'))
    // Escape: closed, the focus back on the button.
    await act(async () => void panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect($('outline')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(button)
    // The button toggles it; a click inside it keeps it, a click beside it (in the text) closes it.
    await act(async () => void button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    await act(async () => button.click())
    expect($('outline')!.dataset.mode).toBe('panel')
    await act(async () => void $('outline')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect($('outline')).not.toBeNull()
    await act(async () => void $('note-page')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect($('outline')).toBeNull()
    // A panel is for the moment: the setting of the column stays as it was.
    expect(localStorage.getItem(prefKey('outline', 1))).toBeNull()
  })

  it('NOTES-3 AC-15 the outline stands right beside the sheet, the two centred together; the info goes with it (fourth review)', async () => {
    width = 2560
    await render('/notes/soup')
    const page = $('note-page')!
    const outline = $('outline')!
    const pane = $('note-pane')!
    // The column follows the sheet at the side's gap (24 px), the pair centred in the side: no auto margin on the
    // sheet, which would push the column to the far edge of a wide window.
    expect(outline.dataset.mode).toBe('column')
    expect(outline.previousElementSibling).toBe(page)
    expect(page.parentElement).toBe(pane)
    expect(pane.className).toContain('justify-center')
    expect(pane.className).toContain('md:gap-6')
    expect(page.className.split(' ')).not.toContain('mx-auto')
    expect(outline.className.split(' ')).not.toContain('ml-auto')
    expect(outline.contains($('outline-info'))).toBe(true)
    // Off and on again: the sheet keeps its width and stays centred, alone.
    await act(async () => $('tool-outline')!.click())
    expect($('outline')).toBeNull()
    expect($('note-page')!.style.maxWidth).toBe('760px')
    expect($('note-page')!.parentElement).toBe($('note-pane'))
    await act(async () => $('tool-outline')!.click())
    expect($('outline')!.previousElementSibling).toBe($('note-page'))
  })

  it('NOTES-3 AC-15 a note without headings says in the outline how it comes about', async () => {
    width = 1170
    await render('/notes/soup')
    expect($('outline-none')!.textContent).toBe('No headings yet. Type # or choose the text style “Heading”, and the outline builds up here.')
    expect($('outline-info')).not.toBeNull()
    await act(async () => void (await i18n.changeLanguage('de')))
    try {
      expect($('outline-none')!.textContent).toBe('Noch keine Überschriften. Mit # oder dem Textstil ‚Überschrift‘ entsteht hier die Gliederung.')
    } finally {
      await act(async () => void (await i18n.changeLanguage('en')))
    }
  })

  it('NOTES-8 NOTES-3 AC-15 side by side in the reviewed window each side opens its own outline as a panel', async () => {
    width = 1170
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
    // Each side about 580 px wide: the column does not fit there.
    width = Math.floor((1170 - 12) / 2)
    await reload('/notes/soup')
    expect(pane('right')).not.toBeNull()
    expect($('outline')).toBeNull()
    const left = pane('left')!
    const first = await outlineButton(left)
    await act(async () => first.click())
    expect($$('outline').map((outline) => outline.dataset.mode)).toEqual(['panel'])
    expect(left.contains($('outline'))).toBe(true)
    // The other side's button opens that side's own; the first closes, as on any click beside it.
    const right = pane('right')!
    const second = await outlineButton(right)
    await act(async () => void second.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    await act(async () => second.click())
    expect($$('outline').length).toBe(1)
    expect(right.contains($('outline'))).toBe(true)
  })

  it("NOTES-3 AC-3 the toolbar stays at the top of the side's one scroll area while the text scrolls (third review)", async () => {
    await render('/notes/soup')
    const head = $('editor-head')!
    // Sticky at the top on a desk (on a phone the tools sit above the keyboard), with a background of its own.
    expect(head.className.split(' ')).toEqual(expect.arrayContaining(['md:sticky', 'md:top-0', 'md:bg-ink-950']))
    expect(head.contains($('toolbar'))).toBe(true)
    // One scroll area per note, the side itself: nothing between it and the toolbar or the text scrolls.
    const side = head.closest<HTMLElement>('[data-testid="tab-pane"]')!
    expect(side.className).toContain('overflow-y-auto')
    for (const inner of [head, $('note-page')!]) {
      for (let at = inner.parentElement; at && at !== side; at = at.parentElement) expect(at.className).not.toMatch(/overflow-(y-)?(auto|scroll)/)
    }
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

  it('NOTES-3 AC-18 a symbol before the title: added from the title row, shown in the list and the tab, removed again', async () => {
    notes.set('shop', { ...notes.get('shop')!, icon: 'shopping-cart', color: 'green' } as NoteHead)
    await render('/notes/soup')
    // The list shows a symbol where a note has one.
    const rows = $$('note-row')
    const shopRow = rows.find((row) => row.textContent?.includes('Saturday shopping'))!
    expect(shopRow.querySelector('[data-testid="note-icon"]')!.getAttribute('data-icon')).toBe('shopping-cart')
    expect(rows.find((row) => row.textContent?.includes('Lentil soup'))!.querySelector('[data-testid="note-icon"]')).toBeNull()
    // Without a symbol: the quiet button in the title row, reachable by keyboard.
    const add = $('title-icon-add')!
    expect(add.getAttribute('aria-label')).toBe('Choose a symbol')
    expect(add.tabIndex).toBe(0)
    await act(async () => add.click())
    const dialog = $('note-icon-dialog')!
    const search = dialog.querySelector<HTMLInputElement>('[data-testid="symbol-search"]')!
    await act(async () => typeTitle(search, 'topf'))
    const found = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(found.length).toBeGreaterThan(0)
    await act(async () => found[0].click())
    await idle()
    expect(requests).toContain('PUT /api/notes/soup/icon')
    const chosen = notes.get('soup')!.icon
    expect(chosen).toBeTruthy()
    expect($('title-icon')!.querySelector('[data-testid="note-icon"]')!.getAttribute('data-icon')).toBe(chosen)
    // The tab shows the symbol in place of the dot.
    await act(async () => void refreshMeta(['soup']))
    await idle()
    expect($$('tab-title')[0].parentElement!.querySelector('[data-testid="note-icon"]')!.getAttribute('data-icon')).toBe(chosen)
    // With a symbol, the picker offers to remove it.
    await act(async () => $('title-icon')!.click())
    const remove = [...$('note-icon-dialog')!.querySelectorAll('button')].find((button) => button.textContent === 'Remove')!
    await act(async () => remove.click())
    await idle()
    expect(notes.get('soup')!.icon).toBe('')
    expect($('title-icon')).toBeNull()
  })

  it('NOTES-8 AC-1 the tab of the side used last stands out: honey along its top, bold, aria-current', async () => {
    await render('/notes/soup')
    await act(async () => openNoteInNewTab('shop'))
    await idle()
    const tab = (note: string) => $$('tab').find((one) => one.dataset.note === note)!
    // One side: the front tab is the active one, the other is neither shown nor marked.
    expect(tab('shop').getAttribute('aria-current')).toBe('true')
    expect(tab('shop').className).toContain('font-semibold')
    expect(tab('shop').className).toContain('shadow-[inset_0_3px_0_var(--color-accent-500)]')
    expect(tab('soup').getAttribute('aria-current')).toBeNull()
    expect(tab('soup').getAttribute('aria-selected')).toBe('false')
    // Two sides: both shown (aria-selected), only the side used last is current, and the mark follows the focus.
    await act(async () => openNoteBeside('meet'))
    await idle()
    const shown = $$('tab').filter((one) => one.getAttribute('aria-selected') === 'true')
    expect(shown).toHaveLength(2)
    expect(shown.filter((one) => one.getAttribute('aria-current') === 'true').map((one) => one.dataset.note)).toEqual(['meet'])
    expect(tab('shop').className).not.toContain('font-semibold')
    await act(async () => tabs.focus('left'))
    await idle()
    expect(tab('shop').getAttribute('aria-current')).toBe('true')
    expect(tab('meet').getAttribute('aria-current')).toBeNull()
    expect(tab('meet').className).not.toContain('shadow-[inset_0_3px_0')
  })

  it('NOTES-3 AC-1 EC-4 EC-9 "New note" while an empty note is open there takes that one; with text a second one comes', async () => {
    notes.set('blank', note('blank', ''))
    rooms.set('blank', new Y.Doc())
    await render('/folder/garden?note=blank')
    const made = () => requests.filter((request) => request === 'POST /api/notes').length
    const title = () => $('note-title') as HTMLInputElement
    expect(title().value).toBe('')
    await act(async () => void (document.activeElement as HTMLElement | null)?.blur())
    // Quite empty and in the folder "New note" goes to: no second note, the cursor goes into its title.
    await act(async () => startNewNote('garden'))
    await idle()
    expect(made()).toBe(0)
    expect(document.activeElement).toBe(title())
    expect(where).toBe('/folder/garden?note=blank')
    // Another folder is another place: a new note there.
    await act(async () => startNewNote('kitchen'))
    await idle()
    expect(made()).toBe(1)
    // Once something is written in it, it is no blank note any more: "New note" makes one.
    await act(async () => typeTitle(title(), 'Groceries'))
    await act(async () => startNewNote('garden'))
    await idle()
    expect(made()).toBe(2)
  })

  it('NOTES-8 AC-3 no choice of the list menu seems to do nothing: new tab, go to tab with a pulse, already open', async () => {
    await render('/notes/soup')
    const menuOf = async (note: string) => {
      const row = box.querySelector(`[data-testid="note-row-box"][data-note="${note}"]`) as HTMLElement
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
      return { tab: $('menu-open-tab')!, beside: $('menu-open-beside')! }
    }
    const tabOfNote = (note: string) => $$('tab').find((one) => one.dataset.note === note)!
    // Not open: a new tab.
    let menu = await menuOf('shop')
    expect(menu.tab.textContent).toBe('Open in a new tabAlt+click')
    expect(menu.tab.getAttribute('aria-disabled')).toBeNull()
    await act(async () => menu.tab.click())
    await idle()
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping'])
    // The front tab already: greyed, "already open", and nothing happens.
    menu = await menuOf('shop')
    expect(menu.tab.getAttribute('aria-disabled')).toBe('true')
    expect(menu.tab.textContent).toContain('already open')
    await act(async () => menu.tab.click())
    expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping'])
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => void document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    // Open in the background: "Go to tab", and the tab pulses as it comes to the front.
    menu = await menuOf('soup')
    expect(menu.tab.textContent).toBe('Go to tabAlt+click')
    await act(async () => menu.tab.click())
    await idle()
    expect(tabOfNote('soup').getAttribute('aria-current')).toBe('true')
    expect(tabOfNote('soup').dataset.pulse).toBe('true')
    expect(tabOfNote('soup').className).toContain('nn-tab-pulse')
    // Beside: once the note stands on the right, "Open beside" is greyed too.
    menu = await menuOf('meet')
    await act(async () => menu.beside.click())
    await idle()
    menu = await menuOf('meet')
    expect(menu.beside.getAttribute('aria-disabled')).toBe('true')
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
    await act(async () => unmountPage())
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
    await act(async () => unmountPage())
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

  it('NOTES-13 AC-5 NOTES-8 EC-6 sharing ends while the note is on show: the side says so and keeps who ended it', async () => {
    notes.set('soup', note('soup', 'Lentil soup', 'garden', { owner: { id: 9, name: 'Lena' }, can_write: false, level: 'read' } as Partial<NoteHead>))
    await render('/notes/soup')
    await settle(40)
    expect($('note-editor')).not.toBeNull()
    // The owner takes it back: the room refuses (4403), the head is not handed out any more (404).
    notes.delete('soup')
    const socket = openSockets().find((one) => one.id === 'soup')!
    await act(async () => {
      socket.readyState = 3
      socket.onclose?.({ code: 4403 } as CloseEvent)
    })
    await settle(60)
    expect($$('tab')[0].dataset.state).toBe('gone')
    expect($('note-editor')).toBeNull()
    expect($('tab-gone')!.textContent).toContain('This note is no longer available.')
    expect($('tab-gone-said')!.textContent).toBe('“Lentil soup” is not here any more: Lena stopped sharing it.')
    // Remembered by this page only: the tab itself keeps no title of a note that is not handed out any more.
    expect(metaOf('soup')).toMatchObject({ state: 'gone', title: '' })
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

describe('the list beside two notes', () => {
  /** Two notes side by side, the right one used last, in a page `px` wide. */
  async function twoNotes(px: number): Promise<void> {
    width = px
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
  }
  const drawer = () => $('list-drawer')
  // Without room for the column the strip at the left edge opens and closes the drawer.
  const toggle = () => $('list-expand')!
  const focusedPane = () => box.querySelector('[data-testid="tab-pane"][data-focused="true"]') as HTMLElement
  const escape = async () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body
    await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  }

  it('NOTES-8 AC-9 the list stands as a column beside two notes while both keep 480 px (fifth review), else it is a drawer', () => {
    // 480 px a side: the sheet keeps about 350 px inside, for a title word and the sheet's own bar in one row.
    expect(COLUMN_PANE).toBe(480)
    expect(COLUMN_PANE).toBeGreaterThan(MIN_PANE)
    expect(SPLIT_ROOM).toBe(2 * COLUMN_PANE + SEPARATOR)
    expect(listStand(true, 300 + SPLIT_ROOM, 300)).toBe('column')
    expect(listStand(true, 300 + SPLIT_ROOM - 1, 300)).toBe('drawer')
    // Room for two sides of 340 px is not room for the column any more (a sheet of 380 px cut its title off).
    expect(listStand(true, 300 + 2 * MIN_PANE + SEPARATOR + 100, 300)).toBe('drawer')
    // One note: as before, the list gives way to the note, never a drawer.
    expect(listStand(false, 300 + MIN_PANE, 300)).toBe('column')
    expect(listStand(false, 300 + MIN_PANE - 1, 300)).toBe('none')
  })

  it('NOTES-8 AC-9 with room the column stands between sidebar and notes; "«" in its head folds it to a strip, "»" brings it back, kept on this device', async () => {
    await twoNotes(300 + SPLIT_ROOM)
    expect($('list-column')!.style.width).toBe('300px')
    expect($('note-list')).not.toBeNull()
    expect(pane('left')).not.toBeNull()
    expect(pane('right')).not.toBeNull()
    // The button "List" in the row of tabs is gone (sixth review); "«" stands at the end of the list's head.
    expect($('tab-list-toggle')).toBeNull()
    expect($('list-expand')).toBeNull()
    const collapse = $('list-collapse', $('list-head')!)!
    expect(collapse.getAttribute('aria-label')).toBe('Collapse list')
    expect(collapse.getAttribute('title')).toBe('Collapse list')
    expect(i18n.getResource('de', 'translation', 'tabs.collapseList')).toBe('Liste einklappen')
    expect(i18n.getResource('de', 'translation', 'tabs.expandList')).toBe('Liste aufklappen')
    await act(async () => collapse.click())
    expect($('list-column')).toBeNull()
    // Folded: a narrow strip at the left edge, the whole height, between the sidebar and the notes; the focus on it.
    const strip = () => $('list-expand')!
    expect(strip().tagName).toBe('BUTTON')
    expect(strip().style.width).toBe(`${LIST_STRIP}px`)
    expect(strip().getAttribute('aria-label')).toBe('Expand list')
    expect(strip().getAttribute('aria-expanded')).toBe('false')
    expect(strip().compareDocumentPosition(pane('left')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await until(() => document.activeElement === strip())
    // "»" brings it back, the focus on its "«"; by keyboard both ways.
    await act(async () => strip().click())
    expect($('list-column')).not.toBeNull()
    await until(() => document.activeElement === $('list-collapse'))
    await act(async () => $('list-collapse')!.click())
    await until(() => document.activeElement === strip())
    expect(localStorage.getItem(prefKey('splitList', 1))).toBe('off')
    // Kept after a reload on this device.
    forgetPrefs()
    await reload('/notes/shop')
    expect($('list-column')).toBeNull()
    expect(strip()).not.toBeNull()
    // Folded, a list chosen in the sidebar still shows: in the drawer.
    await act(async () => $('place-kitchen')!.click())
    await idle()
    expect(drawer()).not.toBeNull()
    // "»" brings the column back, the focus on its "«".
    await act(async () => strip().click())
    expect(drawer()).toBeNull()
    expect($('list-column')).not.toBeNull()
    expect($('list-expand')).toBeNull()
    expect(localStorage.getItem(prefKey('splitList', 1))).toBeNull()
    // One note: the list as always (folding it beside one note: the next test).
    await act(async () => tabs.endSplit())
    await idle()
    expect($('list-column')).not.toBeNull()
    expect($('list-expand')).toBeNull()
  })

  it('NOTES-8 AC-9 beside one note "«" folds the list too and the note takes the whole width; "»" or another list brings it back (24.11.2026)', async () => {
    width = 300 + MIN_PANE + 200
    await render('/notes/soup')
    await idle()
    expect(pane('right')).toBeNull()
    const collapse = () => $('list-collapse', $('list-head')!)!
    await until(() => Boolean($('list-head') && collapse()))
    await act(async () => collapse().click())
    expect($('list-column')).toBeNull()
    expect(pane('left')).not.toBeNull()
    const strip = () => $('list-expand')!
    expect(strip().style.width).toBe(`${LIST_STRIP}px`)
    expect(strip().getAttribute('aria-expanded')).toBe('false')
    await until(() => document.activeElement === strip())
    expect(localStorage.getItem(prefKey('splitList', 1))).toBe('off')
    // No drawer for one note: "»" unfolds the column, the focus on its "«".
    await act(async () => strip().click())
    expect(drawer()).toBeNull()
    expect($('list-column')).not.toBeNull()
    await until(() => document.activeElement === $('list-collapse'))
    // Folded again, another list chosen in the sidebar unfolds the column to show it.
    await act(async () => collapse().click())
    expect($('list-column')).toBeNull()
    await act(async () => $('place-kitchen')!.click())
    await idle()
    await until(() => $('list-column') !== null)
    expect($('folder-list', $('list-column')!)).not.toBeNull()
    expect(drawer()).toBeNull()
    expect($('list-expand')).toBeNull()
  })

  it('NOTES-8 AC-9 too narrow for the column: a folder chosen in the sidebar opens the drawer over the left note, the same one again too', async () => {
    await twoNotes(300 + SPLIT_ROOM - 1)
    expect($('list-column')).toBeNull()
    expect(drawer()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().hasAttribute('aria-pressed')).toBe(false)
    const kitchen = $('place-kitchen')!
    kitchen.focus()
    await act(async () => kitchen.click())
    await idle()
    expect(where).toBe('/folder/kitchen?note=shop')
    // Right beside the sidebar, over the left note, as wide as the list's column, with the folder's list.
    const open = drawer()!
    expect(open.style.width).toBe('300px')
    expect(open.className).toContain('left-0')
    expect($('folder-list', open)).not.toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-controls')).toBe(open.id)
    // Both notes stay as they were.
    expect(pane('left')!.dataset.note).toBe('soup')
    expect(pane('right')!.dataset.note).toBe('shop')
    // Escape closes it, the focus goes back to the folder that opened it.
    await escape()
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(kitchen)
    // The same folder again changes no address and opens it all the same.
    await act(async () => kitchen.click())
    expect(drawer()).not.toBeNull()
    // Another list (the inbox) keeps it open with that list.
    await act(async () => $('place-inbox')!.click())
    await idle()
    expect($('inbox-list', drawer()!)).not.toBeNull()
    // A click beside it (on the left note) closes it.
    await act(async () => void pane('left')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(drawer()).toBeNull()
    // A folder of the tree, chosen with Enter, then again with Enter (no new address): open both times, the focus
    // goes back to it.
    const garden = $('tree-garden')!
    garden.focus()
    const enter = () => garden.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await act(async () => void enter())
    await idle()
    expect(where).toBe('/folder/garden?note=soup')
    expect(drawer()).not.toBeNull()
    await escape()
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(garden)
    await act(async () => void enter())
    expect(drawer()).not.toBeNull()
    await act(async () => void garden.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(drawer()).not.toBeNull()
    await escape()
    // A list chosen another way (the folder named over the note; the search as one types) opens it too.
    const path = pane('left')!.querySelector('[data-testid="note-path"]') as HTMLAnchorElement
    await act(async () => path.click())
    await idle()
    expect(where).toBe('/folder/kitchen?note=soup')
    expect($('folder-list', drawer()!)).not.toBeNull()
  })

  it('NOTES-8 AC-9 a note chosen in the drawer opens on the side used last and closes it; "List" opens it with the focus inside', async () => {
    await twoNotes(900)
    expect(focusedPane().dataset.side).toBe('right')
    await act(async () => toggle().click())
    await idle()
    const open = drawer()!
    expect(document.activeElement).toBe(open)
    expect($('note-list', open)).not.toBeNull()
    const gift = open.querySelector('[data-note="gift"] [data-testid="note-row"]') as HTMLAnchorElement
    await act(async () => gift.click())
    await idle()
    expect(drawer()).toBeNull()
    expect(focusedPane().dataset.side).toBe('right')
    expect(pane('right')!.dataset.note).toBe('gift')
    expect(pane('left')!.dataset.note).toBe('soup')
    expect(where).toBe('/notes/gift')
    // "List" again closes what it opened, and Escape gives the focus back to it.
    await act(async () => toggle().click())
    expect(drawer()).not.toBeNull()
    await act(async () => toggle().click())
    expect(drawer()).toBeNull()
    await act(async () => toggle().click())
    await escape()
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('NOTES-8 AC-3 AC-9 Alt-click and the menu work in the drawer and keep it open', async () => {
    await twoNotes(900)
    await act(async () => toggle().click())
    await idle()
    const link = (id: string) => drawer()!.querySelector(`[data-note="${id}"] [data-testid="note-row"]`) as HTMLAnchorElement
    const alt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true })
    await act(async () => void link('pack').dispatchEvent(alt))
    expect(alt.defaultPrevented).toBe(true)
    await until(() => expect(tabTitles()).toEqual(['Lentil soup', 'Saturday shopping', 'Packing list']))
    expect(drawer()).not.toBeNull()
    // The list's menu: a press inside it is no click beside the drawer.
    const row = drawer()!.querySelector('[data-note="bath"]') as HTMLElement
    await act(async () => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    const menu = $('note-item-menu')!
    await act(async () => void menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(drawer()).not.toBeNull()
    // Escape closes the menu first, the drawer stays.
    const item = menu.querySelector('[role^="menuitem"]') as HTMLElement
    await act(async () => void item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect($('note-item-menu')).toBeNull()
    expect(drawer()).not.toBeNull()
  })

  it('NOTES-8 AC-1 two notes side by side: the side used last has a honey frame, the other is dimmed; a click there makes it the one at once', async () => {
    await twoNotes(1400)
    expect(pane('right')!.dataset.split).toBe('active')
    expect(pane('left')!.dataset.split).toBe('passive')
    await act(async () => void pane('left')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(pane('left')!.dataset.split).toBe('active')
    expect(pane('right')!.dataset.split).toBe('passive')
    // The focus does the same, by keyboard.
    await act(async () => void (pane('right')!.querySelector('[data-testid="note-title"]') as HTMLElement).focus())
    expect(pane('right')!.dataset.split).toBe('active')
    expect(pane('left')!.dataset.split).toBe('passive')
    // What the marks look like: a calm frame of 2 px in honey; the other side clearly set back by its own values of the
    // colors (fifth review): its sheet below the page's gray in light, on it in dark, its text one dimmed gray that
    // still reads at 4.5:1 or more, in light and dark, on the sheet and on code.
    expect(sheetStyles).toMatch(/\[data-split='active'\] \.nn-sheet \{\s*outline: 2px solid var\(--color-accent-500\);/)
    // The colors a rule of the style sheet sets, by its selector at the start of a line.
    const theme = (selector: string) => {
      const css = sheetStyles.replace(/\r\n/g, '\n')
      const at = css.indexOf(`\n${selector} {`)
      expect(at, selector).toBeGreaterThanOrEqual(0)
      const body = css.slice(at, css.indexOf('}', at))
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1], match[2]]))
    }
    const block = theme
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: string, b: string) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const dark = { ...theme('@theme'), ...block("[data-split='passive']") }
    const light = { ...theme('@theme'), ...theme(":root[data-theme='light']"), ...block(":root[data-theme='light'] [data-split='passive']") }
    const before = { dark: theme('@theme'), light: { ...theme('@theme'), ...theme(":root[data-theme='light']") } }
    for (const [mode, colors] of Object.entries({ dark, light })) {
      const sheet = colors['--color-ink-850']
      // The sheet set back from the sheet on the active side, the text dimmed from the full text color.
      expect(sheet, mode).not.toBe(before[mode as 'dark' | 'light']['--color-ink-850'])
      expect(contrast(colors['--color-mist-100'], sheet), mode).toBeLessThan(contrast(before[mode as 'dark' | 'light']['--color-mist-100'], before[mode as 'dark' | 'light']['--color-ink-850']) * 0.6)
      for (const text of ['--color-mist-100', '--color-mist-300', '--color-mist-500', '--color-mist-600', '--color-accent-400']) {
        expect(contrast(colors[text], sheet), `${mode} ${text}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(colors[text], colors['--color-ink-800']), `${mode} ${text} on code`).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(sheetStyles).toMatch(/\[data-split='passive'\] \.nn-sheet \{\s*box-shadow: none;/)
    // One side with the switcher (a narrow window), and one note alone: no marks.
    await act(async () => unmountPage())
    width = 600
    box.remove()
    await render('/notes/shop')
    expect(pane('left')!.hasAttribute('data-split')).toBe(false)
    expect(pane('right')!.hasAttribute('data-split')).toBe(false)
    await act(async () => tabs.endSplit())
    await idle()
    expect(pane('left')!.hasAttribute('data-split')).toBe(false)
  })
})

describe('the one toolbar over two notes', () => {
  /** Two notes side by side with some text each, the right one used last, in a page `px` wide. */
  async function twoNotes(px = 1400): Promise<void> {
    withText('soup', 'Lentils and onions')
    withText('shop', 'Milk and bread')
    width = px
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
    await until(() => Boolean(editorOf('left') && editorOf('right') && $('tool-bold', bar())))
  }
  const editorOf = (side: 'left' | 'right') => (pane(side)?.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null)?.editor ?? null
  const bar = () => $('shared-toolbar')!
  const tool = (name: string) => $(`tool-${name}`, bar()) as HTMLButtonElement
  const label = () => $('toolbar', bar())!.getAttribute('aria-label')
  const textStyle = () => bar().querySelector<HTMLSelectElement>('#nn-text-style')!.value
  /** The first four letters of a side's text chosen, as a mouse would. */
  const chooseWord = async (side: 'left' | 'right') => {
    await act(async () => void editorOf(side)!.commands.setTextSelection({ from: 1, to: 5 }))
  }
  /** A click in a side: it becomes the side used last. */
  const use = async (side: 'left' | 'right') => {
    await act(async () => void pane(side)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  }

  it('NOTES-8 AC-1 side by side one toolbar over both sides holds the text tools; each sheet keeps only the tools of its note', async () => {
    await twoNotes()
    // One bar, above both sides and outside their scroll areas: it stays in sight while either text scrolls. (The
    // phone's bar above the keyboard is drawn too, hidden from `md` on.)
    expect($$('toolbar').filter((one) => !one.closest('.md\\:hidden'))).toHaveLength(1)
    expect(bar().contains($('toolbar'))).toBe(true)
    for (const side of ['left', 'right'] as const) expect(pane(side)!.contains(bar())).toBe(false)
    expect(bar().compareDocumentPosition(pane('left')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (let at = bar().parentElement; at && at !== document.body; at = at.parentElement) expect(at.className).not.toMatch(/overflow-(y-)?(auto|scroll)/)
    // Every tool on the text, and none of the note's.
    const keys = [...bar().querySelectorAll<HTMLElement>('[data-tool]')].map((one) => one.dataset.testid ?? one.id)
    expect(keys).toEqual([
      'nn-text-style', 'tool-bold', 'tool-italic', 'tool-underline', 'tool-strike', 'tool-highlight', 'tool-bullet', 'tool-ordered', 'tool-task',
      'tool-table', 'tool-link', 'tool-quote', 'tool-code', 'tool-indent', 'tool-outdent', 'tool-divider', 'tool-undo', 'tool-redo',
    ])
    expect($('tool-width', bar())).toBeNull()
    expect($('tool-outline', bar())).toBeNull()
    // It names the note it works on, and the side.
    expect($('toolbar', bar())!.getAttribute('role')).toBe('toolbar')
    expect(label()).toBe('Tools for “Saturday shopping” (right)')
    // Each sheet: a small bar at the top right inside the sheet, beside or above the title, with the width, the outline,
    // the clip, the pin, the others and the note's menu; no row of its own above the sheet (fifth review).
    for (const side of ['left', 'right'] as const) {
      expect($('editor-head', pane(side)!)).toBeNull()
      const sheet = $('note-page', pane(side)!)!
      const head = $('sheet-head', sheet)!
      const tools = $('sheet-tools', head)!
      expect(tools.compareDocumentPosition($('note-title', head)!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      expect(head.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap-reverse']))
      expect(tools.className).toMatch(/\bml-auto\b/)
      expect(tools.querySelector('[data-tool]')).toBeNull()
      expect($('toolbar', tools)).toBeNull()
      const own = $('note-tools', tools)!
      expect(own.getAttribute('role')).toBe('group')
      expect(own.getAttribute('aria-label')).toBe('Tools of the note')
      for (const one of ['tool-width', 'tool-outline', 'attach', 'note-menu']) expect($(one, own)).not.toBeNull()
      // "Attach" only as the clip, no word.
      expect($('attach', own)!.textContent).toBe('')
      expect($('attach', own)!.getAttribute('aria-label')).toBe('Attach')
      // NOTES-3 EC-11: a side may be 340 px narrow; the buttons then break into a second row, never cut off.
      expect(own.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap', 'min-w-0']))
      expect(own.className).not.toMatch(/\bshrink-0\b/)
    }
  })

  it('NOTES-8 AC-1 the bar works on the side used last; its states follow that side at once when the other is used', async () => {
    await twoNotes()
    await chooseWord('right')
    await act(async () => tool('bold').click())
    expect(pane('right')!.querySelector('.ProseMirror strong')?.textContent).toBe('Milk')
    expect(pane('left')!.querySelector('.ProseMirror strong')).toBeNull()
    expect(tool('bold').getAttribute('aria-pressed')).toBe('true')
    await until(() => !tool('undo').disabled)
    // The tool gives the focus back to its editor a frame later.
    await settle(40)
    // The left side used: the bar names it and shows its state, nothing bold there and nothing to undo.
    await use('left')
    await chooseWord('left')
    expect(label()).toBe('Tools for “Lentil soup” (left)')
    expect(bar().dataset.side).toBe('left')
    expect(tool('bold').getAttribute('aria-pressed')).toBe('false')
    expect(tool('undo').disabled).toBe(true)
    // Its tools work there now, on the left text only.
    await act(async () => tool('italic').click())
    expect(pane('left')!.querySelector('.ProseMirror em')?.textContent).toBe('Lent')
    expect(pane('right')!.querySelector('.ProseMirror em')).toBeNull()
    await settle(40)
    // The text style shows the side's own: a heading on the right, body text on the left.
    await use('right')
    await act(async () => void editorOf('right')!.chain().setTextSelection(2).setHeading({ level: 1 }).run())
    expect(textStyle()).toBe('h1')
    await use('left')
    expect(textStyle()).toBe('p')
  })

  it('NOTES-8 AC-1 a click in the bar keeps the selection in the editor and the side used last', async () => {
    await twoNotes()
    await act(async () => void editorOf('right')!.commands.focus())
    // The editor takes the focus in the next frame; on a slow machine that frame had not come before the check below.
    await until(() => pane('right')!.contains(document.activeElement))
    await chooseWord('right')
    // The press itself takes no focus from the text (the selection stays where it is).
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    tool('underline').dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    // A press anywhere on the bar is no use of a side.
    await act(async () => void bar().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    await act(async () => tool('underline').click())
    expect(pane('right')!.dataset.focused).toBe('true')
    expect(pane('left')!.dataset.focused).toBe('false')
    const { from, to } = editorOf('right')!.state.selection
    expect([from, to]).toEqual([1, 5])
    expect(pane('right')!.contains(document.activeElement)).toBe(true)
    expect(pane('right')!.querySelector('.ProseMirror u')?.textContent).toBe('Milk')
    // The link opens the dialog of the side used last.
    await act(async () => tool('link').click())
    expect($('link-input')).not.toBeNull()
    expect(pane('right')!.dataset.focused).toBe('true')
  })

  it("NOTES-8 AC-1 a sheet's own tools work on its own note, whichever side was used last", async () => {
    await twoNotes()
    expect(pane('right')!.dataset.focused).toBe('true')
    await act(async () => $('note-menu', pane('left')!)!.click())
    await act(async () => $('paper-lined')!.click())
    expect(requests).toContain('PUT /api/notes/soup/paper')
    expect(requests).not.toContain('PUT /api/notes/shop/paper')
    expect($('note-paper', pane('left')!)!.dataset.paper).toBe('lined')
    expect($('note-paper', pane('right')!)!.dataset.paper).toBe('blank')
    // The text width from the left sheet's bar (a matter of this device, every sheet follows).
    await act(async () => $('tool-width', pane('left')!)!.click())
    await act(async () => $('width-wide')!.click())
    expect($('note-page', pane('left')!)!.style.maxWidth).toBe('1100px')
  })

  it('NOTES-13 AC-4 NOTES-8 a note one only reads, used last: the text tools stand there but cannot be used', async () => {
    notes.set('shop', note('shop', 'Saturday shopping', 'garden', { owner: { id: 9, name: 'Lena' }, can_write: false, level: 'read' } as Partial<NoteHead>))
    await twoNotes()
    await until(() => Boolean($('shared-toolbar-read')))
    expect(label()).toBe('Tools for “Saturday shopping” (right)')
    const tools = [...bar().querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-tool]')].filter((one) => one.dataset.testid !== 'tool-more')
    expect(tools.length).toBeGreaterThan(10)
    for (const one of tools) expect(one.disabled).toBe(true)
    expect($('shared-toolbar-read')!.textContent).toBe('Read only')
    // The note's own tools stay: the reader may still widen the text or hide the outline.
    expect($('tool-width', pane('right')!)).not.toBeNull()
    // The left note is the own one: used, its tools can be used again.
    await use('left')
    expect($('shared-toolbar-read')).toBeNull()
    expect(tool('bold').disabled).toBe(false)
  })

  it('NOTES-8 one note alone and a window with the switcher keep the toolbar of each note as before', async () => {
    width = 1400
    await render('/notes/soup')
    expect($('shared-toolbar')).toBeNull()
    const head = $('editor-head')!
    expect(head.contains($('toolbar'))).toBe(true)
    for (const one of ['tool-bold', 'tool-width', 'tool-outline']) expect($(one, head)).not.toBeNull()
    expect($('note-view-tools')).toBeNull()
    // Too narrow for two: one side with the switcher, its own bar.
    await act(async () => openNoteBeside('shop'))
    await idle()
    await act(async () => unmountPage())
    box.remove()
    width = 600
    await render('/notes/shop')
    expect($('side-switch')).not.toBeNull()
    expect($('shared-toolbar')).toBeNull()
    expect($('toolbar', pane('right')!)).not.toBeNull()
  })
})

describe('fifth review (21.11.2026)', () => {
  const made = () => requests.filter((request) => request === 'POST /api/notes').length
  const tabOfNote = (id: string) => $$('tab').find((one) => one.dataset.note === id)
  const titleOf = (side: 'left' | 'right') => pane(side)!.querySelector('[data-testid="note-title"]') as HTMLTextAreaElement
  const plus = async () => {
    await act(async () => $('tab-new')!.click())
    await idle()
  }

  it('NOTES-8 NOTES-3 AC-1 "+" in the row of tabs takes a quite empty new note that is open instead of making another', async () => {
    await render('/folder/garden?note=shop')
    await plus()
    expect(made()).toBe(1)
    const blank = tabsNow().tabs.at(-1)!.note
    expect(tabOfNote(blank)).toBeTruthy()
    expect($$('tab')).toHaveLength(2)
    await act(async () => void (document.activeElement as HTMLElement | null)?.blur())
    // Again, and again: the same note, with the cursor in its title; no second one.
    await plus()
    await plus()
    expect(made()).toBe(1)
    expect($$('tab')).toHaveLength(2)
    expect(document.activeElement).toBe(titleOf('left'))
    expect(pane('left')!.dataset.note).toBe(blank)
    // The empty note on the left, another note beside it used last: "+" brings the left side to the front and goes
    // into its title.
    await act(async () => openNoteBeside('bath'))
    await idle()
    expect(pane('left')!.dataset.note).toBe(blank)
    expect(pane('right')!.dataset.focused).toBe('true')
    await act(async () => void (document.activeElement as HTMLElement | null)?.blur())
    await plus()
    expect(made()).toBe(1)
    expect(pane('left')!.dataset.focused).toBe('true')
    await until(() => document.activeElement === titleOf('left'))
    // Once something is written in it, "+" makes a new note.
    await act(async () => typeTitle(titleOf('left'), 'Seeds'))
    await plus()
    expect(made()).toBe(2)
  })

  it('NOTES-3 EC-4 NOTES-8 a quite empty note thrown away closes its tab by itself, without asking; the tab beside moves up', async () => {
    await render('/folder/garden?note=shop')
    await plus()
    const blank = tabsNow().tabs.at(-1)!.note
    expect(pane('left')!.dataset.note).toBe(blank)
    // Another tab on its side: the empty note goes out of view, the page throws it away, and its tab closes.
    await act(async () => showTab(tabsNow().tabs[0].key))
    await idle()
    await until(() => requests.includes(`POST /api/notes/${blank}/discard`))
    await until(() => !tabOfNote(blank))
    expect($$('tab').map((one) => one.dataset.note)).toEqual(['shop'])
    expect($('leave-dialog')).toBeNull()
    expect(where).toBe('/folder/garden?note=shop')
    // Thrown away by the server only a moment later (its grace after the last connection): the tab closes as soon as
    // its head says the note is gone, never struck through as "Untitled".
    discardLater = true
    await plus()
    const later = tabsNow().tabs.at(-1)!.note
    await act(async () => showTab(tabsNow().tabs[0].key))
    await idle()
    await until(() => requests.includes(`POST /api/notes/${later}/discard`))
    await settle(30)
    expect(tabOfNote(later)).toBeTruthy()
    notes.delete(later)
    await act(async () => refreshMeta([later]))
    await until(() => !tabOfNote(later))
    expect($$('tab').map((one) => one.dataset.note)).toEqual(['shop'])
    // A note left with a title is not thrown away: its tab stays.
    await act(async () => openNoteInNewTab('bath'))
    await idle()
    await act(async () => showTab(tabsNow().tabs[0].key))
    await idle()
    expect(tabOfNote('bath')).toBeTruthy()
  })

  it('NOTES-8 the button that ends side by side says "Show one note only"', async () => {
    await render('/notes/soup')
    await act(async () => openNoteBeside('shop'))
    await idle()
    const end = $('tab-end-split')!
    expect(end.getAttribute('aria-label')).toBe('Show one note only')
    expect(end.getAttribute('title')).toBe('Show one note only')
    expect(i18n.getResource('de', 'translation', 'tabs.endSplit')).toBe('Nur eine Notiz zeigen')
  })

  it('NOTES-3 a long title breaks into further lines in the sheet, never cut off (one note and side by side)', async () => {
    const long = 'Pfannkuchen mit Apfelmus, Zimt und sehr viel Puderzucker obendrauf'
    notes.set('long', note('long', long))
    const doc = new Y.Doc()
    doc.getText('title').insert(0, long)
    rooms.set('long', doc)
    await render('/notes/long')
    const field = titleOf('left')
    expect(field.tagName).toBe('TEXTAREA')
    expect(field.rows).toBe(1)
    expect(field.className).not.toMatch(/\b(truncate|whitespace-nowrap|text-ellipsis)\b/)
    expect(field.className).toMatch(/\bresize-none\b/)
    expect(field.value).toBe(long)
    // Side by side the same.
    await act(async () => openNoteBeside('soup'))
    await idle()
    expect(titleOf('left').tagName).toBe('TEXTAREA')
    expect(titleOf('right').tagName).toBe('TEXTAREA')
    // A line break typed or pasted never goes into the title.
    await act(async () => typeTitle(titleOf('right'), 'Lentil\nsoup'))
    expect(rooms.get('soup')!.getText('title').toString()).toBe('Lentil soup')
  })

  it('NOTES-3 a narrow sheet says only folder, "changed" and saving under the title; the day it was made is in the tooltip', async () => {
    width = 500
    await render('/notes/shop')
    await until(() => Boolean($('note-changed')))
    expect($('note-created')).toBeNull()
    expect($('note-changed')!.getAttribute('title')).toBe(i18n.t('editor.meta.created', { date: new Date('2026-11-14T08:00:00Z').toLocaleString('en') }))
    expect($('note-path')!.textContent).toBe('Garden')
    await until(() => Boolean($('note-saved')))
    // A wide sheet: as before, "created …" in the line, no tooltip.
    await act(async () => unmountPage())
    width = 1400
    box.remove()
    await render('/notes/shop')
    await until(() => Boolean($('note-created')))
    expect($('note-created')!.textContent).toBe(i18n.t('editor.meta.created', { date: new Date('2026-11-14T08:00:00Z').toLocaleDateString('en') }))
    expect($('note-changed')!.hasAttribute('title')).toBe(false)
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
