/**
 * Light or dark mode, or as the system is set (as in nexlore: a new browser without a choice follows the system). The
 * colors behind it live solely in styles/index.css, this only holds which mode is active.
 */

export type Theme = 'dark' | 'light'
export type Mode = Theme | 'system'

const KEY = 'nexnotes.theme'

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** The mode chosen in this browser; nothing chosen yet means the system's. */
export function storedMode(): Mode {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/** The mode as it shows now: the system's when that was chosen. */
export function storedTheme(): Theme {
  const mode = storedMode()
  return mode === 'system' ? systemTheme() : mode
}

function paint(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f5f8' : '#0b0b0f')
}

export function applyMode(mode: Mode): void {
  paint(mode === 'system' ? systemTheme() : mode)
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Then the choice only holds until the next reload.
  }
}

export function applyTheme(theme: Theme): void {
  applyMode(theme)
}

/** While the mode is the system's, the page changes along when the system does. Once, at the start. */
export function followSystem(): void {
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (storedMode() === 'system') paint(systemTheme())
    })
  } catch {
    // An old browser: the mode stays as it was at the start.
  }
}

/** What this browser kept before the choice moved to the account (konten 1.1.0), "" for nothing. */
export function keptMode(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * The account's choice, on every device (plan "Einstellungen", E5): shown at once and kept here too, so that the next
 * page load starts in it before the account is known (`public/theme.js`). An account that never chose takes what this
 * browser kept, once (`take`, the server's `profiles.adopt_theme`), and shows what the server answers.
 */
export function takeAccountTheme(theme: string | undefined, take: (kept: string) => Promise<{ theme: string }>): void {
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    applyMode(theme)
    return
  }
  // Only an account of before has no theme: it takes, once, what this browser really kept, raw (never what the
  // browser prefers), and without one the server takes nexnotes' default of before (konten 1.1.0, E45).
  void take(keptMode()).then(
    (answer) => {
      if (answer.theme === 'light' || answer.theme === 'dark' || answer.theme === 'system') applyMode(answer.theme)
    },
    () => undefined,
  )
}
