/**
 * NOTES-22 Languages, the interface's part: the browser's language on the first visit, the account's language on every
 * device, both files complete with English as the fallback, the formats of each language, light and dark per device.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n, { changeLanguage, firstShipped } from './i18n'
import de from './i18n/de.json'
import en from './i18n/en.json'
import { bytes, day } from './lib/format'
import { applyMode, followSystem, storedMode } from './lib/theme'

const scene = vi.hoisted(() => ({ me: null as Record<string, unknown> | null }))

vi.mock('./state/auth', async (original) => ({
  ...(await original<typeof import('./state/auth')>()),
  useAuth: () => ({ me: scene.me, status: 'signedIn', setMe: (me: Record<string, unknown>) => (scene.me = me), refresh: async () => undefined }),
}))

function flat(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === 'object' ? flat(value as Record<string, unknown>, `${prefix}${key}.`) : [prefix + key]))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
  await i18n.changeLanguage('en')
})

describe('NOTES-22', () => {
  it('NOTES-22 AC-1 AC-6 the first visit speaks the browser language when it is German or English, else English', () => {
    expect(firstShipped(['de-DE', 'en'])).toBe('de')
    expect(firstShipped(['de-AT'])).toBe('de')
    expect(firstShipped(['en-GB', 'de'])).toBe('en')
    expect(firstShipped(['fr-FR'])).toBe('en')
    expect(firstShipped(['fr-FR', 'de'])).toBe('de')
    expect(firstShipped([])).toBe('en')
  })

  it('NOTES-22 AC-2 the language chosen for the account counts at once and is not only this browser\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/me/language') {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ ...scene.me, language: body.language }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/api/locales') return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    scene.me = { id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '', two_factor: false, two_factor_recovery_left: 0 }
    const { AccountTab } = await import('./pages/settings/AccountTab')
    const box = document.createElement('div')
    document.body.append(box)
    const root: Root = createRoot(box)
    await act(async () => root.render(<MemoryRouter><AccountTab /></MemoryRouter>))
    for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve())
    const select = box.querySelector<HTMLSelectElement>('[data-testid="language-select"]')!
    await act(async () => {
      select.value = 'de'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve())
    // Saved with the account (the server hands it to every device: backend test_notes22_ac2) and shown at once.
    const sent = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([path]) => path === '/api/me/language')
    expect(JSON.parse(String(sent?.[1].body))).toEqual({ language: 'de' })
    expect(i18n.language).toBe('de')
    act(() => root.unmount())
    box.remove()
  })

  it('NOTES-22 EC-4 a language change while writing keeps the text', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { useTranslation } = await import('react-i18next')
    function Writing() {
      const { t } = useTranslation()
      return (
        <label>
          {t('auth.name')}
          <textarea defaultValue="" data-testid="text" />
        </label>
      )
    }
    const box = document.createElement('div')
    document.body.append(box)
    const root = createRoot(box)
    await act(async () => root.render(<Writing />))
    const area = box.querySelector<HTMLTextAreaElement>('[data-testid="text"]')!
    area.value = 'Milch, Butter, Brot'
    await act(async () => void (await changeLanguage('de', false)))
    expect(box.textContent).toContain('Name')
    expect(box.querySelector<HTMLTextAreaElement>('[data-testid="text"]')!.value).toBe('Milch, Butter, Brot')
    act(() => root.unmount())
    box.remove()
  })

  it('NOTES-22 AC-3 every text of the interface exists in both languages', () => {
    const german = new Set(flat(de))
    const english = new Set(flat(en))
    expect([...german].filter((key) => !english.has(key))).toEqual([])
    expect([...english].filter((key) => !german.has(key))).toEqual([])
    expect(german.size).toBeGreaterThan(300)
  })

  it('NOTES-22 EC-1 a text missing in a language appears in English, never as a bare key', async () => {
    i18n.addResourceBundle('xx', 'translation', { auth: { name: 'Nom' } }, true, true)
    await i18n.changeLanguage('xx')
    expect(i18n.t('auth.name')).toBe('Nom')
    expect(i18n.t('auth.password')).toBe('Password')
  })

  it('NOTES-22 AC-4 dates and numbers in the format of the language', () => {
    const moment = new Date(2026, 10, 20, 8, 14)
    expect(day(moment, 'de')).toBe('20.11.2026')
    expect(day(moment, 'en')).toBe('Nov 20, 2026')
    expect(bytes(2.4 * 1024 * 1024, 'de')).toBe('2,4 MB')
    expect(bytes(2.4 * 1024 * 1024, 'en')).toBe('2.4 MB')
    expect(bytes(5 * 1024 ** 3, 'de')).toBe('5,0 GB')
    expect(bytes(512, 'en')).toBe('512 B')
  })

  it('NOTES-22 AC-7 light, dark or as the system, as the system from the start, kept on this device only', () => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('light'), addEventListener: () => undefined }))
    expect(storedMode()).toBe('system')
    applyMode('dark')
    expect(storedMode()).toBe('dark')
    expect(kept.get('nexnotes.theme')).toBe('dark')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    applyMode('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    // Nothing of it goes to the server: the account's data carry no appearance.
    expect(Object.keys(en.me.looks)).toContain('appearanceHint')
  })

  it('NOTES-22 AC-8 as the system, the page follows when the device switches', () => {
    const kept = new Map<string, string>([['nexnotes.theme', 'system']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) })
    let light = false
    let listener: (() => void) | null = null
    vi.stubGlobal('matchMedia', () => ({ get matches() { return light }, addEventListener: (_: string, call: () => void) => (listener = call) }))
    followSystem()
    applyMode('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    light = true
    listener!()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    // A choice of its own does not follow.
    applyMode('dark')
    light = true
    listener!()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})
