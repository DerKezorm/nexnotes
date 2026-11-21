/**
 * NOTES-15 trash on the page: what was deleted with when, where from and the time left (AC-6), orange in the last
 * days (AC-7), where something lands whose folder is gone (EC-1), back and gone for good, emptying with a question that
 * names the number and says it cannot be undone (EC-3), and the entry in the sidebar.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { hideNotice } from '../folders/notice'
import i18n from '../i18n'
import type { TrashItem, TrashList } from './api'
import { TrashEntry } from './register'
import { TrashPage } from './TrashPage'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let list: TrashList
let root: Root
let box: HTMLDivElement

const NOW = '2026-11-21T10:00:00+00:00'

function item(id: string, extra: Partial<TrashItem> = {}): TrashItem {
  return {
    kind: 'note',
    id,
    title: id,
    deleted_at: '2026-11-20T09:00:00+00:00',
    expires_at: '2027-02-18T09:00:00+00:00',
    days_left: 89,
    warn: false,
    origin: { id: 'f1', name: 'Shopping', inbox: false, gone: false },
    origin_gone: false,
    lands: 'origin',
    notes: 1,
    folders: 0,
    deleted_by: null,
    ...extra,
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  if (call.method === 'GET' && call.path === '/api/trash') return reply(200, list)
  if (call.method === 'GET' && call.path === '/api/folders') return reply(200, { inbox: { id: 'inbox', count: 0 }, folders: [] })
  if (call.method === 'POST' && call.path === '/api/trash/empty') {
    list = { ...list, items: [], totals: { notes: 0, folders: 0 } }
    return reply(200, { notes: 15, folders: 1 })
  }
  const one = /^\/api\/trash\/(notes|folders)\/([^/]+)(\/restore)?$/.exec(call.path)
  if (one) {
    list = { ...list, items: list.items.filter((entry) => entry.id !== decodeURIComponent(one[2])) }
    return reply(200, call.method === 'DELETE' ? { notes: 1, folders: 0 } : { id: one[2] })
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/trash']}>
        <TrashEntry />
        <TrashPage />
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const rows = () => [...box.querySelectorAll<HTMLElement>('[data-testid="trash-row"]')]
const row = (id: string) => rows().find((element) => element.dataset.id === id)!
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent === text || element.getAttribute('aria-label') === text)!

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  list = {
    now: NOW,
    trash_days: 90,
    warn_days: 7,
    totals: { notes: 17, folders: 2 },
    items: [
      item('Old bills', { kind: 'folder', notes: 14, folders: 1, origin: { id: 'h', name: 'Household', inbox: false, gone: false } }),
      item('Shopping last week', { days_left: 89 }),
      item('Advent ideas', { origin: { id: 'c', name: 'Crafts', inbox: false, gone: true }, origin_gone: true, lands: 'inbox', days_left: 41 }),
      item('Parents evening', { deleted_by: { id: 2, name: 'Anna' }, origin: { id: 's', name: 'School', inbox: false, gone: false } }),
      item('Packing list', { days_left: 3, warn: true, origin: { id: 'i', name: '', inbox: true, gone: false } }),
    ],
  }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined }
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
  for (const leftover of document.querySelectorAll('[role="dialog"]')) leftover.closest('.fixed')?.remove()
  act(() => hideNotice())
  vi.unstubAllGlobals()
})

describe('the trash', () => {
  it('NOTES-15 AC-6 lists what was deleted with when, where it came from, who deleted it and how long it stays', async () => {
    await render()
    expect(box.textContent).toContain('Deleted items stay for 90 days, then they are gone for good.')
    expect(rows()).toHaveLength(5)
    expect(row('Old bills').textContent).toContain('Old bills · folder with 14 notes')
    expect(row('Old bills').textContent).toContain('from Household')
    expect(row('Shopping last week').textContent).toContain('from Shopping')
    expect(row('Shopping last week').textContent).toContain('89 days left')
    expect(row('Parents evening').textContent).toContain('deleted by Anna, from School')
    expect(row('Packing list').textContent).toContain('from the inbox')
    for (const element of rows()) {
      expect(button(element, 'Restore')).toBeTruthy()
      expect(element.querySelector(`[aria-label="Delete for good: ${element.dataset.id}"]`)).not.toBeNull()
    }
  })

  it('NOTES-15 AC-7 in the last seven days the time left is orange, before that it is not', async () => {
    await render()
    const left = (id: string) => row(id).querySelector<HTMLElement>('[data-testid="trash-left"]')!
    expect(left('Packing list').textContent).toBe('3 days left')
    expect(left('Packing list').className).toContain('text-warn-500')
    expect(left('Shopping last week').className).not.toContain('text-warn-500')
    expect(left('Advent ideas').className).not.toContain('text-warn-500')
  })

  it('NOTES-15 EC-1 a note whose folder is gone says before that it comes back into the inbox', async () => {
    await render()
    const origin = row('Advent ideas').querySelector<HTMLElement>('[data-testid="trash-origin"]')!
    expect(origin.textContent).toBe('from Crafts, which is gone: comes back into the inbox')
    expect(origin.className).toContain('text-warn-500')
    await act(async () => button(row('Advent ideas'), 'Restore').click())
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/trash/notes/Advent%20ideas/restore')).toBe(true)
    expect(document.body.textContent).toContain('“Advent ideas” is back, in the inbox.')
    expect(rows().map((element) => element.dataset.id)).not.toContain('Advent ideas')
  })

  it('NOTES-15 AC-6 a folder comes back with what went with it, and goes for good only after a question', async () => {
    await render()
    await act(async () => button(row('Old bills'), 'Restore').click())
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/trash/folders/Old%20bills/restore')).toBe(true)
    await act(async () => button(row('Shopping last week'), 'Delete for good: Shopping last week').click())
    const dialog = $('trash-purge-dialog')!
    expect(dialog.textContent).toContain('“Shopping last week” will be deleted for good.')
    expect(dialog.textContent).toContain('This cannot be undone.')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await act(async () => $('trash-purge-go')!.click())
    await settle()
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/trash/notes/Shopping%20last%20week')).toBe(true)
    expect(rows().map((element) => element.dataset.id)).not.toContain('Shopping last week')
  })

  it('NOTES-15 EC-3 emptying asks first, names the number of notes and says it cannot be undone', async () => {
    await render()
    await act(async () => $('trash-empty')!.click())
    const dialog = $('trash-empty-dialog')!
    expect(dialog.textContent).toContain('17 notes will be deleted for good.')
    expect(dialog.textContent).toContain('Along with 2 folders.')
    expect(dialog.textContent).toContain('This cannot be undone.')
    // Cancel leaves everything as it is.
    await act(async () => button(dialog, 'Cancel').click())
    expect($('trash-empty-dialog')).toBeNull()
    expect(calls.some((call) => call.path === '/api/trash/empty')).toBe(false)
    await act(async () => $('trash-empty')!.click())
    await act(async () => $('trash-empty-go')!.click())
    await settle()
    const empty = calls.find((call) => call.path === '/api/trash/empty')!
    // Only what the page listed: the server's time of the list.
    expect(empty.body).toEqual({ until: NOW })
    expect($('trash-nothing')!.textContent).toBe('The trash is empty.')
    expect(($('trash-empty') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NOTES-15 EC-3 one note says "1 note"', async () => {
    list = { ...list, totals: { notes: 1, folders: 0 }, items: [item('only')] }
    await render()
    await act(async () => $('trash-empty')!.click())
    expect($('trash-empty-dialog')!.textContent).toContain('1 note will be deleted for good.')
    expect($('trash-empty-dialog')!.textContent).not.toContain('folder')
  })

  it('NOTES-15 AC-6 the sidebar leads to the trash', async () => {
    await render()
    const entry = box.querySelector<HTMLAnchorElement>('[data-testid="trash-entry"]')!
    expect(entry.getAttribute('href')).toBe('/trash')
    expect(entry.textContent).toBe('Trash')
  })
})
