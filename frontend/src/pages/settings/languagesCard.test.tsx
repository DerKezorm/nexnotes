// @vitest-environment jsdom
/**
 * Server › General › "Sprachen" in nexnotes (module sprachen 1.0.0, E51): the module's card under `/api/locales`, its
 * changes naming this tab (`X-Nexnotes-Client`, the server refuses them without), the menus asking again afterwards
 * (`own.forget`), the template made on the page from nexnotes' English texts.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n, { own, TEMPLATE_TEXTS } from '../../i18n'
import { NexuiLanguage } from '../../vendor/nexui'
import { LanguagesCard } from './GeneralCards'

let root: Root
let box: HTMLDivElement
let calls: { path: string; method: string; client: string | null }[]

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('de')
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', client: new Headers(init.headers).get('X-Nexnotes-Client') })
    if ((init.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify([
      { code: 'de', name: 'Deutsch', keys: 0, built_in: true, own: false },
      { code: 'en', name: 'English', keys: 0, built_in: true, own: false },
      { code: 'nl', name: 'Nederlands', keys: 12, built_in: false, own: true },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})

describe('the card "Sprachen" of nexnotes', () => {
  it('is the module card under /api/locales, removes with the tab named and lets the menus ask again', async () => {
    const forget = vi.spyOn(own, 'forget')
    await act(async () => root.render(<NexuiLanguage language="de"><LanguagesCard /></NexuiLanguage>))
    await act(async () => undefined)
    const card = box.querySelector<HTMLElement>('[data-card="languages"]')!
    expect(card.textContent).toContain('Deutsch und Englisch sind eingebaut.')
    expect(box.querySelector('[data-testid="language-nl"]')?.textContent).toContain('Nederlands (nl)')
    expect(calls[0]).toMatchObject({ path: '/api/locales', method: 'GET' })
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="Nederlands entfernen"]')!.click())
    await act(async () => undefined)
    const removed = calls.find((call) => call.method === 'DELETE')!
    expect(removed.path).toBe('/api/locales/nl')
    expect(removed.client).toMatch(/^tab-/)
    expect(forget).toHaveBeenCalled()
  })

  it('hands out nexnotes English texts as the template', () => {
    expect(TEMPLATE_TEXTS).toMatchObject({ settings: { title: 'Settings' } })
  })
})
