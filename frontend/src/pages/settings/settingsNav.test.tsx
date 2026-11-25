/**
 * NOTES-2 AC-9, the settings in areas: the navigation with the groups "My account" and "Server", each area at its own
 * address, `/settings` as the profile, the addresses of the tabs before leading to their area, a member sent from a
 * server area to the profile, the current area marked with `aria-current`, the choice for a narrow page, and every
 * card of the tabs before in one area.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../../i18n'
import { AuthProvider } from '../../state/auth'
import { resolveArea } from './areas'

type Answer = { status: number; body: unknown }
let role: 'member' | 'operator' = 'operator'
let root: Root
let box: HTMLDivElement

const ME = {
  id: 1, name: 'tester', display_name: 'Tester', email: 'tester@example.com', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}
const SETTINGS = {
  public_url: '', password_login: true, two_factor_required: false, backup_schedule: 'daily', backup_keep: 7,
  smtp_host: '', smtp_port: 587, smtp_security: 'starttls', smtp_user: '', smtp_password_set: false, smtp_from: '',
  upload_max_mb: 100, history_days: 365, trash_days: 90, link_previews: true, share_links: true, mcp_enabled: true,
  ocr_languages: [], update_check: true, data_total: 1e12, data_used: 1e11, data_free: 9e11, data_on_share: false,
}

function answer(path: string): Answer | undefined {
  if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
  if (path === '/api/auth/me') return { status: 200, body: { ...ME, role } }
  if (path === '/api/settings') return { status: 200, body: SETTINGS }
  if (path === '/api/oidc/authentik/address') {
    const address = { public_url: '', seen: 'http://localhost:3000', forwarded_proto: '', forwarded_host: '', proxy_ignored: false }
    return { status: 200, body: { ...address, callback_path: '/api/oidc/authentik/callback', redirect_uri: '', registered_redirect_uri: '', stale: false } }
  }
  if (path === '/api/about') return { status: 200, body: { version: '0.1.0', license: 'AGPL-3.0', repo_url: 'https://example.com/nexnotes', releases_url: 'https://example.com/nexnotes/releases', project_url: '' } }
  if (path === '/api/about/updates') return { status: 200, body: { update_check: true, checked: false, latest: null, newer: false, checked_at: null, release_url: null } }
  if (path.startsWith('/api/logs/level')) return { status: 200, body: { mode: 'normal', until: null, fixed_by_env: false, modes: ['quiet', 'normal', 'detailed', 'trace'] } }
  return undefined
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  role = 'operator'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const found = answer(String(input)) ?? { status: 200, body: [] }
      return new Response(JSON.stringify(found.body), { status: found.status, headers: { 'Content-Type': 'application/json' } })
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
  for (let i = 0; i < 16; i++) await act(async () => await Promise.resolve())
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

async function open(at: string): Promise<void> {
  const { FormerAboutAddress, SettingsPage } = await import('../SettingsPage')
  await act(async () =>
    root.render(
      <AuthProvider>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
            <Route path="/about" element={<FormerAboutAddress />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </AuthProvider>,
    ),
  )
  await settle()
}

const where = () => box.querySelector('[data-testid="where"]')!.textContent
const $ = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const current = () => [...box.querySelectorAll('[data-testid="settings-nav"] [aria-current="page"]')].map((entry) => entry.getAttribute('data-testid'))
const heading = () => box.querySelector('h1')!.textContent

describe('the addresses of the settings (NOTES-2 AC-9)', () => {
  it('NOTES-2 AC-9 the addresses of the tabs before lead to their area, an unknown one to the profile', () => {
    expect(resolveArea('server', 'operator', '')).toEqual({ redirect: '/settings/general' })
    expect(resolveArea('account', 'member', '')).toEqual({ redirect: '/settings/profile' })
    for (const kept of ['connections', 'accounts', 'log']) expect(resolveArea(kept, 'operator', '')).toEqual({ area: kept })
    expect(resolveArea('connections', 'member', '')).toEqual({ area: 'connections' })
    expect(resolveArea(undefined, 'member', '')).toEqual({ area: 'profile' })
    expect(resolveArea('nothing-here', 'operator', '')).toEqual({ redirect: '/settings' })
  })

  it('NOTES-2 AC-9 a member asking for a server area or an old server address lands on the profile', () => {
    for (const slug of ['general', 'sign-in', 'mail', 'storage', 'ocr', 'accounts', 'log', 'server']) expect(resolveArea(slug, 'member', '')).toEqual({ redirect: '/settings' })
  })

  it('NOTES-2 AC-9 the answer of a provider after linking goes to Security, with its message', () => {
    expect(resolveArea(undefined, 'member', '?linked=sso')).toEqual({ redirect: '/settings/security?linked=sso' })
    expect(resolveArea(undefined, 'member', '?error=oidc_failed')).toEqual({ redirect: '/settings/security?error=oidc_failed' })
  })

  it('NOTES-2 AC-9 /settings/server of before opens General, with the address replaced', async () => {
    await open('/settings/server')
    expect(where()).toBe('/settings/general')
    expect(heading()).toBe(i18n.t('settings.areas.general.title'))
    expect(current()).toEqual(['settings-nav-general'])
  })

  it('NOTES-2 AC-9 a member at a server address sees the profile, marked as such', async () => {
    role = 'member'
    await open('/settings/accounts')
    expect(where()).toBe('/settings')
    expect(heading()).toBe(i18n.t('settings.areas.profile.title'))
    expect(current()).toEqual(['settings-nav-profile'])
    expect($('settings-nav-accounts')).toBeNull()
    expect(box.textContent).not.toContain(i18n.t('settings.groups.server'))
  })
})

describe('the navigation of the settings (NOTES-2 AC-9)', () => {
  it('NOTES-2 AC-9 the operator sees both groups, the account with name and role at the top', async () => {
    await open('/settings')
    const nav = $('settings-nav')!
    expect(nav.tagName).toBe('NAV')
    expect(nav.textContent).toContain('Tester')
    expect(nav.textContent).toContain(i18n.t('roles.operator'))
    const groups = [...nav.querySelectorAll('ul')].map((list) => box.querySelector(`#${list.getAttribute('aria-labelledby')}`)!.textContent)
    expect(groups).toEqual([i18n.t('settings.groups.account'), i18n.t('settings.groups.server')])
    expect(nav.querySelector('a[href="/settings/about"]')!.textContent).toBe(i18n.t('settings.areas.about.title'))
  })

  it('NOTES-2 AC-9 every entry is a link at its own address, reached by Tab; only the current one is marked', async () => {
    await open('/settings/sign-in')
    const links = [...box.querySelectorAll<HTMLAnchorElement>('[data-testid="settings-nav"] a[data-testid^="settings-nav-"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      ['profile', 'security', 'appearance', 'connections', 'general', 'sign-in', 'mail', 'storage', 'ocr', 'accounts', 'log', 'about'].map((slug) => `/settings/${slug}`),
    )
    for (const link of links) expect(link.tabIndex).toBe(0)
    expect(current()).toEqual(['settings-nav-sign-in'])
    expect($('settings-nav-sign-in')!.className).toContain('nn-chosen')
    expect($('settings-nav-mail')!.className).not.toContain('nn-chosen')
    await act(async () => $('settings-nav-mail')!.click())
    await settle()
    expect(where()).toBe('/settings/mail')
    expect(current()).toEqual(['settings-nav-mail'])
    expect(heading()).toBe(i18n.t('settings.areas.mail.title'))
  })

  it('NOTES-2 AC-9 a narrow page has a choice instead, which goes to the area chosen', async () => {
    role = 'member'
    await open('/settings/appearance')
    // The page's own width decides: the navigation shows from 700 px, the choice below.
    expect($('settings-nav')!.className).toMatch(/(^| )hidden( |$)/)
    expect($('settings-nav')!.className).toContain('@min-[700px]:block')
    expect($('settings-jump-row')!.className).toContain('@min-[700px]:hidden')
    const select = $('settings-jump') as HTMLSelectElement
    expect(select.value).toBe('appearance')
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual([i18n.t('settings.groups.account')])
    expect([...select.options].map((option) => option.value)).toEqual(['profile', 'security', 'appearance', 'connections', 'about'])
    expect(select.closest('label')!.querySelector('.sr-only')!.textContent).toBe(i18n.t('settings.jump'))
    await act(async () => {
      select.value = 'security'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(where()).toBe('/settings/security')
    expect(heading()).toBe(i18n.t('settings.areas.security.title'))
  })
})

describe('"About nexnotes" in the settings (fifth review)', () => {
  it('NOTES-2 AC-9 /settings/about keeps the navigation, marks its entry last and shows heading, line and cards', async () => {
    await open('/settings/about')
    expect(where()).toBe('/settings/about')
    expect($('settings-nav')).not.toBeNull()
    expect(current()).toEqual(['settings-nav-about'])
    const entries = [...box.querySelectorAll('[data-testid="settings-nav"] a')]
    expect(entries.at(-1)!.getAttribute('data-testid')).toBe('settings-nav-about')
    expect($('settings-nav-about')!.className).toContain('nn-chosen')
    expect(heading()).toBe(i18n.t('settings.areas.about.title'))
    expect($('settings-area-about')!.textContent).toContain(i18n.t('settings.areas.about.text'))
    expect($('about-version')!.textContent).toBe('0.1.0')
    expect([...box.querySelectorAll('section[id]')].map((card) => card.id)).toEqual(['about-updates'])
    expect(box.textContent).toContain(i18n.t('about.builtWith'))
    expect(($('settings-jump') as HTMLSelectElement).value).toBe('about')
  })

  it('NOTES-2 AC-9 the old address /about leads to the area, with the address replaced', async () => {
    await open('/about')
    expect(where()).toBe('/settings/about')
    expect(current()).toEqual(['settings-nav-about'])
  })

  it('NOTES-2 AC-9 a member reaches "About nexnotes" in the settings too', async () => {
    role = 'member'
    expect(resolveArea('about', 'member', '')).toEqual({ area: 'about' })
    await open('/settings/about')
    expect(where()).toBe('/settings/about')
    expect(current()).toEqual(['settings-nav-about'])
    expect($('about-version')).not.toBeNull()
  })
})

describe('every card in its area (NOTES-2 AC-9)', () => {
  const cards = () => [...box.querySelectorAll('section[id]')].map((card) => card.id)

  it.each([
    ['profile', ['profile', 'sign-out']],
    ['security', ['security']],
    ['appearance', ['looks', 'lists', 'guide']],
    ['general', ['limits', 'features', 'languages']],
    ['sign-in', ['sign-in', 'sign-in-providers', 'sign-in-authentik']],
    ['mail', ['mail']],
    ['storage', ['backups']],
    ['ocr', ['ocr']],
    ['log', ['log']],
  ])('NOTES-2 AC-9 %s shows its cards and no others', async (slug, ids) => {
    await open(`/settings/${slug}`)
    expect(cards()).toEqual(ids)
  })

  it('NOTES-2 AC-9 the language is set in the profile, theme and paper in Appearance', async () => {
    await open('/settings/profile')
    expect($('profile-picture')).not.toBeNull()
    expect($('language-select')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(box)
    await open('/settings/appearance')
    expect($('language-select')).toBeNull()
    expect(box.textContent).toContain(i18n.t('me.looks.paper'))
  })

  it('NOTES-2 AC-9 Accounts holds the table of the accounts', async () => {
    await open('/settings/accounts')
    expect(cards()).toContain('accounts')
  })

  it('NOTES-13 AC-1 Accounts with ?invite opens "Invite a person" at once (the share dialog leads there); closing drops it', async () => {
    await open('/settings/accounts?invite=1')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(i18n.t('accounts.invite'))
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label]')!.click())
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(where()).toBe('/settings/accounts')
  })
})
