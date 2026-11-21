/**
 * Where nexnotes starts (NOTES-23): on a phone with the folders, one view after the other (AC-1); the installed app
 * where it was left (EC-6). The installed app opens at its start address (`/?app=1`, manifest); while it runs it keeps
 * the path it shows (only the path and the account's number: no title, no text) in `localStorage`, and goes back
 * there at the next start of the same account. A sign-in that ran out on the way leads through the sign-in first.
 * Signing out and another account forget the place.
 */
import { currentAccount, onAccountChange } from '../state/account'
import { DESKTOP_QUERY } from '../tabs/desktop'

export const PLACE_KEY = 'nexnotes.place'
/** The manifest's start address carries this, so a start of the installed app is told apart from a link to `/`. */
export const APP_START = 'app'

/** Pages outside the signed-in app, never a place to come back to. */
const OUTSIDE = /^\/(login|setup|invite|reset|share|oauth)(\/|$)/

/** Whether a path may be kept as the place to come back to. */
export function keepablePlace(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !OUTSIDE.test(path.split('?')[0])
}

/** A phone as far as the page can tell: a screen narrower than the app's `md`. Without `matchMedia`, not one. */
export function onPhone(): boolean {
  try {
    return typeof window.matchMedia === 'function' && !window.matchMedia(DESKTOP_QUERY).matches
  } catch {
    return false
  }
}

/** Where the app goes at its start, or `null` to stay. `last`: the place kept by the installed app. */
export function startPlace(pathname: string, search: string, phone: boolean, last: string | null): string | null {
  const params = new URLSearchParams(search)
  const appStart = params.has(APP_START)
  if (appStart && last && keepablePlace(last)) return last
  if (pathname === '/' && phone) return '/folders'
  if (appStart) {
    params.delete(APP_START)
    const rest = params.toString()
    return pathname + (rest ? `?${rest}` : '')
  }
  return null
}

/** The place kept for `account`, or null (none, or kept for another account). */
export function lastPlace(account: number | null): string | null {
  if (account === null) return null
  try {
    const kept = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null') as { a?: unknown; p?: unknown } | null
    return kept && kept.a === account && typeof kept.p === 'string' && keepablePlace(kept.p) ? kept.p : null
  } catch {
    return null
  }
}

export function rememberPlace(account: number | null, path: string): void {
  if (account === null || !keepablePlace(path) || new URLSearchParams(path.split('?')[1] ?? '').has(APP_START)) return
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ a: account, p: path }))
  } catch {
    // A private window without storage: the app starts at its start.
  }
}

export function forgetPlace(): void {
  try {
    localStorage.removeItem(PLACE_KEY)
  } catch {
    // Nothing kept.
  }
}

// Signed out, or another account: the place goes. The same account signing in again (its session ran out) keeps it.
onAccountChange(() => {
  const now = currentAccount()
  if (now === null || lastPlace(now) === null) forgetPlace()
})

/** Once per page load: whether the start was looked at already (a later "/" on a phone is "All notes", as asked). */
let looked = false

export function startLooked(): boolean {
  const before = looked
  looked = true
  return before
}

/** For the tests. */
export function forgetStart(): void {
  looked = false
}
