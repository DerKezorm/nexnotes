/**
 * Leaving a note. An open note without a title may not be left inside nexnotes (NOTES-3 AC-9): the editor puts up a
 * guard (`setLeaveGuard`), every way out inside the app asks it first (`tryLeave`), and the editor catches links
 * anywhere on the page too.
 */

/** Answers whether leaving must wait; if it must, it calls `proceed` itself once the member decided. */
export type LeaveGuard = (proceed: () => void) => boolean

let guard: LeaveGuard | null = null

export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next
}

/** Leaves at once, or after the open note had its say. */
export function tryLeave(proceed: () => void): void {
  if (guard && guard(proceed)) return
  proceed()
}

/** Goes to an address of the app from outside React's tree (a registered action): the router follows the history. */
export function goTo(path: string, state?: unknown): void {
  const index = typeof window.history.state?.idx === 'number' ? window.history.state.idx + 1 : 0
  window.history.pushState({ usr: state ?? null, key: Math.random().toString(36).slice(2, 10), idx: index }, '', path)
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
}
