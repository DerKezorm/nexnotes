/**
 * Server › General and Text recognition read the server's settings once (`useServerSettings`): when that fails, the
 * area says so with "Erneut versuchen" instead of staying empty (Befundsuche 28.11.2026).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from '../../i18n'
import { AreaContent } from './SettingsAreas'

let root: Root
let box: HTMLDivElement
let failing = true

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('de')
  failing = true
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname
    if (path === '/api/settings' && failing) {
      return new Response(JSON.stringify({ detail: { code: 'server_error', message: 'Something went wrong.' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify(path === '/api/settings' ? { upload_max_mb: 100, history_days: 365, trash_days: 90, new_account_storage_limit: null } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

describe('the server settings that could not be read', () => {
  it('says so with a way to ask again, and shows the cards once they come', async () => {
    await act(async () => root.render(<MemoryRouter><AreaContent area="general" /></MemoryRouter>))
    await settle()
    expect($('server-settings-failed')).not.toBeNull()
    expect($('server-settings-retry')!.textContent).toContain('Erneut versuchen')
    failing = false
    await act(async () => $('server-settings-retry')!.click())
    await settle()
    expect($('server-settings-failed')).toBeNull()
  })
})
