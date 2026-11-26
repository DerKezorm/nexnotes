/**
 * NOTES-20 MCP-Zugang on the page, since the module mcp: the consent page a connecting program sends its member to
 * (`/oauth/authorize`, the module's "Programm verbinden" with nexnotes' levels and folders) and the page of one request
 * (`/mcp/requests/<id>`, with nexnotes' word for the tool). The module's parts are tested in `src/nexmcp.test.tsx`, the
 * server's side in `backend/tests/test_notes20.py` and `backend/tests/nexmcp`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { FEATURE_ROUTES } from '../extensions'
import i18n from '../i18n'
import './register'
import { leave } from './words'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let root: Root
let box: HTMLDivElement

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const CONSENT = {
  app: 'nexnotes',
  client: { id: 'nno_x', name: 'Chat program' },
  client_name: 'Chat program',
  redirect_uri: 'http://127.0.0.1:33418/cb',
  redirect_host: '127.0.0.1:33418',
  levels: ['read', 'write'],
  level: 'read',
  areas: [{ id: 'f-1', name: 'Eingang' }, { id: 'f-2', name: 'Arbeit' }],
  extras: [],
  ai_allowed: true,
}

const REQUEST = {
  id: 7, key_id: 3, key_name: 'Chat program', tool: 'create_note', arguments: { title: 'Plan' }, summary: "Make a note 'Plan'",
  dangerous: false, status: 'waiting', created_at: '2026-11-26T09:00:00Z', expires_at: '2026-11-27T09:00:00Z',
  decided_at: null, decided_by: null, result: null,
}

function answer(call: Call): Response {
  const { method, path, body } = call
  if (method === 'GET' && path === '/api/oauth/authorize') return reply(200, CONSENT)
  if (method === 'POST' && path === '/api/oauth/authorize')
    return reply(200, { redirect: body!.allow ? 'http://127.0.0.1:33418/cb?code=CODE&state=s1' : 'http://127.0.0.1:33418/cb?error=access_denied&state=s1' })
  if (method === 'GET' && path === '/api/connections/mcp/requests/7') return reply(200, REQUEST)
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(at: string): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          {FEATURE_ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
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

describe('NOTES-20 connecting a program (OAuth)', () => {
  const asked = '/oauth/authorize?response_type=code&client_id=nno_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A33418%2Fcb&code_challenge=' + 'c'.repeat(43) + '&code_challenge_method=S256&state=s1'

  it('NOTES-20 AC-7 the member chooses read only or read and write and goes back to the program', async () => {
    const went = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    await render(asked)
    expect($('mcp-consent')!.textContent).toContain('Chat program')
    expect($('mcp-consent')!.textContent).toContain('127.0.0.1:33418')
    // nexnotes' words for its levels, the lowest chosen first.
    expect($('consent-level-read')!.textContent).toContain(i18n.t('mcp.dialog.read'))
    expect($('consent-level-read')!.getAttribute('aria-checked')).toBe('true')
    await click($('consent-level-write'))
    await click($('consent-allow'))
    const sent = calls.find((call) => call.method === 'POST')!.body!
    expect(sent).toMatchObject({ client_id: 'nno_x', allow: true, level: 'write', state: 's1', code_challenge_method: 'S256' })
    expect(went).toHaveBeenCalledWith('http://127.0.0.1:33418/cb?code=CODE&state=s1')
  })

  it('NOTES-20 AC-7 the member may limit the program to some folders', async () => {
    vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    await render(asked)
    expect($('consent-areas')!.textContent).toContain(i18n.t('tokens.dialog.folders'))
    await click($('consent-areas-some'))
    await click(document.body.querySelector<HTMLElement>('[data-testid="consent-area-f-2"] input') ?? $('consent-area-f-2'))
    await click($('consent-allow'))
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ allow: true, areas: ['f-2'] })
  })

  it('NOTES-20 AC-7 denying sends the program away without a code', async () => {
    const went = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    await render(asked)
    await click($('consent-refuse'))
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ allow: false })
    expect(went).toHaveBeenCalledWith('http://127.0.0.1:33418/cb?error=access_denied&state=s1')
  })

  it('NOTES-20 AC-7 an incomplete request asks nothing and says so', async () => {
    await render('/oauth/authorize?client_id=nno_x')
    expect(calls).toEqual([])
    expect($('consent-problem')).not.toBeNull()
    expect($('consent-allow')).toBeNull()
  })
})

describe('a request that waits for the member (module mcp)', () => {
  it('shows the tool in nexnotes\' words at /mcp/requests/<id>', async () => {
    await render('/mcp/requests/7')
    expect(calls.some((call) => call.path === '/api/connections/mcp/requests/7')).toBe(true)
    expect(document.body.textContent).toContain(i18n.t('mcp.tools.create_note'))
  })
})
