/**
 * NOTES-25 Programmschnittstelle (API) on the page, since the settings pass on the cards of the shared key module
 * (schluessel 1.0.0) with nexnotes' words: "API-Schlüssel" in Settings, Connections (the dialog, the key shown once, the
 * list with the older keys, run-out, revoking, "API aus"), "KI-Werkzeuge (MCP)" after it (connected AI tools, the older
 * MCP keys), the operator's switch in "Schnittstellen" and "API-Schlüssel aller Konten" with "Sperren". The server's
 * side is in `backend/tests/test_notes25_*.py` and the module's contract tests.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { CONNECTION_SECTIONS } from '../extensions'
import { originText } from '../folders/origin'
import { OriginIcon } from '../folders/pages'
import { whoText } from '../history/groups'
import i18n from '../i18n'
import { KEY_TEXTS, type AdminKey, type Interfaces as Switches, type KeyEntry, type KeyListing } from '../vendor/nexschluessel'
import { AllKeys, ConnectionKeys, Interfaces } from './KeysCards'
import './register'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { id: 1, name: 'tester', role: 'member' } }) }))

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let keys: KeyEntry[]
let every: AdminKey[]
let api: boolean
let switches: Switches
let root: Root
let box: HTMLDivElement

const SECRET = 'nn_api_ABCDefgh0123456789abcdefghijklmnopqrstuvw'
const DAY = 86_400_000
const BASE = '/api/connections'
const FOLDERS = [
  { id: 'inbox-1', name: 'Eingang' },
  { id: 'f-home', name: 'Haushalt' },
  { id: 'f-shop', name: 'Haushalt › Einkauf' },
]

function entry(fields: Partial<KeyEntry> & { id: number; name: string }): KeyEntry {
  return {
    kind: 'api', right: 'read', options: { mcp: false }, areas: null, prefix: `nn_api_Ab${fields.id}x`, created_at: '2026-11-01T10:00:00Z',
    last_used_at: null, expires_at: new Date(Date.now() + 60 * DAY).toISOString(), expired: false, expiring: false, blocked: false, legacy: null,
    program: false, ...fields,
  }
}

function listing(): KeyListing {
  return {
    app: 'nexnotes', api, mcp: true, programs: true, api_path: '/api/v1', mcp_path: '/api/mcp', keys_wait: false, warn_days: 7,
    address: 'https://notes.example.com',
    kinds: [
      { id: 'api', prefix: 'nn_api_', creatable: true, editable: true, rights: ['read', 'write'], default_right: 'read', options: ['mcp'], areas: FOLDERS,
        areas_required: false, expiry_days: [30, 90, 365, null], default_days: 90, default_days_by_right: {}, max_keys: 20, count: 4, name_max: 100 },
      { id: 'mcp', prefix: 'nn_mcp_', creatable: false, editable: false, rights: ['read', 'write'], default_right: 'read', options: [], areas: null,
        areas_required: false, expiry_days: [30, 90, 365, null], default_days: 90, default_days_by_right: {}, max_keys: 20, count: 1, name_max: 100 },
    ],
    keys,
  } as KeyListing
}

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === `${BASE}/keys`) return reply(200, listing())
  if (method === 'POST' && path === `${BASE}/keys`) {
    const areas = Array.isArray(body!.areas) ? FOLDERS.filter((folder) => (body!.areas as string[]).includes(folder.id)) : null
    const made = entry({ id: 9, name: String(body!.name), right: String(body!.right), options: body!.options as Record<string, boolean>, areas, expires_at: null })
    keys = [made, ...keys]
    return reply(201, { key: made, secret: SECRET })
  }
  const revoke = /^\/api\/connections\/keys\/(\d+)$/.exec(path)
  if (method === 'DELETE' && revoke) {
    keys = keys.filter((one) => one.id !== Number(revoke[1]))
    return reply(204, null)
  }
  if (method === 'GET' && path === `${BASE}/admin/keys`) return reply(200, { keys: every })
  const block = /^\/api\/connections\/admin\/keys\/(\d+)\/block$/.exec(path)
  if (method === 'POST' && block) {
    every = every.map((one) => (one.id === Number(block[1]) ? { ...one, blocked: true } : one))
    return reply(200, every.find((one) => one.id === Number(block[1])))
  }
  if (method === 'GET' && path === `${BASE}/interfaces`) return reply(200, switches)
  if (method === 'PUT' && path === `${BASE}/interfaces`) {
    switches = { ...switches, ...(body as Switches) }
    return reply(200, switches)
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

const $ = (testId: string, scope: ParentNode = document.body) => scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string, scope: ParentNode = document.body) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
const card = (id: string) => document.querySelector<HTMLElement>(`[data-card="${id}"]`)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const dialogTitle = () => document.getElementById(dialog()?.getAttribute('aria-labelledby') ?? '')?.textContent
const rowsOf = (scope: ParentNode) => $$('key-row', scope).filter((row) => row.tagName === 'TR')
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLElement>('button')].find((found) => found.textContent?.trim() === text) ?? null

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
  api = true
  switches = { api: true, mcp: true }
  keys = [
    entry({ id: 1, name: 'n8n Wetter', right: 'write', options: { mcp: true }, areas: [FOLDERS[1]!, FOLDERS[2]!], last_used_at: new Date(Date.now() - DAY).toISOString() }),
    entry({ id: 2, name: 'Skript', expires_at: new Date(Date.now() + 3 * DAY).toISOString(), expiring: true }),
    entry({ id: 3, name: 'Alt', expires_at: new Date(Date.now() - DAY).toISOString(), expired: true }),
    entry({ id: 4, name: 'Chat', kind: 'mcp', prefix: 'nn_mcp_Abcd', options: {}, expires_at: null }),
    entry({ id: 5, name: 'Küche', legacy: 'card', expires_at: null, blocked: true }),
    entry({ id: 6, name: 'Chat Desktop', kind: 'mcp', program: true, right: 'write', options: {}, expires_at: null }),
  ]
  every = [
    { ...entry({ id: 1, name: 'n8n Wetter', right: 'write', options: { mcp: true } }), areas: 2, account: { id: 1, name: 'tester', display_name: 'Tester', out: false }, extra: { folders: 2 } },
    { ...entry({ id: 7, name: 'Fremd', expires_at: null }), areas: null, account: { id: 2, name: 'anna', display_name: 'Anna', out: false }, extra: { folders: 0 } },
  ] as AdminKey[]
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

describe('NOTES-25 API keys in Settings, Connections', () => {
  it('NOTES-25 AC-1 the dialog asks name, right, MCP, folders and run-out, 90 days chosen, MCP off', async () => {
    await render(<ConnectionKeys />)
    await click($('api-keys-new'))
    expect(dialogTitle()).toBe('Neuer API-Schlüssel')
    expect($('key-right-read')!.getAttribute('aria-checked')).toBe('true')
    expect(($('key-option-mcp') as HTMLInputElement).checked).toBe(false)
    expect($('key-areas')!.textContent).toContain('Ordner')
    expect($('key-areas-all')!.getAttribute('aria-checked')).toBe('true')
    // One wording in every app (schluessel 1.1.1, M-5), with nexnotes' word for its areas.
    expect([$('key-areas-all')!.textContent, $('key-areas-some')!.textContent]).toEqual(['Alle Ordner, auch spätere', 'Nur diese Ordner'])
    expect(($('key-expiry') as HTMLSelectElement).value).toBe('90')
    expect([...($('key-expiry') as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['30 Tage', '90 Tage', '1 Jahr', 'Nie'])
    // Without a name, nothing is made.
    expect(($('key-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('NOTES-25 AC-1 a key for some folders, read and write, with MCP, is shown exactly once with Copy', async () => {
    const copied = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    vi.stubGlobal('isSecureContext', true)
    await render(<ConnectionKeys />)
    expect($('key-made')).toBeNull()
    await click($('api-keys-new'))
    act(() => type($('key-name') as HTMLInputElement, 'Home Assistant'))
    await click($('key-right-write'))
    await click($('key-option-mcp'))
    await click($('key-areas-some'))
    // "Nur diese Ordner" needs one folder at least.
    expect(($('key-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(FOLDERS.map((folder) => $(`key-area-${folder.id}`) !== null)).toEqual([true, true, true])
    await click($('key-area-f-home'))
    const days = $('key-expiry') as HTMLSelectElement
    await act(async () => {
      days.value = [...days.options].find((option) => option.textContent === 'Nie')!.value
      days.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click($('key-submit'))
    const sent = calls.find((call) => call.method === 'POST')!.body!
    expect({ ...sent, client_ref: undefined }).toEqual({ kind: 'api', name: 'Home Assistant', right: 'write', options: { mcp: true }, areas: ['f-home'], days: null, client_ref: undefined })
    expect($('key-made')!.textContent).toContain('„Home Assistant“ angelegt')
    expect($('key-made')!.textContent).toContain('Er wird nur dieses eine Mal angezeigt')
    expect(($('key-secret')!.querySelector('input') ?? $('key-secret')) as HTMLElement).toBeTruthy()
    expect(document.body.innerHTML).toContain(SECRET)
    await click(button($('key-made')!, 'Kopieren'))
    expect(copied).toHaveBeenCalledWith(SECRET)
    await act(async () => root.unmount())
    root = createRoot(box)
    await render(<ConnectionKeys />)
    expect($('key-made')).toBeNull()
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('NOTES-25 AC-2 the list says right, folders, run-out and last use; marked from 7 days before', async () => {
    await render(<ConnectionKeys />)
    const rows = rowsOf(card('api-keys'))
    expect(rows.map((row) => row.querySelector('.font-medium')!.textContent)).toEqual(['n8n Wetter', 'Skript', 'Alt', 'Küche'])
    expect(rows[0]!.textContent).toContain('Lesen und schreiben')
    expect(rows[0]!.textContent).toContain('MCP')
    expect(rows[0]!.textContent).toContain('Haushalt, Haushalt › Einkauf')
    expect(rows[1]!.textContent).toContain('Nur lesen')
    expect(rows[1]!.textContent).toContain('alles')
    expect(rows[0]!.textContent).toMatch(/Läuft am .+ ab/)
    expect($('key-expiring', rows[0]!)).toBeNull()
    expect($('key-expiring', rows[1]!)).not.toBeNull()
    expect($('key-expired', rows[2]!)!.textContent).toBe('Abgelaufen')
    expect(rows[3]!.textContent).toContain('Läuft nie ab')
    expect(rows[1]!.textContent).toContain('noch nie')
    expect(rows[0]!.textContent).not.toContain('noch nie')
    expect(($('api-keys-address')!.querySelector('input') as HTMLInputElement).value).toBe('https://notes.example.com/api/v1')
    expect($('api-keys-count')!.textContent).toBe('4 von 20 Schlüsseln')
  })

  it('NOTES-25 AC-2 revoking asks once, then the key is gone', async () => {
    await render(<ConnectionKeys />)
    await click($$('key-revoke', card('api-keys'))[1]!)
    expect(dialogTitle()).toBe('„Skript“ widerrufen?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await click(button($('key-revoke-dialog')!, 'Widerrufen'))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`${BASE}/keys/2`])
    expect(rowsOf(card('api-keys')).map((row) => row.querySelector('.font-medium')!.textContent)).not.toContain('Skript')
  })

  it('NOTES-25 AC-3 older keys stand in the lists with what they still open', async () => {
    await render(<ConnectionKeys />)
    const card4 = rowsOf(card('api-keys'))[3]!
    expect(card4.textContent).toContain(KEY_TEXTS.de.legacy.card)
    expect($('key-blocked', card4)!.textContent).toBe('Vom Betreiber gesperrt')
    // The MCP key made by hand: in "KI-Werkzeuge (MCP)", under "MCP-Schlüssel", revocable, not editable.
    const mcp = rowsOf($('tools-keys', card('ai-tools'))!)
    expect(mcp.map((row) => row.querySelector('.font-medium')!.textContent)).toEqual(['Chat'])
    expect($('key-edit', mcp[0]!)).toBeNull()
    expect($('key-revoke', mcp[0]!)).not.toBeNull()
  })

  it('NOTES-25 AC-4 connected AI tools stand below the keys and are revoked there', async () => {
    await render(<ConnectionKeys />)
    expect([...document.querySelectorAll('[data-card]')].map((found) => found.getAttribute('data-card'))).toEqual(['api-keys', 'ai-tools'])
    expect(card('ai-tools').textContent).toContain('Verbundene Programme')
    const programs = rowsOf($('tools-programs', card('ai-tools'))!)
    expect(programs.map((row) => row.querySelector('.font-medium')!.textContent)).toEqual(['Chat Desktop'])
    await click($('key-revoke', programs[0]!))
    await click(button($('key-revoke-dialog')!, 'Widerrufen'))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`${BASE}/keys/6`])
    expect(rowsOf($('tools-programs', card('ai-tools'))!)).toHaveLength(0)
    expect(($('tools-address')!.querySelector('input') as HTMLInputElement).value).toBe('https://notes.example.com/api/mcp')
  })

  it('NOTES-25 AC-5 while the operator has the API switched off, the card says so and makes nothing', async () => {
    api = false
    await render(<ConnectionKeys />)
    expect($('api-keys-off')!.textContent).toContain(
      'Der Betreiber hat die Programmschnittstelle abgeschaltet. Bestehende Schlüssel funktionieren erst wieder, wenn er sie einschaltet.',
    )
    expect(($('api-keys-new') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NOTES-25 AC-25 the card links to the API documentation', async () => {
    await render(<ConnectionKeys />)
    expect($('api-keys-docs')!.getAttribute('href')).toBe('/api/v1/docs')
    expect($('api-keys-docs')!.textContent).toBe('Beschreibung der Schnittstelle')
  })

  it('NOTES-25 one place for the keys in Connections, before the vault password, no separate MCP or card section', () => {
    const order = CONNECTION_SECTIONS.map((section) => section.key)
    expect(order).toContain('tokens')
    expect(order).not.toContain('mcp')
    expect(order).not.toContain('dashboard')
    if (order.includes('vault')) expect(order.indexOf('tokens')).toBeLessThan(order.indexOf('vault'))
  })
})

describe('NOTES-25 the operator', () => {
  it('NOTES-25 AC-5 the switch "Programmschnittstelle (API) für Mitglieder" stands in "Schnittstellen" and saves', async () => {
    await render(<Interfaces />)
    expect(card('interfaces')).not.toBeNull()
    const toggle = document.querySelector<HTMLInputElement>('input[data-testid="interfaces-api"]')!
    expect(toggle.type).toBe('checkbox')
    expect(toggle.labels![0]!.textContent).toBe('Programmschnittstelle (API) für Mitglieder')
    expect(toggle.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[data-testid="interfaces-mcp"]')!.labels![0]!.textContent).toBe('MCP-Zugang')
    await click(toggle)
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ api: false }])
    expect(toggle.checked).toBe(false)
  })

  it('NOTES-25 AC-27 every key of every account, folders only as a number, and Sperren', async () => {
    await render(<AllKeys />)
    const rows = $$('all-keys-row').filter((row) => row.tagName === 'TR')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Tester'), expect.stringContaining('Anna')])
    expect(rows[0]!.textContent).toContain('n8n Wetter')
    expect(rows[0]!.textContent).toContain('Lesen und schreiben')
    // The operator learns how many folders (nexnotes' own column, E36), never which; never the key, not even its start.
    const heads = [...document.querySelectorAll('[data-testid="all-keys-table"] thead th')].map((cell) => cell.textContent)
    expect(heads).toContain('Ordner')
    expect(rows[0]!.textContent).toContain('2 Ordner')
    expect(rows[1]!.textContent).toContain('alle Notizen')
    expect(document.body.textContent).not.toContain('Haushalt')
    expect(document.body.textContent).not.toContain('nn_api_')
    await click($('all-keys-block', rows[1]!))
    expect(dialogTitle()).toBe('„Fremd“ von Anna sperren?')
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    await click(button($('all-keys-block-dialog')!, 'Sperren'))
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([`${BASE}/admin/keys/7/block`])
    expect($$('all-keys-row').filter((row) => row.tagName === 'TR')[1]!.dataset.blocked).toBe('true')
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

  it('NOTES-25 AC-22 the history names the account through the API key', () => {
    expect(whoText([{ id: 1, name: 'Tester', via: 'api:Hausautomation' }], i18n.t)).toBe('Tester über API-Schlüssel „Hausautomation“')
    expect(whoText([{ id: 1, name: 'Tester', via: 'mcp:Laptop' }], i18n.t)).toBe('MCP · Laptop')
  })
})
