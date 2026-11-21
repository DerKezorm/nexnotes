/**
 * The looks of the lists (decision of 21.11.2026 after the mock-up): list, cards, compact and tiles, one choice of the
 * account for every list, the hints on or off, the menu "Ansicht" (sort, grouping, look, hints; keyboard), the groups
 * folded shut per device, and in every look the note's link (Alt click, middle click), its menu (right click, "…")
 * and its dragging.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { forgetFolders } from '../../folders/store'
import { hideNotice } from '../../folders/notice'
import i18n from '../../i18n'
import { installTabLinks } from '../../tabs/links'
import { NoteList } from '../NoteList'
import { DEFAULT_VIEW, LIST_STYLES, type ListItem, type ListStyle, type ListView } from './api'
import { forgetCollapsed } from './collapsed'
import { layout, SIZES } from './layout'
import { LookSettings } from './LookSettings'
import { currentListLook, forgetListLook, takeListLook } from './look'
import { arrange } from './order'
import { takeEarly } from './preload'

const opened = vi.hoisted(() => ({ paths: [] as string[], tabs: [] as string[] }))
vi.mock('../../tabs/open', async (original) => ({
  ...(await original<typeof import('../../tabs/open')>()),
  openPath: (path: string) => opened.paths.push(path),
  openNoteInNewTab: (note: string) => opened.tabs.push(note),
}))

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let items: ListItem[] = []
let views: Map<string, ListView>
let look = { list_style: 'list', list_hints: true }
let refuse = false

function item(id: string, extra: Partial<ListItem> = {}): ListItem {
  const at = new Date(Date.now() - 60_000).toISOString()
  return { id, folder_id: 'h', title: id, title_check: false, origin: '', preview: '', created_at: at, updated_at: at, pinned: false, color: '', tasks: null, ...extra }
}

function answer({ method, path, body }: Call, query: URLSearchParams): { status: number; body: unknown } {
  const key = query.get('folder_id') ?? 'all'
  if (method === 'GET' && path === '/api/folders') return { status: 200, body: { inbox: { id: 'inbox-1', count: 0 }, folders: [] } }
  if (method === 'GET' && path === '/api/note-list')
    return { status: 200, body: { key, view: views.get(key) ?? DEFAULT_VIEW, counts: { own: items.length, shared: 0 }, items: items.filter((note) => key === 'all' || note.folder_id === key) } }
  if (method === 'GET' && path === '/api/note-list/stamp') return { status: 200, body: { stamp: '1' } }
  if (method === 'PUT' && path === '/api/note-list/view') {
    const where = (body?.folder_id as string | undefined) ?? 'all'
    const next = { ...(views.get(where) ?? DEFAULT_VIEW), ...body }
    delete (next as Record<string, unknown>).folder_id
    views.set(where, next)
    return { status: 200, body: next }
  }
  if (method === 'PUT' && path === '/api/me/list-look') {
    if (refuse) return { status: 422, body: { detail: { code: 'list_style_unknown', message: 'Choose list, cards, compact or tiles.' } } }
    if (body?.style !== undefined) look = { ...look, list_style: String(body.style) }
    if (body?.hints !== undefined) look = { ...look, list_hints: Boolean(body.hints) }
    return { status: 200, body: { id: 1, name: 'tester', ...look } }
  }
  return { status: 404, body: { detail: { code: 'not_found', message: 'Not found.' } } }
}

let root: Root
let box: HTMLDivElement

async function settle(rounds = 15): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await Promise.resolve())
}

async function render(folderId = 'h', selectedId?: string): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <NoteList folderId={folderId} heading="Haushalt" selectedId={selectedId} />
      </MemoryRouter>,
    ),
  )
  await settle()
}

async function again(folderId = 'h'): Promise<void> {
  act(() => root.unmount())
  for (const leftover of document.querySelectorAll('[role="menu"]')) leftover.remove()
  root = createRoot(box)
  await render(folderId)
}

const $ = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
const note = (id: string) => box.querySelector<HTMLElement>(`[data-note="${id}"]`)!

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click())
  await settle()
}

async function viewEntry(testId: string): Promise<HTMLElement> {
  if (!$('list-view-menu')) await click($('list-view')!)
  return $(testId)!
}

function lookIs(style: ListStyle, hints = true): void {
  look = { list_style: style, list_hints: hints }
  act(() => takeListLook(look))
}

/** The note's link in each look. */
const LINK: Record<ListStyle, string> = { list: 'note-row', cards: 'note-card', compact: 'note-compact', tiles: 'note-tile' }

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  views = new Map()
  look = { list_style: 'list', list_hints: true }
  refuse = false
  opened.paths = []
  opened.tabs = []
  items = [
    item('a', {
      title: 'Einkauf Samstag',
      icon: 'basket',
      color: 'green',
      preview: 'Milch, Tomaten',
      tasks: { done: 3, total: 8 },
      attachments: 2,
      tags: ['einkauf'],
    }),
    item('b', { title: 'Zitate', preview: 'Einfachheit ist die höchste Stufe', updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const call = { method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
      calls.push(call)
      const { status, body } = answer(call, url.searchParams)
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  forgetFolders()
  forgetListLook()
  forgetCollapsed()
  hideNotice()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('de')
})

afterEach(() => {
  takeEarly()
  act(() => root.unmount())
  box.remove()
  for (const leftover of document.querySelectorAll('[role="menu"]')) leftover.remove()
  act(() => hideNotice())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the looks of the lists', () => {
  it('every look shows title, symbol, time, preview and the hints of a note', async () => {
    const time = new Date(Date.now() - 60_000).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })
    for (const style of LIST_STYLES) {
      lookIs(style)
      await again()
      expect($('note-list')!.dataset.style).toBe(style)
      const shown = note('a')
      const link = shown.querySelector<HTMLElement>(`[data-testid="${LINK[style]}"]`) ?? (shown.matches(`[data-testid="${LINK[style]}"]`) ? shown : null)
      expect(link, style).not.toBeNull()
      expect(shown.textContent, style).toContain('Einkauf Samstag')
      expect(shown.querySelector('[data-testid="note-icon"]')!.getAttribute('data-icon'), style).toBe('basket')
      expect(shown.textContent, style).toContain(time)
      expect(shown.querySelector('[data-testid="note-preview"]')!.textContent, style).toContain('Milch, Tomaten')
      expect(shown.querySelector('[data-testid="note-color"]'), style).not.toBeNull()
      // Checklist, attachments, tags: as chips with a bar, in a compact row as small numbers, on a tile at its foot.
      expect(shown.textContent, style).toContain(style === 'compact' ? '3/8' : '3 von 8')
      expect(shown.querySelector('[aria-label="2 Anhänge"]'), style).not.toBeNull()
      if (style !== 'compact') expect(shown.textContent, style).toContain('#einkauf')
      if (style === 'list' || style === 'cards') expect(shown.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'), style).toBe('38')
      expect(note('b').textContent, style).toContain('Einfachheit')
    }
  })

  it('the hints switch off for every look, and the choice is saved for the account', async () => {
    await render()
    expect($$('note-hints').length).toBeGreaterThan(0)
    const hints = await viewEntry('list-hints')
    expect(hints.getAttribute('role')).toBe('menuitemcheckbox')
    expect(hints.getAttribute('aria-checked')).toBe('true')
    await click(hints)
    expect(calls.filter((call) => call.path === '/api/me/list-look').map((call) => call.body)).toEqual([{ hints: false }])
    expect(currentListLook()).toEqual({ style: 'list', hints: false })
    expect($('list-hints')!.getAttribute('aria-checked')).toBe('false')
    for (const style of LIST_STYLES) {
      lookIs(style, false)
      await again()
      expect($$('note-hints'), style).toHaveLength(0)
      expect(note('a').textContent, style).not.toContain('#einkauf')
      expect(note('a').querySelector('[aria-label="2 Anhänge"]'), style).toBeNull()
      // The note itself stays: title and preview.
      expect(note('a').textContent, style).toContain('Milch, Tomaten')
    }
    // A row without hints is lower than one with them: the layout follows.
    const sections = arrange(items, DEFAULT_VIEW, new Date())
    const heights = (hints: boolean) => layout(sections, 'list', 800, { hints }).entries.filter((entry) => entry.kind === 'row').map((entry) => entry.height)
    expect(heights(true)).toEqual([SIZES.rowHints, SIZES.row])
    expect(heights(false)).toEqual([SIZES.row, SIZES.row])
  })

  it('the menu "Ansicht" saves sort and grouping for the folder, look and hints for the account', async () => {
    await render()
    expect($('list-state')!.textContent).toBe('Zuletzt geändert · nach Datum gruppiert')
    const menu = await viewEntry('list-view-menu')
    expect([...menu.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label'))).toEqual(['Sortieren', 'Gruppieren', 'Darstellung'])
    expect([...menu.querySelectorAll('[role="group"][aria-label="Darstellung"] [role="menuitemradio"]')].map((entry) => entry.textContent)).toEqual(['Liste', 'Karten', 'Kompakt', 'Kacheln'])
    await click($('list-sort-created')!)
    await click($('list-group-off')!)
    expect(calls.filter((call) => call.path === '/api/note-list/view').map((call) => call.body)).toEqual([
      { folder_id: 'h', sort: 'created', direction: 'desc' },
      { folder_id: 'h', grouped: false },
    ])
    await click($('list-style-compact')!)
    expect(calls.filter((call) => call.path === '/api/me/list-look').map((call) => call.body)).toEqual([{ style: 'compact' }])
    // The menu stays open while choosing; the line under the heading says what is chosen.
    expect($('list-view-menu')).not.toBeNull()
    expect($('list-state')!.textContent).toBe('Erstellt · Kompakt')
    expect($$('note-compact')).toHaveLength(2)
    // Another folder: its own sort, the account's look.
    items = [...items, item('c', { title: 'Werkzeug', folder_id: 'r' })]
    await again('r')
    expect($('note-list')!.dataset.style).toBe('compact')
    expect($('list-state')!.textContent).toBe('Zuletzt geändert · nach Datum gruppiert · Kompakt')
    // Back in the first folder after a reload: what the server kept.
    forgetListLook()
    lookIs(look.list_style as ListStyle, look.list_hints)
    await again('h')
    expect($('list-state')!.textContent).toBe('Erstellt · Kompakt')
  })

  it('Einstellungen › Darstellung chooses the same look and hints as the menu "Ansicht", each shows the other at once', async () => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <LookSettings />
          <NoteList folderId="h" heading="Haushalt" />
        </MemoryRouter>,
      ),
    )
    await settle()
    const radios = [...$('settings-list-style')!.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios.map((radio) => radio.textContent)).toEqual(['Liste', 'Karten', 'Kompakt', 'Kacheln'])
    // Each with the small picture of the menu "Ansicht".
    expect(radios.map((radio) => radio.querySelector('svg')?.getAttribute('class'))).toEqual([
      expect.stringContaining('lucide-layout-list'),
      expect.stringContaining('lucide-gallery-vertical-end'),
      expect.stringContaining('align-justify'),
      expect.stringContaining('lucide-layout-grid'),
    ])
    expect($('settings-list-style-list')!.getAttribute('aria-checked')).toBe('true')
    // Chosen in the settings: the list follows at once, the menu shows it, the server keeps it for the account.
    await click($('settings-list-style-tiles')!)
    expect($('note-list')!.dataset.style).toBe('tiles')
    expect((await viewEntry('list-style-tiles')).getAttribute('aria-checked')).toBe('true')
    // Chosen in the menu: the settings follow.
    await click($('list-style-compact')!)
    expect($('settings-list-style-compact')!.getAttribute('aria-checked')).toBe('true')
    expect($('settings-list-style-tiles')!.getAttribute('aria-checked')).toBe('false')
    // The hints the same way, both directions.
    expect($('settings-list-hints')!.getAttribute('aria-checked')).toBe('true')
    await click($('settings-list-hints')!)
    expect($('list-hints')!.getAttribute('aria-checked')).toBe('false')
    await click($('list-hints')!)
    expect($('settings-list-hints')!.getAttribute('aria-checked')).toBe('true')
    expect(calls.filter((call) => call.path === '/api/me/list-look').map((call) => call.body)).toEqual([
      { style: 'tiles' },
      { style: 'compact' },
      { hints: false },
      { hints: true },
    ])
  })

  it('the menu "Ansicht" is worked by keyboard: arrows, Escape closes it and the focus goes back', async () => {
    await render()
    const button = $('list-view')!
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    await click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const menu = $('list-view-menu')!
    expect(document.activeElement).toBe($('list-sort-updated'))
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe($('list-sort-created'))
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.activeElement).toBe($('list-hints'))
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle()
    expect($('list-view-menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('a look the server refuses goes back, with a notice', async () => {
    await render()
    refuse = true
    await click(await viewEntry('list-style-tiles'))
    expect(currentListLook().style).toBe('list')
    expect($('note-list')!.dataset.style).toBe('list')
    expect(document.body.textContent).toContain('Wähl Liste, Karten, Kompakt oder Kacheln.')
  })

  it('in every look the note is a link for Alt click, its menu opens on a right click and from "…", it can be dragged', async () => {
    installTabLinks()
    for (const style of LIST_STYLES) {
      lookIs(style)
      await again()
      const shown = note('a')
      const link = shown.querySelector<HTMLAnchorElement>(`a[data-testid="${LINK[style]}"]`)!
      expect(link.getAttribute('href'), style).toBe('/folder/h?note=a')
      expect(shown.draggable, style).toBe(true)
      // Alt click: the note at its address while no tab is open (`tabs/links.ts`), never the browser's download.
      opened.paths = []
      const alt = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, button: 0 })
      await act(async () => link.dispatchEvent(alt))
      expect(alt.defaultPrevented, style).toBe(true)
      expect(opened.paths, style).toEqual(['/folder/h?note=a'])
      // Right click: the note's menu.
      await act(async () => shown.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })))
      expect($('note-item-menu'), style).not.toBeNull()
      await act(async () => $('note-item-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()
      expect($('note-item-menu'), style).toBeNull()
      await click(note('a').querySelector<HTMLElement>('[aria-label="Aktionen für „Einkauf Samstag“"]')!)
      expect($('note-item-menu'), style).not.toBeNull()
      await act(async () => $('note-item-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()
    }
  })

  it('the open note is marked in every look', async () => {
    for (const style of LIST_STYLES) {
      lookIs(style)
      act(() => root.unmount())
      root = createRoot(box)
      await render('h', 'a')
      expect(note('a').querySelector('[aria-current="page"]'), style).not.toBeNull()
      expect(note('b').querySelector('[aria-current="page"]'), style).toBeNull()
    }
    lookIs('list')
    act(() => root.unmount())
    root = createRoot(box)
    await render('h', 'a')
    expect(note('a').querySelector('[data-testid="note-chosen-bar"]')).not.toBeNull()
    expect(note('a').className).toContain('bg-accent-wash')
  })

  it('groups show their count and fold shut and open, kept per list on this device', async () => {
    await render()
    const toggles = () => $$('list-group-toggle')
    expect(toggles().map((toggle) => toggle.dataset.section)).toEqual(['today', 'week'])
    expect($$('list-group-count').map((count) => count.textContent)).toEqual(['· 1', '· 1'])
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('true')
    await click(toggles()[0])
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('false')
    expect(box.querySelector('[data-note="a"]')).toBeNull()
    expect(note('b')).not.toBeNull()
    // Kept on this device: the same list opened again stays folded; another list is not.
    await again('h')
    expect(box.querySelector('[data-note="a"]')).toBeNull()
    expect(localStorage.getItem('nexnotes:list-collapsed')).toBe(JSON.stringify(['h|today']))
    items = items.map((one) => ({ ...one, folder_id: 'r' }))
    await again('r')
    expect(note('a')).not.toBeNull()
    items = items.map((one) => ({ ...one, folder_id: 'h' }))
    await again('h')
    await click(toggles()[0])
    expect(note('a')).not.toBeNull()
    expect(localStorage.getItem('nexnotes:list-collapsed')).toBe('[]')
    // A folded group keeps its heading only, in every look.
    const sections = arrange(items, DEFAULT_VIEW, new Date())
    for (const style of LIST_STYLES) {
      const placed = layout(sections, style, 800, { collapsed: new Set(['today']) })
      expect(placed.entries.filter((entry) => entry.kind !== 'header').flatMap((entry) => (entry.kind === 'row' ? [entry.item.id] : entry.kind === 'grid' ? entry.items.map((one) => one.id) : []))).toEqual(['b'])
    }
  })

  it('compact rows and group headings are a finger high on a touch screen; cards stand in a grid when wide', () => {
    const sections = arrange(items, DEFAULT_VIEW, new Date())
    const touch = layout(sections, 'compact', 390, { touch: true })
    expect(touch.entries.map((entry) => entry.height)).toEqual([SIZES.headerTouch, SIZES.compactTouch, SIZES.headerTouch, SIZES.compactTouch])
    expect(layout(sections, 'compact', 1024).entries.map((entry) => entry.height)).toEqual([SIZES.header, SIZES.compact, SIZES.header, SIZES.compact])
    expect(layout(sections, 'cards', 340).columns).toBe(1)
    expect(layout(sections, 'cards', 1100).columns).toBe(3)
    expect(layout(sections, 'tiles', 390).columns).toBe(2)
  })
})
