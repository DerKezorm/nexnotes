/**
 * NOTES-6 in the interface: how lists look from the account (AC-1), sorting and its direction (AC-4), the date
 * groups (AC-5), pinned notes on top (AC-6), "All notes" with own and shared notes, folders and stripes (AC-7), colors
 * (AC-8), the marks of rows and tiles (AC-2, AC-3, AC-9), 10,000 notes (EC-2), locked notes (EC-3), text never as HTML
 * (EC-5), changes from another device without a reload (EC-6) and midnight (EC-7).
 *
 * A small stand-in for the server keeps the notes, the views per folder, the account's look and the stamp.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { registerNoteActions } from '../../folders/actions'
import type { Folder } from '../../folders/api'
import { hideNotice } from '../../folders/notice'
import { FolderPage } from '../../folders/pages'
import { forgetFolders } from '../../folders/store'
import i18n from '../../i18n'
import { accountChanged } from '../../state/account'
import { NoteList } from '../NoteList'
import { DEFAULT_VIEW, type ListItem, type ListStyle, type ListView } from './api'
import { forgetCollapsed } from './collapsed'
import { NotePinButton } from './EditorMarks'
import { anchorOf, layout, shiftFor, SIZES, visibleRange } from './layout'
import { arrange, dayGroup, sectionLabel, sortItems } from './order'
import { forgetListLook, takeListLook } from './look'
import { listKeyOf, preloadList, takeEarly } from './preload'
import { STAMP_EVERY_MS } from './useNoteList'
import { Window } from './Window'

// ---- The stand-in server ---------------------------------------------------------------------------------------------

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let items: ListItem[] = []
let views: Map<string, ListView>
let shared = 0
let stampValue = 1
let folders: Folder[] = []
let look: { list_style: string; list_hints: boolean } = { list_style: 'list', list_hints: true }
/** The heads `GET /api/notes/<id>` answers (the note's menu in the list asks for it). */
let heads: Record<string, unknown> = {}
const INBOX = 'inbox-1'
const DAY = 86_400_000

function item(id: string, extra: Partial<ListItem> = {}): ListItem {
  const at = new Date(Date.now() - 60_000).toISOString()
  return { id, folder_id: 'h', title: id, title_check: false, origin: '', preview: '', created_at: at, updated_at: at, pinned: false, color: '', tasks: null, ...extra }
}

function folder(id: string, name: string, color = ''): Folder {
  return { id, name, parent_id: null, icon: '', color, position: null, count: 1 }
}

function answer(call: Call): { status: number; body: unknown } {
  const { method, path, query, body } = call
  const key = query.get('folder_id') ?? 'all'
  if (method === 'GET' && path === '/api/folders') return { status: 200, body: { inbox: { id: INBOX, count: 0 }, folders } }
  if (method === 'GET' && path === '/api/note-list') {
    const found = key === 'all' ? items : items.filter((note) => note.folder_id === key && !note.owner)
    const own = found.filter((note) => !note.owner).length
    return { status: 200, body: { key, view: views.get(key) ?? DEFAULT_VIEW, counts: { own, shared: key === 'all' ? shared : 0 }, items: found } }
  }
  if (method === 'GET' && path === '/api/note-list/stamp') return { status: 200, body: { stamp: String(stampValue) } }
  if (method === 'PUT' && path === '/api/me/list-look') {
    if (body?.style !== undefined) look = { ...look, list_style: String(body.style) }
    if (body?.hints !== undefined) look = { ...look, list_hints: Boolean(body.hints) }
    return { status: 200, body: { id: 1, name: 'tester', ...look } }
  }
  if (method === 'PUT' && path === '/api/note-list/view') {
    const where = (body?.folder_id as string | undefined) ?? 'all'
    const next = { ...(views.get(where) ?? DEFAULT_VIEW) }
    for (const field of ['mode', 'sort', 'direction', 'grouped'] as const) if (body?.[field] !== undefined) Object.assign(next, { [field]: body[field] })
    views.set(where, next)
    return { status: 200, body: next }
  }
  const head = /^\/api\/notes\/([^/]+)$/.exec(path)
  if (head && method === 'GET' && heads[head[1]]) return { status: 200, body: heads[head[1]] }
  const one = /^\/api\/notes\/([^/]+)\/(pin|color)$/.exec(path)
  if (one && method === 'PUT') {
    const [, id, what] = one
    items = items.map((note) => (note.id === id ? { ...note, ...(what === 'pin' ? { pinned: Boolean(body?.pinned) } : { color: String(body?.color) }) } : note))
    stampValue++
    return { status: 200, body: items.find((note) => note.id === id) }
  }
  return { status: 404, body: { detail: { code: 'not_found', message: 'Not found.' } } }
}

// ---- Rendering -------------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement

async function settle(rounds = 15): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await Promise.resolve())
}

async function render(folderId?: string, heading = 'Notes'): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <NoteList folderId={folderId} heading={heading} />
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...box.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
const rowTitles = () => $$('note-row').map((row) => row.querySelector('.truncate')!.textContent)
const headings = () => $$('list-group-heading').map((heading) => heading.textContent)
const byText = (text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="menuitemradio"], [role="radio"]')].find(
    (element) => element.textContent?.trim() === text || element.getAttribute('aria-label') === text,
  )!

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click())
  await settle()
}

/** The menu "Ansicht", opened when it is not. */
async function viewMenu(): Promise<HTMLElement> {
  if (!document.querySelector('[data-testid="list-view-menu"]')) await click($('list-view')!)
  return document.querySelector<HTMLElement>('[data-testid="list-view-menu"]')!
}

/** The look of every list, as the account brings it. */
function lookIs(style: ListStyle, hints = true): void {
  look = { list_style: style, list_hints: hints }
  act(() => takeListLook(look))
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  items = []
  heads = {}
  shared = 0
  stampValue = 1
  views = new Map()
  folders = [folder('h', 'Haushalt', 'honey'), folder('r', 'Rezepte', 'red')]
  look = { list_style: 'list', list_hints: true }
  forgetListLook()
  forgetCollapsed()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
      calls.push(call)
      const { status, body } = answer(call)
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  forgetFolders()
  hideNotice()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  takeEarly()
  act(() => root.unmount())
  box.remove()
  for (const leftover of document.querySelectorAll('[role="menu"]')) leftover.remove()
  act(() => hideNotice())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---- Fifty notes for the orders -------------------------------------------------------------------------------------

const NOW = new Date(2026, 10, 21, 15, 0, 0)

function fifty(): ListItem[] {
  return Array.from({ length: 50 }, (_, index) =>
    item(`n${index}`, {
      title: index % 10 === 0 ? `Ärger ${index}` : `Topic ${index}`,
      // Changed 0 to 196 days ago, made in reverse order.
      updated_at: new Date(NOW.getTime() - index * 4 * DAY - 3600_000).toISOString(),
      created_at: new Date(NOW.getTime() - (50 - index) * DAY).toISOString(),
    }),
  )
}

// ---- AC-1 -------------------------------------------------------------------------------------------------------------

describe('NOTES-6 list and tiles', () => {
  it('NOTES-6 AC-1 list or tiles comes from the account for every list and a switch is saved there', async () => {
    items = [item('a', { title: 'Einkauf' }), item('b', { title: 'Werkzeug', folder_id: 'r' })]
    lookIs('tiles')
    await render('h')
    expect($('note-list')!.dataset.style).toBe('tiles')
    expect($$('note-tile').map((tile) => tile.textContent)).toEqual([expect.stringContaining('Einkauf')])
    await click((await viewMenu()).querySelector<HTMLElement>('[data-testid="list-style-list"]')!)
    expect(calls.filter((call) => call.method === 'PUT' && call.path === '/api/me/list-look').map((call) => call.body)).toEqual([{ style: 'list' }])
    expect(calls.some((call) => call.path === '/api/note-list/view')).toBe(false)
    expect($('note-list')!.dataset.style).toBe('list')
    expect(rowTitles()).toEqual(['Einkauf'])
    // Another folder looks the same: the look is the account's, not the folder's.
    act(() => root.unmount())
    root = createRoot(box)
    await render('r')
    expect($('note-list')!.dataset.style).toBe('list')
    expect(rowTitles()).toEqual(['Werkzeug'])
    // Another device chose tiles: the next account answer brings them to every list here.
    lookIs('tiles')
    await settle()
    expect($('note-list')!.dataset.style).toBe('tiles')
    expect($$('note-tile')).toHaveLength(1)
  })

  // ---- AC-4 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 AC-4 sorts fifty notes by change, creation and title, up and down', () => {
    const notes = fifty()
    const check = (sorted: ListItem[], key: (note: ListItem) => number | string, up: boolean) => {
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = [key(sorted[i - 1]), key(sorted[i])]
        expect(up ? a <= b : a >= b).toBe(true)
      }
    }
    check(sortItems(notes, { sort: 'updated', direction: 'desc' }), (note) => Date.parse(note.updated_at), false)
    check(sortItems(notes, { sort: 'updated', direction: 'asc' }), (note) => Date.parse(note.updated_at), true)
    check(sortItems(notes, { sort: 'created', direction: 'desc' }), (note) => Date.parse(note.created_at), false)
    check(sortItems(notes, { sort: 'created', direction: 'asc' }), (note) => Date.parse(note.created_at), true)
    const byTitle = sortItems(notes, { sort: 'title', direction: 'asc' }, 'de').map((note) => note.title)
    // Umlauts with their letter, numbers as numbers.
    expect(byTitle.slice(0, 6)).toEqual(['Ärger 0', 'Ärger 10', 'Ärger 20', 'Ärger 30', 'Ärger 40', 'Topic 1'])
    expect(byTitle.indexOf('Topic 2')).toBeLessThan(byTitle.indexOf('Topic 11'))
    expect(sortItems(notes, { sort: 'title', direction: 'desc' }, 'de').map((note) => note.title)).toEqual([...byTitle].reverse())
    // A note without a title goes last both ways.
    const untitled = [...notes, item('z', { title: '' })]
    expect(sortItems(untitled, { sort: 'title', direction: 'asc' }).at(-1)!.id).toBe('z')
    expect(sortItems(untitled, { sort: 'title', direction: 'desc' }).at(-1)!.id).toBe('z')
  })

  it('NOTES-6 AC-4 the menu "Ansicht" offers last changed, created and title, and the direction', async () => {
    items = fifty()
    await render('h')
    expect(rowTitles()[0]).toBe('Ärger 0')
    let menu = await viewMenu()
    const sorting = menu.querySelector<HTMLElement>('[role="group"][aria-label="Sort"]')!
    expect([...sorting.querySelectorAll('[role="menuitemradio"]')].map((entry) => entry.textContent)).toEqual(['Last changed', 'Created', 'Title A to Z', 'Newest first', 'Oldest first'])
    await click(byText('Title A to Z', menu))
    expect(calls.at(-1)!.body).toEqual({ folder_id: 'h', sort: 'title', direction: 'asc' })
    expect(rowTitles().slice(0, 2)).toEqual(['Ärger 0', 'Ärger 10'])
    expect($('list-state')!.textContent).toBe('Title A to Z')
    // The menu stays open for the next choice.
    menu = await viewMenu()
    await click(byText('Z to A', menu))
    expect(calls.at(-1)!.body).toEqual({ folder_id: 'h', direction: 'desc' })
    expect(rowTitles()[0]).toBe('Topic 49')
    await click(byText('Created', await viewMenu()))
    expect(calls.at(-1)!.body).toEqual({ folder_id: 'h', sort: 'created', direction: 'desc' })
    expect(rowTitles()[0]).toBe('Topic 49')
    expect($('list-state')!.textContent).toBe('Created · grouped by date')
  })

  // ---- AC-5 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 AC-5 groups by Today, Yesterday, 7 days, 30 days and then month, none by title', () => {
    const at = (days: number, hours = 0) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days, 12 - hours).toISOString()
    expect(dayGroup(at(0), NOW)).toBe('today')
    expect(dayGroup(new Date(NOW.getTime() + 3600_000 * 30).toISOString(), NOW)).toBe('today')
    expect(dayGroup(at(1), NOW)).toBe('yesterday')
    expect(dayGroup(at(2), NOW)).toBe('week')
    expect(dayGroup(at(6), NOW)).toBe('week')
    expect(dayGroup(at(7), NOW)).toBe('month')
    expect(dayGroup(at(29), NOW)).toBe('month')
    expect(dayGroup(at(30), NOW)).toBe('m:2026-10')
    expect(dayGroup(new Date(2025, 11, 31).toISOString(), NOW)).toBe('m:2025-12')
    const view: ListView = { ...DEFAULT_VIEW }
    const keys = arrange(fifty(), view, NOW).map((section) => section.key)
    expect(keys.slice(0, 4)).toEqual(['today', 'week', 'month', 'm:2026-10'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(arrange(fifty(), { ...view, sort: 'title', direction: 'asc' }, NOW).map((section) => section.key)).toEqual(['all'])
    expect(arrange(fifty(), { ...view, grouped: false }, NOW).map((section) => section.key)).toEqual(['all'])
    // Oldest first: the groups turn round as well.
    expect(arrange(fifty(), { ...view, direction: 'asc' }, NOW).at(-1)!.key).toBe('today')
    const t = (key: string) => i18n.t(key)
    expect(sectionLabel('m:2026-10', t, 'en', NOW)).toBe('October')
    expect(sectionLabel('m:2025-12', t, 'en', NOW)).toBe('December 2025')
    expect(sectionLabel('week', t, 'en', NOW)).toBe('Last 7 days')
  })

  it('NOTES-6 AC-5 grouping is on from the start, can be switched off and is off while sorted by title', async () => {
    const now = Date.now()
    items = [item('a', { title: 'Heute', updated_at: new Date(now - 60_000).toISOString() }), item('b', { title: 'Alt', updated_at: new Date(now - 90 * DAY).toISOString() })]
    await render('h')
    expect(headings()[0]).toBe('Today')
    expect(headings()).toHaveLength(2)
    await viewMenu()
    expect($('list-group-on')!.getAttribute('aria-checked')).toBe('true')
    await click($('list-group-off')!)
    expect(calls.at(-1)!.body).toEqual({ folder_id: 'h', grouped: false })
    expect(headings()).toEqual([])
    expect($('list-group-off')!.getAttribute('aria-checked')).toBe('true')
    await click($('list-group-on')!)
    expect(headings()).toHaveLength(2)
    views.set('h', { ...DEFAULT_VIEW, sort: 'title', direction: 'asc' })
    act(() => root.unmount())
    root = createRoot(box)
    for (const leftover of document.querySelectorAll('[role="menu"]')) leftover.remove()
    await render('h')
    expect(headings()).toEqual([])
    await viewMenu()
    expect($('list-group-on')!.getAttribute('aria-checked')).toBe('false')
    expect($('list-group-on')!.getAttribute('aria-disabled')).toBe('true')
    const before = calls.length
    await click($('list-group-on')!)
    expect(calls.length).toBe(before)
  })

  // ---- AC-6, AC-8 -------------------------------------------------------------------------------------------------------

  it('NOTES-6 AC-6 a pinned note stands on top under "Pinned" with a pin, set from its menu', async () => {
    items = [item('a', { title: 'Neu' }), item('b', { title: 'Einkauf Samstag', updated_at: new Date(Date.now() - 40 * DAY).toISOString() })]
    await render('h')
    expect(rowTitles()).toEqual(['Neu', 'Einkauf Samstag'])
    await click(byText('Actions for “Einkauf Samstag”'))
    await click(byText('Pin', document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!))
    expect(calls.find((call) => call.method === 'PUT' && call.path === '/api/notes/b/pin')!.body).toEqual({ pinned: true })
    expect(rowTitles()).toEqual(['Einkauf Samstag', 'Neu'])
    expect(headings()[0]).toBe('Pinned')
    expect(box.querySelector('[data-note="b"] [aria-label="pinned"]')).not.toBeNull()
    expect(box.querySelector('[data-note="a"] [aria-label="pinned"]')).toBeNull()
    // Also in tiles, and also when grouping is off: then the others stand under a heading of their own, apart from the
    // pinned ones.
    views.set('h', { ...DEFAULT_VIEW, grouped: false })
    lookIs('tiles')
    act(() => root.unmount())
    root = createRoot(box)
    await render('h')
    expect(headings()).toEqual(['Pinned', 'Notes'])
    expect($$('note-tile')[0].textContent).toContain('Einkauf Samstag')
    // Unpinned from the right click.
    await act(async () => $$('note-tile')[0].parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 })))
    await click(byText('Unpin', document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!))
    expect(calls.filter((call) => call.path === '/api/notes/b/pin').at(-1)!.body).toEqual({ pinned: false })
    expect(headings()).toEqual([])
  })

  it('NOTES-6 AC-6 without date groups the other notes stand apart under "Notes", by title as well', async () => {
    items = [item('a', { title: 'Zettel' }), item('b', { title: 'Abfall', pinned: true }), item('c', { title: 'Baumarkt' })]
    views.set('h', { ...DEFAULT_VIEW, sort: 'title', direction: 'asc' })
    await render('h')
    expect(headings()).toEqual(['Pinned', 'Notes'])
    expect(rowTitles()).toEqual(['Abfall', 'Baumarkt', 'Zettel'])
    // The heading stands between the pinned note and the others.
    const topOf = (element: HTMLElement) => parseFloat(element.closest<HTMLElement>('[style*="top"]')!.style.top)
    const [pinnedHeading, notesHeading] = $$('list-group-heading').map(topOf)
    const top = (id: string) => topOf(box.querySelector<HTMLElement>(`[data-note="${id}"]`)!)
    expect(pinnedHeading).toBeLessThan(top('b'))
    expect(top('b')).toBeLessThan(notesHeading)
    expect(notesHeading).toBeLessThan(top('c'))
    // Nothing pinned: no heading at all.
    expect(arrange(fifty(), { ...DEFAULT_VIEW, grouped: false }, NOW).map((section) => section.key)).toEqual(['all'])
    const somePinned = fifty().map((note, index) => (index === 7 ? { ...note, pinned: true } : note))
    expect(arrange(somePinned, { ...DEFAULT_VIEW, grouped: false }, NOW).map((section) => section.key)).toEqual(['pinned', 'notes'])
    // In German as well.
    await act(async () => void (await i18n.changeLanguage('de')))
    await settle()
    expect(headings()).toEqual(['Angeheftet', 'Notizen'])
  })

  it('the menu of a note in the list has the entries of the note menu, with its conditions and words', async () => {
    items = [item('a', { title: 'Geschenkideen' }), item('b', { title: 'Tresor', locked: true })]
    const headOf = (id: string, extra: Record<string, unknown> = {}) => ({
      ...items.find((note) => note.id === id), path: [{ id: 'h', name: 'Haushalt', inbox: false }], updated_by: null,
      owner: { id: 0, name: 'tester' }, deleted_at: null, can_write: true, can_share: true, paper: 'blank', ...extra,
    })
    heads = { a: headOf('a'), b: headOf('b', { locked: true }) }
    await render('h')
    await click(byText('Actions for “Geschenkideen”'))
    const menu = document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!
    const words = [...menu.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim())
    const tr = (key: string) => i18n.t(key)
    const at = (word: string) => words.indexOf(word)
    for (const key of ['shares.menu', 'editor.duplicate', 'export.menu', 'history.menu', 'editor.delete']) expect(words, key).toContain(tr(key))
    // In the order of the note menu, after pinning and the tabs.
    expect(at(tr('noteList.menu.pin'))).toBeLessThan(at(tr('shares.menu')))
    expect([at(tr('shares.menu')), at(tr('editor.duplicate')), at(tr('export.menu')), at(tr('history.menu')), at(tr('editor.delete'))]).toEqual(
      [...[at(tr('shares.menu')), at(tr('editor.duplicate')), at(tr('export.menu')), at(tr('history.menu')), at(tr('editor.delete'))]].sort((x, y) => x - y),
    )
    // The paper as well, and the list's own color row only once.
    expect(menu.querySelector('[data-testid="note-item-note-entries"] [role="menuitemradio"]')).not.toBeNull()
    expect(menu.querySelectorAll('[data-testid="note-colors"]')).toHaveLength(0)
    // Duplicate does what the note menu does.
    await click(byText(tr('editor.duplicate'), menu))
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/notes/a/duplicate')).toBe(true)
    expect(document.querySelector('[data-testid="note-item-menu"]')).toBeNull()
    // A locked note: as an open locked note, nothing that reads its text (share, duplicate, export), by the right click too.
    await act(async () => box.querySelector<HTMLElement>('[data-note="b"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 })))
    await settle()
    const locked = document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!
    const lockedWords = [...locked.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim())
    expect(lockedWords).toContain(tr('history.menu'))
    expect(lockedWords).toContain(tr('editor.delete'))
    for (const key of ['shares.menu', 'editor.duplicate', 'export.menu']) expect(lockedWords, key).not.toContain(tr(key))
  })

  it('NOTES-6 AC-8 a color from the fixed row: a stripe on the tile, a mark in the list', async () => {
    items = [item('a', { title: 'Geschenkideen' })]
    await render('h')
    expect($('note-color')).toBeNull()
    await click(byText('Actions for “Geschenkideen”'))
    const menu = document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(13)
    await click(byText('Green', menu))
    expect(calls.find((call) => call.path === '/api/notes/a/color')!.body).toEqual({ color: 'green' })
    expect($('note-color')!.style.background).toBe('rgb(74, 222, 128)')
    await click(byText('Tiles', await viewMenu()))
    expect($('note-tile')!.querySelector<HTMLElement>('[data-testid="note-color"]')!.style.background).toBe('rgb(74, 222, 128)')
  })

  // ---- AC-7 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 AC-7 all notes shows own and shared ones with both counts, the folder and its stripe', async () => {
    items = [
      item('a', { title: 'Einkauf', folder_id: 'h' }),
      item('b', { title: 'Linsensuppe', folder_id: 'r' }),
      item('c', { title: 'Elternabend', folder_id: 'x', owner: { id: 7, name: 'Lena' } }),
    ]
    shared = 1
    await render(undefined, 'All notes')
    expect($('list-counts')!.textContent).toBe('2 own, 1 shared with you')
    const row = (id: string) => box.querySelector<HTMLElement>(`[data-note="${id}"]`)!
    expect(row('a').textContent).toContain('Haushalt')
    expect((row('a').firstElementChild as HTMLElement).style.background).toBe('rgb(242, 193, 78)')
    expect(row('b').textContent).toContain('Rezepte')
    expect(row('c').textContent).toContain('Shared with me')
    expect(row('c').textContent).toContain('from Lena')
    // Somebody else's note has no menu here and is not dragged off into a folder.
    expect(row('c').querySelector('button')).toBeNull()
    expect(row('c').draggable).toBe(false)
    // Without shared notes the count is the own one alone.
    shared = 0
    items = items.slice(0, 2)
    act(() => root.unmount())
    root = createRoot(box)
    await render(undefined, 'All notes')
    expect($('list-counts')!.textContent).toBe('2 notes')
  })

  it('NOTES-6 AC-7 on a narrow list (beside an open note, the phone) the folder goes in the second line', async () => {
    // The list measures 300 px, like the column beside an open note.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly told: ResizeObserverCallback) {}
        observe() {
          this.told([{ contentRect: { width: 300 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        disconnect() {}
        unobserve() {}
      },
    )
    items = [item('a', { title: 'Einkauf', folder_id: 'h', preview: 'Milch' }), item('c', { title: 'Elternabend', folder_id: 'x', owner: { id: 7, name: 'Lena' } })]
    await render(undefined, 'All notes')
    const row = (id: string) => box.querySelector<HTMLElement>(`[data-note="${id}"]`)!
    const place = row('a').querySelector<HTMLElement>('[data-testid="note-folder"]')!
    expect(place.textContent).toBe('Haushalt')
    // In the link's second line, beside the date, not as a column of its own.
    expect(place.closest('[data-testid="note-row"]')).not.toBeNull()
    expect(place.parentElement!.textContent).toContain('Milch')
    expect((row('a').firstElementChild as HTMLElement).style.background).toBe('rgb(242, 193, 78)')
    expect(row('c').querySelector('[data-testid="note-folder"]')!.textContent).toBe('Shared with me')
    // A folder's own list names no folder, narrow or not.
    act(() => root.unmount())
    root = createRoot(box)
    await render('h', 'Haushalt')
    expect($('note-folder')).toBeNull()
  })

  it('NOTES-6 AC-3 a narrow tile has its "…" at the end of the bottom line, a wide one beside the title; both open the menu', async () => {
    // Review of 22.11.2026: on a phone two tiles stand side by side and the "…" took width from the title.
    let width = 358
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly told: ResizeObserverCallback) {}
        observe() {
          this.told([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        disconnect() {}
        unobserve() {}
      },
    )
    lookIs('tiles')
    items = [
      item('a', { title: 'Urlaubsplanung', pinned: true, attachments: 2, tags: ['reise'], tasks: { done: 0, total: 5 } }),
      item('b', { title: 'Willkommen' }),
    ]
    const tile = (id: string) => box.querySelector<HTMLElement>(`[data-note="${id}"]`)!
    const more = () => byText('Actions for “Urlaubsplanung”', tile('a'))
    const titleRow = () => tile('a').querySelector<HTMLElement>('[data-testid="note-tile-title"]')!.closest<HTMLElement>('[style]')!
    const foot = () => tile('a').querySelector<HTMLElement>('[data-testid="note-tile-foot"]')!
    const menuOpens = async () => {
      expect(document.querySelector('[data-testid="note-item-menu"]')).toBeNull()
      await click(more())
      const menu = document.querySelector<HTMLElement>('[data-testid="note-item-menu"]')!
      expect(menu.textContent).toContain('Unpin')
      await act(async () => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()
      expect(document.querySelector('[data-testid="note-item-menu"]')).toBeNull()
    }

    await render('h')
    expect($$('list-grid')[0].style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    // Narrow: the "…" stands at the end of the bottom line, which keeps its width free; the title row keeps none.
    const place = tile('a').querySelector<HTMLElement>('[data-testid="note-tile-more-foot"]')!
    expect(place.contains(more())).toBe(true)
    expect(place.className).toMatch(/(^| )bottom-/)
    expect(place.className).not.toMatch(/(^| )top-/)
    expect(tile('a').querySelector('[data-testid="note-tile-buttons"]')).toBeNull()
    expect(titleRow().contains(more())).toBe(false)
    expect(titleRow().style.paddingRight).toBe('0px')
    // The bottom line keeps the "…" free: 28 px, on a phone or touch screen 48 px, where every button is 44 px.
    expect(foot().className).toContain('nn-tile-foot-more')
    const fs = (await import(/* @vite-ignore */ 'node:fs'.toString())) as { readFileSync: (f: string, e: string) => string }
    const css = fs.readFileSync('src/notes/list/list.css', 'utf-8')
    expect(css).toMatch(/\.nn-tile-foot-more\s*\{\s*padding-right:\s*28px;/)
    expect(css).toMatch(/@media \(max-width: 767px\), \(pointer: coarse\) \{\s*\.nn-tile-foot-more\s*\{\s*padding-right:\s*48px;/)
    expect(tile('a').querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1)
    // After the tile's link: the Tab key reaches it right after the tile, as before.
    expect(tile('a').querySelector('[data-testid="note-tile"]')!.compareDocumentPosition(more()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The pin stays with the title; in the bottom line the date gets cut first, the attachments stay.
    expect(titleRow().querySelector('[aria-label="pinned"]')).not.toBeNull()
    const line = tile('a').querySelector<HTMLElement>('[data-testid="hint-attachments"]')!
    expect(line.className).toContain('shrink-0')
    expect(line.parentElement!.firstElementChild!.className).toContain('truncate')
    await menuOpens()

    // Wide: as before, beside the title at the top.
    width = 1024
    act(() => root.unmount())
    root = createRoot(box)
    await render('h')
    expect($$('list-grid')[0].style.gridTemplateColumns).not.toBe('repeat(2, minmax(0, 1fr))')
    expect(tile('a').querySelector('[data-testid="note-tile-more-foot"]')).toBeNull()
    expect(tile('a').querySelector('[data-testid="note-tile-buttons"]')!.contains(more())).toBe(true)
    expect(titleRow().style.paddingRight).toBe('24px')
    expect(foot().className).not.toContain('nn-tile-foot-more')
    expect(titleRow().querySelector('[aria-label="pinned"]')).not.toBeNull()
    await menuOpens()
  })

  it('NOTES-6 AC-2 rows and tiles show the date of the last change, also when sorted by creation', async () => {
    const created = new Date(2025, 2, 3, 10, 0).toISOString()
    items = [item('a', { title: 'Alt angelegt', created_at: created, updated_at: new Date(Date.now() - 60_000).toISOString() })]
    views.set('h', { ...DEFAULT_VIEW, sort: 'created' })
    await render('h')
    const changed = new Date(Date.now() - 60_000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    const made = new Date(created).toLocaleDateString('en', { day: 'numeric', month: 'numeric', year: 'numeric' })
    const row = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(row.textContent).toContain(changed)
    expect(row.textContent).not.toContain(made)
    // Sorted and grouped by creation all the same.
    expect(headings()).toEqual(['March 2025'])
    await click(byText('Tiles', await viewMenu()))
    const tile = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(tile.textContent).toContain(changed)
    expect(tile.textContent).not.toContain(made)
  })

  // ---- AC-2, AC-3, AC-9 (checked by eye; the pieces are checked here) ---------------------------------------------------

  it('NOTES-6 AC-2 AC-3 AC-9 rows and tiles carry tags, shared mark, picture count, progress and marks', async () => {
    items = [
      item('a', {
        title: 'Einkauf Samstag',
        preview: 'Milch, Tomaten',
        tags: ['einkauf', { name: 'samstag' }],
        shared: { names: ['Anna'] },
        tasks: { done: 3, total: 8 },
        media: { kind: 'image', count: 2 },
      }),
      item('b', { title: 'Kompost', title_check: true, media: { kind: 'scan', count: 1, text: true } }),
      item('c', { title: 'Ohne alles' }),
    ]
    await render('h')
    const row = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(row.textContent).toContain('#einkauf #samstag')
    expect(row.textContent).toContain('shared with Anna')
    expect(row.textContent).toContain('3 of 8')
    expect(row.textContent).toContain('Milch, Tomaten')
    expect(box.querySelector('[data-note="b"]')!.textContent).toContain('Check title')
    expect(box.querySelector('[data-note="b"] [aria-label="Scan · text recognized"]')).not.toBeNull()
    expect(box.querySelector('[data-note="c"]')!.textContent).not.toContain('#')
    await click(byText('Tiles', await viewMenu()))
    const tile = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(tile.querySelector('[data-testid="note-media"]')!.textContent).toBe('2 photos')
    expect(tile.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('38')
    expect(tile.textContent).toContain('3 of 8 · shared with Anna')
    expect(box.querySelector('[data-note="b"] [data-testid="note-media"]')!.textContent).toBe('Scan · text recognized')
    expect(box.querySelector('[data-note="c"] [data-testid="note-media"]')).toBeNull()
  })

  // ---- EC-1 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 EC-1 an empty folder opened from the tree invites to a new note in it and to drag notes in', async () => {
    const started: string[] = []
    registerNoteActions({ newNote: (id) => started.push(id) })
    folders.push({ ...folder('g', 'Garten', 'green'), count: 0 })
    // The folder page as the app shows it (`/folder/<id>`): its empty state is the one a member sees.
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/folder/g']}>
          <Routes>
            <Route path="/folder/:id" element={<FolderPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    )
    await settle()
    const empty = $('folder-empty')!
    expect(empty.textContent).toContain('No notes in “Garten” yet')
    expect(empty.textContent).toContain('drag')
    await click(byText('New note in “Garten”', empty))
    expect(started).toEqual(['g'])
    // The list's own empty state says the same, for a folder whose count was not yet up to date.
    act(() => root.unmount())
    root = createRoot(box)
    await render('h', 'Haushalt')
    const stale = $('list-empty')!
    expect(stale.textContent).toContain('No notes in “Haushalt” yet')
    expect(stale.textContent).toContain('drag')
    await click(byText('New note in “Haushalt”', stale))
    expect(started).toEqual(['g', 'h'])
  })

  // ---- EC-2 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 EC-2 ten thousand notes are ordered at once and only those on screen are drawn', async () => {
    const many = Array.from({ length: 10_000 }, (_, index) =>
      item(`n${index}`, { title: `Notiz ${index}`, updated_at: new Date(Date.now() - index * 600_000).toISOString(), pinned: index % 500 === 0 }),
    )
    let started = performance.now()
    const sections = arrange(many, DEFAULT_VIEW, new Date(), 'de')
    const placed = layout(sections, 'list', 1024)
    expect(performance.now() - started).toBeLessThan(400)
    started = performance.now()
    arrange(many, { ...DEFAULT_VIEW, sort: 'title', direction: 'asc' }, new Date(), 'de')
    expect(performance.now() - started).toBeLessThan(400)
    const [from, to] = visibleRange(placed.entries, 300_000, 300_900)
    expect(to - from).toBeLessThan(40)
    // On the page: the window over the scrolled list holds a few dozen rows, not ten thousand.
    items = many
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.testid === 'note-window' ? -120_000 : 0
      return { top, bottom: top + 800, left: 0, right: 1024, width: 1024, height: this.dataset.testid === 'note-window' ? 700_000 : 800, x: 0, y: top, toJSON: () => ({}) }
    })
    started = performance.now()
    await render('h')
    expect($$('note-row').length).toBeGreaterThan(5)
    expect($$('note-row').length).toBeLessThan(60)
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it('NOTES-6 EC-2 the list of the page a tab opens on is asked for before the first render, and taken once', async () => {
    expect(listKeyOf('/', '')).toBe('all')
    expect(listKeyOf('/folder/h', '')).toBe('h')
    expect(listKeyOf('/notes/x', '?folder=h')).toBe('h')
    expect(listKeyOf('/notes/x', '')).toBe('all')
    expect(listKeyOf('/settings', '')).toBeNull()
    items = [item('a', { title: 'Früh' })]
    preloadList('/folder/h', '')
    expect(calls.map((call) => call.path)).toEqual(['/api/note-list', '/api/note-list/stamp'])
    await render('h')
    // The list drew from the answer already on its way: nothing asked twice.
    expect(calls.filter((call) => call.path === '/api/note-list')).toHaveLength(1)
    expect(rowTitles()).toEqual(['Früh'])
    // Asked for another list (the page changed meanwhile): the list asks for its own.
    act(() => root.unmount())
    root = createRoot(box)
    preloadList('/', '')
    await render('h')
    expect(calls.filter((call) => call.path === '/api/note-list').map((call) => call.query.get('folder_id'))).toEqual(['h', null, 'h'])
    // Signed out or failed: the list asks itself as well.
    act(() => root.unmount())
    root = createRoot(box)
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }))
    preloadList('/folder/h', '')
    await render('h')
    expect(calls.filter((call) => call.path === '/api/note-list')).toHaveLength(4)
    expect(rowTitles()).toEqual(['Früh'])
    // Another account signed in meanwhile: what was asked for the first one is not taken.
    act(() => root.unmount())
    root = createRoot(box)
    preloadList('/folder/h', '')
    accountChanged()
    await render('h')
    expect(calls.filter((call) => call.path === '/api/note-list')).toHaveLength(6)
  })

  // ---- EC-3, EC-5 -------------------------------------------------------------------------------------------------------

  it('NOTES-6 EC-3 a locked note shows its title and the lock, nothing of its text', async () => {
    items = [item('a', { title: 'WLAN-Gäste und Codes', locked: true, preview: 'Passwort: geheim', tasks: { done: 1, total: 2 }, tags: ['wlan'], media: { kind: 'image', count: 1 } })]
    await render('h')
    const row = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(row.textContent).toContain('WLAN-Gäste und Codes')
    expect(row.querySelector('[aria-label="locked"]')).not.toBeNull()
    for (const hidden of ['geheim', '1 of 2', '#wlan', 'photo']) expect(row.textContent).not.toContain(hidden)
    await click(byText('Tiles', await viewMenu()))
    const tile = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(tile.textContent).toContain('Locked')
    expect(tile.querySelector('[role="progressbar"]')).toBeNull()
    expect(tile.textContent).not.toContain('geheim')
  })

  it('NOTES-6 EC-5 a title or text with HTML or a script is shown as text, never run', async () => {
    const title = '<script>window.ran = true</script><b>Fett</b>'
    const preview = '<img src=x onerror="window.ran = true"> & <i>kursiv</i>'
    items = [item('a', { title, preview, tags: ['<u>x</u>'], owner: { id: 2, name: '<em>Lena</em>' } })]
    await render(undefined, 'All notes')
    const row = box.querySelector<HTMLElement>('[data-note="a"]')!
    expect(row.textContent).toContain(title)
    expect(row.textContent).toContain(preview)
    expect(row.textContent).toContain('from <em>Lena</em>')
    expect(row.querySelector('script, b, img, i, u, em')).toBeNull()
    await click(byText('Tiles', await viewMenu()))
    expect(box.querySelector('[data-note="a"] script, [data-note="a"] img')).toBeNull()
    expect((window as { ran?: boolean }).ran).toBeUndefined()
  })

  // ---- EC-6 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 EC-6 a note changed on another device shows up without reloading, only when the stamp moved', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    items = [item('a', { title: 'Handwerker Bad', preview: 'Montag' }), item('b', { title: 'Zweite' })]
    await render('h')
    const reads = () => calls.filter((call) => call.path === '/api/note-list').length
    expect(reads()).toBe(1)
    await act(async () => vi.advanceTimersByTime(STAMP_EVERY_MS))
    await settle()
    expect(reads()).toBe(1)
    // The phone changed the text: a new stamp, the list follows on its own.
    items = items.map((note) => (note.id === 'a' ? { ...note, preview: 'Dienstag um 9 Uhr' } : note))
    stampValue++
    const before = box.querySelector('[data-note="b"]')
    await act(async () => vi.advanceTimersByTime(STAMP_EVERY_MS))
    await settle()
    expect(reads()).toBe(2)
    expect(box.querySelector('[data-note="a"]')!.textContent).toContain('Dienstag um 9 Uhr')
    // The other rows stay the same elements: nothing is drawn anew from scratch.
    expect(box.querySelector('[data-note="b"]')).toBe(before)
  })

  it('NOTES-6 EC-6 the note at the top of the screen keeps its place when notes arrive above it', () => {
    const first = layout(arrange(fifty(), DEFAULT_VIEW, NOW), 'list', 1024)
    const from = 1000
    const anchor = anchorOf(first.entries, from)!
    const topOf = (entries: typeof first.entries, id: string) => entries.find((entry) => (entry.kind === 'row' && entry.item.id === id) || entry.key === id)!.top
    const before = topOf(first.entries, anchor.id)
    // Three new notes come in at the top.
    const more = [...fifty(), item('x1', { updated_at: NOW.toISOString() }), item('x2', { updated_at: NOW.toISOString() }), item('x3', { updated_at: NOW.toISOString() })]
    const second = layout(arrange(more, DEFAULT_VIEW, NOW), 'list', 1024)
    const shift = shiftFor(anchor, second.entries, from)
    const after = topOf(second.entries, anchor.id)
    expect(shift).toBe(after - before)
    expect(shift).toBeGreaterThan(0)
    // At the very top nothing is held: new notes simply show.
    expect(anchorOf(first.entries, 0)).toBeNull()
  })

  it('NOTES-6 EC-2 the window draws one screen of a long list at first, not hundreds of entries on the way', async () => {
    // A measured page: the list at the top of a 600 px column.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === 'note-window' ? 640_000 : 600
      return { top: 0, bottom: height, left: 0, right: 1024, width: 1024, height, x: 0, y: 0, toJSON: () => ({}) }
    })
    const many = Array.from({ length: 10_000 }, (_, index) => item(`n${index}`, { updated_at: new Date(NOW.getTime() - index * 60_000).toISOString() }))
    const placed = layout(arrange(many, DEFAULT_VIEW, NOW), 'list', 1024)
    let drawn = 0
    await act(async () =>
      root.render(
        <div style={{ overflowY: 'auto', height: 600 }}>
          <Window
            entries={placed.entries}
            height={placed.height}
            render={(entry) => {
              drawn++
              return entry.key
            }}
          />
        </div>,
      ),
    )
    // The first drawing and the measured one together: a few dozen entries.
    expect(drawn).toBeGreaterThan(5)
    expect(drawn).toBeLessThan(100)
    expect(box.querySelectorAll('[data-testid="note-window"] > div').length).toBeLessThan(40)
  })

  it('NOTES-6 EC-6 the window scrolls by what arrived above, so the note at the top of the screen does not jump', async () => {
    // A scrolling column of 600 px, scrolled down 1000 px; the window measures itself against it.
    let scrolled = 0
    let total = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const inWindow = this.dataset.testid === 'note-window'
      const top = inWindow ? -scrolled : 0
      const height = inWindow ? total : 600
      return { top, bottom: top + height, left: 0, right: 1024, width: 1024, height, x: 0, y: top, toJSON: () => ({}) }
    })
    const show = async (entries: ReturnType<typeof layout>) => {
      total = entries.height
      await act(async () =>
        root.render(
          <div data-testid="scroller" style={{ overflowY: 'auto', height: 600 }}>
            <Window entries={entries.entries} height={entries.height} render={(entry) => <span data-entry={entry.key}>{entry.key}</span>} />
          </div>,
        ),
      )
    }
    const first = layout(arrange(fifty(), DEFAULT_VIEW, NOW), 'list', 1024)
    await show(first)
    const scroller = $('scroller')!
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrolled, set: (value: number) => void (scrolled = value) })
    scrolled = 1000
    await act(async () => scroller.dispatchEvent(new Event('scroll')))
    // Where the note at the top of the screen stands, seen from the top of the screen.
    const anchor = anchorOf(first.entries, 1000)!
    const onScreen = () => parseFloat(box.querySelector<HTMLElement>(`[data-entry="${anchor.id}"]`)!.parentElement!.style.top) - scrolled
    const before = onScreen()
    expect(box.querySelectorAll('[data-entry]').length).toBeLessThan(40)
    // Three notes arrive at the top (another device): the list grows above the screen, the window scrolls along.
    const more = [...fifty(), ...['x1', 'x2', 'x3'].map((id) => item(id, { updated_at: NOW.toISOString() }))]
    const second = layout(arrange(more, DEFAULT_VIEW, NOW), 'list', 1024)
    await show(second)
    expect(scrolled).toBe(1000 + 3 * SIZES.row)
    expect(onScreen()).toBe(before)
    // At the very top nothing is held: the new notes simply show.
    scrolled = 0
    await act(async () => scroller.dispatchEvent(new Event('scroll')))
    await show(first)
    expect(scrolled).toBe(0)
  })

  // ---- EC-7 -----------------------------------------------------------------------------------------------------------

  it('NOTES-6 EC-7 a note changed before midnight moves from Today to Yesterday after midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: new Date(2026, 10, 21, 23, 59, 0) })
    items = [item('a', { title: 'Spät', updated_at: new Date(2026, 10, 21, 23, 58, 0).toISOString() })]
    await render('h')
    expect(headings()).toEqual(['Today'])
    await act(async () => vi.advanceTimersByTime(2 * 60_000))
    await settle()
    expect(headings()).toEqual(['Yesterday'])
  })

  // ---- The pin in the editor --------------------------------------------------------------------------------------------

  it('NOTES-6 AC-6 the pin beside an open note pins and unpins it', async () => {
    items = [item('a')]
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotePinButton noteId="a" head={{ pinned: false }} />
        </MemoryRouter>,
      ),
    )
    const pin = $('note-pin')!
    expect(pin.getAttribute('aria-label')).toBe('Pin note')
    // The last write, not the last call: reads of other parts (the folders' stamp) may come between.
    const lastWrite = () => calls.filter((call) => call.method !== 'GET').at(-1)!
    await click(pin)
    expect(lastWrite().body).toEqual({ pinned: true })
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    await click(pin)
    expect(lastWrite().body).toEqual({ pinned: false })
  })
})
