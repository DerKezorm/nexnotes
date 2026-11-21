/**
 * NOTES-7 in the interface: the editor with every kind of condition and "alle"/"mindestens eine" (AC-1, AC-2), the
 * preview (AC-3), the smart folder as a list or tiles (AC-4), saving from the search and from a tag's page (AC-5, and
 * the real tests of NOTES-9 AC-6 and NOTES-5 AC-6), deleting with a question (AC-6), the two that come with an account
 * (AC-7), the section "Intelligent" with its order (AC-8), conditions that point nowhere (EC-1), nothing that fits
 * (EC-2), the device's zone (EC-3), a name taken (EC-6), and "New note" going into the inbox (NOTES-4 AC-9).
 * "Mit mir geteilt" and "Anhänge" are presets in the place of the sidebar's fixed entries, "Anhänge" opening as the
 * gallery of its notes' attachments.
 *
 * The real search page and the real tag page are on show, with smart folders docked on (`register.tsx`); a small
 * stand-in for the server keeps the smart folders.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'

import { SIDEBAR_SECTIONS } from '../extensions'
// The folders' section first, as in `main.tsx`: smart folders take their place right after it.
import '../folders'
// Sharing and attachments as `main.tsx` docks them: neither brings a fixed entry of the sidebar any more.
import '../attachments'
import '../shares'
import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import type { GalleryItem } from '../attachments/api'
import { notesChanged } from '../notes/api'
import type { ListItem } from '../notes/list/api'
import { folderOfList, hrefIn, isListPath, listNameOf, noteOf } from '../notes/workspace'
import { SearchPage } from '../search/SearchPage'
import { forgetTags } from '../tags/store'
import { TagPage } from '../tags/TagPage'
import type { Condition, Preset, SmartFolder } from './api'
import { fromSearch, nameFromSearch } from './conditions'
import { moved } from './order'
// Docks smart folders onto the frame, as `main.tsx` does: the sidebar, the routes, the buttons of search and tags.
import './register'
import { SmartEditor } from './SmartEditor'
import { SmartFolderPage } from './SmartFolderPage'
import { SmartSection } from './SmartSection'
import { forgetSmartFolders } from './store'

// ---- The stand-in server -------------------------------------------------------------------------------------------

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let smart: SmartFolder[] = []
let items: ListItem[] = []
let broken: { index: number; kind: 'folder' | 'tag'; name: string }[] = []
let views: Record<string, string> = {}
let gallery: GalleryItem[] = []
let made = 0
const INBOX = 'inbox-1'

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** One moment for every note of a test: notes made a millisecond apart would change their order. */
const AT = new Date(Date.now() - 60_000).toISOString()

function item(id: string, extra: Partial<ListItem> = {}): ListItem {
  const at = AT
  return { id, folder_id: 'f1', title: id, title_check: false, origin: '', preview: '', created_at: at, updated_at: at, pinned: false, color: '', tasks: null, ...extra }
}

const PRESET_NAMES: Record<string, string[]> = {
  open_tasks: ['Offene Checklisten', 'Open checklists'],
  recent: ['Zuletzt bearbeitet', 'Recently edited'],
  shared_with_me: ['Mit mir geteilt', 'Shared with me'],
  attachments: ['Anhänge', 'Attachments'],
}

function taken(name: string, besides = ''): SmartFolder | undefined {
  const names = (folder: SmartFolder) => (folder.name ? [folder.name] : PRESET_NAMES[folder.preset])
  return smart.find((folder) => folder.id !== besides && names(folder).some((one) => one.toLowerCase() === name.trim().toLowerCase()))
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (path === '/api/folders') return reply(200, { inbox: { id: INBOX, count: 0 }, folders: [{ id: 'f1', parent_id: null, name: 'Rezepte', icon: '', color: '', position: 0, count: 2 }] })
  if (path === '/api/tags') return reply(200, { tags: [{ key: 'einkauf', label: 'einkauf', count: 3 }], total: 1 })
  if (path === '/api/tags/einkauf')
    return reply(200, { key: 'einkauf', label: 'einkauf', count: 1, mine: 1, others: [], notes: [{ id: 'n1', title: 'Samstag', preview: '', updated_at: new Date().toISOString(), mine: true, folder: null, owner: null }] })
  if (path === '/api/search') return reply(200, { total: 1, offset: 0, items: [], unfiltered: null, terms: [], tags: [] })
  if (path === '/api/smart-folders' && method === 'GET') return reply(200, { items: smart })
  if (path === '/api/smart-folders' && method === 'POST') {
    const name = String(body?.name ?? '')
    const there = taken(name)
    if (there) return reply(409, { detail: { code: 'smart_folder_exists', message: 'x', name: there.name || 'Offene Checklisten' } })
    const folder: SmartFolder = { id: `s${++made}`, name: name.trim(), preset: '', match: (body?.match as 'all' | 'any') ?? 'all', conditions: body?.conditions as Condition[], position: smart.length }
    smart = [...smart, folder]
    return reply(201, folder)
  }
  if (path === '/api/smart-folders/order') {
    const ids = body?.ids as string[]
    smart = ids.map((id) => smart.find((folder) => folder.id === id)!).concat(smart.filter((folder) => !ids.includes(folder.id)))
    return reply(200, { items: smart })
  }
  if (path === '/api/smart-folders/preview') {
    const conditions = body?.conditions as Condition[]
    const fitting = conditions.some((condition) => condition.kind === 'tasks') ? items.filter((one) => one.tasks) : items
    return reply(200, { total: fitting.length + (body?.match === 'any' ? 10 : 0), items: fitting, broken: [] })
  }
  const one = /^\/api\/smart-folders\/([^/]+)(?:\/(notes|stamp|view|attachments))?$/.exec(path)
  if (one) {
    const [, id, what] = one
    const folder = smart.find((each) => each.id === id)
    if (!folder) return reply(404, { detail: { code: 'smart_folder_not_found', message: 'x' } })
    if (what === 'notes')
      return reply(200, { key: `s:${id}`, view: { mode: views[id] ?? 'list', sort: 'updated', direction: 'desc', grouped: true }, counts: { own: items.length, shared: 0 }, items, folder, broken })
    if (what === 'stamp') return reply(200, { stamp: '1' })
    if (what === 'attachments') {
      const kind = call.query.get('kind')
      const chosen = gallery.filter((each) => !kind || each.kind === kind)
      const counts = { image: 0, scan: 0, pdf: 0, recording: 0, drawing: 0, video: 0, file: 0 }
      for (const each of gallery) counts[each.kind as keyof typeof counts] += 1
      return reply(200, { total: chosen.length, all: gallery.length, bytes: 2048, counts, items: chosen })
    }
    if (what === 'view') {
      views[id] = String(body?.mode ?? views[id] ?? 'list')
      return reply(200, { mode: views[id], sort: 'updated', direction: 'desc', grouped: true })
    }
    if (method === 'GET') return reply(200, folder)
    if (method === 'PUT') {
      if (body?.name && taken(String(body.name), id)) return reply(409, { detail: { code: 'smart_folder_exists', message: 'x', name: String(body.name) } })
      Object.assign(folder, body)
      return reply(200, folder)
    }
    if (method === 'DELETE') {
      smart = smart.filter((each) => each.id !== id)
      return reply(204, null)
    }
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

// ---- Rendering -----------------------------------------------------------------------------------------------------

let root: Root | null = null
let box: HTMLDivElement
let where = ''

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

async function render(path: string): Promise<void> {
  window.history.replaceState({ idx: 0 }, '', path)
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root!.render(
      <BrowserRouter>
        <Where />
        <SmartSection />
        <Routes>
          <Route path="/" element={<div data-testid="home" />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/tags/:tag" element={<TagPage />} />
          <Route path="/smart/new" element={<SmartEditor />} />
          <Route path="/smart/:id/edit" element={<SmartEditor />} />
          <Route path="/smart/:id" element={<SmartFolderPage />} />
        </Routes>
      </BrowserRouter>,
    )
  })
  await settle(60)
}

const $ = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => Array.from(box.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`))
const anywhere = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  await settle()
}

async function typeInto(input: HTMLElement | null, value: string): Promise<void> {
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLElement | null, value: string): Promise<void> {
  expect(select).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function press(target: Element, key: string, extra: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  })
  await settle()
}

const posted = (path: string, method = 'POST') => calls.filter((call) => call.path === path && call.method === method)
/** Long enough for the pause of the preview and its answer. */
const previewed = () => settle(400)

const PRESET_CONDITIONS: Record<Exclude<Preset, ''>, Condition[]> = {
  open_tasks: [{ kind: 'tasks', op: 'open' }],
  recent: [{ kind: 'date', field: 'updated', period: 'week' }],
  shared_with_me: [{ kind: 'shared', op: 'with_me' }],
  attachments: [{ kind: 'attachment', type: 'any' }],
}

function preset(id: string, kind: Exclude<Preset, ''>, position: number): SmartFolder {
  return { id, name: '', preset: kind, match: 'all', conditions: PRESET_CONDITIONS[kind], position }
}

function attachment(id: string, kind: GalleryItem['kind'], note: string): GalleryItem {
  return {
    id, note_id: note, kind, name: `${id}.bin`, mime: 'application/octet-stream', size: 1024, width: null, height: null, pages: null,
    duration_ms: null, view: false, thumb: false, inline: false, created_at: null, note: { id: note, title: note },
  }
}

beforeEach(async () => {
  calls = []
  made = 0
  smart = [preset('p1', 'open_tasks', 0), preset('p2', 'recent', 1)]
  items = []
  broken = []
  views = {}
  gallery = []
  forgetFolders()
  forgetTags()
  forgetSmartFolders()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const call = { method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname), query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      return answer(call)
    }),
  )
  await i18n.changeLanguage('de')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  box?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// ---- The tests -----------------------------------------------------------------------------------------------------

describe('NOTES-7 smart folders', () => {
  it('NOTES-7 AC-1 AC-2 the editor makes every kind of condition and "at least one" of them', async () => {
    await render('/smart/new')
    await typeInto($('smart-name'), 'Alles Mögliche')
    // The first row starts as a tag.
    await typeInto($('smart-tag'), '#Rezept')
    await choose($('smart-tag-op'), 'not')
    const kinds: [string, (row: HTMLElement) => Promise<void>][] = [
      ['folder', async (row) => {
        await choose(row.querySelector('[data-testid="smart-folder-op"]'), 'in')
        await choose(row.querySelector('[data-testid="smart-folder"]'), 'f1')
      }],
      ['updated', async (row) => choose(row.querySelector('[data-testid="smart-period"]'), 'today')],
      ['created', async (row) => {
        await choose(row.querySelector('[data-testid="smart-period"]'), 'custom')
        await typeInto(row.querySelector('[data-testid="smart-from"]'), '2026-03-01')
      }],
      ['tasks', async () => undefined],
      ['attachment', async (row) => choose(row.querySelector('[data-testid="smart-attachment"]'), 'sketch')],
      ['shared', async (row) => choose(row.querySelector('[data-testid="smart-shared"]'), 'by_me')],
      ['pinned', async () => undefined],
      ['color', async (row) => choose(row.querySelector('[data-testid="smart-color"]'), 'orange')],
      ['text', async (row) => typeInto(row.querySelector('[data-testid="smart-text"]'), '"rote Linsen"')],
    ]
    for (const [kind, fill] of kinds) {
      await click($('smart-add'))
      const row = $$('smart-condition-row').at(-1)!
      await choose(row.querySelector('[data-testid="smart-kind"]'), kind)
      await fill($$('smart-condition-row').at(-1)!)
    }
    await click($('smart-match-any'))
    expect($('smart-match-any')!.getAttribute('aria-checked')).toBe('true')
    await click($('smart-save'))
    const sent = posted('/api/smart-folders')[0].body!
    expect(sent.name).toBe('Alles Mögliche')
    expect(sent.match).toBe('any')
    expect(sent.conditions).toEqual([
      { kind: 'tag', op: 'not', key: 'rezept', label: 'Rezept' },
      { kind: 'folder', op: 'in', id: 'f1', name: 'Rezepte' },
      { kind: 'date', field: 'updated', period: 'today' },
      { kind: 'date', field: 'created', period: 'custom', from: '2026-03-01' },
      { kind: 'tasks', op: 'open' },
      { kind: 'attachment', type: 'sketch' },
      { kind: 'shared', op: 'by_me' },
      { kind: 'pinned' },
      { kind: 'color', color: 'orange' },
      { kind: 'text', value: '"rote Linsen"' },
    ])
    // Saved, the new smart folder opens.
    expect(where).toBe('/smart/s1')
  })

  it('NOTES-7 AC-1 a condition that is not complete is not sent, and removing one takes it out', async () => {
    await render('/smart/new')
    await typeInto($('smart-name'), 'Halb')
    expect(($('smart-save') as HTMLButtonElement).disabled).toBe(true)
    await click($('smart-add'))
    await choose($$('smart-kind').at(-1)!, 'tasks')
    expect(($('smart-save') as HTMLButtonElement).disabled).toBe(false)
    await click($$('smart-remove')[0])
    expect($$('smart-condition-row')).toHaveLength(1)
    await click($('smart-save'))
    expect(posted('/api/smart-folders')[0].body!.conditions).toEqual([{ kind: 'tasks', op: 'open' }])
  })

  it('NOTES-7 AC-3 the preview shows what fits right now, with its count, and follows every change', async () => {
    items = [item('Linsensuppe', { tasks: { done: 2, total: 6 } }), item('Shakshuka', { owner: { id: 2, name: 'Lena' } })]
    await render('/smart/new')
    expect($('smart-preview-count')!.textContent).toBe('Wähle eine Bedingung, dann siehst du hier, welche Notizen passen.')
    await choose($('smart-kind'), 'tasks')
    await previewed()
    expect($('smart-preview-count')!.textContent).toBe('Passt gerade: 1 Notiz')
    expect($$('smart-preview-item').map((one) => one.textContent)).toEqual([expect.stringMatching(/^LinsensuppeRezepte · 2 von 6 · /)])
    await click($('smart-add'))
    await choose($$('smart-kind').at(-1)!, 'pinned')
    await click($('smart-match-any'))
    await previewed()
    expect($('smart-preview-count')!.textContent).toBe('Passt gerade: 11 Notizen')
    const asked = posted('/api/smart-folders/preview')
    expect(asked.at(-1)!.body).toEqual({ match: 'any', conditions: [{ kind: 'tasks', op: 'open' }, { kind: 'pinned' }], tz: expect.any(String) })
  })

  it('NOTES-7 AC-4 opened it shows its notes as a list or as tiles, and the view is kept on the server', async () => {
    items = [item('Einkauf', { folder_id: 'f1' }), item('Packliste', { folder_id: INBOX })]
    await render('/smart/p1')
    expect(anywhere('smart-page')).not.toBeNull()
    expect($$('note-row').map((row) => row.querySelector('.truncate')!.textContent)).toEqual(['Einkauf', 'Packliste'])
    expect(box.querySelector('h1')!.textContent).toBe('Offene Checklisten')
    await click($('list-mode-tiles'))
    expect(posted('/api/smart-folders/p1/view', 'PUT')[0].body).toEqual({ mode: 'tiles' })
    expect($('note-list')!.getAttribute('data-mode')).toBe('tiles')
    // A note opens beside the list, in the workspace of the lists (NOTES-8 AC-9).
    expect($$('note-tile')[0].getAttribute('href')).toBe('/smart/p1?note=Einkauf')
  })

  it('NOTES-7 AC-5 NOTES-9 AC-6 from the search: "Als intelligenten Ordner sichern" makes one with exactly these conditions', async () => {
    await render('/search?q=rechn&folder=f1&tag=bad&period=week')
    await settle(200)
    await click($('search-save-smart'))
    expect(where).toBe('/smart/new')
    expect(($('smart-name') as HTMLInputElement).value).toBe('rechn')
    expect($$('smart-kind').map((select) => (select as HTMLSelectElement).value)).toEqual(['text', 'folder', 'tag', 'updated'])
    expect(($('smart-text') as HTMLInputElement).value).toBe('rechn')
    expect(($('smart-folder') as HTMLSelectElement).value).toBe('f1')
    expect(($('smart-tag') as HTMLInputElement).value).toBe('#bad')
    expect(($('smart-period') as HTMLSelectElement).value).toBe('week')
    await click($('smart-save'))
    expect(posted('/api/smart-folders')[0].body).toEqual({
      name: 'rechn',
      match: 'all',
      conditions: [
        { kind: 'text', value: 'rechn' },
        { kind: 'folder', op: 'tree', id: 'f1' },
        { kind: 'tag', op: 'has', key: 'bad', label: 'bad' },
        { kind: 'date', field: 'updated', period: 'week' },
      ],
    })
    expect(where).toBe('/smart/s1')
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).toContain('rechn')
  })

  it('NOTES-7 AC-5 a search turns into conditions: words, folder with subfolders, tag by its key, the period as a choice', () => {
    const search = { q: '  Rechnung "Bad"  ', folderId: 'f9', tag: 'Urlaub', period: 'custom' as const, from: '2026-01-01', to: '' }
    expect(fromSearch(search)).toEqual([
      { kind: 'text', value: 'Rechnung "Bad"' },
      { kind: 'folder', op: 'tree', id: 'f9' },
      { kind: 'tag', op: 'has', key: 'urlaub', label: 'Urlaub' },
      { kind: 'date', field: 'updated', period: 'custom', from: '2026-01-01' },
    ])
    expect(fromSearch({ q: '', folderId: '', tag: '', period: 'year', from: '', to: '' })).toEqual([{ kind: 'date', field: 'updated', period: 'year' }])
    expect(nameFromSearch({ ...search, q: '' })).toBe('#Urlaub')
  })

  it('NOTES-7 AC-5 NOTES-5 AC-6 from a tag page: the button is there and makes "#tag" with "tag has …"', async () => {
    await render('/tags/einkauf')
    await settle(100)
    await click($('tag-smart'))
    await settle(60)
    expect(posted('/api/smart-folders')[0].body).toEqual({ name: '#einkauf', match: 'all', conditions: [{ kind: 'tag', op: 'has', key: 'einkauf', label: 'einkauf' }] })
    expect(where).toBe('/smart/s1')
  })

  it('NOTES-7 EC-6 the same name twice: the tag page and the editor say so', async () => {
    smart = [...smart, { id: 'x', name: '#einkauf', preset: '', match: 'all', conditions: [], position: 2 }]
    await render('/tags/einkauf')
    await settle(100)
    await click($('tag-smart'))
    await settle(60)
    expect(box.textContent).toContain('Einen intelligenten Ordner „#einkauf“ gibt es schon. Wähle einen anderen Namen.')
    expect(where).toBe('/tags/einkauf')
    act(() => root?.unmount())
    box.remove()
    await render('/smart/new')
    await typeInto($('smart-name'), 'offene checklisten')
    await choose($('smart-kind'), 'tasks')
    await click($('smart-save'))
    expect(box.querySelector('[role="alert"]')!.textContent).toBe('Einen intelligenten Ordner „Offene Checklisten“ gibt es schon. Wähle einen anderen Namen.')
    expect(where).toBe('/smart/new')
  })

  it('NOTES-7 AC-6 editing keeps the folder, deleting asks once and goes without the trash', async () => {
    smart = [...smart, { id: 's7', name: 'Rezepte', preset: '', match: 'all', conditions: [{ kind: 'tag', op: 'has', key: 'rezept', label: 'rezept' }], position: 2 }]
    await render('/smart/s7/edit')
    await settle(60)
    expect(($('smart-name') as HTMLInputElement).value).toBe('Rezepte')
    expect(($('smart-tag') as HTMLInputElement).value).toBe('#rezept')
    await typeInto($('smart-name'), 'Rezepte zum Ausprobieren')
    await click($('smart-save'))
    expect(posted('/api/smart-folders/s7', 'PUT')[0].body).toEqual({ name: 'Rezepte zum Ausprobieren', match: 'all', conditions: [{ kind: 'tag', op: 'has', key: 'rezept', label: 'rezept' }] })
    expect(where).toBe('/smart/s7')
    await settle(60)
    await click($('smart-delete-open'))
    const dialog = anywhere('smart-delete')!
    expect(dialog.textContent).toContain('Nur der intelligente Ordner geht, ohne Papierkorb. Die Notizen darin bleiben, wo sie sind.')
    expect(posted('/api/smart-folders/s7', 'DELETE')).toHaveLength(0)
    await click(anywhere('smart-delete-confirm'))
    await settle(60)
    expect(posted('/api/smart-folders/s7', 'DELETE')).toHaveLength(1)
    expect(where).toBe('/')
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).toEqual(['Offene Checklisten', 'Zuletzt bearbeitet'])
  })

  it('NOTES-7 AC-7 the two that come with the account are named in the language of the page, and keep that while unchanged', async () => {
    await render('/smart/p2/edit')
    await settle(60)
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).toEqual(['Offene Checklisten', 'Zuletzt bearbeitet'])
    expect(($('smart-name') as HTMLInputElement).value).toBe('Zuletzt bearbeitet')
    await choose($('smart-period'), 'month')
    await click($('smart-save'))
    // Unchanged, the name stays the preset's: the next language shows its own.
    expect(posted('/api/smart-folders/p2', 'PUT')[0].body).toEqual({ name: '', match: 'all', conditions: [{ kind: 'date', field: 'updated', period: 'month' }] })
    act(() => root?.unmount())
    box.remove()
    await i18n.changeLanguage('en')
    forgetSmartFolders()
    await render('/')
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).toEqual(['Open checklists', 'Recently edited'])
  })

  it('NOTES-7 AC-7 "Mit mir geteilt" and "Anhänge" are smart folders with their old symbols; the sidebar has no fixed entries for them', async () => {
    smart = [...smart, preset('p3', 'shared_with_me', 2), preset('p4', 'attachments', 3)]
    await render('/')
    const keys = SIDEBAR_SECTIONS.map((section) => section.key)
    expect(keys).not.toContain('shared')
    expect(keys).not.toContain('attachments')
    const links = $$('sidebar-smart-folder')
    expect(links.map((link) => link.textContent)).toEqual(['Offene Checklisten', 'Zuletzt bearbeitet', 'Mit mir geteilt', 'Anhänge'])
    expect(links[2].querySelector('[data-testid="smart-icon-shared_with_me"]')).not.toBeNull()
    expect(links[3].querySelector('[data-testid="smart-icon-attachments"]')).not.toBeNull()
    expect(links[3].querySelector('[data-testid="smart-filter-icon"]')).toBeNull()
    // Deleted, it is gone like any other smart folder.
    act(() => root?.unmount())
    box.remove()
    smart = smart.filter((folder) => folder.id !== 'p3')
    forgetSmartFolders()
    await render('/')
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).not.toContain('Mit mir geteilt')
  })

  it('NOTES-7 AC-7 whoever deleted them makes them anew: "Geteilt: mit mir geteilt" and "Anhang" of any kind or one kind', async () => {
    await render('/smart/new')
    await typeInto($('smart-name'), 'Mit mir geteilt')
    await choose($('smart-kind'), 'shared')
    expect(($('smart-shared') as HTMLSelectElement).value).toBe('with_me')
    await click($('smart-add'))
    await choose($$('smart-kind').at(-1)!, 'attachment')
    const types = Array.from(($('smart-attachment') as HTMLSelectElement).options).map((option) => option.value)
    expect(types).toEqual(expect.arrayContaining(['any', 'image', 'pdf', 'recording', 'file']))
    expect(($('smart-attachment') as HTMLSelectElement).value).toBe('any')
    expect(Array.from(($('smart-attachment') as HTMLSelectElement).options).find((option) => option.value === 'recording')!.textContent).toBe('Aufnahme')
    await choose($('smart-attachment'), 'pdf')
    await previewed()
    expect(posted('/api/smart-folders/preview').at(-1)!.body!.conditions).toEqual([{ kind: 'shared', op: 'with_me' }, { kind: 'attachment', type: 'pdf' }])
    await click($('smart-save'))
    expect(posted('/api/smart-folders')[0].body).toEqual({ name: 'Mit mir geteilt', match: 'all', conditions: [{ kind: 'shared', op: 'with_me' }, { kind: 'attachment', type: 'pdf' }] })
  })

  it('NOTES-7 AC-4 "Anhänge" opens as the gallery of its notes\' attachments, beside list and tiles, and an entry opens its note', async () => {
    smart = [...smart, preset('p4', 'attachments', 2)]
    views = { p4: 'gallery' }
    items = [item('Urlaub'), item('Vertrag')]
    gallery = [attachment('a1', 'image', 'Urlaub'), attachment('a2', 'pdf', 'Vertrag')]
    await render('/smart/p4')
    expect($('note-list')!.getAttribute('data-mode')).toBe('gallery')
    expect($('list-mode-gallery')!.getAttribute('aria-checked')).toBe('true')
    expect($('list-mode-gallery')!.textContent).toBe('Anhänge')
    // The gallery sorts itself: no sorting or grouping of notes above it, no second heading.
    expect($('list-sort')).toBeNull()
    expect($('list-group')).toBeNull()
    expect(box.querySelectorAll('h1')).toHaveLength(1)
    expect($$('gallery-item').map((tile) => tile.getAttribute('data-kind'))).toEqual(['image', 'pdf'])
    expect($$('note-row')).toHaveLength(0)
    expect(calls.some((call) => call.path === '/api/smart-folders/p4/attachments' && call.query.get('tz') !== null)).toBe(true)
    await click($('gallery-kind-pdf'))
    expect($$('gallery-item').map((tile) => tile.getAttribute('data-kind'))).toEqual(['pdf'])
    // An entry opens its note beside the list, at the attachment.
    await click($$('gallery-item')[0])
    expect(where).toBe('/smart/p4?kind=pdf&attachment=a2&note=Vertrag')
    // Back to the notes: a list, kept on the server.
    await click($('list-mode-list'))
    expect(posted('/api/smart-folders/p4/view', 'PUT')[0].body).toEqual({ mode: 'list' })
    expect($('gallery')).toBeNull()
    expect($$('note-row')).toHaveLength(2)
  })

  it('NOTES-7 AC-4 AC-7 the gallery follows its notes: a note that comes in with an attachment shows it without reloading', async () => {
    smart = [...smart, preset('p4', 'attachments', 2)]
    views = { p4: 'gallery' }
    await render('/smart/p4')
    expect($$('gallery-item')).toHaveLength(0)
    // A file attached in the note open beside the gallery: the note now fits, and the list reads its notes anew.
    items = [item('Vertrag')]
    gallery = [attachment('a2', 'pdf', 'Vertrag')]
    await act(async () => notesChanged())
    await settle()
    expect($$('gallery-item').map((tile) => tile.getAttribute('data-kind'))).toEqual(['pdf'])
  })

  it('NOTES-7 AC-4 a smart folder without "Anhang" offers no gallery, and one kept from before shows as a list', async () => {
    items = [item('Einkauf')]
    views = { p1: 'gallery' }
    await render('/smart/p1')
    expect($('list-mode-gallery')).toBeNull()
    expect($('gallery')).toBeNull()
    expect($('note-list')!.getAttribute('data-mode')).toBe('list')
    expect($$('note-row')).toHaveLength(1)
    expect($('smart-shared-page')).toBeNull()
  })

  it('NOTES-7 AC-7 "Mit mir geteilt" leads to the page of what others shared (owners, rights, leaving)', async () => {
    smart = [...smart, preset('p3', 'shared_with_me', 2)]
    await render('/smart/p3')
    expect($('smart-shared-page')!.getAttribute('href')).toBe('/shared')
    expect($('smart-shared-page')!.textContent).toBe('Freigaben verwalten')
    expect($('list-mode-gallery')).toBeNull()
  })

  it('NOTES-7 AC-8 the section "Intelligent" stands after the folders, with the filter symbol, in the order dragged', async () => {
    smart = [...smart, { id: 's3', name: 'Drei', preset: '', match: 'all', conditions: [{ kind: 'pinned' }], position: 2 }]
    await render('/')
    const keys = SIDEBAR_SECTIONS.map((section) => section.key)
    expect(keys.indexOf('smart')).toBe(keys.indexOf('folders') + 1)
    expect($('sidebar-smart')!.querySelector('h2')!.textContent).toBe('Intelligent')
    const links = $$('sidebar-smart-folder')
    expect(links.map((link) => link.querySelector('[data-testid="smart-filter-icon"]'))).not.toContain(null)
    // Alt + arrow down moves the first one down.
    await press(links[0], 'ArrowDown', { altKey: true })
    expect(posted('/api/smart-folders/order', 'PUT')[0].body).toEqual({ ids: ['p2', 'p1', 's3'] })
    expect($$('sidebar-smart-folder').map((link) => link.textContent)).toEqual(['Zuletzt bearbeitet', 'Offene Checklisten', 'Drei'])
    // Dragging one onto another puts it there.
    expect(moved(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c'])
  })

  it('NOTES-7 EC-1 a condition that points nowhere is named, with the way to edit it', async () => {
    broken = [
      { index: 0, kind: 'folder', name: 'Küche' },
      { index: 1, kind: 'tag', name: 'rezept' },
    ]
    await render('/smart/p1')
    expect($$('smart-broken-item').map((one) => one.textContent)).toEqual([
      'Der Ordner „Küche“ aus einer Bedingung ist gelöscht. Diese Bedingung passt auf keine Notiz.',
      'Das Schlagwort #rezept aus einer Bedingung steht in keiner Notiz mehr.',
    ])
    await click($('smart-broken-edit'))
    expect(where).toBe('/smart/p1/edit')
  })

  it('NOTES-7 EC-2 when nothing fits it says so and shows the conditions', async () => {
    smart = [...smart, { id: 's4', name: 'Leer', preset: '', match: 'any', conditions: [{ kind: 'tag', op: 'has', key: 'rezept', label: 'rezept' }, { kind: 'folder', op: 'tree', id: 'f1' }, { kind: 'date', field: 'updated', period: 'week' }], position: 2 }]
    await render('/smart/s4')
    const empty = $('smart-empty')!
    expect(empty.textContent).toContain('Gerade passt keine Notiz')
    expect(empty.textContent).toContain('Passt, wenn mindestens eine Bedingung erfüllt ist:')
    expect($$('smart-condition').map((one) => one.textContent)).toEqual(['Schlagwort #rezept', 'in „Rezepte“ mit Unterordnern', 'Geändert in den letzten 7 Tagen'])
    expect($('list-empty')).toBeNull()
  })

  it('NOTES-7 EC-3 every request names the zone of the device, so the periods count from its today', async () => {
    await render('/smart/p2')
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const asked = calls.filter((call) => call.path === '/api/smart-folders/p2/notes' || call.path === '/api/smart-folders/p2/stamp')
    expect(asked.length).toBeGreaterThan(0)
    for (const call of asked) expect(call.query.get('tz')).toBe(zone)
  })

  it('NOTES-7 a smart folder that is gone says so', async () => {
    await render('/smart/nope')
    expect($('smart-missing')!.textContent).toContain('Diesen intelligenten Ordner gibt es nicht')
  })

  it('NOTES-4 AC-9 NOTES-7 a smart folder is a list of the workspace; a new note there goes into the inbox', () => {
    expect(isListPath('/smart/s1')).toBe(true)
    expect(isListPath('/smart/new')).toBe(false)
    expect(isListPath('/smart/s1/edit')).toBe(false)
    expect(hrefIn('/smart/s1', 'n1')).toBe('/smart/s1?note=n1')
    expect(noteOf('/smart/s1', '?note=n1')).toBe('n1')
    // No folder of its own: "New note" takes the inbox.
    expect(folderOfList('/smart/s1')).toBeNull()
  })

  it('NOTES-7 the way back on a phone names the smart folder', async () => {
    await render('/')
    expect(listNameOf('/smart/p1')).toBe('Offene Checklisten')
    expect(listNameOf('/folder/f1')).toBeNull()
  })
})
