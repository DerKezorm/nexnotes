/** Light, dark or as the system: a new browser without a choice follows the system does. */
import { applyMode, storedMode, storedTheme, takeAccountTheme } from './theme'

function system(light: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: light && query.includes('light'), addEventListener: () => undefined }))
}

describe('the mode', () => {
  beforeEach(() => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('follows the system while nothing was chosen', () => {
    system(true)
    expect(storedMode()).toBe('system')
    expect(storedTheme()).toBe('light')
    system(false)
    expect(storedTheme()).toBe('dark')
  })

  it('keeps a choice, and the system again when that is chosen', () => {
    system(true)
    applyMode('dark')
    expect([storedMode(), storedTheme()]).toEqual(['dark', 'dark'])
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    applyMode('system')
    expect([storedMode(), storedTheme()]).toEqual(['system', 'light'])
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

/**
 * The account's theme (konten 1.1.0, E45): an account with a choice shows it and asks nothing; only an account of
 * before (no theme) takes, once, what this browser really kept, raw, and without a kept value lets the server take
 * nexnotes' default of before. What the browser prefers (`prefers-color-scheme`) is never sent.
 */
describe('the account takes its theme (E45)', () => {
  const kept = new Map<string, string>()
  const answer = (theme: string) => vi.fn(async () => ({ theme }))
  beforeEach(() => {
    kept.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    })
    // The browser prefers light: that must never count as a kept choice.
    system(true)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('shows the choice of an account that has one and asks nothing', () => {
    const take = answer('light')
    takeAccountTheme('dark', take)
    expect(take).not.toHaveBeenCalled()
    expect(kept.get('nexnotes.theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  })

  it('sends what the browser really kept, raw, for an account of before', async () => {
    kept.set('nexnotes.theme', 'light')
    const take = answer('light')
    takeAccountTheme('', take)
    expect(take).toHaveBeenCalledWith('light')
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
  })

  it('sends nothing made up when the browser kept nothing: the server takes the default of before', async () => {
    const take = answer('system')
    takeAccountTheme('', take)
    expect(take).toHaveBeenCalledWith('')
    await vi.waitFor(() => expect(kept.get('nexnotes.theme')).toBe('system'))
  })
})
