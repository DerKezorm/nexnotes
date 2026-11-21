/**
 * NOTES-13 Teilen on the page: the dialog (members, rights, the sentence that only the owner decides, the read link
 * with its day), "Mit mir geteilt" with rights, notices and leaving, the question before a note leaves a shared folder,
 * and the read links in "Mein Konto". The editor's part (no toolbar for a reader, no passing on) is in
 * `notes/notes.test.tsx`.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { hideNotice } from '../folders/notice'
import i18n from '../i18n'
import { dayFrom, endOfDay, type Sharing, type WithMe } from './api'
import { askMoveOut } from './moveAsk'
import { MoveQuestion } from './MoveQuestion'
import { ReadLinksCard } from './ReadLinksCard'
import { ShareDialog } from './ShareDialog'
import { SharedPage } from './SharedPage'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let sharing: Sharing
let withMe: WithMe
let moveCheck: { id: string; title: string; people: string[] }[]
let links: Record<string, unknown>[]
let root: Root
let box: HTMLDivElement

const anna = { id: 2, name: 'Anna', email: 'anna@example.com', avatar: null }
const lena = { id: 3, name: 'Lena', email: 'lena@example.com', avatar: null }

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/shares/note/n1') return reply(200, sharing)
  if (method === 'GET' && path === '/api/shares/people') return reply(200, [anna, lena].filter((person) => person.name.toLowerCase().includes(new URLSearchParams(call.query).get('q')!.toLowerCase())))
  const person = /^\/api\/shares\/note\/n1\/people\/(\d+)$/.exec(path)
  if (person) {
    const id = Number(person[1])
    const who = [anna, lena].find((each) => each.id === id)!
    if (method === 'PUT') {
      const level = body!.level as 'read' | 'write'
      sharing = { ...sharing, people: sharing.people.some((each) => each.id === id) ? sharing.people.map((each) => (each.id === id ? { ...each, level } : each)) : [...sharing.people, { ...who, level }] }
    } else sharing = { ...sharing, people: sharing.people.filter((each) => each.id !== id) }
    return reply(200, sharing)
  }
  if (method === 'POST' && path === '/api/notes/n1/read-link')
    return reply(201, { id: 9, note_id: 'n1', expires_on: body!.expires_on, expires_at: body!.ends_at, created_at: '', expired: false, path: '/l/TOKEN-abcdefghijklmnopqrstuvwxyz0123456789' })
  if (method === 'PUT' && path === '/api/read-links/9') return reply(200, { id: 9, note_id: 'n1', expires_on: body!.expires_on, expires_at: body!.ends_at, created_at: '', expired: false })
  if (method === 'DELETE' && /^\/api\/read-links\/\d+$/.test(path)) {
    links = links.filter((link) => `/api/read-links/${link.id}` !== path)
    return reply(204, null)
  }
  if (method === 'GET' && path === '/api/read-links') return reply(200, links)
  if (method === 'GET' && path === '/api/shares/with-me') return reply(200, withMe)
  if (method === 'DELETE' && path.startsWith('/api/shares/with-me/')) {
    const [, , , , kind, id] = path.split('/')
    withMe = { ...withMe, groups: withMe.groups.map((group) => ({ ...group, items: group.items.filter((item) => !(item.kind === kind && item.id === id)) })).filter((group) => group.items.length) }
    return reply(204, null)
  }
  if (method === 'DELETE' && path.startsWith('/api/shares/notices/')) {
    withMe = { ...withMe, notices: [] }
    return reply(204, null)
  }
  if (method === 'POST' && path === '/api/shares/move-check') return reply(200, { notes: moveCheck })
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20, ms = 0): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, ms)))
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>))
  await settle()
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  sharing = { kind: 'note', id: 'n1', title: 'Lentil soup', people: [], through_folder: [], links: true, link: null }
  withMe = {
    count: 3,
    notices: [{ id: 1, reason: 'ended', kind: 'note', title: 'Parents evening notes', owner: 'Lena', at: '2026-11-20T10:00:00Z' }],
    groups: [
      {
        owner: { id: 2, name: 'Anna', avatar: null },
        items: [
          { kind: 'folder', id: 'f1', title: 'Family holiday 2027', level: 'write', updated_at: '2026-11-21T09:00:00Z', icon: '', color: '', notes: 8 },
          { kind: 'note', id: 'n7', title: 'Birthday list', level: 'read', updated_at: '2026-11-18T09:00:00Z', icon: '', color: '' },
        ],
      },
      { owner: { id: 3, name: 'Lena', avatar: null }, items: [{ kind: 'note', id: 'n8', title: 'Barbecue', level: 'write', updated_at: null, icon: '', color: '' }] },
    ],
  }
  moveCheck = []
  links = [
    { id: 4, note_id: 'n1', title: 'Lentil soup', expires_on: '2026-11-28', expires_at: '', created_at: '', expired: false },
    { id: 5, note_id: 'n2', title: 'Packing list', expires_on: '2026-11-01', expires_at: '', created_at: '', expired: true },
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
  for (const leftover of document.querySelectorAll('[role="dialog"]')) leftover.closest('.fixed')?.remove()
  act(() => hideNotice())
  vi.unstubAllGlobals()
})

describe('the share dialog', () => {
  it('NOTES-13 AC-1 finds members by name, sets read or edit, removes, and says that only the owner decides', async () => {
    await render(<ShareDialog kind="note" id="n1" title="Lentil soup" onClose={() => undefined} />)
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Share “Lentil soup”')
    expect($('share-hint')!.textContent).toBe('Only you decide who sees the note. Others cannot share it further.')
    const search = $('share-search') as HTMLInputElement
    await act(async () => type(search, 'a'))
    await settle(10, 30)
    // Nothing for a single letter.
    expect($$('share-found')).toHaveLength(0)
    await act(async () => type(search, 'ann'))
    await settle(10, 30)
    expect($$('share-found').map((element) => element.textContent)).toEqual(['AAnnaanna@example.com'])
    await act(async () => $$('share-found')[0].click())
    await settle()
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({ path: '/api/shares/note/n1/people/2', body: { level: 'read' } })
    expect($$('share-person').map((element) => element.textContent)).toEqual([expect.stringContaining('Anna')])
    // "bearbeiten" for Anna, then removed.
    await act(async () => choose($$('share-person')[0].querySelector('select')!, 'write'))
    await settle()
    expect(calls.filter((call) => call.method === 'PUT').at(-1)!.body).toEqual({ level: 'write' })
    expect(($$('share-person')[0].querySelector('select') as HTMLSelectElement).value).toBe('write')
    await act(async () => $$('share-person')[0].querySelector<HTMLButtonElement>('button[aria-label="Remove Anna"]')!.click())
    await settle()
    expect($$('share-person')).toHaveLength(0)
  })

  it('NOTES-13 AC-1 a folder says the same of the folder; who has it through a folder above is named', async () => {
    sharing = { ...sharing, through_folder: [{ ...lena, level: 'write', folder: 'Family' }] }
    await render(<ShareDialog kind="note" id="n1" title="Lentil soup" onClose={() => undefined} />)
    expect($('share-through')!.textContent).toBe('Lena through the folder “Family” (edit)')
    await act(async () => root.unmount())
    root = createRoot(box)
    await render(<ShareDialog kind="folder" id="f1" title="Family" onClose={() => undefined} />)
    expect($('share-hint')!.textContent).toBe('Only you decide who sees the folder. Others cannot share it further.')
    expect($('share-link')).toBeNull()
  })

  it('NOTES-13 AC-9 the read link: on makes one for seven days, copied, another day, revoked', async () => {
    await render(<ShareDialog kind="note" id="n1" title="Lentil soup" onClose={() => undefined} />)
    expect($('share-link-switch')!.getAttribute('aria-checked')).toBe('false')
    await act(async () => $('share-link-switch')!.click())
    await settle()
    const made = calls.find((call) => call.method === 'POST')!
    expect(made.body).toEqual({ expires_on: dayFrom(7), ends_at: endOfDay(dayFrom(7)) })
    expect(($('share-link-url') as HTMLInputElement).value).toBe(`${window.location.origin}/l/TOKEN-abcdefghijklmnopqrstuvwxyz0123456789`)
    const day = $('share-link-day') as HTMLInputElement
    // At the earliest tomorrow, never without a day.
    expect(day.min).toBe(dayFrom(1))
    expect(day.required).toBe(true)
    await act(async () => type(day, dayFrom(30)))
    await settle()
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({ path: '/api/read-links/9', body: { expires_on: dayFrom(30) } })
    await act(async () => $('share-link-revoke')!.click())
    await settle()
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/read-links/9' })
    expect($('share-link-switch')!.getAttribute('aria-checked')).toBe('false')
    expect($('share-link-url')).toBeNull()
  })

  it('NOTES-13 AC-9 a link made before shows its day but not its address, only a new one', async () => {
    sharing = { ...sharing, link: { id: 9, note_id: 'n1', expires_on: '2026-11-28', expires_at: '', created_at: '', expired: false } }
    await render(<ShareDialog kind="note" id="n1" title="Lentil soup" onClose={() => undefined} />)
    expect($('share-link-url')).toBeNull()
    expect($('share-link-hidden')!.textContent).toContain('nexnotes shows its address only when it is created')
    expect(($('share-link-day') as HTMLInputElement).value).toBe('2026-11-28')
  })

  it('NOTES-13 AC-10 without the operator\'s read links there is no switch', async () => {
    sharing = { ...sharing, links: false }
    await render(<ShareDialog kind="note" id="n1" title="Lentil soup" onClose={() => undefined} />)
    expect($('share-link')).toBeNull()
    expect($('share-link-switch')).toBeNull()
  })
})

describe('"Shared with me"', () => {
  it('NOTES-13 AC-3 AC-5 AC-6 by owner with the right, what went and why, and leaving', async () => {
    await render(<SharedPage />)
    const groups = $$('shared-group')
    expect(groups.map((group) => group.querySelector('h2')!.textContent)).toEqual(['Afrom Anna', 'Lfrom Lena'])
    const items = $$('shared-item')
    expect(items[0].textContent).toContain('Family holiday 2027')
    expect(items[0].textContent).toContain('Folder · 8 notes')
    expect(items.map((item) => item.querySelector('[data-testid="shared-level"]')!.textContent)).toEqual(['edit', 'read', 'edit'])
    expect(items[0].querySelector('a')!.getAttribute('href')).toBe('/shared/folder/f1')
    expect(items[1].querySelector('a')!.getAttribute('href')).toBe('/notes/n7')
    expect($('shared-notice')!.textContent).toContain('“Parents evening notes” is not here any more: Lena stopped sharing it.')
    await act(async () => items[1].querySelector<HTMLButtonElement>('[data-testid="shared-leave"]')!.click())
    await settle()
    expect(calls.find((call) => call.method === 'DELETE')!.path).toBe('/api/shares/with-me/note/n7')
    expect($$('shared-item').map((item) => item.querySelector('a')!.textContent)).not.toContain(expect.stringContaining('Birthday list'))
    expect($$('shared-item')).toHaveLength(2)
  })

  it('NOTES-13 EC-4 an owner deleted: the notice says the account went', async () => {
    withMe = { count: 0, groups: [], notices: [{ id: 2, reason: 'owner_gone', kind: 'folder', title: 'School', owner: 'Lena', at: '' }] }
    await render(<SharedPage />)
    expect($('shared-notice')!.textContent).toContain('“School” is not here any more: the account of Lena was deleted.')
    expect($('shared-empty')).not.toBeNull()
  })
})

describe('moving out of a shared folder', () => {
  it('NOTES-13 EC-2 asks whether the note may stop being shared; cancel keeps it, move lets it go', async () => {
    await render(<MoveQuestion />)
    moveCheck = []
    expect(await askMoveOut(['n1'], 'x')).toBe(true)
    moveCheck = [{ id: 'n1', title: 'Shopping', people: ['Anna', 'Lena'] }]
    let answered: boolean | null = null
    await act(async () => {
      void askMoveOut(['n1'], null).then((value) => (answered = value))
    })
    await settle()
    expect($('share-move-question')!.textContent).toContain('“Shopping” is in a shared folder. Anywhere else it is no longer shared with: Anna, Lena.')
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="share-move-question"] button')].find((element) => element.textContent === 'Cancel')!.click())
    await settle()
    expect(answered).toBe(false)
    expect($('share-move-question')).toBeNull()
    await act(async () => {
      void askMoveOut(['n1'], null).then((value) => (answered = value))
    })
    await settle()
    await act(async () => $('share-move-go')!.click())
    await settle()
    expect(answered).toBe(true)
  })
})

describe('"My account"', () => {
  it('NOTES-13 AC-13 lists every read link with its note and day and revokes each', async () => {
    await render(<ReadLinksCard />)
    const rows = $$('read-link')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Lentil soup'),
      expect.stringContaining('Packing list'),
    ])
    expect(rows[0].textContent).toContain('until ')
    expect(rows[1].textContent).toContain('expired on')
    await act(async () => rows[0].querySelector<HTMLButtonElement>('[data-testid="read-link-revoke"]')!.click())
    await settle()
    expect(calls.find((call) => call.method === 'DELETE')!.path).toBe('/api/read-links/4')
    expect($$('read-link')).toHaveLength(1)
  })
})
