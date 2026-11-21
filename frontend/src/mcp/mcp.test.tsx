/**
 * NOTES-20 MCP-Zugang on the page: the keys in Settings, Connections (made with a name and a right, shown once with
 * "Copy", listed with right and last use, revoked; nothing new while the operator has MCP switched off) and the consent
 * page of a connecting program. The server's side is in `backend/tests/test_notes20.py`.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { CONNECTION_SECTIONS } from '../extensions'
import i18n from '../i18n'
import { leave, type McpKey } from './api'
import { ConsentPage } from './ConsentPage'
import { McpKeysSection } from './McpKeysSection'
import './register'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let keys: McpKey[]
let allowed: boolean
let root: Root
let box: HTMLDivElement

const TOKEN = 'nn_mcp_ABCDefgh0123456789abcdefghijklmnopqrstuvw'

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/mcp/keys') return reply(200, { allowed, address: 'http://localhost/api/mcp', max_keys: 20, keys })
  if (method === 'POST' && path === '/api/mcp/keys') {
    if (!allowed) return reply(403, { detail: { code: 'mcp_off', message: 'off' } })
    const key: McpKey = { id: 7, name: String(body!.name), level: body!.level as 'read' | 'write', prefix: 'nn_mcp_ABCD', kind: 'key', created_at: '2026-11-21T10:00:00Z', last_used_at: null }
    keys = [...keys, key]
    return reply(201, { key, token: TOKEN })
  }
  const revoke = /^\/api\/mcp\/keys\/(\d+)$/.exec(path)
  if (method === 'DELETE' && revoke) {
    keys = keys.filter((key) => key.id !== Number(revoke[1]))
    return reply(204, null)
  }
  if (method === 'GET' && path === '/api/oauth/authorize') return reply(200, { client_name: 'Chat program', redirect_host: '127.0.0.1:33418' })
  if (method === 'POST' && path === '/api/oauth/authorize')
    return reply(200, { redirect: body!.approve ? 'http://127.0.0.1:33418/cb?code=CODE&state=s1' : 'http://127.0.0.1:33418/cb?error=access_denied&state=s1' })
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(node: ReactNode, at = '/settings/connections'): Promise<void> {
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>))
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
  allowed = true
  keys = [
    { id: 1, name: 'Claw', level: 'write', prefix: 'nn_mcp_aaaa', kind: 'key', created_at: '2026-11-01T10:00:00Z', last_used_at: new Date(Date.now() - 86400_000).toISOString() },
    { id: 2, name: 'Skript Wochenplan', level: 'read', prefix: 'nn_mcp_bbbb', kind: 'key', created_at: '2026-11-02T10:00:00Z', last_used_at: null },
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NOTES-20 MCP keys in Settings, Connections', () => {
  it('NOTES-20 AC-1 a key gets a name and read only or read and write, and is shown exactly once with Copy', async () => {
    const copied = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    vi.stubGlobal('isSecureContext', true)
    await render(<McpKeysSection />)
    expect($('mcp-made')).toBeNull()
    await click($('mcp-new'))
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!
    act(() => type(name, 'Einkaufsliste per Chat'))
    await click($('mcp-level-write'))
    await click($('mcp-make'))
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ name: 'Einkaufsliste per Chat', level: 'write' })
    expect($('mcp-made')!.textContent).toContain('„Einkaufsliste per Chat“ angelegt · nur jetzt sichtbar')
    expect($('mcp-token')!.textContent).toBe(TOKEN)
    await click($('mcp-copy'))
    expect(copied).toHaveBeenCalledWith(TOKEN)
    expect($('mcp-copy')!.textContent).toBe('Kopiert')
    // Gone for good once the page is left: a new look at the list never shows it again.
    await act(async () => root.unmount())
    root = createRoot(box)
    await render(<McpKeysSection />)
    expect($('mcp-made')).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('NOTES-20 AC-1 the dialog starts at read only and makes nothing without a name', async () => {
    await render(<McpKeysSection />)
    await click($('mcp-new'))
    expect(($('mcp-level-read') as HTMLInputElement).checked).toBe(true)
    expect(($('mcp-make') as HTMLButtonElement).disabled).toBe(true)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('NOTES-20 AC-9 the list says name, right and last use of each key', async () => {
    await render(<McpKeysSection />)
    const rows = $$('mcp-key')
    expect(rows.map((row) => row.querySelector('span span')!.textContent)).toEqual(['Claw', 'Skript Wochenplan'])
    const metas = $$('mcp-key-meta').map((meta) => meta.textContent)
    expect(metas[0]).toBe('lesen und schreiben · zuletzt gestern')
    expect(metas[1]).toBe('nur lesen · noch nie benutzt')
    expect($('mcp-address')!.textContent).toBe('http://localhost/api/mcp')
  })

  it('NOTES-20 AC-5 revoking asks once, then the key is gone from the list', async () => {
    await render(<McpKeysSection />)
    await click($$('mcp-revoke')[0])
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('„Claw“ widerrufen?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await click($('mcp-revoke-confirm'))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/mcp/keys/1'])
    expect($$('mcp-key').map((row) => row.querySelector('span span')!.textContent)).toEqual(['Skript Wochenplan'])
  })

  it('NOTES-20 AC-8 while the operator has MCP switched off, no key can be made', async () => {
    allowed = false
    await render(<McpKeysSection />)
    expect($('mcp-off')!.textContent).toContain('Der Betreiber hat MCP abgeschaltet')
    expect(($('mcp-new') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NOTES-20 the section stands after the others and before the vault password', () => {
    const order = CONNECTION_SECTIONS.map((section) => section.key)
    expect(order).toContain('mcp')
    if (order.includes('vault')) expect(order.indexOf('mcp')).toBeLessThan(order.indexOf('vault'))
  })
})

describe('NOTES-20 connecting a program (OAuth)', () => {
  const asked = '/oauth/authorize?response_type=code&client_id=nno_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A33418%2Fcb&code_challenge=' + 'c'.repeat(43) + '&code_challenge_method=S256&state=s1'

  it('NOTES-20 AC-7 the member chooses read only or read and write and goes back to the program', async () => {
    const went = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    await render(<ConsentPage />, asked)
    expect($('mcp-consent')!.textContent).toContain('„Chat program“ verbinden?')
    expect($('mcp-consent')!.textContent).toContain('127.0.0.1:33418')
    expect(($('consent-level-read') as HTMLInputElement).checked).toBe(true)
    await click($('consent-level-write'))
    await click($('consent-allow'))
    const sent = calls.find((call) => call.method === 'POST')!.body!
    expect(sent).toMatchObject({ client_id: 'nno_x', approve: true, level: 'write', state: 's1', code_challenge_method: 'S256' })
    expect(went).toHaveBeenCalledWith('http://127.0.0.1:33418/cb?code=CODE&state=s1')
  })

  it('NOTES-20 AC-7 denying sends the program away without a code', async () => {
    const went = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    await render(<ConsentPage />, asked)
    await click($('consent-deny'))
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ approve: false })
    expect(went).toHaveBeenCalledWith('http://127.0.0.1:33418/cb?error=access_denied&state=s1')
  })

  it('NOTES-20 AC-7 an incomplete request asks nothing and says so', async () => {
    await render(<ConsentPage />, '/oauth/authorize?client_id=nno_x')
    expect(calls).toEqual([])
    expect($('mcp-consent')!.textContent).toContain('unvollständig')
    expect($('consent-allow')).toBeNull()
  })
})
