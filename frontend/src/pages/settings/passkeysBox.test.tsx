// @vitest-environment jsdom
/**
 * The box "Passkeys" under My account › Security (konten 1.1.0, E49): "Passkey hinzufügen" only where the server can
 * add one (`passkeys_can_add`), else the module's sentence, for the operator with the way to Server › Anmeldung. The
 * account's passkeys stay listed and removable either way.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../i18n'

vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  passkeysApi: { list: async () => [{ uid: 'k1', name: 'Laptop', created_at: '2026-11-20T10:00:00Z', last_used_at: null }] },
}))
vi.mock('../../lib/passkeys', async (original) => ({
  ...(await original<typeof import('../../lib/passkeys')>()),
  passkeysSupported: () => true,
}))

const { PasskeysBox } = await import('./SecurityBoxes')

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

async function show(canAdd: boolean, operator: boolean) {
  await act(async () => root.render(<PasskeysBox signedInByPassword canAdd={canAdd} operator={operator} />))
  await act(async () => undefined)
}

describe('the box Passkeys (E49)', () => {
  it('offers "Passkey hinzufügen" where the server can add one', async () => {
    await show(true, false)
    expect(box.querySelector('[data-testid="passkey-add"]')?.textContent).toContain('Passkey hinzufügen')
    expect(box.querySelector('[data-testid="passkey-needs-address"]')).toBeNull()
  })

  it('tells the operator where the address goes, keeps the passkeys and offers no button', async () => {
    await show(false, true)
    expect(box.querySelector('[data-testid="passkey-add"]')).toBeNull()
    const note = box.querySelector('[data-testid="passkey-needs-address"]')!
    expect(note.textContent).toContain('Passkeys brauchen die öffentliche Adresse mit https.')
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/settings/sign-in')
    expect(box.textContent).toContain('Laptop')
  })

  it('tells a member that the operator has to enter it', async () => {
    await show(false, false)
    expect(box.querySelector('[data-testid="passkey-needs-address"]')?.textContent).toContain('Der Betreiber muss sie zuerst eintragen.')
    expect(box.querySelector('[data-testid="passkey-needs-address"] a')).toBeNull()
  })
})
