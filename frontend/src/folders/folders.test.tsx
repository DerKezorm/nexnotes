/**
 * NOTES-4 in the interface: the tree of the sidebar with open and closed per device, counts, symbol and color, the
 * menu, dragging and reordering, "Move …" with greyed places, the trash with "Undo" for ten seconds, the path of a
 * folder page, the inbox with where each note came from, the open folder for new notes, and the keyboard alone.
 *
 * A small stand-in for the server keeps the folders, so that two "devices" (two loads of the page with their own
 * `localStorage`) see the same order and colors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../i18n'
import { registerNoteActions, startNoteDrag } from './actions'
import type { Folder, InboxNote } from './api'
import { FolderTree, InboxEntry } from './FolderTree'
import { FolderPage, InboxPage } from './pages'
import { forgetFolders, indent, refreshFolders, reloadOpenFolders, setCurrentFolder, useCurrentFolder } from './store'
import { hideNotice } from './notice'

// ---- The stand-in server ---------------------------------------------------------------------------------------------

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let folders: Folder[] = []
let inboxNotes: InboxNote[] = []
let refuse: ((call: Call) => { status: number; body: unknown } | undefined) | null = null
const INBOX = 'inbox-1'

function folder(id: string, name: string, parent: string | null = null, extra: Partial<Folder> = {}): Folder {
  return { id, name, parent_id: parent, icon: '', color: '', position: null, count: 0, ...extra }
}

function ordered(): Folder[] {
  return [...folders].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.name.localeCompare(b.name))
}

function answer(call: Call): { status: number; body: unknown } {
  const blocked = refuse?.(call)
  if (blocked) return blocked
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/folders') return { status: 200, body: { inbox: { id: INBOX, count: inboxNotes.length }, folders: ordered() } }
  if (method === 'GET' && path === '/api/folders/inbox') return { status: 200, body: { id: INBOX, notes: inboxNotes } }
  if (method === 'POST' && path === '/api/folders') {
    const made = folder(`new-${folders.length}`, String(body?.name), (body?.parent_id as string) ?? null)
    folders.push(made)
    return { status: 201, body: made }
  }
  if (method === 'POST' && path === '/api/folders/move') {
    for (const id of (body?.folder_ids as string[]) ?? []) folders = folders.map((f) => (f.id === id ? { ...f, parent_id: (body?.target_id as string) ?? null } : f))
    for (const id of (body?.note_ids as string[]) ?? []) inboxNotes = inboxNotes.filter((n) => n.id !== id)
    return { status: 200, body: { folders: 0, notes: 0 } }
  }
  if (method === 'PUT' && path === '/api/folders/order') {
    const ids = body?.ids as string[]
    folders = folders.map((f) => (ids.includes(f.id) ? { ...f, position: ids.indexOf(f.id) } : f))
    return { status: 200, body: [] }
  }
  const one = /^\/api\/folders\/([^/]+)(\/impact|\/restore)?$/.exec(path)
  if (one) {
    const [, id, tail] = one
    if (method === 'GET' && tail === '/impact') return { status: 200, body: { notes: 14, folders: 2, trash_days: 90 } }
    if (method === 'POST' && tail === '/restore') return { status: 200, body: { id, folders: 2, notes: 14 } }
    if (method === 'PATCH') {
      folders = folders.map((f) => (f.id === id ? { ...f, ...(body as Partial<Folder>) } : f))
      return { status: 200, body: folders.find((f) => f.id === id) }
    }
    if (method === 'DELETE') {
      folders = folders.filter((f) => f.id !== id && f.parent_id !== id)
      return { status: 200, body: { id, folders: 2, notes: 14 } }
    }
  }
  return { status: 404, body: { detail: { code: 'not_found', message: 'Not found.' } } }
}

// ---- Rendering -------------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  const { openFolderId, targetFolderId } = useCurrentFolder()
  return <output data-testid="where" data-path={location.pathname} data-open={openFolderId ?? ''} data-target={targetFolderId ?? ''} />
}

async function settle(): Promise<void> {
  for (let i = 0; i < 15; i++) await act(async () => await Promise.resolve())
}

async function render(at = '/'): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <InboxEntry />
        <FolderTree />
        <Routes>
          <Route path="/folder/:id" element={<FolderPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>,
    ),
  )
  await settle()
}

/** Another device: the tree from the server again, and a `localStorage` of its own. */
async function otherDevice(at = '/'): Promise<void> {
  act(() => root.unmount())
  localStorage.clear()
  reloadOpenFolders()
  forgetFolders()
  root = createRoot(box)
  await render(at)
}

const rows = () => [...box.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const row = (name: string) => rows().find((element) => element.querySelector('span[title]')?.getAttribute('title') === name)!
const where = () => box.querySelector<HTMLElement>('[data-testid="where"]')!.dataset
const button = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find((element) => element.textContent?.trim() === text || element.getAttribute('aria-label') === text)!

function click(element: Element) {
  act(() => void (element as HTMLElement).click())
}

function key(element: Element, name: string, extra: KeyboardEventInit = {}) {
  act(() => void element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra })))
}

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => void field.dispatchEvent(new Event('input', { bubbles: true })))
}

/** A drag event as a browser sends it (jsdom has none): with a data transfer and a pointer height. */
function drag(element: Element, kind: 'dragstart' | 'dragover' | 'drop' | 'dragend', transfer: ReturnType<typeof dataTransfer>, clientY = 0): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  act(() => void element.dispatchEvent(event))
  return event
}

function dataTransfer() {
  const data: Record<string, string> = {}
  return {
    data,
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => void (data[type] = value),
    getData: (type: string) => data[type] ?? '',
    get types() {
      return Object.keys(data)
    },
  }
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  refuse = null
  inboxNotes = []
  folders = [
    folder('a', 'Arbeit', null, { color: 'orange', count: 57 }),
    folder('p', 'Projekte', 'a', { color: 'orange', count: 21 }),
    folder('y', '2026', 'p', { count: 14 }),
    folder('h', 'Haushalt', null, { color: 'honey', count: 12 }),
    folder('r', 'Rezepte', null, { color: 'red', icon: 'chef-hat', count: 31 }),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const call = { method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
      calls.push(call)
      const { status, body } = answer(call)
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  localStorage.clear()
  reloadOpenFolders()
  forgetFolders()
  setCurrentFolder(null)
  hideNotice()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  for (const leftover of document.querySelectorAll('[role="menu"], [role="dialog"]')) leftover.remove()
  act(() => hideNotice())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const changes = () => calls.filter((call) => call.method !== 'GET')

// ---- Tests -----------------------------------------------------------------------------------------------------------

describe('the folder tree of the sidebar (NOTES-4)', () => {
  it('NOTES-4 AC-6 AC-10 AC-11 open and closed stay on the device; order and color travel to the other', async () => {
    await render()
    expect(rows().map((element) => element.querySelector('span[title]')!.textContent)).toEqual(['Arbeit', 'Haushalt', 'Rezepte'])
    click(row('Arbeit').querySelector('button[aria-label="Expand"]')!)
    click(row('Projekte').querySelector('button[aria-label="Expand"]')!)
    expect(rows().map((element) => element.getAttribute('aria-level'))).toEqual(['1', '2', '3', '1', '1'])
    expect(JSON.parse(localStorage.getItem('nexnotes.folders.open')!)).toEqual(['a', 'p'])

    // A color and an order made here ...
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('Symbol and color …'))
    await settle()
    click(button('Green'))
    click(button('Star'))
    await settle()
    expect(changes().map((call) => call.body)).toEqual([{ color: 'green' }, { icon: 'star' }])
    await act(async () => {
      folders = folders.map((f) => (f.parent_id === null ? { ...f, position: ['r', 'h', 'a'].indexOf(f.id) } : f))
    })

    // ... are there on the other device; which folders are open is not.
    await otherDevice()
    expect(rows().map((element) => element.querySelector('span[title]')!.textContent)).toEqual(['Rezepte', 'Haushalt', 'Arbeit'])
    expect(rows()).toHaveLength(3)
    const mark = row('Haushalt').querySelector('svg.lucide-star') as SVGElement
    expect(mark.style.color).toBe('rgb(74, 222, 128)')
  })

  it('NOTES-4 AC-8 beside every folder stands the number of its own notes, and the inbox has its own', async () => {
    inboxNotes = [{ id: 'n1', title: 'Kompost', preview: '', origin: 'share:Safari', title_check: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]
    await render()
    expect(row('Arbeit').getAttribute('aria-label')).toBe('Arbeit, 57 notes')
    expect(row('Haushalt').textContent).toContain('12')
    expect(box.querySelector('[data-testid="sidebar-inbox"]')!.textContent).toBe('Inbox1')
  })

  it('NOTES-4 EC-3 fifteen levels stay readable: names cut short with the whole name as a tooltip', async () => {
    const long = 'A folder name that is far too long to fit into the sidebar at all'
    folders = Array.from({ length: 15 }, (_, level) => folder(`l${level}`, level === 14 ? long : `Level ${level + 1}`, level ? `l${level - 1}` : null))
    localStorage.setItem('nexnotes.folders.open', JSON.stringify(folders.map((f) => f.id)))
    reloadOpenFolders()
    await render()
    expect(rows()).toHaveLength(15)
    const deepest = row(long)
    expect(deepest.getAttribute('aria-level')).toBe('15')
    expect(deepest.querySelector('span[title]')!.className).toContain('truncate')
    // The indent of the fifteenth level leaves more than 100 of the 260 pixels for the name.
    expect(parseInt(deepest.style.paddingLeft)).toBe(indent(14))
    expect(indent(14)).toBeLessThan(125)
  })

  it('NOTES-4 AC-12 the menu offers all seven entries; share and export wait for their features', async () => {
    await render()
    act(() => void row('Haushalt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    const menu = document.querySelector('[role="menu"]')!
    const entries = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(entries.map((entry) => entry.firstElementChild!.textContent)).toEqual([
      'New subfolder', 'Rename', 'Symbol and color …', 'Move …', 'Share …', 'Export', 'Move to trash',
    ])
    expect(entries.filter((entry) => entry.getAttribute('aria-disabled') === 'true').map((entry) => entry.firstElementChild!.textContent)).toEqual(['Share …', 'Export'])
    click(entries[4])
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('NOTES-4 AC-1 AC-4 EC-2 a new subfolder and a rename go through a name; a name already there is said', async () => {
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('New subfolder'))
    type(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Garten')
    click(button('Create'))
    await settle()
    expect(changes().at(-1)).toMatchObject({ method: 'POST', path: '/api/folders', body: { name: 'Garten', parent_id: 'h', icon: '', color: '' } })
    // The parent opens, so the new one shows.
    expect(row('Garten').getAttribute('aria-level')).toBe('2')

    refuse = (call) => (call.method === 'PATCH' ? { status: 409, body: { detail: { code: 'folder_name_taken', message: '', name: 'Rezepte' } } } : undefined)
    click(row('Arbeit').querySelector('button[aria-label="Menu of Arbeit"]')!)
    click(button('Rename'))
    type(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'rezepte')
    click(button('Save'))
    await settle()
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('There is already a folder “Rezepte” here.')
    refuse = null
    click(button('Save'))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(row('rezepte')).toBeTruthy()
  })
})

describe('NOTES-4 AC-10 symbol and color when making a folder', () => {
  it('NOTES-4 AC-10 the dialog "New folder" chooses symbol and color at once, from some 250 symbols in groups', async () => {
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('New subfolder'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    type(dialog.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!, 'Bello')
    const grid = dialog.querySelector<HTMLElement>('[data-testid="symbol-grid"]')!
    const symbols = () => [...grid.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(symbols().length).toBeGreaterThanOrEqual(250)
    expect(grid.textContent).toContain('Animals')
    // Searched in German on an English page: "hund" finds the dog by its German search word.
    type(dialog.querySelector<HTMLInputElement>('[data-testid="symbol-search"]')!, 'hund')
    expect(symbols().map((one) => one.getAttribute('aria-label'))).toEqual(['Dog'])
    click(symbols()[0])
    click(button('Sky', dialog))
    // The preview shows the choice at once: the dog in sky blue.
    const preview = dialog.querySelector<HTMLElement>('[data-testid="look-preview"] svg')!
    expect(preview.getAttribute('class')).toContain('lucide-dog')
    expect(preview.style.color).toBe('rgb(56, 189, 248)')
    click(button('Create', dialog))
    await settle()
    expect(changes().at(-1)).toMatchObject({ method: 'POST', path: '/api/folders', body: { name: 'Bello', parent_id: 'h', icon: 'dog', color: 'sky' } })
  })

  it('NOTES-4 AC-10 the symbols are one stop for the keyboard, the arrow keys move inside, nothing found says so', async () => {
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('New subfolder'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const grid = dialog.querySelector<HTMLElement>('[data-testid="symbol-grid"]')!
    const stops = [...grid.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((one) => one.tabIndex === 0)
    expect(stops).toHaveLength(1)
    act(() => stops[0].focus())
    key(stops[0], 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-symbol')).toBe(grid.querySelectorAll('[role="radio"]')[1].getAttribute('data-symbol'))
    key(document.activeElement!, 'End')
    expect(document.activeElement).toBe([...grid.querySelectorAll('[role="radio"]')].at(-1))
    key(document.activeElement!, 'Home')
    expect(document.activeElement).toBe(grid.querySelector('[role="radio"]'))
    type(dialog.querySelector<HTMLInputElement>('[data-testid="symbol-search"]')!, 'xylophonzz')
    expect(grid.textContent).toBe('No symbol found.')
  })
})

describe('moving (NOTES-4 AC-3, AC-11, EC-1)', () => {
  it('NOTES-4 AC-3 a note dragged from a list onto a folder lands there', async () => {
    await render()
    const transfer = dataTransfer()
    const source = document.createElement('div')
    source.draggable = true
    source.addEventListener('dragstart', (event) => startNoteDrag(event as unknown as React.DragEvent, ['n1', 'n2']))
    box.append(source)
    drag(source, 'dragstart', transfer)
    const over = drag(row('Rezepte'), 'dragover', transfer)
    expect(over.defaultPrevented).toBe(true)
    drag(row('Rezepte'), 'drop', transfer)
    await settle()
    expect(changes()).toEqual([{ method: 'POST', path: '/api/folders/move', body: { target_id: 'r', folder_ids: [], note_ids: ['n1', 'n2'] } }])
  })

  it('NOTES-4 AC-3 EC-1 a folder dragged onto another moves into it, never into itself or below itself', async () => {
    localStorage.setItem('nexnotes.folders.open', '["a","p"]')
    reloadOpenFolders()
    await render()
    const transfer = dataTransfer()
    drag(row('Arbeit'), 'dragstart', transfer)
    for (const inside of ['Arbeit', 'Projekte', '2026']) expect(drag(row(inside), 'dragover', transfer, 16).defaultPrevented).toBe(false)
    expect(drag(row('Haushalt'), 'dragover', transfer, 16).defaultPrevented).toBe(true)
    drag(row('Haushalt'), 'drop', transfer, 16)
    await settle()
    expect(changes()).toEqual([{ method: 'POST', path: '/api/folders/move', body: { target_id: 'h', folder_ids: ['a'], note_ids: [] } }])
  })

  it('NOTES-4 AC-11 a folder dragged between two others takes that place, and the order is sent', async () => {
    await render()
    const transfer = dataTransfer()
    for (const element of rows()) element.getBoundingClientRect = () => ({ top: 100, height: 32, bottom: 132, left: 0, right: 260, width: 260, x: 0, y: 100, toJSON: () => ({}) })
    drag(row('Rezepte'), 'dragstart', transfer)
    // The upper quarter of "Arbeit": before it.
    expect(drag(row('Arbeit'), 'dragover', transfer, 103).defaultPrevented).toBe(true)
    expect(row('Arbeit').querySelector('.top-0')).not.toBeNull()
    drag(row('Arbeit'), 'drop', transfer, 103)
    await settle()
    expect(changes()).toEqual([{ method: 'PUT', path: '/api/folders/order', body: { parent_id: null, ids: ['r', 'a', 'h'] } }])
    expect(rows().map((element) => element.querySelector('span[title]')!.textContent)).toEqual(['Rezepte', 'Arbeit', 'Haushalt'])
  })

  it('NOTES-4 AC-3 EC-1 "Move …" finds places by search and greys the folder itself and what lies in it', async () => {
    localStorage.setItem('nexnotes.folders.open', '["a"]')
    reloadOpenFolders()
    await render()
    click(row('Projekte').querySelector('button[aria-label="Menu of Projekte"]')!)
    click(button('Move …'))
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Move “Projekte”')
    expect(dialog.textContent).toContain('With 2 subfolders and 14 notes. Everything moves along.')
    const option = (name: string) => [...dialog.querySelectorAll('[role="option"]')].find((element) => element.querySelector('.truncate')?.textContent === name)!
    expect(option('Projekte').getAttribute('aria-disabled')).toBe('true')
    expect(option('Projekte').textContent).toContain('the folder itself')
    expect(option('2026').getAttribute('aria-disabled')).toBe('true')
    expect(option('2026').textContent).toContain('inside it')
    expect(option('Arbeit').textContent).toContain('here now')
    click(option('2026'))
    expect(button('Choose a place', dialog)).toBeTruthy()

    type(dialog.querySelector<HTMLInputElement>('input')!, 'rez')
    expect([...dialog.querySelectorAll('[role="option"] .truncate')].map((element) => element.textContent)).toEqual(['Rezepte'])
    const search = dialog.querySelector<HTMLInputElement>('input')!
    key(search, 'ArrowDown')
    key(search, 'Enter')
    await settle()
    expect(changes()).toEqual([{ method: 'POST', path: '/api/folders/move', body: { target_id: 'r', folder_ids: ['p'], note_ids: [] } }])
  })
})

describe('the trash (NOTES-4 AC-5, EC-10)', () => {
  it('NOTES-4 AC-5 the question counts notes and subfolders and names 90 days; "Undo" stays ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render('/folder/a')
    click(row('Arbeit').querySelector('button[aria-label="Menu of Arbeit"]')!)
    click(button('Move to trash'))
    await settle()
    expect(document.querySelector('[data-testid="trash-question"]')!.textContent).toBe(
      'With 2 subfolders and 14 notes. Everything stays in the trash for 90 days and can be brought back from there.',
    )
    click(button('Move to trash', document.querySelector('[role="dialog"]')!))
    await settle()
    expect(changes().map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /api/folders/a'])
    // The open folder is gone: the page goes to the start.
    expect(where().path).toBe('/')
    const notice = () => document.querySelector('[data-testid="folder-notice"]')
    expect(notice()!.textContent).toBe('“Arbeit” with 14 notes moved to the trash.Undo')

    // Ten seconds by the spec, written out: a shorter notice must not pass.
    await act(async () => void vi.advanceTimersByTime(9_900))
    click(button('Undo', notice()!))
    await settle()
    expect(changes().map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /api/folders/a', 'POST /api/folders/a/restore'])
    expect(notice()!.textContent).toBe('“Arbeit” is back.')
  })

  it('NOTES-4 AC-5 EC-10 after ten seconds the notice is gone; the way back is the trash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('Move to trash'))
    await settle()
    click(button('Move to trash', document.querySelector('[role="dialog"]')!))
    await settle()
    expect(document.querySelector('[data-testid="folder-notice"]')).not.toBeNull()
    await act(async () => void vi.advanceTimersByTime(9_900))
    expect(document.querySelector('[data-testid="folder-notice"]')).not.toBeNull()
    await act(async () => void vi.advanceTimersByTime(100))
    expect(document.querySelector('[data-testid="folder-notice"]')).toBeNull()
  })
})

describe('the pages (NOTES-4 AC-7, AC-9, AC-13, AC-14, EC-5, EC-6)', () => {
  it('NOTES-4 AC-13 a folder shows its path at the top, every step above it a link', async () => {
    await render('/folder/y')
    const path = box.querySelector('nav[aria-label="Path"]')!
    expect([...path.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Arbeit', '/folder/a'],
      ['Projekte', '/folder/p'],
    ])
    expect(path.querySelector('[aria-current="page"]')!.textContent).toBe('2026')
    // Opening it opened its parents in the sidebar.
    expect(row('2026').getAttribute('aria-selected')).toBe('true')
    click(path.querySelector('a')!)
    await settle()
    expect(where().path).toBe('/folder/a')
  })

  it('NOTES-4 AC-9 a new note goes into the open folder, anywhere else into the inbox', async () => {
    await render('/folder/h')
    expect(where().open).toBe('h')
    expect(where().target).toBe('h')
    click(box.querySelector('nav[aria-label="Path"] [aria-current]')!)
    act(() => root.unmount())
    root = createRoot(box)
    await render('/all-notes')
    expect(where().open).toBe('')
    expect(where().target).toBe(INBOX)
  })

  it('NOTES-4 EC-5 an empty folder invites with "New note in …" and takes notes dragged onto it', async () => {
    const started: string[] = []
    registerNoteActions({ newNote: (id) => started.push(id) })
    folders.push(folder('g', 'Garten', 'h'))
    await render('/folder/g')
    const empty = box.querySelector('[data-testid="folder-empty"]')!
    expect(empty.textContent).toContain('No notes in “Garten” yet')
    click(button('New note in “Garten”', empty))
    expect(started).toEqual(['g'])
    // A folder with notes shows the list of notes instead.
    act(() => root.unmount())
    root = createRoot(box)
    await render('/folder/h')
    expect(box.querySelector('[data-testid="note-list"]')!.getAttribute('data-folder')).toBe('h')
  })

  it('NOTES-4 AC-7 AC-14 the inbox says where each note came from and files it into a folder', async () => {
    const now = new Date().toISOString()
    inboxNotes = [
      { id: 'n1', title: 'Kompost', preview: 'Schichten', origin: 'share:Safari', title_check: true, created_at: now, updated_at: now },
      { id: 'n2', title: 'Zahnarzt', preview: '', origin: 'dictation', title_check: false, created_at: now, updated_at: now },
      { id: 'n3', title: '', preview: 'Nudeln', origin: 'mcp:Desktop', title_check: false, created_at: now, updated_at: now },
    ]
    await render('/inbox')
    expect(where().target).toBe(INBOX)
    const cards = [...box.querySelectorAll('[data-note]')]
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Shared from Safari'),
      expect.stringContaining('Dictation'),
      expect.stringContaining('Via MCP from “Desktop”'),
    ])
    expect(cards[0].textContent).toContain('Check title')
    expect(cards[2].textContent).toContain('Untitled')

    click(button('File', cards[0]))
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('File “Kompost”')
    expect(dialog.querySelector('[role="option"]')!.textContent).toContain('Inbox')
    click([...dialog.querySelectorAll('[role="option"]')].find((element) => element.textContent?.includes('Rezepte'))!)
    click(button('Move to “Rezepte”', dialog))
    await settle()
    expect(changes()).toEqual([{ method: 'POST', path: '/api/folders/move', body: { target_id: 'r', folder_ids: [], note_ids: ['n1'] } }])
    expect(box.querySelectorAll('[data-note]')).toHaveLength(2)
  })

  it('NOTES-4 EC-6 an empty inbox explains what it is for', async () => {
    await render('/inbox')
    expect(box.querySelector('[data-testid="inbox-empty"]')!.textContent).toContain('Whatever you capture quickly lands here')
  })

  it('NOTES-4 AC-7 the inbox is not among the folders and opens as its own page', async () => {
    await render(`/folder/${INBOX}`)
    expect(where().path).toBe('/inbox')
    expect(rows().some((element) => element.dataset.folder === INBOX)).toBe(false)
  })
})

describe('the keyboard alone (NOTES-4 EC-11)', () => {
  it('NOTES-4 EC-11 arrows move, open and close, Enter opens, Shift+F10 brings the menu, and Move works from there', async () => {
    await render()
    const first = row('Arbeit')
    expect(first.tabIndex).toBe(0)
    expect(rows().filter((element) => element.tabIndex === 0)).toHaveLength(1)
    act(() => first.focus())
    key(first, 'ArrowRight')
    expect(first.getAttribute('aria-expanded')).toBe('true')
    key(first, 'ArrowRight')
    expect(document.activeElement).toBe(row('Projekte'))
    key(row('Projekte'), 'ArrowLeft')
    expect(document.activeElement).toBe(row('Arbeit'))
    key(row('Arbeit'), 'ArrowLeft')
    expect(row('Arbeit').getAttribute('aria-expanded')).toBe('false')
    key(row('Arbeit'), 'ArrowDown')
    expect(document.activeElement).toBe(row('Haushalt'))
    key(row('Haushalt'), 'Enter')
    await settle()
    expect(where().path).toBe('/folder/h')

    key(row('Haushalt'), 'F10', { shiftKey: true })
    const menu = document.querySelector('[role="menu"]')!
    expect(document.activeElement?.textContent).toContain('New subfolder')
    for (let i = 0; i < 3; i++) key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Move …')
    key(menu, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(row('Haushalt'))
    key(row('Haushalt'), 'F10', { shiftKey: true })
    for (let i = 0; i < 3; i++) key(document.activeElement!, 'ArrowDown')
    act(() => (document.activeElement as HTMLElement).click())
    await settle()
    const search = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(document.activeElement).toBe(search)
    key(search, 'ArrowDown')
    key(search, 'Enter')
    await settle()
    expect(changes().at(-1)).toEqual({ method: 'POST', path: '/api/folders/move', body: { target_id: null, folder_ids: ['h'], note_ids: [] } })
  })

  it('NOTES-4 EC-11 F2 renames and Delete asks before the trash', async () => {
    await render()
    act(() => row('Rezepte').focus())
    key(row('Rezepte'), 'F2')
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Rename')
    key(document.querySelector('[role="dialog"] input')!, 'Escape')
    act(() => row('Rezepte').focus())
    key(row('Rezepte'), 'Delete')
    await settle()
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Move “Rezepte” to the trash?')
    expect(changes()).toEqual([])
  })
})

describe('the tree follows other devices', () => {
  it('NOTES-4 AC-10 AC-11 asks again when the window comes back to the front', async () => {
    await render()
    folders = folders.map((f) => (f.id === 'h' ? { ...f, name: 'Zuhause', color: 'blue' } : f))
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await settle()
    expect(row('Zuhause')).toBeTruthy()
    await refreshFolders()
  })
})
