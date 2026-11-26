/**
 * Settings, Connections: the cards of the other nex apps (module verbinden) with nexnotes' parts: nextasks' older way
 * (a key typed in, NOTES-19) behind "Von Hand verbinden", and its "Bereiche und Listen" while connected with a click.
 * The module's card is tested in `src/nexverbinden.test.tsx`, the server's side in `backend/tests/nexverbinden` and
 * `backend/tests/test_verbinden_module.py`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from '../i18n'
import { setNextasks } from '../nextasks/api'
import type { PartnerView } from '../vendor/nexverbinden'
import { AppsArea } from './AppsArea'

let root: Root
let box: HTMLDivElement
let views: PartnerView[]
let status: Record<string, unknown>
const paths: string[] = []

function view(partner: string, more: Partial<PartnerView> = {}): PartnerView {
  return {
    partner, state: 'none', address: '', address_from_operator: false, host: '', uses: [], grants: [], uses_levels: {},
    grants_levels: {}, account: null, since: null, ok_at: null, used_at: null, stale_since: null, problem: null,
    areas_used: null, areas_granted: null, legacy: null, areas_choice: [], version: null, ...more,
  }
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

const $ = (testId: string, within: ParentNode = document.body) => within.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  paths.length = 0
  setNextasks(null)
  views = [view('nextasks', { uses: ['tasks.read', 'tasks.write'], uses_levels: { 'tasks.read': 'read', 'tasks.write': 'write' } }), view('nexlore'), view('nextime')]
  status = { connected: false, local_allowed: false }
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname
    paths.push(path)
    const body = path === '/api/connect/partners' ? views : path === '/api/nextasks' ? status : path === '/api/nextasks/areas' ? { areas: [], default: null } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function show(): Promise<void> {
  await act(async () => root.render(<MemoryRouter><AppsArea /></MemoryRouter>))
  await settle()
}

/** A card opens on a click on its head. */
async function open(card: HTMLElement): Promise<void> {
  const head = card.querySelector<HTMLElement>('[aria-expanded]')!
  if (head.getAttribute('aria-expanded') !== 'true') await act(async () => head.click())
  await settle()
}

describe('the cards of the other nex apps (module verbinden)', () => {
  it('V23 shows "Bereiche und Listen" open in the card of a key typed in, not under "Von Hand verbinden"', async () => {
    views[0] = view('nextasks', { state: 'legacy', address: 'https://tasks.example.com', host: 'tasks.example.com', legacy: { shown: 'ntk_AbCd', expires_at: null }, uses: ['tasks.read', 'tasks.write'], uses_levels: { 'tasks.read': 'read', 'tasks.write': 'write' } })
    status = { connected: true, local_allowed: false, url: 'https://tasks.example.com', host: 'tasks.example.com', name: 'kim', by: 'key' }
    await show()
    const card = $('connection-nextasks')!
    await open(card)
    expect(paths).toContain('/api/nextasks/areas')
    expect($('nextasks-by-hand', card)).toBeNull()
  })

  it('shows one card per partner of the catalog, each with its logo', async () => {
    await show()
    expect(paths).toContain('/api/connect/partners')
    for (const partner of ['nextasks', 'nexlore', 'nextime']) expect($(`connection-${partner}`)).not.toBeNull()
    // The partners' logos come from the module (0.1.2), not from nexnotes.
    expect($('connection-nextasks')!.querySelector('img')).not.toBeNull()
  })

  it('NOTES-19 AC-5 keeps the key typed in as "Von Hand verbinden" in the card of nextasks', async () => {
    await show()
    const card = $('connection-nextasks')!
    await open(card)
    expect($('nextasks-form', card)).toBeNull()
    await act(async () => $('connection-manual', card)!.click())
    await settle()
    expect($('nextasks-by-hand', card)).not.toBeNull()
    expect($('nextasks-form', card)).not.toBeNull()
    // Not connected: no lists to choose.
    expect(paths).not.toContain('/api/nextasks/areas')
    expect(i18n.t('nextasks.section.url')).toBeTruthy()
  })

  it('shows "Bereiche und Listen" while nextasks is connected with a click, and no form of a key', async () => {
    views[0] = view('nextasks', { state: 'connected', address: 'https://tasks.example.com', host: 'tasks.example.com', account: 'kim', uses: ['tasks.read', 'tasks.write'], uses_levels: { 'tasks.read': 'read', 'tasks.write': 'write' } })
    status = { connected: true, local_allowed: false, url: 'https://tasks.example.com', host: 'tasks.example.com', name: 'kim', by: 'connection' }
    await show()
    const card = $('connection-nextasks')!
    await open(card)
    expect(paths).toContain('/api/nextasks/areas')
    expect($('nextasks-form', card)).toBeNull()
  })
})
