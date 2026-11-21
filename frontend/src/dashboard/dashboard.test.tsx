/**
 * NOTES-21 nexdeck-Karte on the page: the keys for nexdeck in Settings, Connections (a name and "show" or "show and
 * tick off", shown once with "Copy", listed with right and last use, revoked) and the history naming a card that
 * ticked. What a card reads is the server's (`backend/tests/test_notes21.py`).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { CONNECTION_SECTIONS } from '../extensions'
import { whoText } from '../history/groups'
import i18n from '../i18n'
import type { DeckKey } from './api'
import { DeckKeysSection } from './DeckKeysSection'
import './register'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let keys: DeckKey[]
let root: Root
let box: HTMLDivElement

const TOKEN = 'nn_deck_ABCDefgh0123456789abcdefghijklmnopqrstuvw'

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/dashboard/keys') return reply(200, { address: 'http://notes.home:8570', max_keys: 20, keys })
  if (method === 'POST' && path === '/api/dashboard/keys') {
    const key: DeckKey = { id: 7, name: String(body!.name), level: body!.level as 'read' | 'write', prefix: 'nn_deck_ABCD', created_at: '2026-11-21T10:00:00Z', last_used_at: null }
    keys = [...keys, key]
    return reply(201, { key, token: TOKEN })
  }
  const revoke = /^\/api\/dashboard\/keys\/(\d+)$/.exec(path)
  if (method === 'DELETE' && revoke) {
    keys = keys.filter((key) => key.id !== Number(revoke[1]))
    return reply(204, null)
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <DeckKeysSection />
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeAll(async () => {
  await i18n.changeLanguage('de')
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  keys = [{ id: 1, name: 'Wand-Tablet', level: 'write', prefix: 'nn_deck_aaaa', created_at: '2026-11-01T10:00:00Z', last_used_at: new Date(Date.now() - 86400_000).toISOString() }]
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NOTES-21 keys for nexdeck in Settings, Connections', () => {
  it('stand among the connections, before the vault', () => {
    const order = CONNECTION_SECTIONS.map((section) => section.key)
    expect(order).toContain('dashboard')
    if (order.includes('vault')) expect(order.indexOf('dashboard')).toBeLessThan(order.indexOf('vault'))
  })

  it('NOTES-21 AC-1 a key gets a name and show or show and tick off, and is shown exactly once with Copy', async () => {
    const copied = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    vi.stubGlobal('isSecureContext', true)
    await render()
    expect($('deck-address')!.textContent).toBe('http://notes.home:8570')
    await click($('deck-new'))
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!
    act(() => type(name, 'Tablet in der Küche'))
    await click($('deck-level-read'))
    await click($('deck-make'))
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ name: 'Tablet in der Küche', level: 'read' })
    expect($('deck-made')!.textContent).toContain('„Tablet in der Küche“ angelegt · nur jetzt sichtbar')
    expect($('deck-token')!.textContent).toBe(TOKEN)
    await click($('deck-copy'))
    expect(copied).toHaveBeenCalledWith(TOKEN)
    await act(async () => root.unmount())
    root = createRoot(box)
    await render()
    expect($('deck-made')).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('NOTES-21 AC-1 the list names the right and the last use', async () => {
    keys.push({ id: 2, name: 'Flur', level: 'read', prefix: 'nn_deck_bbbb', created_at: '2026-11-02T10:00:00Z', last_used_at: null })
    await render()
    const metas = $$('deck-key-meta').map((meta) => meta.textContent)
    expect(metas[0]).toMatch(/^zeigen und abhaken · zuletzt /)
    expect(metas[1]).toBe('nur zeigen · noch nie benutzt')
  })

  it('NOTES-21 EC-3 a key is revoked here, after asking', async () => {
    await render()
    await click($('deck-revoke'))
    expect(document.body.textContent).toContain('„Wand-Tablet“ widerrufen?')
    await click($('deck-revoke-confirm'))
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/dashboard/keys/1')).toBe(true)
    expect($('deck-none')).not.toBeNull()
  })

  it('NOTES-21 AC-2 the history names the key of a card that ticked an item', () => {
    const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
    expect(whoText([{ id: 1, name: 'Robin', via: 'nexdeck:Küche' }], t)).toBe('nexdeck · Küche')
    expect(whoText([{ id: 1, name: 'Robin', via: 'mcp:Laptop' }], t)).toBe('MCP · Laptop')
  })
})
