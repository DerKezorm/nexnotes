// @vitest-environment jsdom
/**
 * Mein Konto › Benachrichtigungen (plan "Einstellungen", E57): nexnotes notifies through the bell of shared notes, so
 * the area has the kit's "Auf welchem Weg" with this browser (off and on, a test notification), the account's
 * browsers (this one marked, another one removed on the server), and the iPhone and iPad under Verbindungen; no mail.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../i18n'

const state = vi.hoisted(() => ({ here: 'on' as string, stopped: 0 }))
vi.mock('../../notify/browser', () => ({
  browserState: async () => state.here,
  allowBrowser: async () => 'on',
  stopBrowser: async () => {
    state.stopped += 1
    return 'off'
  },
}))

const { NotificationsArea } = await import('./NotificationsArea')

let root: Root
let box: HTMLDivElement
let calls: { path: string; method: string }[]

const DEVICES = {
  apps: [{ id: 7, name: 'iPhone', on: true }],
  browsers: [
    { id: 1, browser: 'Firefox', system: 'Linux', this: false, since: '2026-11-20T10:00:00Z', last_ok_at: null },
    { id: 2, browser: 'Chrome', system: 'macOS', this: true, since: '2026-11-25T10:00:00Z', last_ok_at: null },
  ],
  this_browser: true,
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('de')
  state.here = 'on'
  state.stopped = 0
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET' })
    if (path === '/api/notify/devices') return new Response(JSON.stringify(DEVICES), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(null, { status: 204 })
  }))
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

async function show() {
  await act(async () => root.render(<NotificationsArea />))
  await act(async () => undefined)
}

const find = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('the area Benachrichtigungen (E57)', () => {
  it('is the card "Auf welchem Weg" with this browser, the browsers and the devices, without mail', async () => {
    await show()
    const card = box.querySelector<HTMLElement>('[data-card="notify-ways"]')!
    expect(card.textContent).toContain('Glocke')
    expect(find('notify-mail')).toBeNull()
    expect(find('notify-browser-off')).not.toBeNull()
    expect(find('notify-browsers')?.textContent).toContain('Firefox auf Linux')
    expect(find('notify-devices')?.getAttribute('href')).toBe('/settings/connections')
    expect(find('notify-devices-box')?.textContent).toContain('1 Gerät bekommt Mitteilungen.')
  })

  it('sends a test notification to this browser and removes another browser on the server', async () => {
    await show()
    await act(async () => find('notify-probe')!.click())
    await act(async () => undefined)
    expect(calls).toContainEqual({ path: '/api/notify/webpush/test', method: 'POST' })
    expect(find('notify-done')?.textContent).toContain('Probemeldung geschickt')
    await act(async () => find('notify-remove-1')!.click())
    await act(async () => undefined)
    expect(calls).toContainEqual({ path: '/api/notify/webpush/1', method: 'DELETE' })
    expect(state.stopped).toBe(0)
  })

  it('turns this browser off itself when its own row is removed', async () => {
    await show()
    await act(async () => find('notify-remove-2')!.click())
    await act(async () => undefined)
    expect(state.stopped).toBe(1)
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('offers no test where this browser is off', async () => {
    state.here = 'off'
    await show()
    expect(find('notify-probe')).toBeNull()
    expect(find('notify-browser-on')).not.toBeNull()
  })
})
