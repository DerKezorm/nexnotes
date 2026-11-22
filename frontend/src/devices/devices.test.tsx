/**
 * NOTES-24 Anbindung der iOS-App on the page: "Geräte" in Settings, Connections with name, kind, last contact,
 * notifications and "Trennen" (AC-5); "iPhone oder iPad verbinden" with the QR code, three steps, ten minutes and
 * "neu erzeugen", closing itself once the app used the code (AC-1); the page `/app-connect` the app opens to sign in
 * (AC-2). The server's side is in `backend/tests/test_notes24.py`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { CONNECTION_SECTIONS } from '../extensions'
import i18n from '../i18n'
import { AppConnectPage } from '../pages/AppConnectPage'
import { qrSource, type AppDevice, type Pairing } from './api'
import { POLL_MS } from './ConnectDialog'
import { DevicesSection } from './DevicesSection'
import './register'

const scene = vi.hoisted(() => ({
  me: { id: 1, name: 'mila', display_name: 'Mila' } as Record<string, unknown> | null,
  status: 'signedIn' as string,
  assigned: [] as string[],
}))

vi.mock('../lib/providers', async (original) => ({
  ...(await original<typeof import('../lib/providers')>()),
  go: (url: string) => void scene.assigned.push(url),
}))

vi.mock('../state/auth', async (original) => ({
  ...(await original<typeof import('../state/auth')>()),
  useAuth: () => ({ me: scene.me, status: scene.status, setMe: () => undefined, refresh: async () => undefined, signOut: async () => undefined }),
}))

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let devices: AppDevice[] = []
let pairings = 0
let pairingState: 'waiting' | 'used' | 'expired' = 'waiting'
let root: Root
let box: HTMLDivElement

const HOUR = 3_600_000

function pairing(): Pairing {
  pairings += 1
  return {
    id: `p${pairings}`,
    secret: `s${pairings}`,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    link: `nexnotes://connect?server=https%3A%2F%2Fnotes.example.com&pairing=p${pairings}&secret=s${pairings}`,
    address: 'https://notes.example.com',
    qr_svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>p${pairings}</title></svg>`,
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(call: Call): Response {
  const { method, path } = call
  if (method === 'GET' && path === '/api/app-devices') return reply(200, devices)
  if (method === 'DELETE' && path.startsWith('/api/app-devices/')) {
    devices = devices.filter((device) => `/api/app-devices/${device.id}` !== path)
    return reply(204, null)
  }
  if (method === 'POST' && path === '/api/app-pairing') return reply(201, pairing())
  if (method === 'GET' && path.startsWith('/api/app-pairing/')) return reply(200, { state: pairingState, device: null })
  if (method === 'DELETE' && path.startsWith('/api/app-pairing/')) return reply(204, null)
  if (method === 'POST' && path === '/api/app-connect') {
    if (call.body?.state === 'refused-state-1') return reply(403, { detail: { code: 'second_factor_setup_required', message: 'x' } })
    return reply(200, { link: `nexnotes://connected?code=c0de&state=${String(call.body?.state)}` })
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  pairings = 0
  pairingState = 'waiting'
  scene.assigned.length = 0
  scene.status = 'signedIn'
  devices = [
    { id: 1, name: 'iPhone von Mila', kind: 'ios', created_at: new Date(Date.now() - 48 * HOUR).toISOString(), last_seen_at: new Date(Date.now() - 2 * 60_000).toISOString(), push: true },
    { id: 2, name: 'Mac mini', kind: 'mac', created_at: new Date(Date.now() - 48 * HOUR).toISOString(), last_seen_at: null, push: false },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin)
      const call = { method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
      calls.push(call)
      return answer(call)
    }),
  )
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('de')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await Promise.resolve())
}

async function render(node: React.ReactNode, at = '/'): Promise<void> {
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>))
  await settle()
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const $$ = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

describe('NOTES-24 devices in Settings, Connections', () => {
  it('NOTES-24 AC-5 comes first among the connections', () => {
    expect(CONNECTION_SECTIONS[0].key).toBe('devices')
  })

  it('NOTES-24 AC-5 lists every device with its kind, last contact and notifications', async () => {
    await render(<DevicesSection />)
    expect($$('device-name').map((element) => element.textContent)).toEqual(['iPhone von Mila', 'Mac mini'])
    const [phone, mac] = $$('device-meta').map((element) => element.textContent)
    expect(phone).toBe('iOS-App · zuletzt vor 2 Minuten · Mitteilungen an')
    expect(mac).toBe('iPad-App auf dem Mac · noch nicht gemeldet')
  })

  it('NOTES-24 AC-5 disconnects a device after asking', async () => {
    await render(<DevicesSection />)
    await click($$('device-disconnect')[0])
    expect(document.body.textContent).toContain('„iPhone von Mila“ trennen?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await click($('device-disconnect-confirm'))
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/app-devices/1', body: undefined })
    expect($$('device-name').map((element) => element.textContent)).toEqual(['Mac mini'])
  })

  it('NOTES-24 AC-5 says when no device is connected', async () => {
    devices = []
    await render(<DevicesSection />)
    expect($('devices-none')?.textContent).toBe('Noch kein Gerät verbunden.')
  })
})

describe('NOTES-24 connecting an iPhone or iPad', () => {
  it('NOTES-24 AC-1 shows the QR code with three steps, valid 10 minutes, and the address without a camera', async () => {
    await render(<DevicesSection />)
    await click($('devices-connect'))
    const dialog = $('devices-connect-dialog')!
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('iPhone oder iPad verbinden')
    expect(($('devices-qr') as HTMLImageElement).src).toBe(qrSource(pairing().qr_svg.replace('p2', 'p1')))
    expect([...dialog.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'nexnotes auf dem iPhone oder iPad öffnen.',
      '„Server verbinden“ tippen und den Code scannen.',
      'Fertig. Deine Notizen laden, und die Anmeldung wandert über deine Apple-ID auf deine anderen Geräte.',
    ])
    expect(dialog.textContent).toContain('Gilt 10 Minuten · neu erzeugen')
    expect($('devices-address')?.textContent).toBe('Ohne Kamera: In der App die Adresse notes.example.com eingeben und anmelden.')
  })

  it('NOTES-24 AC-1 makes a new code and withdraws the one before', async () => {
    await render(<DevicesSection />)
    await click($('devices-connect'))
    await click($('devices-renew'))
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/app-pairing')).toHaveLength(2)
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/app-pairing/p1', body: undefined })
    expect(decodeURIComponent(($('devices-qr') as HTMLImageElement).src)).toContain('<title>p2</title>')
  })

  it('NOTES-24 AC-1 closes itself once the app used the code, and the list shows the new device', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    await render(<DevicesSection />)
    await click($('devices-connect'))
    pairingState = 'used'
    devices = [...devices, { id: 3, name: 'iPad', kind: 'ipados', created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), push: false }]
    await act(async () => vi.advanceTimersByTime(POLL_MS))
    await settle()
    expect($('devices-connect-dialog')).toBeNull()
    expect($$('device-name').map((element) => element.textContent)).toContain('iPad')
    // A code that was used is not withdrawn.
    expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith('/api/app-pairing/'))).toBe(false)
  })

  it('NOTES-24 AC-1 says when the code ran out after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    await render(<DevicesSection />)
    await click($('devices-connect'))
    await act(async () => vi.advanceTimersByTime(10 * 60_000 + POLL_MS))
    await settle()
    expect($('devices-expired')?.textContent).toBe('Der Code ist abgelaufen.')
    expect($('devices-qr')).toBeNull()
  })

  it('NOTES-24 AC-1 withdraws an unused code when closed', async () => {
    await render(<DevicesSection />)
    await click($('devices-connect'))
    await click($('devices-close'))
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/app-pairing/p1', body: undefined })
    expect($('devices-connect-dialog')).toBeNull()
  })
})

describe('NOTES-24 the page /app-connect', () => {
  const page = (
    <Routes>
      <Route path="/app-connect" element={<AppConnectPage />} />
      <Route path="/login" element={<p data-testid="login">login</p>} />
    </Routes>
  )

  it('NOTES-24 AC-2 asks before connecting and hands the code to the app', async () => {
    await render(page, '/app-connect?state=AbCdEfGhIjKlMnOpQrStUv')
    expect(document.body.textContent).toContain('Die nexnotes-App mit diesem Konto verbinden?')
    expect(document.body.textContent).toContain('Angemeldet als Mila.')
    expect(calls.some((call) => call.path === '/api/app-connect')).toBe(false)
    await click($('app-connect-confirm'))
    expect(calls).toContainEqual({ method: 'POST', path: '/api/app-connect', body: { state: 'AbCdEfGhIjKlMnOpQrStUv' } })
    expect(scene.assigned).toEqual(['nexnotes://connected?code=c0de&state=AbCdEfGhIjKlMnOpQrStUv'])
    expect($('app-connect-done')).not.toBeNull()
  })

  it('NOTES-24 AC-2 cancel tells the app and connects nothing', async () => {
    await render(page, '/app-connect?state=AbCdEfGhIjKlMnOpQrStUv')
    await click($('app-connect-cancel'))
    expect(scene.assigned).toEqual(['nexnotes://connected?error=cancelled&state=AbCdEfGhIjKlMnOpQrStUv'])
    expect(calls.some((call) => call.path === '/api/app-connect')).toBe(false)
  })

  it('NOTES-24 AC-2 signs in first and comes back to the page', async () => {
    scene.status = 'signedOut'
    await render(
      <Routes>
        <Route path="/app-connect" element={<AppConnectPage />} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>,
      '/app-connect?state=AbCdEfGhIjKlMnOpQrStUv',
    )
    expect($('login-next')?.textContent).toBe('/app-connect?state=AbCdEfGhIjKlMnOpQrStUv')
  })

  it('NOTES-24 AC-2 says what went wrong', async () => {
    await render(page, '/app-connect?state=refused-state-1')
    await click($('app-connect-confirm'))
    expect($('app-connect-problem')).not.toBeNull()
    expect(scene.assigned).toEqual([])
  })

  it('NOTES-24 AC-2 without a state from the app does nothing', async () => {
    await render(page, '/app-connect')
    expect($('app-connect-invalid')).not.toBeNull()
    expect($('app-connect-confirm')).toBeNull()
  })
})

function LoginProbe() {
  const location = useLocation()
  return <p data-testid="login-next">{new URLSearchParams(location.search).get('next')}</p>
}
