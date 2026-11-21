/**
 * NOTES-22 AC-2 on another device: the account chose German on one device; a browser in English that signs in or
 * loads the page takes the account's language from the server, not the browser's.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'

import i18n from './i18n'
import { AuthProvider } from './state/auth'

const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: 'de',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}

function Shown() {
  const { t } = useTranslation()
  return <p data-testid="shown">{t('settings.tabs.account')}</p>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('NOTES-22 AC-2 a page loading in an English browser takes the language of the account', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('en')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    const body = path === '/api/setup'
      ? { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 }
      : path === '/api/auth/me' ? ME : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  await act(async () => root.render(<AuthProvider><Shown /></AuthProvider>))
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
  expect(i18n.language).toBe('de')
  expect(box.querySelector('[data-testid="shown"]')!.textContent).toBe('Mein Konto')
  act(() => root.unmount())
  box.remove()
  await i18n.changeLanguage('en')
})
