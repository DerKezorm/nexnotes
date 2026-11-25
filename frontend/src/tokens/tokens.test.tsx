/**
 * NOTES-25 Programmschnittstelle (API) on the page: the one section "API-Token" in Settings, Connections (the dialog,
 * the token shown once, the list with older keys, run-out in orange, revoking, "API aus"), the connected AI tools below
 * it, the operator's switch and the overview of every token with "Sperren". The server's side is in
 * `backend/tests/test_notes25_*.py`.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { CONNECTION_SECTIONS } from '../extensions'
import { originText } from '../folders/origin'
import { OriginIcon } from '../folders/pages'
import { whoText } from '../history/groups'
import i18n from '../i18n'
import { FeaturesCard } from '../pages/settings/GeneralCards'
import type { ApiTokenEntry, OperatorToken } from './api'
import { AllTokensCard } from './AllTokensCard'
import { TokensSection } from './TokensSection'
import './register'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let tokens: ApiTokenEntry[]
let connectors: ApiTokenEntry[]
let every: OperatorToken[]
let allowed: boolean
let root: Root
let box: HTMLDivElement

const SECRET = 'nn_api_ABCDefgh0123456789abcdefghijklmnopqrstuvw'
const DAY = 86_400_000

function entry(fields: Partial<ApiTokenEntry> & { id: number; name: string }): ApiTokenEntry {
  return {
    kind: 'api', legacy: null, level: 'read', access: ['api'], folders: null, created_at: '2026-11-01T10:00:00Z', last_used_at: null,
    expires_at: new Date(Date.now() + 60 * DAY).toISOString(), expired: false, blocked: false, ...fields,
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/tokens') return reply(200, { allowed, mcp_allowed: true, address: 'https://notes.example', max_tokens: 20, tokens, connectors })
  if (method === 'POST' && path === '/api/tokens') {
    const made = entry({ id: 9, name: String(body!.name), level: body!.level as 'read' | 'write', folders: (body!.folders as string[] | null) ?? null })
    tokens = [...tokens, made]
    return reply(201, { made, token: SECRET })
  }
  const revoke = /^\/api\/tokens\/(\d+)$/.exec(path)
  if (method === 'DELETE' && revoke) {
    tokens = tokens.filter((one) => one.id !== Number(revoke[1]))
    connectors = connectors.filter((one) => one.id !== Number(revoke[1]))
    return reply(204, null)
  }
  if (method === 'GET' && path === '/api/folders')
    return reply(200, { inbox: { id: 'inbox-1', count: 2 }, folders: [{ id: 'f-home', parent_id: null, name: 'Haushalt', icon: '', color: '', position: null, count: 3 }, { id: 'f-shop', parent_id: 'f-home', name: 'Einkauf', icon: '', color: '', position: null, count: 1 }] })
  if (method === 'GET' && path === '/api/admin/tokens') return reply(200, { tokens: every })
  const block = /^\/api\/admin\/tokens\/(\d+)\/block$/.exec(path)
  if (method === 'POST' && block) {
    every = every.map((one) => (one.id === Number(block[1]) ? { ...one, blocked: true } : one))
    return reply(204, null)
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(<MemoryRouter initialEntries={['/settings/connections']}>{node}</MemoryRouter>))
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
  tokens = [
    entry({ id: 1, name: 'n8n Wetter', level: 'write', access: ['api', 'mcp'], folders: ['f-home', 'f-shop'], last_used_at: new Date(Date.now() - DAY).toISOString() }),
    entry({ id: 2, name: 'Skript', expires_at: new Date(Date.now() + 3 * DAY).toISOString() }),
    entry({ id: 3, name: 'Alt', expires_at: new Date(Date.now() - DAY).toISOString(), expired: true }),
    entry({ id: 4, name: 'Chat', kind: 'mcp', legacy: 'mcp', access: ['mcp'], expires_at: null }),
    entry({ id: 5, name: 'Küche', kind: 'dashboard', legacy: 'card', access: ['card'], expires_at: null, blocked: true }),
  ]
  connectors = [entry({ id: 6, name: 'Chat Desktop', kind: 'connector', access: ['mcp'], expires_at: null })]
  every = [
    { ...entry({ id: 1, name: 'n8n Wetter', level: 'write', access: ['api', 'mcp'] }), folders: 2, account: { id: 1, name: 'Tester' } },
    { ...entry({ id: 7, name: 'Fremd', expires_at: null }), folders: 0, account: { id: 2, name: 'Anna' } },
  ]
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

describe('NOTES-25 API tokens in Settings, Connections', () => {
  it('NOTES-25 AC-1 the dialog asks name, right, MCP, folders and run-out, 90 days chosen, MCP off', async () => {
    await render(<TokensSection />)
    await click($('tokens-new'))
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Neuer API-Token')
    expect(($('token-level-read') as HTMLInputElement).checked).toBe(true)
    expect(($('token-mcp') as HTMLInputElement).checked).toBe(false)
    expect(($('token-scope-all') as HTMLInputElement).checked).toBe(true)
    expect(($('token-days') as HTMLSelectElement).value).toBe('90')
    expect([...($('token-days') as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['30 Tage', '90 Tage', '1 Jahr', 'Nie'])
    // Without a name, nothing is made.
    expect(($('token-make') as HTMLButtonElement).disabled).toBe(true)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('NOTES-25 AC-1 a token for some folders, read and write, with MCP, is shown exactly once with Copy', async () => {
    const copied = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    vi.stubGlobal('isSecureContext', true)
    await render(<TokensSection />)
    expect($('tokens-made')).toBeNull()
    await click($('tokens-new'))
    act(() => type(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!, 'Home Assistant'))
    await click($('token-level-write'))
    await click($('token-mcp'))
    await click($('token-scope-some'))
    // "Nur diese Ordner" needs one folder at least.
    expect(($('token-make') as HTMLButtonElement).disabled).toBe(true)
    expect($$('token-folder').map((box) => box.dataset.folder)).toEqual(['inbox-1', 'f-home', 'f-shop'])
    await click($$('token-folder')[1])
    const days = $('token-days') as HTMLSelectElement
    await act(async () => {
      days.value = 'never'
      days.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click($('token-make'))
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ name: 'Home Assistant', level: 'write', mcp: true, folders: ['f-home'], days: null })
    expect($('tokens-made')!.textContent).toContain('„Home Assistant“ angelegt')
    expect($('tokens-made')!.textContent).toContain('Er wird nur dieses eine Mal angezeigt.')
    expect($('tokens-secret')!.textContent).toBe(SECRET)
    await click($('tokens-copy'))
    expect(copied).toHaveBeenCalledWith(SECRET)
    expect($('tokens-copy')!.textContent).toBe('Kopiert')
    await act(async () => root.unmount())
    root = createRoot(box)
    await render(<TokensSection />)
    expect($('tokens-made')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('NOTES-25 AC-2 the list says right, access, folders, run-out and last use; orange from 7 days before', async () => {
    await render(<TokensSection />)
    expect($$('token-name').map((name) => name.textContent)).toEqual(['n8n Wetter', 'Skript', 'Alt', 'Chat', 'Küche'])
    const metas = $$('token-meta').map((meta) => meta.textContent)
    expect(metas[0]).toBe('lesen und schreiben · API · MCP · 2 Ordner')
    expect(metas[1]).toBe('nur lesen · API · alle Notizen')
    const runs = $$('token-expiry')
    expect(runs[0].textContent).toMatch(/^Läuft am \d\d\.\d\d\.\d{4} ab$/)
    expect(runs[0].className).not.toContain('text-warn-500')
    expect(runs[1].className).toContain('text-warn-500')
    expect(runs[2].textContent).toBe('Abgelaufen')
    expect(runs[2].className).toContain('text-warn-500')
    expect(runs[3].textContent).toBe('Läuft nie ab')
    expect($$('token-row')[0].textContent).toContain('zuletzt gestern')
    expect($$('token-row')[1].textContent).toContain('noch nie benutzt')
    expect($('tokens-address')!.textContent).toBe('https://notes.example')
  })

  it('NOTES-25 AC-2 revoking asks once, then the token is gone', async () => {
    await render(<TokensSection />)
    await click($$('token-revoke')[1])
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('„Skript“ widerrufen?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await click($('tokens-revoke-confirm'))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/tokens/2'])
    expect($$('token-name').map((name) => name.textContent)).not.toContain('Skript')
  })

  it('NOTES-25 AC-3 older keys stand in the same list with what they still open', async () => {
    await render(<TokensSection />)
    const metas = $$('token-meta').map((meta) => meta.textContent)
    expect(metas[3]).toBe('nur lesen · nur MCP (älterer Schlüssel) · alle Notizen')
    expect(metas[4]).toBe('nur lesen · nur nexdeck-Karte (älterer Token) · alle Notizen')
    expect($$('token-row')[4].textContent).toContain('Vom Betreiber gesperrt')
  })

  it('NOTES-25 AC-4 connected AI tools stand below the tokens and are revoked there', async () => {
    await render(<TokensSection />)
    expect(document.body.textContent).toContain('Verbundene KI-Werkzeuge')
    expect($$('connector-row').map((row) => row.textContent)).toEqual([expect.stringContaining('Chat Desktop')])
    await click($('connector-revoke'))
    await click($('tokens-revoke-confirm'))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/tokens/6'])
    expect($('connectors-none')).not.toBeNull()
  })

  it('NOTES-25 AC-5 while the operator has the API switched off, the section says so and makes nothing', async () => {
    allowed = false
    await render(<TokensSection />)
    expect($('tokens-off')!.textContent).toBe(
      'Der Betreiber hat die Programmschnittstelle abgeschaltet. Bestehende Tokens funktionieren erst wieder, wenn er sie einschaltet.',
    )
    expect(($('tokens-new') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NOTES-25 AC-25 the section links to the API documentation', async () => {
    await render(<TokensSection />)
    expect($('tokens-docs')!.getAttribute('href')).toBe('/api/v1/docs')
    expect($('tokens-docs')!.textContent).toBe('API-Dokumentation')
  })

  it('NOTES-25 one section API-Token in Connections, before the vault password, no separate MCP or card section', () => {
    const order = CONNECTION_SECTIONS.map((section) => section.key)
    expect(order).toContain('tokens')
    expect(order).not.toContain('mcp')
    expect(order).not.toContain('dashboard')
    if (order.includes('vault')) expect(order.indexOf('tokens')).toBeLessThan(order.indexOf('vault'))
  })
})

describe('NOTES-25 the operator', () => {
  it('NOTES-25 AC-5 the switch "Programmschnittstelle (API) für Mitglieder" stands in General and saves', async () => {
    const save = vi.fn(async () => undefined)
    const server = { settings: { link_previews: true, share_links: true, mcp_enabled: true, api_enabled: true, connections_local_network: false }, save }
    await render(<FeaturesCard server={server as never} />)
    const toggle = document.querySelector<HTMLInputElement>('input[data-testid="feature-api"]')!
    expect(toggle.type).toBe('checkbox')
    expect(toggle.labels![0].textContent).toBe('Programmschnittstelle (API) für Mitglieder')
    expect(toggle.checked).toBe(true)
    await click(toggle)
    expect(save).toHaveBeenCalledWith({ api_enabled: false })
  })

  it('NOTES-25 AC-27 every token of every account, folders only as a number, and Sperren', async () => {
    await render(<AllTokensCard />)
    const rows = $$('all-token-row')
    expect(rows.map((row) => row.querySelector('span span')!.textContent)).toEqual(['Tester · n8n Wetter', 'Anna · Fremd'])
    expect($$('all-token-meta')[0].textContent).toContain('lesen und schreiben · API · MCP · 2 Ordner')
    expect(document.body.textContent).not.toContain('nn_api_')
    await click($$('all-token-block')[1])
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('„Fremd“ sperren?')
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    await click(document.querySelector<HTMLElement>('[role="dialog"] button[type="submit"]'))
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual(['/api/admin/tokens/7/block'])
    expect($$('all-token-row')[1].textContent).toContain('Vom Betreiber gesperrt')
  })
})

describe('NOTES-25 what a program wrote, in the inbox and the history', () => {
  it('NOTES-25 AC-14 a note made over the API says "Über die API von …" with a sign of its own', async () => {
    expect(originText('api:Wetterbericht', i18n.t)).toBe('Über die API von „Wetterbericht“')
    expect(originText('api:', i18n.t)).toBe('Über die API')
    await render(<OriginIcon origin="api:Wetterbericht" />)
    expect($('inbox-origin-icon')!.dataset.origin).toBe('api')
    expect($('inbox-origin-icon')!.getAttribute('class')).toContain('lucide-braces')
  })

  it('NOTES-25 AC-22 the history names the account through the API token', () => {
    expect(whoText([{ id: 1, name: 'Tester', via: 'api:Hausautomation' }], i18n.t)).toBe('Tester über API-Token „Hausautomation“')
    expect(whoText([{ id: 1, name: 'Tester', via: 'mcp:Laptop' }], i18n.t)).toBe('MCP · Laptop')
  })
})
