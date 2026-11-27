/**
 * Bauplan E44: Server › General › "Grenzen" has "Speicher für neue Konten" with its own save (a field of the kit with
 * its button level with it), in GB, empty for no limit, and says where the limit of one account is set.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import i18n from '../../i18n'
import { FeaturesCard, LimitsCard } from './GeneralCards'

let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('de')
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  act(() => root.unmount())
  box.remove()
  await i18n.changeLanguage('en')
})

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function show(limit: number | null, save: (change: object) => Promise<boolean>) {
  const server = { settings: { upload_max_mb: 100, history_days: 365, trash_days: 90, new_account_storage_limit: limit }, save, busy: false, problem: null, done: null }
  await act(async () => root.render(<LimitsCard server={server as never} />))
}

describe('E44 the storage for new accounts', () => {
  it('stands in "Grenzen" with its own save, in GB, and says where one account gets its limit', async () => {
    const save = vi.fn(async () => true)
    await show(5 * 1024 ** 3, save)
    const field = box.querySelector<HTMLInputElement>('[data-testid="limits-new-account-storage"]')!
    expect(field.labels![0]!.textContent).toBe('Speicher für neue Konten (GB)')
    expect(field.value).toBe('5')
    const hint = document.getElementById((field.getAttribute('aria-describedby') ?? '').split(' ')[0]!)!
    expect(hint.textContent).toBe('Leer heißt ohne Grenze. Gilt für Konten, die ab jetzt dazukommen.')
    // E48: the card says once where one account's limit is set, the field no second time.
    const card = box.querySelector<HTMLElement>('[data-card="limits"]')!
    expect(card.textContent).toContain('Die Grenze eines Kontos setzt du unter Server › Konten › Verwalten.')
    expect(card.textContent!.split('Konten › Verwalten').length).toBe(2)
    const button = box.querySelector<HTMLElement>('[data-testid="limits-new-account-storage-save"]')!
    expect(field.closest('[data-part="field-action"]')?.contains(button)).toBe(true)
    expect([button.dataset.kind, button.dataset.icon]).toEqual(['secondary', 'Check'])
    act(() => type(field, '2.5'))
    await act(async () => button.click())
    expect(save).toHaveBeenLastCalledWith({ new_account_storage_limit: Math.round(2.5 * 1024 ** 3) }, expect.any(String))
    act(() => type(field, ''))
    await act(async () => button.click())
    expect(save).toHaveBeenLastCalledWith({ new_account_storage_limit: null }, expect.any(String))
  })

  it('shows an empty field while new accounts start without a limit', async () => {
    await show(null, vi.fn(async () => true))
    expect(box.querySelector<HTMLInputElement>('[data-testid="limits-new-account-storage"]')!.value).toBe('')
  })
})

describe('E48 the features for every account', () => {
  it('say in one sentence what they are, in the card "features"', async () => {
    const server = { settings: { link_previews: true, share_links: true, connections_local_network: false }, save: vi.fn(), busy: false, problem: null, done: null }
    await act(async () => root.render(<FeaturesCard server={server as never} />))
    const card = box.querySelector<HTMLElement>('[data-card="features"]')!
    expect(card.textContent).toContain('Funktionen für alle Konten')
    expect(card.textContent).toContain('Was jedes Konto auf diesem Server nutzen darf.')
    // verbinden 0.1.8: "Verbindungen ins eigene Netz" stands once, in the card "Andere nex-Apps" (connect/AppsArea).
    expect(card.querySelector('[data-testid="feature-local-network"]')).toBeNull()
    expect(card.textContent).not.toContain('eigene Netz')
  })
})
