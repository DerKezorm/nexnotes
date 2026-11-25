/**
 * NOTES-2 AC-11: the profile picture in "My account" (upload, remove), and in the others' row of a note (NOTES-12):
 * the picture with a border in the person's color, else the initial.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { PresenceBar } from './editor/PresenceBar'
import { presenceOf, presenceUser } from './editor/presence'
import i18n from './i18n'
import { AuthProvider } from './state/auth'

let root: Root
let box: HTMLDivElement
let avatar: string | null = null
const calls: { method: string; path: string; body: unknown }[] = []

const me = () => ({
  id: 7, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: 'en',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0', min_password: 12, avatar,
})

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  avatar = null
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, path, body: init?.body })
      if (path === '/api/auth/avatar' && method === 'PUT') avatar = '2026-11-21T09:00:00+00:00'
      if (path === '/api/auth/avatar' && method === 'DELETE') avatar = null
      const body =
        path === '/api/setup'
          ? { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 }
          : path === '/api/auth/me' || path === '/api/auth/avatar'
            ? me()
            : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

describe('NOTES-2 AC-11 profile pictures', () => {
  it('NOTES-2 AC-11 My account uploads a picture and removes it again; without one the initial shows', async () => {
    const { SettingsPage } = await import('./pages/SettingsPage')
    await act(async () =>
      root.render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      ),
    )
    await settle()
    const card = () => box.querySelector<HTMLElement>('[data-testid="profile-picture"]')!
    expect(card().querySelector('[data-testid="avatar-initial"]')!.textContent).toBe('A')
    expect(card().textContent).toContain('Upload a profile picture')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'me.jpg', { type: 'image/jpeg' })
    const input = card().querySelector<HTMLInputElement>('[data-testid="picture-file"]')!
    expect(input.accept).toBe('image/*')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/auth/avatar')!
    expect(put.body).toBe(file)
    const picture = card().querySelector<HTMLImageElement>('[data-testid="avatar-picture"]')!
    expect(picture.getAttribute('src')).toBe(`/api/avatars/7?v=${encodeURIComponent('2026-11-21T09:00:00+00:00')}`)
    await act(async () => [...card().querySelectorAll('button')].find((button) => button.textContent === 'Remove the picture')!.click())
    await settle()
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/auth/avatar')).toBe(true)
    expect(card().querySelector('[data-testid="avatar-picture"]')).toBeNull()
    expect(card().querySelector('[data-testid="avatar-initial"]')).not.toBeNull()
  })

  it('NOTES-2 AC-11 the others in a note show with their picture and a border in their color, else their initial', async () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: presenceUser(1, 'Me') }],
      [2, { user: presenceUser(2, 'Lena', '2026-11-20T10:00:00+00:00') }],
      [3, { user: presenceUser(3, 'Tom') }],
    ])
    const presence = presenceOf(states, 1, 1)
    act(() => root.render(<PresenceBar presence={presence} />))
    const people = [...box.querySelectorAll<HTMLElement>('[data-testid="presence-person"]')]
    expect(people.map((person) => person.title)).toEqual(['Lena', 'Tom'])
    const picture = people[0].querySelector<HTMLImageElement>('img')!
    expect(picture.getAttribute('src')).toBe(`/api/avatars/2?v=${encodeURIComponent('2026-11-20T10:00:00+00:00')}`)
    expect(picture.style.borderColor).not.toBe('')
    expect(people[1].querySelector('[data-testid="avatar-initial"]')!.textContent).toBe('T')
    // A picture the server does not show this viewer: the initial instead, nothing broken.
    act(() => void picture.dispatchEvent(new Event('error')))
    expect(people[0].querySelector('[data-testid="avatar-initial"]')!.textContent).toBe('L')
  })
})
