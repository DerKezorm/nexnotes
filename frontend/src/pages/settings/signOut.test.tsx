/**
 * NOTES-2 AC-12, signing out: one button "Sign out", in Settings › Profile only (the phone shows the same page), not in
 * the sidebar nor in the settings' navigation. It ends the session and leads to the sign-in page; changes that still
 * wait ask first, with the same question as the session's dialog. A provider's session is not touched.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'

import App from '../../App'
import i18n from '../../i18n'
import { onWaiting } from '../../state/account'
import { AuthProvider } from '../../state/auth'

const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}

let me: Record<string, unknown> = ME
let signedIn = true
const calls: { method: string; path: string }[] = []
let root: Root
let box: HTMLDivElement
let here = ''

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  me = ME
  signedIn = true
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      calls.push({ method, path })
      if (path === '/api/setup') return reply(200, { needs_setup: false, signed_in: signedIn, code_required: false, version: '0.1.0', min_password: 12 })
      if (path === '/api/auth/logout' && method === 'POST') {
        signedIn = false
        return reply(204, null)
      }
      if (path === '/api/auth/me') return signedIn ? reply(200, me) : reply(401, { detail: { code: 'sign_in_required' } })
      if (path === '/api/auth/methods') return reply(200, { password: true, providers: [] })
      return reply(200, [])
    }),
  )
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
}

function Where() {
  const { pathname } = useLocation()
  useEffect(() => {
    here = pathname
  }, [pathname])
  return null
}

async function open(at: string): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <AuthProvider>
          <App />
          <Where />
        </AuthProvider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const logouts = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/auth/logout').length

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

describe('signing out (NOTES-2 AC-12)', () => {
  it('NOTES-2 AC-12 the profile has "Sign out"; it ends the session and leads to the sign-in page', async () => {
    await open('/settings/profile')
    const card = byTestId('sign-out-card')
    expect(card).not.toBeNull()
    expect(document.getElementById('sign-out-title')?.textContent).toBe('Sign out')
    await click(byTestId('sign-out'))
    expect(logouts()).toBe(1)
    expect(here).toBe('/login')
    expect(byTestId('sign-out-card')).toBeNull()
  })

  it('NOTES-2 AC-12 the button stands only in the profile, not in the sidebar nor in the settings\' navigation', async () => {
    await open('/settings/profile')
    const label = i18n.t('me.signOut.button')
    const ways = [...document.querySelectorAll<HTMLElement>('button, a, [role="menuitem"], option')].filter((element) => element.textContent?.trim() === label)
    expect(ways).toHaveLength(1)
    expect(byTestId('sign-out-card')?.contains(ways[0])).toBe(true)
    expect(document.querySelector('nav[aria-label="' + i18n.t('app.mainMenu') + '"]')?.textContent).not.toContain(label)
    expect(byTestId('settings-nav')?.textContent).not.toContain(label)
    expect(byTestId('settings-jump-row')?.textContent).not.toContain(label)
    act(() => root.unmount())
    root = createRoot(box)
    await open('/settings/security')
    expect(byTestId('sign-out-card')).toBeNull()
  })

  it('NOTES-2 AC-12 changes still waiting ask first, as in the session dialog: "Wait" keeps the session, "Sign out anyway" ends it', async () => {
    const stop = onWaiting(() => 2)
    try {
      await open('/settings/profile')
      await click(byTestId('sign-out'))
      expect(logouts()).toBe(0)
      expect(byTestId('sign-out-waiting')?.textContent).toContain(i18n.t('session.waitingText', { count: 2 }))
      await click(byTestId('sign-out-wait'))
      expect(byTestId('sign-out-waiting')).toBeNull()
      expect(logouts()).toBe(0)
      expect(here).toBe('/settings/profile')
      await click(byTestId('sign-out'))
      await click(byTestId('sign-out-anyway'))
      expect(logouts()).toBe(1)
      expect(here).toBe('/login')
    } finally {
      stop()
    }
  })

  it('NOTES-2 AC-12 an account from a provider is told it stays signed in there; nexnotes alone signs out', async () => {
    me = { ...ME, sign_in: 'oidc' }
    await open('/settings/profile')
    expect(byTestId('sign-out-card')?.textContent).toContain(i18n.t('me.signOut.provider'))
    await click(byTestId('sign-out'))
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual(['/api/auth/logout'])
    expect(here).toBe('/login')
  })

  it('NOTES-2 AC-12 says it in German too', async () => {
    await i18n.changeLanguage('de')
    me = { ...ME, language: 'de' }
    await open('/settings/profile')
    expect(byTestId('sign-out')?.textContent).toBe('Abmelden')
    expect(document.getElementById('sign-out-title')?.textContent).toBe('Abmelden')
  })
})
