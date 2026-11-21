/**
 * NOTES-15 history on the page: the versions grouped with time and who (AC-1) in the device's time zone (EC-9), one
 * version whole with "Version of …" and its buttons (AC-3), restoring (AC-4), a copy (AC-5), readers only look (AC-8),
 * the list a page at a time (EC-5), the notice in an open note when somebody else restored (EC-2), and the entry in
 * the note's menu.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as Y from 'yjs'

import { NoteEditor } from '../editor/NoteEditor'
import { AuthProvider } from '../state/auth'
import { hideNotice } from '../folders/notice'
import i18n from '../i18n'
import type { Author, LastRestore, VersionItem } from './api'
import { dayNumber, groupVersions, weekStart, whoText } from './groups'
import { HistoryPage } from './HistoryPage'
import { RestoreWatch, WATCH_DELAY_MS } from './RestoreWatch'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let versions: VersionItem[] = []
let canRestore = true
let pageSize = 50
let lastRestore: LastRestore = null
let root: Root
let box: HTMLDivElement
let where = ''

const DAY = 86_400_000
const me: Author = { id: 1, name: 'Bruno', via: '' }
const anna: Author = { id: 2, name: 'Anna', via: '' }

function version(id: number, at: Date, authors: Author[] = [me], extra: Partial<VersionItem> = {}): VersionItem {
  return { id, created_at: at.toISOString(), started_at: at.toISOString(), title: 'Bathroom', authors, restored_from: null, current: false, ...extra }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, query } = call
  const list = /^\/api\/notes\/n1\/history$/.exec(path)
  if (method === 'GET' && list) {
    const before = Number(new URLSearchParams(query).get('before')) || null
    const start = before ? versions.findIndex((v) => v.id === before) + 1 : 0
    const slice = versions.slice(start, start + pageSize)
    const next = start + pageSize < versions.length ? slice[slice.length - 1].id : null
    return reply(200, { versions: slice, next, pending: false, updated_at: new Date().toISOString(), updated_by: { id: 1, name: 'Bruno' }, can_restore: canRestore, history_days: 365 })
  }
  if (method === 'GET' && path === '/api/notes/n1/history/restored') return reply(200, { last: lastRestore })
  const one = /^\/api\/notes\/n1\/history\/(\d+)(\/restore|\/copy)?$/.exec(path)
  if (one) {
    const found = versions.find((v) => v.id === Number(one[1]))
    if (!found) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET' && !one[2])
      return reply(200, {
        ...found,
        note_id: 'n1',
        can_restore: canRestore,
        text: 'Tiles on Tuesday',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Tiles on ' }, { type: 'text', text: 'Tuesday', marks: [{ type: 'bold' }] }] },
            { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'order tiles' }] }] }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
          ],
        },
      })
    if (method === 'POST' && one[2] === '/restore') return reply(200, { id: 99, restored_from: found.created_at })
    if (method === 'POST' && one[2] === '/copy') return reply(201, { id: 'copy-1', title: 'Bathroom (Version of …)' })
  }
  if (path === '/api/auth/me') return reply(200, { id: 1, name: 'bruno', display_name: 'Bruno', role: 'member', language: 'en', version: '1', whats_new_seen: '1' })
  if (method === 'GET' && path === '/api/notes/n1') return reply(200, { id: 'n1', folder_id: 'f', title: 'Bathroom', title_check: false, origin: '', preview: '', created_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-20T08:00:00Z', path: [], updated_by: null, owner: null, deleted_at: null, can_write: true })
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname + location.search
  }, [location])
  return null
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(at = '/notes/n1/history'): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <Where />
        <Routes>
          <Route path="/notes/:noteId/history" element={<HistoryPage />} />
          <Route path="/notes/:noteId" element={<div data-testid="note" />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const all = (testId: string) => [...box.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  canRestore = true
  pageSize = 50
  lastRestore = null
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  versions = [
    version(5, new Date(Date.now() - 60_000), [me], { current: true }),
    version(4, new Date(noon.getTime() - DAY), [anna]),
    version(3, new Date(noon.getTime() - 10 * DAY), [me, { id: 1, name: 'Bruno', via: 'mcp:Laptop' }]),
    version(2, new Date(noon.getTime() - 60 * DAY)),
    version(1, new Date(noon.getTime() - 120 * DAY)),
  ]
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
  act(() => hideNotice())
  vi.unstubAllGlobals()
})

describe('the history of a note', () => {
  it('NOTES-15 AC-1 the versions stand on the right, grouped today, yesterday, by day, by week, with time and who', async () => {
    await render()
    const headings = [...box.querySelectorAll('aside h3')].map((h) => h.textContent)
    expect(headings).toEqual(['Today', 'Yesterday', 'Earlier, by day', 'Older, by week'])
    const rows = all('history-item').map((row) => row.textContent)
    expect(rows[0]).toMatch(/· current/)
    expect(rows[0]).toMatch(/Bruno$/)
    expect(rows[1]).toMatch(/Anna$/)
    // A person and the key of their program.
    expect(rows[2]).toMatch(/Bruno, MCP · Laptop$/)
    expect(rows[3]).toMatch(/^Week of /)
    expect($('history-banner')!.textContent).toContain('Version of')
    expect(box.querySelector('aside')!.textContent).toContain('Versions stay for a year')
  })

  it('NOTES-15 EC-9 versions are grouped by the days of the device, summer time included', () => {
    // 23:30 UTC on the night summer time begins in Europe: already the next day in Berlin, still the day in New York.
    const late = version(1, new Date('2026-03-28T23:30:00Z'))
    const now = new Date('2026-03-29T10:00:00Z')
    const berlin = groupVersions([late], 'de', (date) => `Week of ${date}`, now, 'Europe/Berlin')
    const newYork = groupVersions([late], 'en', (date) => `Week of ${date}`, now, 'America/New_York')
    expect(berlin.map((group) => group.key)).toEqual(['today'])
    expect(berlin[0].entries[0].label).toBe('00:30')
    // The same moment is yesterday evening in New York.
    expect(newYork.map((group) => group.key)).toEqual(['yesterday'])
    expect(newYork[0].entries[0].label).toBe('07:30 PM')
    // In Berlin the day before ends at midnight local time, not at midnight UTC.
    const beforeMidnight = version(2, new Date('2026-03-28T22:30:00Z'))
    const groups = groupVersions([late, beforeMidnight], 'de', (date) => date, now, 'Europe/Berlin')
    expect(groups.map((group) => [group.key, group.entries.map((entry) => entry.label)])).toEqual([
      ['today', ['00:30']],
      ['yesterday', ['23:30']],
    ])
    expect(dayNumber(new Date('2026-03-28T23:30:00Z'), 'Europe/Berlin') - dayNumber(new Date('2026-03-28T23:30:00Z'), 'UTC')).toBe(1)
    // Weeks begin on Monday: 30 March 2026 was one.
    const monday = Date.UTC(2026, 2, 30) / DAY
    expect(weekStart(monday + 6)).toBe(monday)
    expect(weekStart(monday)).toBe(monday)
  })

  it('NOTES-15 AC-3 an old version opens whole with "Version of …", Close, As a copy and Restore', async () => {
    await render('/notes/n1/history?v=4')
    const banner = $('history-banner')!
    expect(banner.textContent).toMatch(/Version of .* · Anna/)
    expect([...banner.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close', 'As a copy', 'Restore'])
    expect($('version-title')!.textContent).toBe('Bathroom')
    const body = $('version-body')!
    expect(body.querySelector('strong')!.textContent).toBe('Tuesday')
    expect((body.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    // Read only, and an unsafe link is no link.
    expect(body.querySelector('[contenteditable="true"]')).toBeNull()
    expect(body.querySelector('a')).toBeNull()
    expect(body.textContent).toContain('evil')
    expect(box.querySelector('[aria-current="true"]')!.getAttribute('data-id')).toBe('4')
    // Another version from the list.
    await act(async () => all('history-item').find((row) => row.dataset.id === '3')!.click())
    await settle()
    expect(where).toBe('/notes/n1/history?v=3')
    await act(async () => $('history-close')!.click())
    expect(where).toBe('/notes/n1')
  })

  it('NOTES-15 AC-4 restoring makes the version the note and goes back to it', async () => {
    await render('/notes/n1/history?v=3')
    await act(async () => $('history-restore')!.click())
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/notes/n1/history/3/restore')).toBe(true)
    expect(where).toBe('/notes/n1')
    expect(document.body.textContent).toContain('The one before is in the history.')
  })

  it('NOTES-15 AC-4 the current version cannot be restored onto itself', async () => {
    await render('/notes/n1/history?v=5')
    expect($('history-restore')).toBeNull()
    expect($('history-copy')).not.toBeNull()
  })

  it('NOTES-15 AC-5 "As a copy" makes a new note with the version\'s date and opens it', async () => {
    await render('/notes/n1/history?v=2')
    await act(async () => $('history-copy')!.click())
    await settle()
    const copy = calls.find((call) => call.method === 'POST' && call.path === '/api/notes/n1/history/2/copy')!
    expect(copy.body!.when).toBe(new Date(versions[3].created_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }))
    expect(where).toBe('/notes/copy-1')
  })

  it('NOTES-15 AC-8 who may only read sees the versions, but neither restores nor copies', async () => {
    canRestore = false
    await render('/notes/n1/history?v=3')
    expect(all('history-item')).toHaveLength(5)
    expect($('version-body')).not.toBeNull()
    expect($('history-restore')).toBeNull()
    expect($('history-copy')).toBeNull()
    expect($('history-close')).not.toBeNull()
  })

  it('NOTES-15 EC-5 a long history comes a page at a time', async () => {
    const start = Date.now() - 400 * DAY
    versions = Array.from({ length: 120 }, (_, index) => version(1000 - index, new Date(start + (120 - index) * 3 * DAY)))
    pageSize = 50
    await render()
    expect(all('history-item')).toHaveLength(50)
    await act(async () => $('history-more')!.click())
    await settle()
    expect(all('history-item')).toHaveLength(100)
    await act(async () => $('history-more')!.click())
    await settle()
    expect(all('history-item')).toHaveLength(120)
    expect($('history-more')).toBeNull()
    const asked = calls.filter((call) => call.path === '/api/notes/n1/history').map((call) => call.query)
    expect(asked).toEqual(['', '?before=951', '?before=901'])
  })

  it('NOTES-15 AC-1 who wrote: names once each, a program by its key, somebody gone as someone', () => {
    const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
    expect(whoText([me, anna, me], t)).toBe('Bruno, Anna')
    expect(whoText([{ id: 1, name: 'Bruno', via: 'mcp:Laptop' }], t)).toBe('MCP · Laptop')
    expect(whoText([{ id: null, name: '', via: '' }], t)).toBe('Someone')
  })
})

describe('an open note', () => {
  it('NOTES-15 EC-2 a restore by somebody else brings a notice with who and which version', async () => {
    const doc = new Y.Doc()
    const origin = { name: 'the room' }
    lastRestore = { id: 7, at: '2026-11-20T10:00:00Z', version_at: '2026-11-19T18:40:00Z', authors: [me] }
    await act(async () => root.render(<RestoreWatch noteId="n1" doc={doc} origin={origin} />))
    await settle()
    // Own typing asks nothing; a change from the room with an old restore says nothing.
    doc.getText('title').insert(0, 'mine')
    const first = new Y.Doc()
    first.getText('body').insert(0, 'typed by somebody')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(first), origin)
    await act(async () => await new Promise((resolve) => setTimeout(resolve, WATCH_DELAY_MS + 100)))
    await settle()
    expect(document.body.textContent).not.toContain('restored the version')
    lastRestore = { id: 8, at: new Date().toISOString(), version_at: '2026-11-19T18:40:00Z', authors: [anna] }
    const theirs = new Y.Doc()
    theirs.getText('title').insert(0, 'old title')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(theirs), origin)
    await act(async () => await new Promise((resolve) => setTimeout(resolve, WATCH_DELAY_MS + 100)))
    await settle()
    expect(document.body.textContent).toContain('Anna restored the version of')
    expect(calls.filter((call) => call.path === '/api/notes/n1/history/restored')).toHaveLength(3)
  })

  it('NOTES-15 AC-1 the note\'s menu has "History", which opens the history of the note', async () => {
    class Quiet {
      readyState = 0
      binaryType = 'arraybuffer'
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: (() => void) | null = null
      onerror: (() => void) | null = null
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }
    vi.stubGlobal('WebSocket', Quiet)
    await act(async () =>
      root.render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/notes/n1']}>
            <Where />
            <Routes>
              <Route path="/notes/:noteId" element={<NoteEditor noteId="n1" />} />
              <Route path="/notes/:noteId/history" element={<div data-testid="history-route" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      ),
    )
    await settle()
    await act(async () => $('note-menu')!.click())
    const entry = $('note-history')!
    expect(entry.textContent).toBe('History')
    expect(entry.getAttribute('href')).toBe('/notes/n1/history')
    await act(async () => entry.click())
    await settle()
    expect(where).toBe('/notes/n1/history')
  })
})
