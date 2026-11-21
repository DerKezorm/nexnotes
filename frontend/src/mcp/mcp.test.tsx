/**
 * NOTES-20 MCP-Zugang on the page: the consent page of a connecting program. Keys for MCP are API tokens since NOTES-25
 * (`src/tokens/tokens.test.tsx`). The server's side is in `backend/tests/test_notes20.py`.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from '../i18n'
import { leave } from './api'
import { ConsentPage } from './ConsentPage'
import './register'

type Call = { method: string; path: string; query: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let root: Root
let box: HTMLDivElement

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path, body } = call
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
