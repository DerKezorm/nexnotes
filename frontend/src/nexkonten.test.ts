/**
 * Every text of the konten module is in the app, in German and English, through the app's own i18n, and the screens
 * show the module's fields in the module's order. Copied once by the module's `tools/sync.py` to
 * `frontend/src/nexkonten.test.ts`; then the app's file. Fill in the places marked APP.
 *
 * The module's own tests check the wording files word for word against the blueprint; this test checks that the
 * app really loads them (merged into its resources, `{{app}}`, `{{setupTokenEnv}}` and `{{minimum}}` filled in
 * through kontenVariables) and that nothing in the app overrides them. Since 0.3.7 it shows the app's screens
 * (APP_RENDER) and checks that every field is found by exactly its label and that the profile saves with one button;
 * this needs `@testing-library/dom` among the app's devDependencies and vitest's `environment: 'jsdom'`.
 */
import { fireEvent, getAllByRole, getByLabelText } from '@testing-library/dom'
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { AccountTab, type AccountPart } from './pages/settings/AccountTab'
import { APP_PAGES as SHOWN_PAGES } from './pages/settings/accountPages'
import { AuthProvider } from './state/auth'
import { FIELDS, kontenVariables, PAGES, pageOrder, PASSWORD_MIN, SCREENS, screenFields, suggestUsername } from './vendor/nexkonten/konten'
import type { AccountField } from './vendor/nexkonten/konten'
import de from './vendor/nexkonten/konten.de.json'
import en from './vendor/nexkonten/konten.en.json'
// APP: the app's i18n instance after its set-up (with the module's files merged into the resources and
// interpolation.defaultVariables: kontenVariables(APP_NAME)).
import i18n from './i18n'

// APP: the app's name as its container is called.
const APP_NAME = 'nexnotes'
// APP: the fields each screen of the app shows, top to bottom, by the module's field names (screenFields).
const APP_SCREENS: Partial<Record<keyof typeof SCREENS, readonly string[]>> = {
  setup: SCREENS.setup,
  invite: SCREENS.invite,
  login: SCREENS.login,
  forgot: SCREENS.forgot,
  reset: SCREENS.reset,
  profile: SCREENS.profile,
}

// APP (since 0.3.6): the parts of the app's pages "Profile" and "Security", top to bottom, by the module's part names
// (PAGES), then the app's own parts (e.g. nexmail 'googleMicrosoft', nexnotes 'readingLinks', 'vault'), which always
// come after the module's.
const APP_PAGES: Record<keyof typeof PAGES, readonly string[]> = SHOWN_PAGES

/** A screen of the app shown in the document: the element that holds it, and how to take it away again. */
type Shown = { root: HTMLElement; unmount: () => void }

// APP (since 0.3.7): for every screen of APP_SCREENS, show it in the document as the app does (its own components,
// the server answered by the app's test helpers, e.g. a stubbed fetch), wait until it has loaded, and give its root.
// `profile` is the page "Profile" of an account with a password. In German: the tests below switch to 'de' first.
const APP_RENDER: Partial<Record<keyof typeof SCREENS, () => Promise<Shown>>> = {
  setup: () => show('/setup', '/setup', 'SetupPage', { setup: { needs_setup: true, signed_in: false } }),
  invite: () => show('/invite/:token', '/invite/abc', 'InvitePage', {
    invite: { by: 'Robin', email: '', role: 'member', min_password: PASSWORD_MIN, password: true, signed_in_as: null },
  }),
  login: () => show('/login', '/login', 'LoginPage'),
  forgot: () => show('/forgot', '/forgot', 'ForgotPage'),
  reset: () => show('/reset/:token', '/reset/abcdefghijklmnopqrstuvwxyz', 'ResetPage', {
    reset: { name: 'Anna', min_password: PASSWORD_MIN, expires_at: '2026-12-01T00:00:00Z' },
  }),
  profile: () => show('/settings/profile', '/settings/profile', createElement(AccountTab as ComponentType<{ part?: AccountPart }>, { part: 'profile' }), { me: ME }),
}

/** An account with a password, as the server gives it (`/api/auth/me`). */
const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0', min_password: PASSWORD_MIN,
}

/** The server's answers to the pages above; reading only, anything else an empty list. */
type Answers = { setup?: object; me?: object; invite?: object; reset?: object }

/** Shows a page (one of AuthPages by name, or an element) at an address, with the server answered by a stubbed fetch,
 * and waits until it has loaded. */
async function show(path: string, at: string, page: string | ReactNode, answers: Answers = {}): Promise<Shown> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const setup = { needs_setup: false, code_required: true, signed_in: !!answers.me, version: '0.1.0', min_password: PASSWORD_MIN, ...answers.setup }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const asked = String(input)
      const body =
        asked === '/api/setup' ? setup
        : asked === '/api/auth/me' && answers.me ? answers.me
        : asked === '/api/auth/methods' ? { password: true, providers: [], forgot_mail: true }
        : asked.startsWith('/api/invite/') ? answers.invite
        : asked.startsWith('/api/reset/') ? answers.reset
        : undefined
      const status = body === undefined && asked === '/api/auth/me' ? 401 : 200
      return new Response(JSON.stringify(body ?? []), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const element = typeof page === 'string' ? createElement((await import('./pages/AuthPages'))[page as 'LoginPage']) : page
  const root = document.createElement('div')
  document.body.append(root)
  const react = createRoot(root)
  await act(async () =>
    react.render(
      createElement(MemoryRouter, { initialEntries: [at] }, createElement(AuthProvider, null, createElement(Routes, null, createElement(Route, { path, element })))),
    ),
  )
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
  return {
    root,
    unmount: () => {
      act(() => react.unmount())
      root.remove()
      vi.unstubAllGlobals()
    },
  }
}

type Tree = { [key: string]: string | Tree }

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [[key, value] as [string, string]] : leaves(value, key)
  })
}

const values = { username: 'kim', email: 'kim@example.com', provider: 'Pocket ID' }
const fill: Record<string, string | number> = { ...kontenVariables(APP_NAME), ...values }
/** Plural keys (``days_one``, ``recoveryLeft_other``) are asked by their base with a count that picks them. */
const PLURAL = /_(one|other)$/
const COUNTS: Record<string, number> = { one: 1, other: 5 }

describe('the konten texts', () => {
  for (const [language, tree] of [['de', de], ['en', en]] as const) {
    it(`are all in the app in ${language}, word for word`, async () => {
      await i18n.changeLanguage(language)
      for (const [key, text] of leaves(tree as Tree)) {
        const plural = PLURAL.exec(key)
        const count = plural ? COUNTS[plural[1] ?? 'other'] : undefined
        const given: Record<string, string | number> = count === undefined ? { ...fill } : { ...fill, count }
        const expected = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(given[name] ?? ''))
        const asked = plural ? key.replace(PLURAL, '') : key
        expect(i18n.t(asked, count === undefined ? values : { ...values, count }), key).toBe(expected)
      }
    })
  }
})

describe('the konten screens', () => {
  it('show the fields of the module in its order', () => {
    for (const [screen, fields] of Object.entries(APP_SCREENS)) {
      expect(fields, screen).toEqual(screenFields(screen as keyof typeof SCREENS).map((entry) => entry.field))
    }
  })

  it('suggest the username the server would', () => {
    expect(suggestUsername('Max Müller')).toBe('max-mueller')
  })
})

describe('the konten pages (since 0.3.6)', () => {
  it("show the module's parts first, in its order, and the app's own after them", () => {
    for (const page of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const module = pageOrder(page)
      const shown = APP_PAGES[page]
      expect(shown.slice(0, module.length), page).toEqual(module)
      for (const own of shown.slice(module.length)) expect(module, `${page}: ${own}`).not.toContain(own)
    }
  })

  it("title every part with the module's texts", async () => {
    await i18n.changeLanguage('de')
    expect(i18n.t('account.sessions')).toBe('Angemeldete Geräte')
    expect(i18n.t('account.signOutEverywhere')).toBe('Überall sonst abmelden')
    expect(i18n.t('account.stateOff')).toBe('Aus')
    expect(i18n.t('account.pictureUpload')).toBe('Profilbild hochladen')
    for (const page of Object.values(PAGES)) {
      for (const part of page.parts) {
        const rules = 'rules' in part ? [part.rules] : []
        for (const key of [part.title, ...part.buttons, ...rules]) expect(i18n.exists(key), key).toBe(true)
      }
    }
    expect(i18n.t(PAGES.profile.saveButton)).toBe('Speichern')
  })
})

/** The texts of the elements ``aria-describedby`` names, one after the other. */
function description(field: HTMLElement): string {
  const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => field.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
}

/** The field of a screen, found by exactly its label (getByLabelText fails on none and on more than one). */
function labelled(root: HTMLElement, field: AccountField): HTMLElement {
  return getByLabelText(root, i18n.t(FIELDS[field].label))
}

async function shown(screen: keyof typeof SCREENS): Promise<Shown> {
  await i18n.changeLanguage('de')
  const render = APP_RENDER[screen]
  if (!render) throw new Error(`APP_RENDER.${screen} is missing`)
  return render()
}

describe('the konten fields (since 0.3.7)', () => {
  for (const screen of Object.keys(APP_SCREENS) as (keyof typeof SCREENS)[]) {
    it(`${screen}: every field is found by exactly its label, its hints by aria-describedby`, async () => {
      const { root, unmount } = await shown(screen)
      try {
        for (const spec of screenFields(screen)) {
          const label = i18n.t(spec.label)
          const field = getByLabelText(root, label)
          const own = field.getAttribute('aria-label')
          expect(own === null || own === label, `${screen}.${spec.field}: aria-label`).toBe(true)
          const said = description(field)
          for (const hint of spec.hints) expect(said, `${screen}.${spec.field}: ${hint}`).toContain(i18n.t(hint))
        }
      } finally {
        unmount()
      }
    })
  }
})

describe('the profile saves with one button (since 0.3.7)', () => {
  it('has exactly one "Save" for display name, username and email', async () => {
    const { root, unmount } = await shown('profile')
    try {
      const fields = PAGES.profile.saveFields.map((field) => labelled(root, field))
      // The card: the closest element holding all three fields.
      let card: HTMLElement = fields[0] ?? root
      while (!fields.every((field) => card.contains(field)) && card.parentElement) card = card.parentElement
      expect(getAllByRole(card, 'button', { name: i18n.t(PAGES.profile.saveButton) })).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('saves nothing when a field is changed and left', async () => {
    const { root, unmount } = await shown('profile')
    const sent = vi.spyOn(globalThis, 'fetch')
    try {
      for (const field of PAGES.profile.saveFields) {
        const input = labelled(root, field)
        fireEvent.focus(input)
        fireEvent.change(input, { target: { value: field === 'email' ? 'neu@example.com' : 'neu' } })
        fireEvent.focusOut(input)
        fireEvent.blur(input)
      }
      await new Promise((done) => setTimeout(done, 50))
      const writes = sent.mock.calls.filter(([input, init]) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        return method.toUpperCase() !== 'GET'
      })
      expect(writes).toEqual([])
    } finally {
      sent.mockRestore()
      unmount()
    }
  })
})
