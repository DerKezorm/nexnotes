/**
 * NOTES-2 AC-10: wherever a new password is set (first account, invitation, reset link, "My account"), it is typed
 * twice. Two different ones are not sent; the second field says why, in the page's language. Both fields are
 * "new-password", so a password manager fills its suggestion into both.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import i18n from './i18n'
import { AuthProvider } from './state/auth'

type Answer = { status: number; body: unknown }
let handler: (method: string, path: string, body: unknown) => Answer | undefined = () => undefined
const calls: { method: string; path: string; body: unknown }[] = []

let root: Root
let box: HTMLDivElement

const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0', min_password: 12,
}
const SET_UP = { needs_setup: false, code_required: true, signed_in: true, version: '0.1.0', min_password: 12 }

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  handler = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, path, body })
      const answer = handler(method, path, body) ?? { status: 200, body: [] }
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
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

async function render(node: React.ReactNode, at: string): Promise<void> {
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>))
  await settle()
}

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => void field.dispatchEvent(new Event('input', { bubbles: true })))
}

function field(label: string, within: ParentNode = box): HTMLInputElement {
  const found = [...within.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === label)
  if (!found) throw new Error(`no field "${label}"`)
  return found.querySelector('input')!
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => form.requestSubmit())
  await settle()
}

const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path.startsWith(path))

/** The two fields of the new password: both new-password, the second one named "Confirm password". */
function expectPair(within: ParentNode, first: string) {
  const confirm = field(i18n.t('auth.passwordConfirm'), within)
  expect(field(first, within).autocomplete).toBe('new-password')
  expect(confirm.autocomplete).toBe('new-password')
  expect(confirm.type).toBe('password')
  return confirm
}

/** Two different passwords: nothing is sent, the message sits right below the second field and is tied to it. */
async function expectMismatchRefused(form: HTMLFormElement, confirm: HTMLInputElement, method: string, path: string) {
  await submit(form)
  expect(sent(method, path)).toEqual([])
  const message = document.getElementById(confirm.getAttribute('aria-describedby') ?? '')
  expect(message?.textContent).toBe(i18n.t('errors.password_mismatch'))
  expect(confirm.closest('div')!.contains(message)).toBe(true)
  expect(confirm.getAttribute('aria-invalid')).toBe('true')
}

describe('NOTES-2 AC-10 password confirmation', () => {
  it('NOTES-2 AC-10 password confirmation on the setup of the first account', async () => {
    handler = (method, path) => {
      if (path === '/api/setup' && method === 'GET') return { status: 200, body: { ...SET_UP, needs_setup: true, signed_in: false } }
      if (path === '/api/setup' && method === 'POST') return { status: 200, body: { ...ME, role: 'operator' } }
      return undefined
    }
    const { SetupPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><Routes><Route path="/setup" element={<SetupPage />} /><Route path="/" element={<p>home</p>} /></Routes></AuthProvider>, '/setup')
    const confirm = expectPair(box, i18n.t('auth.password'))
    type(field(i18n.t('setup.code')), 'AB12-CD34')
    type(field(i18n.t('auth.name')), 'Robin')
    type(field(i18n.t('auth.password')), 'twelve chars')
    type(confirm, 'twelve charz')
    await expectMismatchRefused(box.querySelector('form')!, confirm, 'POST', '/api/setup')
    // Typed again the same: the message goes, and the form sends both.
    type(confirm, 'twelve chars')
    expect(box.textContent).not.toContain(i18n.t('errors.password_mismatch'))
    await submit(box.querySelector('form')!)
    expect(sent('POST', '/api/setup').map((call) => call.body)).toEqual([
      { display_name: 'Robin', email: '', password: 'twelve chars', password_confirm: 'twelve chars', code: 'AB12-CD34', language: 'en' },
    ])
  })

  it('NOTES-2 AC-10 password confirmation on the invitation', async () => {
    handler = (method, path) => {
      if (path === '/api/setup') return { status: 200, body: { ...SET_UP, signed_in: false } }
      if (path === '/api/auth/methods') return { status: 200, body: { password: true, providers: [] } }
      if (path.startsWith('/api/invite/') && method === 'GET') return { status: 200, body: { by: 'Robin', email: '', role: 'member', min_password: 12, password: true, signed_in_as: null } }
      if (path.startsWith('/api/invite/') && method === 'POST') return { status: 200, body: ME }
      return undefined
    }
    const { InvitePage } = await import('./pages/AuthPages')
    await render(<AuthProvider><Routes><Route path="/invite/:token" element={<InvitePage />} /><Route path="/" element={<p>home</p>} /></Routes></AuthProvider>, '/invite/abc')
    const confirm = expectPair(box, i18n.t('auth.password'))
    type(field(i18n.t('auth.name')), 'Anna')
    type(field(i18n.t('auth.password')), 'twelve chars')
    type(confirm, 'twelve')
    await expectMismatchRefused(box.querySelector('form')!, confirm, 'POST', '/api/invite/')
    type(confirm, 'twelve chars')
    await submit(box.querySelector('form')!)
    expect(sent('POST', '/api/invite/').map((call) => call.body)).toEqual([
      { display_name: 'Anna', email: '', password: 'twelve chars', password_confirm: 'twelve chars' },
    ])
  })

  it('NOTES-2 AC-10 password confirmation on the reset link', async () => {
    handler = (method, path) => {
      if (path === '/api/setup') return { status: 200, body: { ...SET_UP, signed_in: false } }
      if (path.startsWith('/api/reset/') && method === 'GET') return { status: 200, body: { name: 'Anna', min_password: 12, expires_at: '2026-12-01T00:00:00Z' } }
      if (path.startsWith('/api/reset/') && method === 'POST') return { status: 200, body: {} }
      return undefined
    }
    const { ResetPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><Routes><Route path="/reset/:token" element={<ResetPage />} /></Routes></AuthProvider>, '/reset/abcdefghijklmnopqrstuvwxyz')
    const confirm = expectPair(box, i18n.t('auth.password'))
    type(field(i18n.t('auth.password')), 'twelve chars')
    await expectMismatchRefused(box.querySelector('form')!, confirm, 'POST', '/api/reset/')
    type(confirm, 'twelve chars')
    await submit(box.querySelector('form')!)
    expect(sent('POST', '/api/reset/').map((call) => call.body)).toEqual([{ password: 'twelve chars', password_confirm: 'twelve chars' }])
    expect(box.textContent).toContain(i18n.t('auth.reset.doneTitle'))
  })

  it('NOTES-2 AC-10 password confirmation on changing the own password in My account, in German too', async () => {
    await i18n.changeLanguage('de')
    handler = (method, path) => {
      if (path === '/api/setup') return { status: 200, body: SET_UP }
      if (path === '/api/auth/me') return { status: 200, body: ME }
      if (path === '/api/oidc/me') return { status: 200, body: [] }
      if (path === '/api/auth/password' && method === 'PUT') return { status: 200, body: {} }
      return undefined
    }
    const { SettingsPage } = await import('./pages/SettingsPage')
    await render(<AuthProvider><Routes><Route path="/settings" element={<SettingsPage />} /></Routes></AuthProvider>, '/settings')
    const row = box.querySelector<HTMLElement>('[data-testid="password-row"]')!
    const confirm = expectPair(row, i18n.t('me.password.new'))
    expect(i18n.t('auth.passwordConfirm')).toBe('Passwort bestätigen')
    type(field(i18n.t('me.password.current'), row), 'the old one!')
    type(field(i18n.t('me.password.new'), row), 'a brand new one')
    type(confirm, 'a brand new on')
    await expectMismatchRefused(row.querySelector('form')!, confirm, 'PUT', '/api/auth/password')
    expect(row.textContent).toContain('Die Passwörter stimmen nicht überein.')
    type(confirm, 'a brand new one')
    await submit(row.querySelector('form')!)
    expect(sent('PUT', '/api/auth/password').map((call) => call.body)).toEqual([
      { current: 'the old one!', new: 'a brand new one', password_confirm: 'a brand new one' },
    ])
    // Changed: both fields are empty again, and no old message is left.
    expect(confirm.value).toBe('')
    expect(row.querySelector('[aria-invalid]')).toBeNull()
  })
})
