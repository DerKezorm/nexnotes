/**
 * What another app shared (NOTES-23 AC-5), taken from the service worker that took the share target's form
 * (`public/sw.js`). It lives in this page's memory while the page shows it, never in a store that outlives the page:
 * a sign-in in the same page (the password) keeps it, "Save" and "Cancel" let it go, signing out and another account
 * drop it. The worker keeps it too until then (a sign-in through a provider loads the page anew).
 */
import { currentAccount, onAccountChange } from '../../state/account'
import { activeWorker, ask, tell } from '../worker'
import type { Shared } from './compose'

type Taken = { id: string; shared: Shared; account: number | null }

let taken: Taken | null = null

/** The shape the worker sends; anything else is nothing. */
export function asShared(value: unknown): Shared | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const files = Array.isArray(raw.files) ? raw.files.filter((file): file is File => typeof File !== 'undefined' && file instanceof Blob && typeof (file as File).name === 'string') : []
  const shared = { title: text('title'), text: text('text'), url: text('url'), files }
  return shared.title || shared.text || shared.url || shared.files.length ? shared : null
}

/** What was shared under `id`: from this page's memory, else from the worker. `null`: nothing (lost, run out, saved). */
export async function takeShared(id: string): Promise<Shared | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null
  if (taken?.id === id) return taken.shared
  const answer = asShared(await ask<unknown>(await activeWorker(), { type: 'nexnotes-share-take', id }))
  if (answer) taken = { id, shared: answer, account: currentAccount() }
  return answer
}

/** Saved or cancelled: the page and the worker let it go. */
export function doneShared(id: string): void {
  if (taken?.id === id) taken = null
  void tell({ type: 'nexnotes-share-done', id })
}

// Signed out, or another account than the one that took it: gone. Taken before signing in, it stays for the account
// that signs in now (the member shared it on this device and signs in to save it).
onAccountChange(() => {
  const now = currentAccount()
  if (!taken) return
  if (now === null || (taken.account !== null && taken.account !== now)) taken = null
  else taken.account = now
})

/** For the tests. */
export function forgetTaken(): void {
  taken = null
}
