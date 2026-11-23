/**
 * NOTES-4 in the interface: the tree of the sidebar with open and closed per device, counts, symbol and color, the
 * menu, dragging and reordering, "Move …" with greyed places, the trash with "Undo" for ten seconds, the path of a
 * folder page, the inbox with where each note came from, the open folder for new notes, and the keyboard alone.
 *
 * A small stand-in for the server keeps the folders, so that two "devices" (two loads of the page with their own
 * `localStorage`) see the same order and colors.
 */
import { contrast, readableColor } from '../lib/color'
import { forgetPrefs } from '../lib/devicePref'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../i18n'
import { registerNoteActions, startNoteDrag } from './actions'
import type { Folder, InboxNote } from './api'
import { FolderTree } from './FolderTree'
import { FolderPage, InboxPage } from './pages'
import { QuickTiles } from './QuickTiles'
import { TILE_COLORS, TITLE_CHECK_COLORS } from './tileColors'
import { forgetFolders, indent, refreshFolders, reloadOpenFolders, setCurrentFolder, useCurrentFolder, useShownFolder } from './store'
import { forgetListLook, saveListLook } from '../notes/list/look'
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
  if (method === 'GET' && path === '/api/folders') {
    const places = { all: 40, shared: 3, inbox_title_check: inboxNotes.filter((note) => note.title_check).length }
    return { status: 200, body: { inbox: { id: INBOX, count: inboxNotes.length }, folders: ordered(), places } }
  }
  if (method === 'GET' && path === '/api/folders/inbox') return { status: 200, body: { id: INBOX, notes: inboxNotes } }
  if (method === 'PUT' && path === '/api/me/list-look') return { status: 200, body: { list_style: body?.style ?? 'list', list_hints: body?.hints ?? true } }
  // The inbox is a list like every other (`/api/note-list` with its id).
  if (method === 'GET' && path.startsWith('/api/note-list/stamp')) return { status: 200, body: { stamp: inboxNotes.map((note) => note.id + note.title_check).join() } }
  if (method === 'GET' && path.startsWith(`/api/note-list?folder_id=${INBOX}`)) {
    const items = inboxNotes.map((note) => ({ icon: '', color: '', ...note, folder_id: INBOX, pinned: false, tasks: null }))
    return { status: 200, body: { key: INBOX, view: { mode: 'list', sort: 'updated', direction: 'desc', grouped: false }, counts: { own: items.length, shared: 0 }, items } }
  }
  const titleOk = /^\/api\/notes\/([^/]+)\/title\/ok$/.exec(path)
  if (method === 'POST' && titleOk) {
    inboxNotes = inboxNotes.map((note) => (note.id === titleOk[1] ? { ...note, title_check: false } : note))
    return { status: 200, body: { id: titleOk[1] } }
  }
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

function ShownFolder() {
  const { pathname } = useLocation()
  const folder = /^\/folder\/([^/]+)$/.exec(pathname)?.[1] ?? (pathname === '/inbox' ? 'inbox' : null)
  useShownFolder(folder)
  return <Outlet />
}

async function render(at = '/'): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <QuickTiles />
        <FolderTree />
        <Routes>
          {/* As the notes' workspace: the folder of the list on show is the open one. */}
          <Route element={<ShownFolder />}>
            <Route path="/folder/:id" element={<FolderPage />} />
            <Route path="/inbox" element={<InboxPage />} />
          </Route>
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
  forgetPrefs()
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
  forgetListLook()
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
    expect(row('Haushalt').getAttribute('aria-label')).toBe('Haushalt, 12 notes')
    expect(row('Haushalt').textContent).toContain('12')
    const inbox = box.querySelector('[data-testid="sidebar-inbox"]')!
    expect(inbox.querySelector('[data-testid="tile-count"]')!.textContent).toBe('1')
    expect(inbox.textContent).toContain('Inbox')
  })

  it('NOTES-4 AC-8 zwei Zahlen: a folder with subfolders shows its own notes and all below in brackets, „3 (12)“', async () => {
    // Arbeit 57, in it Projekte 21, in that 2026 14, in that Entwürfe 2; Haushalt 12 without subfolders.
    folders.push(folder('d', 'Entwürfe', 'y', { count: 2 }))
    await render()
    const number = (name: string) => row(name).querySelector('span[aria-hidden].tabular-nums')!.textContent
    expect(number('Arbeit')).toBe('57 (94)')
    expect(row('Arbeit').getAttribute('aria-label')).toBe('Arbeit, 57 notes, 94 including subfolders')
    expect(number('Haushalt')).toBe('12')
    click(row('Arbeit').querySelector('button[aria-label="Expand"]')!)
    click(row('Projekte').querySelector('button[aria-label="Expand"]')!)
    click(row('2026').querySelector('button[aria-label="Expand"]')!)
    expect(number('Projekte')).toBe('21 (37)')
    expect(number('2026')).toBe('14 (16)')
    expect(number('Entwürfe')).toBe('2')
    // A folder whose subfolders hold nothing still shows both numbers, as on the iPhone.
    folders.push(folder('e', 'Leer', 'h'))
    await act(async () => await refreshFolders())
    expect(number('Haushalt')).toBe('12 (12)')
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

  it('NOTES-4 AC-12 NOTES-13 AC-1 NOTES-14 AC-1 the menu offers all eight entries; share opens the share dialog, notifications and export are there (NOTES-17)', async () => {
    await render()
    act(() => void row('Haushalt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    const menu = document.querySelector('[role="menu"]')!
    const entries = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(entries.map((entry) => entry.firstElementChild!.textContent)).toEqual([
      'New subfolder', 'Rename', 'Symbol and color …', 'Move …', 'Share …', 'Notifications …', 'Export', 'Move to trash',
    ])
    expect(entries.filter((entry) => entry.getAttribute('aria-disabled') === 'true')).toEqual([])
    click(entries[4])
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[role="dialog"][aria-label="Share “Haushalt”"]')).not.toBeNull()
  })

  it('NOTES-17 AC-4 "Export" in the menu of a folder opens the export with this folder chosen', async () => {
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('Export'))
    await settle()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Export"]')!
    expect(dialog).not.toBeNull()
    const chosen = dialog.querySelector<HTMLInputElement>('input[type="radio"]:checked')!
    expect(chosen.closest('label')!.textContent).toContain('Folder “Haushalt” as ZIP')
    // From a folder there is no note to export: the folder and everything.
    expect(dialog.querySelectorAll('input[type="radio"]').length).toBe(2)
    expect(calls.some((call) => call.method === 'GET' && call.path === '/api/export/estimate?folder_id=h')).toBe(true)
  })

  it('NOTES-4 AC-1 AC-4 EC-2 a new subfolder and a rename go through a name; a name already there is said', async () => {
    await render()
    click(row('Haushalt').querySelector('button[aria-label="Menu of Haushalt"]')!)
    click(button('New subfolder'))
    type(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Garten')
    click(button('Create'))
    await settle()
    expect(changes().at(-1)).toMatchObject({ method: 'POST', path: '/api/folders', body: { name: 'Garten', parent_id: 'h', icon: 'folder', color: '' } })
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
    // A new folder starts with the folder symbol chosen: that is the stop, the arrow goes to the one after it.
    expect(stops[0].getAttribute('data-symbol')).toBe('folder')
    const radios = [...grid.querySelectorAll('[role="radio"]')]
    act(() => stops[0].focus())
    key(stops[0], 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-symbol')).toBe(radios[radios.indexOf(stops[0]) + 1].getAttribute('data-symbol'))
    key(document.activeElement!, 'End')
    expect(document.activeElement).toBe([...grid.querySelectorAll('[role="radio"]')].at(-1))
    key(document.activeElement!, 'Home')
    expect(document.activeElement).toBe(grid.querySelector('[role="radio"]'))
    type(dialog.querySelector<HTMLInputElement>('[data-testid="symbol-search"]')!, 'xylophonzz')
    expect(grid.textContent).toBe('No symbol found.')
  })
})

describe('NOTES-4 AC-10 a color of its own', () => {
  async function styleOf(name: string) {
    await render()
    click(row(name).querySelector(`button[aria-label="Menu of ${name}"]`)!)
    click(button('Symbol and color …'))
    await settle()
    return document.querySelector<HTMLElement>('[role="dialog"]')!
  }
  const preview = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>('[data-testid="look-preview"] svg')!

  it('NOTES-4 AC-10 the chosen color carries a check mark, focus alone does not; the preview shows the choice', async () => {
    const dialog = await styleOf('Haushalt')
    const chosen = [...dialog.querySelectorAll('[aria-pressed="true"][data-color]')]
    expect(chosen.map((one) => one.getAttribute('aria-label'))).toEqual(['Honey'])
    expect(dialog.querySelectorAll('[data-testid="color-chosen"]')).toHaveLength(1)
    expect(preview(dialog).style.color).toBe('rgb(242, 193, 78)')
    // Focus on another color is no choice: no check mark, the preview stays.
    act(() => button('Green', dialog).focus())
    expect(button('Green', dialog).getAttribute('aria-pressed')).toBe('false')
    expect(button('Green', dialog).querySelector('[data-testid="color-chosen"]')).toBeNull()
    click(button('Green', dialog))
    await settle()
    expect(preview(dialog).style.color).toBe('rgb(74, 222, 128)')
    expect(button('Green', dialog).querySelector('[data-testid="color-chosen"]')).not.toBeNull()
  })

  it('NOTES-4 AC-10 an own color as #rrggbb or from the picker is saved, shown readable and kept at hand', async () => {
    const dialog = await styleOf('Haushalt')
    const hex = dialog.querySelector<HTMLInputElement>('[data-testid="color-hex"]')!
    // Not a color: said at the field, nothing sent.
    type(hex, '#fff')
    key(hex, 'Enter')
    await settle()
    expect(dialog.querySelector('#color-hex-wrong')!.textContent).toBe('Enter the color as #rrggbb, for example #1e3a8a.')
    expect(changes()).toEqual([])
    type(hex, '#1E3A8A')
    key(hex, 'Enter')
    await settle()
    expect(changes().map((call) => call.body)).toEqual([{ color: '#1e3a8a' }])
    // The preview follows at once, lighter than the dark blue so that it reads on dark backgrounds too.
    const shown = readableColor('#1e3a8a')
    expect(shown).not.toBe('#1e3a8a')
    const rgb = (value: string) => `rgb(${[1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)).join(', ')})`
    expect(preview(dialog).style.color).toBe(rgb(shown))
    // The system's picker: its result counts when it closes.
    const picker = dialog.querySelector<HTMLInputElement>('[data-testid="color-picker"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(picker, '#c81e1e')
    act(() => void picker.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(changes().map((call) => call.body)).toEqual([{ color: '#1e3a8a' }, { color: '#c81e1e' }])
    expect(preview(dialog).style.color).toBe('rgb(200, 30, 30)')
    // Both own colors stay at hand, the last one first, and one click takes one again.
    const own = [...dialog.querySelectorAll<HTMLElement>('[data-color^="#"]')].filter((one) => one.getAttribute('aria-label')!.startsWith('Own color'))
    expect(own.map((one) => one.dataset.color)).toEqual(['#c81e1e', '#1e3a8a'])
    click(own[1])
    await settle()
    expect(changes().at(-1)!.body).toEqual({ color: '#1e3a8a' })
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

  it('NOTES-6 Unterordner über den Notizen: the direct subfolders stand above the notes with both numbers, open and have their menu', async () => {
    const now = new Date().toISOString()
    folders = folders.map((f) => (f.id === 'a' ? { ...f, count: 2 } : f))
    folders.push(folder('q', 'Quartal', 'a', { color: 'blue', count: 3 }))
    const notes = ['n1', 'n2'].map((id) => ({ id, title: `Note ${id}`, preview: '', origin: '', title_check: false, created_at: now, updated_at: now, icon: '', color: '', folder_id: 'a', pinned: false, tasks: null }))
    refuse = ({ method, path }) =>
      method === 'GET' && path.startsWith('/api/note-list?folder_id=a')
        ? { status: 200, body: { key: 'a', view: { mode: 'list', sort: 'updated', direction: 'desc', grouped: false }, counts: { own: 2, shared: 0 }, items: notes } }
        : undefined
    await render('/folder/a')
    const section = box.querySelector<HTMLElement>('[data-testid="subfolders"]')!
    expect(section.querySelector('h2')!.textContent).toBe('Folders')
    const subfolders = [...section.querySelectorAll<HTMLElement>('[data-testid="subfolder"]')]
    // Only the direct ones (not 2026 inside Projekte), in the sidebar's order, with symbol, name and both numbers.
    expect(subfolders.map((item) => [item.querySelector('span[title]')!.textContent, item.querySelector('[data-testid="subfolder-count"]')!.textContent])).toEqual([
      ['Projekte', '21 (35)'],
      ['Quartal', '3'],
    ])
    expect(subfolders[0].querySelector('a')!.getAttribute('aria-label')).toBe('Projekte, 21 notes, 35 including subfolders')
    expect((subfolders[1].querySelector('svg[data-symbol]') as SVGElement).style.color).not.toBe('')
    // Under the head and above the notes; the head counts the same way.
    const firstNote = box.querySelector('[data-testid="note-list"] a[href*="n1"]')!
    expect(section.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(box.querySelector('[data-testid="list-head"]')!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(box.querySelector('[data-testid="list-counts"]')!.textContent).toBe('2 (40) notes')
    // "…" brings the folder's menu, as in the sidebar.
    click(button('Menu of Quartal', section))
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Rename')
    key(menu.querySelector('[role="menuitem"]') ?? menu, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // A click opens the subfolder.
    click(subfolders[0].querySelector('a')!)
    await settle()
    expect(where().path).toBe('/folder/p')
  })

  it('NOTES-6 Unterordner über den Notizen: only subfolders give a small line instead of the empty state; neither keeps it', async () => {
    folders.push(folder('e', 'Leer', null), folder('k', 'Kind', 'e', { count: 3 }))
    refuse = ({ method, path }) =>
      method === 'GET' && path.startsWith('/api/note-list?folder_id=e')
        ? { status: 200, body: { key: 'e', view: { mode: 'list', sort: 'updated', direction: 'desc', grouped: false }, counts: { own: 0, shared: 0 }, items: [] } }
        : undefined
    await render('/folder/e')
    expect(box.querySelector('[data-testid="folder-empty"]')).toBeNull()
    expect(box.querySelector('[data-testid="list-empty"]')).toBeNull()
    expect(box.querySelector('[data-testid="subfolder-count"]')!.textContent).toBe('3')
    expect(box.querySelector('[data-testid="folder-no-notes"]')!.textContent).toBe('No notes directly in “Leer”')
    expect(box.querySelector('[data-testid="list-counts"]')!.textContent).toBe('0 (3) notes')
    // A folder with neither subfolders nor notes keeps the empty state of NOTES-6 EC-1, without the section.
    folders = folders.map((f) => (f.id === 'k' ? { ...f, count: 0 } : f))
    act(() => root.unmount())
    forgetFolders()
    root = createRoot(box)
    await render('/folder/k')
    expect(box.querySelector('[data-testid="folder-empty"]')!.textContent).toContain('No notes in “Kind” yet')
    expect(box.querySelector('[data-testid="subfolders"]')).toBeNull()
    // The inbox has no section of subfolders.
    act(() => root.unmount())
    root = createRoot(box)
    await render('/inbox')
    expect(box.querySelector('[data-testid="inbox-page"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="subfolders"]')).toBeNull()
  })

  it('NOTES-4 AC-7 AC-14 the inbox says where each note came from and files it into a folder', async () => {
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    inboxNotes = [
      { id: 'n1', title: 'Kompost', preview: 'Schichten', origin: 'share:Safari', title_check: true, created_at: at(1), updated_at: at(1) },
      { id: 'n2', title: 'Zahnarzt', preview: '', origin: 'dictation', title_check: false, created_at: at(2), updated_at: at(2) },
      { id: 'n3', title: '', preview: 'Nudeln', origin: 'mcp:Desktop', title_check: false, created_at: at(3), updated_at: at(3) },
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

  it('NOTES-4 AC-7 NOTES-3 AC-18 a note of the inbox shows its symbol in its colour; without one, where it came from', async () => {
    let minutes = 0
    const card = (id: string, origin: string, look: { icon?: string; color?: string } = {}): InboxNote => {
      const at = new Date(Date.now() - ++minutes * 60_000).toISOString()
      return { id, title: id, preview: '', origin, title_check: false, created_at: at, updated_at: at, icon: '', color: '', ...look }
    }
    inboxNotes = [
      card('Trip', 'share:Safari', { icon: 'plane', color: 'teal' }),
      card('Shared', 'share:Safari'),
      card('Spoken', 'dictation'),
      card('Asked', 'mcp:Desktop'),
      card('Quick', 'shortcut'),
      card('Deck', 'nexdeck'),
      card('Typed', '', { color: 'rose' }),
    ]
    await render('/inbox')
    const notes = [...box.querySelectorAll<HTMLElement>('[data-note]')]
    expect(notes).toHaveLength(7)
    // With a symbol: the symbol in the note's colour, no sign of the origin.
    const symbol = notes[0].querySelector<HTMLElement>('[data-testid="note-icon"]')!
    expect(symbol.dataset.icon).toBe('plane')
    expect((symbol.firstElementChild as HTMLElement).style.color).not.toBe('currentcolor')
    expect(notes[0].querySelector('[data-testid="inbox-origin-icon"]')).toBeNull()
    // Without: a quiet sign of the origin, never the inbox's tray again.
    expect(notes.slice(1).map((note) => note.querySelector<HTMLElement>('[data-testid="inbox-origin-icon"]')?.dataset.origin)).toEqual(['share', 'dictation', 'mcp', 'shortcut', 'nexdeck', 'here'])
    expect(box.querySelector('[data-note] .lucide-inbox')).toBeNull()
    const texts = notes.map((element) => element.textContent)
    expect(texts[4]).toContain('Via a shortcut')
    expect(texts[5]).toContain('From nexdeck')
    expect(texts[6]).toContain('Created here')
    // "File" names the note with its symbol too.
    click(button('File', notes[0]))
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2 [data-testid="note-icon"]')?.getAttribute('data-icon')).toBe('plane')
  })

  it('NOTES-4 AC-7 AC-14 NOTES-6 AC-1 the inbox has the head and the menu "View" of every list, its looks keep "File"', async () => {
    const at = new Date(Date.now() - 60_000).toISOString()
    inboxNotes = [{ id: 'n1', title: 'Kompost', preview: 'Schichten', origin: 'dictation', title_check: true, created_at: at, updated_at: at }]
    await render('/inbox')
    const head = box.querySelector('[data-testid="list-head"]')!
    expect(head.querySelector('h1')!.textContent).toBe('Inbox')
    expect(head.querySelector('[data-testid="list-counts"]')!.textContent).toBe('1 note')
    expect(head.querySelector('[data-testid="list-view"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="note-list"]')!.getAttribute('data-folder')).toBe(INBOX)
    // A row shows "Title OK" and "File" with their words; "Title OK" is asked of the server and the list loads anew.
    expect(box.querySelector('[data-testid="inbox-sort-in"]')!.textContent).toBe('File')
    click(box.querySelector('[data-testid="inbox-title-ok"]')!)
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/notes/n1/title/ok')).toBe(true)
    expect(box.querySelector('[data-testid="inbox-title-ok"]')).toBeNull()
    expect(box.querySelector('[data-note]')!.textContent).not.toContain('Check title')
    // Tiles, cards and compact rows keep "File" as a sign with its name, and where the note came from.
    for (const style of ['tiles', 'cards', 'compact'] as const) {
      await act(async () => {
        await saveListLook({ style })
      })
      await settle()
      expect(box.querySelector('[data-testid="note-list"]')!.getAttribute('data-style')).toBe(style)
      const sortIn = box.querySelector<HTMLElement>('[data-testid="inbox-sort-in"]')!
      expect(sortIn.getAttribute('aria-label')).toBe('File')
      expect(box.querySelector('[data-note] [data-testid="inbox-origin-icon"]')!.getAttribute('data-origin')).toBe('dictation')
    }
    click(button('File', box.querySelector('[data-note]')!))
    await settle()
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('File “Kompost”')
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

// ---- The tiles at the top (NOTES-4 AC-16) -----------------------------------------------------------------------------

/** The app's style sheet as written (the test setup draws no CSS): the colours of the sidebar in both themes. */
const fsName = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (file: string, encoding: string) => string }
function themeColors(selector: string): Record<string, string> {
  const css = readFileSync('src/styles/index.css', 'utf-8').replace(/\r\n/g, '\n')
  const at = css.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1], match[2]]))
}

describe('the tiles at the top of the sidebar (NOTES-4 AC-16)', () => {
  const tile = (id: string) => box.querySelector<HTMLAnchorElement>(`[data-testid="${id}"]`)!
  const count = (id: string) => tile(id).querySelector('[data-testid="tile-count"]')!.textContent

  it('NOTES-4 AC-16 three tiles, two per row: Inbox, All notes, Shared with me, each with its symbol, number and name', async () => {
    const at = new Date().toISOString()
    inboxNotes = [
      { id: 'n1', title: 'Kompost', preview: '', origin: '', title_check: true, created_at: at, updated_at: at },
      { id: 'n2', title: 'Rezept', preview: '', origin: '', title_check: true, created_at: at, updated_at: at },
      { id: 'n3', title: 'Liste', preview: '', origin: '', title_check: false, created_at: at, updated_at: at },
    ]
    await render()
    const grid = box.querySelector('[data-testid="quick-tiles"]')!
    expect(grid.className).toContain('grid-cols-2')
    expect([...grid.children].map((child) => child.getAttribute('data-testid'))).toEqual(['sidebar-inbox', 'sidebar-all', 'sidebar-shared'])
    expect([tile('sidebar-inbox'), tile('sidebar-all'), tile('sidebar-shared')].map((link) => link.getAttribute('href'))).toEqual(['/inbox', '/', '/shared'])
    expect([count('sidebar-inbox'), count('sidebar-all'), count('sidebar-shared')]).toEqual(['3', '40', '3'])
    expect(tile('sidebar-all').textContent).toContain('All notes')
    expect(tile('sidebar-shared').textContent).toContain('Shared with me')
    for (const id of ['sidebar-inbox', 'sidebar-all', 'sidebar-shared']) expect(tile(id).querySelector('svg')).not.toBeNull()
    expect(tile('sidebar-inbox').querySelector('[data-testid="tile-title-check"]')!.textContent).toBe('2 titles to check')
    // A screen reader hears the name first, then the number and the mark.
    expect(tile('sidebar-inbox').getAttribute('aria-label')).toBe('Inbox, 3 notes, 2 titles to check')
    expect(tile('sidebar-all').getAttribute('aria-label')).toBe('All notes, 40 notes')
    expect(tile('sidebar-shared').getAttribute('aria-label')).toBe('Shared with me, 3 notes')
    await i18n.changeLanguage('de')
    await settle()
    expect(tile('sidebar-inbox').querySelector('[data-testid="tile-title-check"]')!.textContent).toBe('2 Titel prüfen')
    expect(tile('sidebar-shared').textContent).toContain('Mit mir geteilt')
    await i18n.changeLanguage('en')
  })

  it('NOTES-4 AC-16 no mark without a title to check; the tile of the place on show is chosen', async () => {
    await render('/shared')
    expect(tile('sidebar-inbox').querySelector('[data-testid="tile-title-check"]')).toBeNull()
    expect(tile('sidebar-shared').getAttribute('aria-current')).toBe('page')
    expect(tile('sidebar-shared').className).toContain('ring-2')
    expect(tile('sidebar-inbox').getAttribute('aria-current')).toBeNull()
    expect(tile('sidebar-inbox').className).not.toContain('ring-2')
    click(tile('sidebar-inbox'))
    await settle()
    expect(where().path).toBe('/inbox')
    expect(tile('sidebar-inbox').getAttribute('aria-current')).toBe('page')
    expect(tile('sidebar-shared').getAttribute('aria-current')).toBeNull()
    // "All notes" only on its own page, not on every page below it.
    expect(tile('sidebar-all').getAttribute('aria-current')).toBeNull()
  })

  it('NOTES-4 AC-16 the writing on every tile reaches 4.5:1 (WCAG AA), the mark of the chosen one 3:1 in light and dark', () => {
    for (const [name, colors] of Object.entries(TILE_COLORS)) expect(contrast(colors.ink, colors.ground), name).toBeGreaterThanOrEqual(4.5)
    expect(contrast(TITLE_CHECK_COLORS.ink, TITLE_CHECK_COLORS.ground)).toBeGreaterThanOrEqual(4.5)
    const dark = themeColors('@theme')
    const light = { ...dark, ...themeColors(":root[data-theme='light']") }
    for (const [mode, colors] of Object.entries({ dark, light })) {
      expect(contrast(colors['--color-mist-100'], colors['--color-ink-900']), mode).toBeGreaterThanOrEqual(3)
    }
  })

  it('NOTES-4 AC-3 notes dropped on the inbox tile go back into the inbox', async () => {
    await render('/folder/h')
    const transfer = dataTransfer()
    const source = document.createElement('div')
    source.draggable = true
    source.addEventListener('dragstart', (event) => startNoteDrag(event as unknown as React.DragEvent, ['n9']))
    box.append(source)
    drag(source, 'dragstart', transfer)
    expect(drag(tile('sidebar-inbox'), 'dragover', transfer).defaultPrevented).toBe(true)
    drag(tile('sidebar-inbox'), 'drop', transfer)
    await settle()
    expect(calls.find((call) => call.path === '/api/folders/move')?.body).toEqual({ target_id: INBOX, folder_ids: [], note_ids: ['n9'] })
  })
})
