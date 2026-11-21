/**
 * NOTES-1 and NOTES-2 in the interface: the setup page (first account, setup code, a warning for a data folder on a
 * share, nothing to do once set up), the tabs of the settings for a member and for the operator, and what an open
 * window does when its session ends while writing (runs out: sign in again, nothing lost; blocked: says so).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { api, ApiError } from './api/client'
import i18n from './i18n'
import { AuthProvider, SIGNED_IN_AGAIN_EVENT } from './state/auth'

type Answer = { status: number; body: unknown }
let handler: (method: string, path: string, body: unknown) => Answer | undefined = () => undefined
const calls: { method: string; path: string; body: unknown }[] = []

let root: Root
let box: HTMLDivElement

const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}

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

async function render(node: React.ReactNode, at = '/'): Promise<void> {
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>))
  await settle()
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
  act(() => void field.dispatchEvent(new Event('input', { bubbles: true })))
}

describe('the setup (NOTES-1)', () => {
  it('NOTES-1 AC-1 AC-2 a fresh server shows the setup with code, name, address and password; the first account is made', async () => {
    let made: unknown = null
    handler = (method, path, body) => {
      if (path === '/api/setup' && method === 'GET') return { status: 200, body: { needs_setup: !made, code_required: true, signed_in: !!made, version: '0.1.0', min_password: 12, data_on_share: false, data_free: 412 * 1024 ** 3 } }
      if (path === '/api/setup' && method === 'POST') {
        made = body
        return { status: 200, body: { ...ME, role: 'operator' } }
      }
      return undefined
    }
    const { SetupPage } = await import('./pages/AuthPages')
    await render(
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/" element={<p data-testid="home">home</p>} />
        </Routes>
      </AuthProvider>,
      '/setup',
    )
    expect(box.textContent).toContain(i18n.t('setup.title'))
    expect(box.textContent).toContain(i18n.t('setup.codeHint'))
    expect(box.textContent).toContain('412 GB')
    const fields = [...box.querySelectorAll('input')]
    expect(fields.map((field) => field.closest('label')?.querySelector('span')?.textContent)).toEqual([
      i18n.t('setup.code'), i18n.t('auth.name'), i18n.t('auth.email'), i18n.t('auth.password'), i18n.t('auth.passwordConfirm'),
    ])
    type(fields[0], 'AB12-CD34-EF56')
    type(fields[1], 'Robin')
    type(fields[2], 'robin@example.com')
    type(fields[3], 'twelve chars')
    type(fields[4], 'twelve chars')
    await act(async () => box.querySelector('form')!.requestSubmit())
    await settle()
    expect(made).toEqual({ display_name: 'Robin', email: 'robin@example.com', password: 'twelve chars', password_confirm: 'twelve chars', code: 'AB12-CD34-EF56', language: 'en' })
    expect(box.querySelector('[data-testid="home"]')).not.toBeNull()
  })

  it('NOTES-1 AC-12 the setup names the data folder the server really uses, and none when it names none', async () => {
    const answer = { needs_setup: true, code_required: true, signed_in: false, version: '0.1.0', min_password: 12, data_on_share: false, data_free: 412 * 1024 ** 3 }
    handler = (_method, path) => (path === '/api/setup' ? { status: 200, body: { ...answer, data_dir: '/srv/nexnotes-daten' } } : undefined)
    const { SetupPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><SetupPage /></AuthProvider>, '/setup')
    expect(box.textContent).toContain(`${i18n.t('setup.folder', { path: '/srv/nexnotes-daten' })} · 412 GB free · Version 0.1.0`)
    expect(box.textContent).not.toContain('/data ')
    act(() => root.unmount())
    root = createRoot(box)
    handler = (_method, path) => (path === '/api/setup' ? { status: 200, body: answer } : undefined)
    await render(<AuthProvider><SetupPage /></AuthProvider>, '/setup')
    expect(box.textContent).toContain('412 GB free · Version 0.1.0')
    expect(box.textContent).not.toContain(i18n.t('setup.folder', { path: '' }).trim())
  })

  it('NOTES-1 EC-2 a data folder on a network share is warned about on the setup', async () => {
    handler = (_method, path) =>
      path === '/api/setup' ? { status: 200, body: { needs_setup: true, code_required: true, signed_in: false, version: '0.1.0', min_password: 12, data_on_share: true } } : undefined
    const { SetupPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><SetupPage /></AuthProvider>, '/setup')
    expect(box.textContent).toContain(i18n.t('setup.share'))
  })

  it('NOTES-1 EC-8 once set up, the setup page leads to the sign-in', async () => {
    handler = (_method, path) =>
      path === '/api/setup' ? { status: 200, body: { needs_setup: false, code_required: true, signed_in: false, version: '0.1.0', min_password: 12 } } : undefined
    const { SetupPage } = await import('./pages/AuthPages')
    await render(
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<p data-testid="login">login</p>} />
        </Routes>
      </AuthProvider>,
      '/setup',
    )
    expect(box.querySelector('[data-testid="login"]')).not.toBeNull()
  })
})

describe('the settings (NOTES-2 AC-9)', () => {
  async function settingsAs(role: 'member' | 'operator') {
    handler = (_method, path) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path === '/api/auth/me') return { status: 200, body: { ...ME, role } }
      if (path === '/api/oidc/me') return { status: 200, body: [] }
      return undefined
    }
    const { SettingsPage } = await import('./pages/SettingsPage')
    await render(
      <AuthProvider>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AuthProvider>,
      '/settings',
    )
    return [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  }

  it('NOTES-2 AC-9 a member finds My account and Connections; an operator also Server, Accounts and Log', async () => {
    expect(await settingsAs('member')).toEqual([i18n.t('settings.tabs.account'), i18n.t('settings.tabs.connections')])
    act(() => root.unmount())
    root = createRoot(box)
    expect(await settingsAs('operator')).toEqual(['account', 'connections', 'server', 'accounts', 'log'].map((tab) => i18n.t(`settings.tabs.${tab}`)))
    expect(box.textContent).toContain(i18n.t('me.profile.title'))
    expect(box.textContent).toContain(i18n.t('me.security.title'))
    expect(box.textContent).toContain(i18n.t('me.looks.title'))
  })
})

describe('a session that ends while writing', () => {
  async function writing() {
    let expired = true
    handler = (method, path) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path === '/api/auth/me') return { status: 200, body: ME }
      if (path === '/api/probe' && method === 'PUT') {
        return expired ? { status: 401, body: { detail: { code: 'sign_in_required', message: 'Sign in first.' } } } : { status: 200, body: {} }
      }
      if (path === '/api/auth/login') {
        expired = false
        return { status: 200, body: ME }
      }
      if (path === '/api/auth/methods') return { status: 200, body: { password: true, providers: [] } }
      return undefined
    }
    const { AppShell } = await import('./components/AppShell')
    await render(
      <AuthProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<textarea data-testid="note" defaultValue="" />} />
          </Route>
        </Routes>
      </AuthProvider>,
    )
    const note = box.querySelector<HTMLTextAreaElement>('[data-testid="note"]')!
    type(note, 'Einkaufsliste: Milch, Butter')
    return note
  }

  it('NOTES-2 EC-3 the text stays, nexnotes asks to sign in again, and afterwards the editors save', async () => {
    await writing()
    const resumed = vi.fn()
    window.addEventListener(SIGNED_IN_AGAIN_EVENT, resumed)
    await act(async () => void (await api('/api/probe', { method: 'PUT', body: {} }).catch(() => undefined)))
    await settle()
    expect(document.querySelector('[data-testid="session-expired"]')).not.toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="note"]')!.value).toBe('Einkaufsliste: Milch, Butter')
    const password = document.querySelector<HTMLInputElement>('[data-testid="session-expired"] input[type="password"]')!
    type(password, 'twelve chars')
    await act(async () => document.querySelector<HTMLFormElement>('[data-testid="session-expired"]')!.requestSubmit())
    await settle()
    expect(calls.find((call) => call.path === '/api/auth/login')?.body).toEqual({ name: 'anna@example.com', password: 'twelve chars' })
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull()
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="note"]')!.value).toBe('Einkaufsliste: Milch, Butter')
    window.removeEventListener(SIGNED_IN_AGAIN_EVENT, resumed)
  })

  it('NOTES-2 EC-4 an open window of a blocked account says the account is blocked', async () => {
    await writing()
    handler = (_method, path) =>
      path === '/api/probe' ? { status: 401, body: { detail: { code: 'account_blocked', message: 'This account is blocked.' } } } : undefined
    await act(async () => void (await api('/api/probe', { method: 'PUT', body: {} }).catch(() => undefined)))
    await settle()
    const said = document.querySelector('[data-testid="session-blocked"]')
    expect(said?.textContent).toContain(i18n.t('session.blockedText'))
    expect(document.body.textContent).toContain(i18n.t('session.blockedTitle'))
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull()
  })
})

describe('the operator never sets another password (NOTES-2 AC-7)', () => {
  it('NOTES-2 AC-7 the account list offers a reset link, never a password field, and shows the link once', async () => {
    const anna = { ...ME, id: 2, providers: [], has_password: true, storage_used: 0, storage_limit: null, locked: false, blocked: false, blocked_at: null, deleted_at: null, purge_at: null }
    handler = (method, path, body) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path === '/api/auth/me') return { status: 200, body: { ...ME, role: 'operator', id: 1, name: 'tester' } }
      if (path === '/api/accounts') return { status: 200, body: [anna] }
      if (path === '/api/accounts/2/reset-link' && method === 'POST') {
        expect(body).toEqual({ days: 30, current_password: 'mine is long' })
        return { status: 201, body: { link: 'http://notes.test/reset/abcdefghijklmnopqrstuvwxyz', expires_at: '2026-12-21T00:00:00Z' } }
      }
      return undefined
    }
    const { AccountsTab } = await import('./pages/settings/AccountsTab')
    await render(<AuthProvider><AccountsTab /></AuthProvider>)
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('accounts.actionsFor', { name: 'Anna' }) + '"]')!.click())
    // The menu stands over everything, outside the table's box.
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toContain(i18n.t('accounts.resetLink'))
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === i18n.t('accounts.resetLink'))!.click())
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelectorAll('input[autocomplete="new-password"]')).toHaveLength(0)
    const select = dialog.querySelector('select')!
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '30')
    act(() => void select.dispatchEvent(new Event('change', { bubbles: true })))
    type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, 'mine is long')
    await act(async () => dialog.querySelector('form')!.requestSubmit())
    await settle()
    expect(document.querySelector<HTMLInputElement>('[data-testid="reset-link"] input')!.value).toBe('http://notes.test/reset/abcdefghijklmnopqrstuvwxyz')
  })

  it('NOTES-2 AC-7 the person sets the new password with the link and is sent to sign in', async () => {
    let set: unknown = null
    handler = (method, path, body) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: false, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path.startsWith('/api/reset/') && method === 'GET') return { status: 200, body: { name: 'Anna', min_password: 12, expires_at: '2026-12-01T00:00:00Z' } }
      if (path.startsWith('/api/reset/') && method === 'POST') {
        set = body
        return { status: 200, body: {} }
      }
      return undefined
    }
    const { ResetPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><Routes><Route path="/reset/:token" element={<ResetPage />} /></Routes></AuthProvider>, '/reset/abcdefghijklmnopqrstuvwxyz')
    expect(box.textContent).toContain(i18n.t('auth.reset.text', { name: 'Anna' }))
    for (const field of box.querySelectorAll<HTMLInputElement>('input[type="password"]')) type(field, 'twelve chars')
    await act(async () => box.querySelector('form')!.requestSubmit())
    await settle()
    expect(set).toEqual({ password: 'twelve chars', password_confirm: 'twelve chars' })
    expect(box.textContent).toContain(i18n.t('auth.reset.doneTitle'))
    expect(box.querySelector('a[href="/login"]')).not.toBeNull()
  })

  it('NOTES-2 AC-7 a used link says so and asks nothing', async () => {
    handler = (_method, path) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: false, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path.startsWith('/api/reset/')) return { status: 404, body: { detail: { code: 'reset_invalid' } } }
      return undefined
    }
    const { ResetPage } = await import('./pages/AuthPages')
    await render(<AuthProvider><Routes><Route path="/reset/:token" element={<ResetPage />} /></Routes></AuthProvider>, '/reset/abcdefghijklmnopqrstuvwxyz')
    expect(box.textContent).toContain(i18n.t('auth.reset.invalidText'))
    expect(box.querySelector('input')).toBeNull()
  })

  it.each(['en', 'de'])('NOTES-2 AC-7 after a reset the account is told at the next sign-in until it puts the notice away (%s)', async (language) => {
    await i18n.changeLanguage(language)
    let notice = true
    handler = (method, path) => {
      if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
      if (path === '/api/auth/me') return { status: 200, body: { ...ME, password_reset_notice: notice } }
      if (path === '/api/me/password-reset-notice/seen' && method === 'POST') {
        notice = false
        return { status: 200, body: { ...ME, password_reset_notice: false } }
      }
      return undefined
    }
    const { AppShell } = await import('./components/AppShell')
    await render(<AuthProvider><Routes><Route element={<AppShell />}><Route path="/" element={<p>notes</p>} /></Route></Routes></AuthProvider>)
    const said = document.querySelector('[data-testid="reset-notice"]')
    expect(said?.textContent).toContain(language === 'de' ? 'Dein Passwort wurde über einen Link des Betreibers zurückgesetzt.' : 'Your password was reset through a link from the operator.')
    await act(async () => [...said!.querySelectorAll('button')].find((button) => button.textContent === i18n.t('resetNotice.button'))!.click())
    await settle()
    expect(notice).toBe(false)
    expect(document.querySelector('[data-testid="reset-notice"]')).toBeNull()
  })
})

describe('an operator from a provider confirms with a fresh sign-in there', () => {
  it('NOTES-2 AC-7 a refusal for an old sign-in offers the operator\'s providers, asking them for a new sign-in', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/settings/accounts', search: '' })
    const { Feedback } = await import('./pages/settings/ui')
    await render(<Feedback problem={new ApiError(403, 'fresh_sign_in_required', { minutes: 10, providers: [{ slug: 'sso', label: 'Pocket ID' }] })} />)
    expect(box.textContent).toContain(i18n.t('errors.fresh_sign_in_required', { minutes: 10 }))
    const button = box.querySelector<HTMLButtonElement>('[data-testid="sign-in-again"] button')!
    expect(button.textContent).toBe(i18n.t('oidc.login.button', { name: 'Pocket ID' }))
    await act(async () => button.click())
    expect(assign).toHaveBeenCalledWith('/api/oidc/sso/start?next=%2Fsettings%2Faccounts&fresh=1')
  })
})
