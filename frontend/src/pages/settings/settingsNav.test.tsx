/**
 * NOTES-2 AC-9, the settings in areas (plan "Einstellungen", the frame of the ui kit): the navigation with the groups
 * "My account" and "Server" and "About nexnotes" set apart, each area at its own address, `/settings` as the profile
 * (and the list on a phone), the addresses of the tabs before leading to their area, a member sent from a server area
 * to the profile, the current area marked with `aria-current`, a phone going from the list to an area and back, and
 * every card in its area, in the plan's order. Titles and lines of the shared areas are the kit's words.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../../i18n'
import { AuthProvider } from '../../state/auth'
import { areaText, languageOf, NEXUI_TEXTS } from '../../vendor/nexui'
import { resolveArea } from './areas'

const KIT = NEXUI_TEXTS.en
const title = (slug: string) => areaText(KIT, slug, { app: 'nexnotes', things: 'notes' })!.title

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
  if (path === '/api/server/sign-in') {
    return { status: 200, body: { password_login: true, factor_required: false, passkeys_allowed: true, password_may_go_off: false, factor_may_go_on: false, second_factor_off: false, public_url: '', operator_has_password: true } }
  }
  if (path === '/api/server/sign-in/readiness') {
    return { status: 200, body: { state: 'bad', open: 1, points: [{ key: 'address', state: 'bad', title: 'account.ready.address.title', text: 'account.ready.address.missing', values: { app: 'nexnotes' } }] } }
  }
  if (path === '/api/server/mail') {
    return { status: 200, body: { host: '', port: 587, security: 'starttls', user: '', password_set: false, sender: '', sender_name: '', sender_name_default: 'nexnotes', configured: false, warnings: [], last_ok_at: null, last_error: '', last_error_at: null, waiting: 0 } }
  }
  if (path === '/api/connections/admin/keys') return { status: 200, body: { keys: [] } }
  if (path === '/api/connections/interfaces') return { status: 200, body: { api: true, mcp: true } }
  // "Andere nex-Apps": the switch and addresses of the other nex apps (module verbinden, V14).
  if (path === '/api/connect/admin') return { status: 200, body: { connections: true, partners: ['nextasks', 'nexlore', 'nextime'], addresses: {} } }
  // The operator's MCP settings after "MCP-Zugang" (module mcp).
  if (path === '/api/connections/mcp/admin') {
    return { status: 200, body: { programs: true, levels: ['read', 'write'], max_level: 'write', blocked_tools: [], tools: [{ name: 'trash_note', group: 'risky', level: 'write' }] } }
  }
  if (path === '/api/server/storage') return { status: 200, body: { app: 'nexnotes', used: 1000, parts: [], complete: true, total: 1e12, disk_used: 1e11, free: 9e11, nearly_full: false, where: {}, network: [] } }
  if (path === '/api/server/storage/backups') {
    const schedule = { every: 'daily', time: '03:00', keep: 7 }
    return { status: 200, body: { schedule, zone: 'UTC', last: null, count: 0, kept: 0, failure: null, running: false, restore_failure: null, restored: null, restore: 'restart', download_password: false, backups: [] } }
  }
  if (path === '/api/notify/devices') return { status: 200, body: { apps: [], browsers: [], this_browser: false } }
  if (path === '/api/about') return { status: 200, body: { version: '0.1.0', license: 'AGPL-3.0', repo_url: 'https://example.com/nexnotes', releases_url: 'https://example.com/nexnotes/releases', project_url: '' } }
  if (path === '/api/about/updates') return { status: 200, body: { update_check: true, checked: false, latest: null, newer: false, checked_at: null, release_url: null, hidden: false } }
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
    expect(heading()).toBe(title('general'))
    expect(current()).toEqual(['settings-nav-general'])
  })

  it('NOTES-2 AC-9 a member at a server address sees the profile, marked as such', async () => {
    role = 'member'
    await open('/settings/accounts')
    expect(where()).toBe('/settings')
    expect(heading()).toBe(title('profile'))
    expect(current()).toEqual(['settings-nav-profile'])
    expect($('settings-nav-accounts')).toBeNull()
    expect(box.querySelector('[data-group="server"]')).toBeNull()
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
    expect(groups).toEqual([KIT.groupAccount, KIT.groupServer])
    expect(nav.querySelector('a[href="/settings/about"]')!.textContent).toBe('About nexnotes')
    // Text recognition keeps its own title, nexnotes' words.
    expect($('settings-nav-ocr')!.textContent).toBe(i18n.t('settings.areas.ocr.title'))
  })

  it('NOTES-2 AC-9 every entry is a link at its own address, reached by Tab; only the current one is marked', async () => {
    await open('/settings/sign-in')
    const links = [...box.querySelectorAll<HTMLAnchorElement>('[data-testid="settings-nav"] a[data-testid^="settings-nav-"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      ['profile', 'security', 'appearance', 'notifications', 'connections', 'general', 'sign-in', 'mail', 'storage', 'ocr', 'accounts', 'log', 'about'].map((slug) => `/settings/${slug}`),
    )
    for (const link of links) expect(link.tabIndex).toBe(0)
    expect(current()).toEqual(['settings-nav-sign-in'])
    expect($('settings-nav-mail')!.getAttribute('aria-current')).toBeNull()
    await act(async () => $('settings-nav-mail')!.click())
    await settle()
    expect(where()).toBe('/settings/mail')
    expect(current()).toEqual(['settings-nav-mail'])
    expect(heading()).toBe(title('mail'))
  })

  it('NOTES-2 AC-9 a phone goes from the list (/settings) to an area and back to the list', async () => {
    role = 'member'
    await open('/settings')
    // The page's own width decides: from 700 px both side by side; narrower /settings is the list ...
    const side = () => box.querySelector('[data-part="settings-side"]')!
    const main = () => box.querySelector('[data-part="settings-main"]')!
    expect($('settings')!.dataset.list).toBe('true')
    expect(side().className).toMatch(/(^| )block( |$)/)
    expect(main().className).toMatch(/(^| )hidden( |$)/)
    expect(main().className).toContain('@min-[700px]:flex')
    expect([...box.querySelectorAll('[data-testid="settings-nav"] a')].map((link) => link.getAttribute('href'))).toEqual(
      ['profile', 'security', 'appearance', 'notifications', 'connections', 'about'].map((slug) => `/settings/${slug}`),
    )
    // ... and an area shows itself with a small way back above its title.
    await act(async () => $('settings-nav-security')!.click())
    await settle()
    expect(where()).toBe('/settings/security')
    expect($('settings')!.dataset.list).toBeUndefined()
    expect(side().className).toMatch(/(^| )hidden( |$)/)
    expect(side().className).toContain('@min-[700px]:block')
    const back = $('settings-back')!
    expect([back.getAttribute('href'), back.textContent]).toEqual(['/settings', KIT.backToList])
    expect(back.closest('[data-part="settings-back"]')!.className).toContain('@min-[700px]:hidden')
    await act(async () => back.click())
    await settle()
    expect(where()).toBe('/settings')
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
    expect(heading()).toBe('About nexnotes')
    expect($('settings-area-about')!.textContent).toContain(areaText(KIT, 'about', { app: 'nexnotes' })!.text)
    expect($('about-version')!.textContent).toBe('0.1.0')
    expect([...box.querySelectorAll('section[data-card]')].map((card) => card.getAttribute('data-card'))).toEqual(['about', 'about-updates', 'about-built-with'])
    expect(box.textContent).toContain(KIT.builtWith)
    expect(box.textContent).toContain(i18n.t('about.subtitle'))
    expect(box.querySelector('[data-card="about"] img')!.getAttribute('src')).toBe('/logo.svg')
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
  const kitCards = () => [...box.querySelectorAll('section[data-card]')].map((card) => card.getAttribute('data-card'))

  it.each([
    ['profile', ['profile', 'sign-out']],
    ['security', ['security']],
    ['appearance', ['appearance', 'paper', 'lists', 'guide']],
    ['notifications', ['notify-ways']],
    ['general', ['limits', 'features', 'interfaces', 'nex-apps', 'languages']],
    // The points of "Ready for the internet?" are boxes of their own in its card (here one, `ready-address`).
    ['sign-in', ['sign-in-ready', 'ready-address', 'sign-in', 'sign-in-providers', 'sign-in-authentik']],
    ['mail', ['mail']],
    ['storage', ['storage', 'backups']],
    ['ocr', ['ocr']],
    ['log', ['log']],
  ])('NOTES-2 AC-9 %s shows its cards and no others', async (slug, ids) => {
    await open(`/settings/${slug}`)
    expect(cards()).toEqual(ids)
  })

  it.each([
    ['appearance', ['appearance', 'paper', 'lists', 'guide']],
    ['notifications', ['notify-ways']],
    ['general', ['limits', 'features', 'interfaces', 'nex-apps', 'languages']],
    ['sign-in', ['sign-in-ready', 'sign-in', 'sign-in-providers', 'sign-in-authentik']],
    ['mail', ['mail']],
    ['storage', ['storage', 'backups']],
    ['ocr', ['ocr']],
    ['log', ['log']],
    ['about', ['about', 'about-updates', 'about-built-with']],
  ])('plan "Einstellungen": %s is built of the kit\'s cards only, each named for the comparison', async (slug, ids) => {
    await open(`/settings/${slug}`)
    expect(kitCards()).toEqual(ids)
    // No button of nexnotes' own in these areas: every one says its kind, size and symbol.
    const buttons = [...$(`settings-area-${slug}`)!.querySelectorAll('button, a[data-kind]')].filter((button) => !button.closest('[role="radiogroup"], [role="group"][data-segment]') && !button.hasAttribute('data-chip'))
    for (const button of buttons.filter((one) => one.hasAttribute('data-kind'))) expect([button.getAttribute('data-size'), button.getAttribute('data-icon')]).not.toContain(null)
    expect($(`settings-area-${slug}`)!.querySelector('.nn-btn, [role="switch"], [role="tab"]')).toBeNull()
  })

  it('ui 1.1.3 U-3: the line of Server › General names exactly its cards, in their order', async () => {
    await open('/settings/general')
    const parts: Record<string, string> = { limits: 'limits', features: 'features', interfaces: 'interfaces', 'nex-apps': 'nexApps', languages: 'languages' }
    const { GENERAL_PARTS } = await import('./SettingsAreas')
    expect(GENERAL_PARTS).toEqual(cards().map((id) => parts[id]))
    const texts = NEXUI_TEXTS[languageOf(i18n.language)]
    const said = GENERAL_PARTS.map((part) => texts.generalParts[part])
    const line = `${said.slice(0, -1).join(', ')}${texts.and}${said.at(-1)}`
    expect($('settings-area-general')!.textContent).toContain(`${line.charAt(0).toUpperCase()}${line.slice(1)}.`)
    expect($('settings-area-general')!.textContent).not.toContain(texts.generalParts.webPush)
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
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(i18n.t('account.inviteTitle'))
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label]')!.click())
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(where()).toBe('/settings/accounts')
  })
})
