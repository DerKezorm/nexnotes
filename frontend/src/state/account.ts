/**
 * What a page keeps of the account signed in, outside React's tree: the tags, the folder tree, a notice. A feature
 * that keeps such a store registers how to forget it with `onAccountChange`; signing out and every change of the
 * account in the tab (`state/auth.tsx`) forget them all at once, before anything of the next account is drawn. So
 * nothing of one account stays on screen for the next one in the same tab.
 *
 * Components need nothing of this: the signed-in part of the page is drawn anew for every account (`App.tsx`), which
 * takes their state with it.
 */

const forgets = new Set<() => void>()

/** `forget` runs whenever the account of the tab changes or signs out. Returns how to take it back. */
export function onAccountChange(forget: () => void): () => void {
  forgets.add(forget)
  return () => forgets.delete(forget)
}

/** Forgets what every store kept of the account before. One store failing does not keep the others. */
export function accountChanged(): void {
  for (const forget of [...forgets]) {
    try {
      forget()
    } catch {
      // A store that cannot forget is drawn anew anyway; the others must still forget.
    }
  }
}

let account: number | null | undefined

/** The account of the tab now (`null`: none). Forgets the stores when it is another one than before. */
export function followAccount(id: number | null): void {
  if (account !== undefined && account !== id) accountChanged()
  account = id
}

/** For tests: the tab starts without an account. */
export function forgetAccount(): void {
  account = undefined
}
