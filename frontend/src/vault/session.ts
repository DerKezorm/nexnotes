/**
 * The open vault of this tab (NOTES-16): the vault key in memory, and nothing else.
 *
 * - **Only in memory:** the key is a non-extractable `CryptoKey` in this module; never in localStorage,
 *   sessionStorage, IndexedDB or a cookie. The password is not kept at all (EC-6).
 * - **It closes by itself** after `AUTO_LOCK_MS` without use (keys, pointer, wheel, touch in the tab; AC-3, EC-6),
 *   when the last open locked note goes (`hold`/`release`, AC-3: closing locks again), at signing out and when another
 *   account comes into the tab (`onAccountChange`), and when the vault changed elsewhere (`epoch`, EC-7). Before it
 *   closes, what an open note still has to save is saved (`onBeforeLock`).
 * - **Wrong passwords** are counted by the server (EC-1); `open` says how many tries are left and how long to wait.
 */
import { ApiError } from '../api/client'
import { currentAccount, onAccountChange } from '../state/account'
import { vaultApi, type VaultStatus } from './api'
import { derive, unwrapVault } from './crypto'

/** Five minutes without use (decision of 21.11.2026). */
export const AUTO_LOCK_MS = 5 * 60 * 1000
/** A locked note closed and opened again at once (React's strict mode, a tab switched) keeps the vault open. */
const RELEASE_GRACE_MS = 1500
const CHECK_MS = 1000

type Open = { key: CryptoKey; epoch: number; account: number | null }

let open: Open | null = null
let lastUse = 0
let holders = 0
let releaseTimer: ReturnType<typeof setTimeout> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let version = 0
const listeners = new Set<() => void>()
const beforeLock = new Set<() => Promise<void>>()
let now = () => Date.now()

function emit(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function vaultVersion(): number {
  return version
}

export function isOpen(): boolean {
  return open !== null && open.account === currentAccount()
}

export function vaultKey(): CryptoKey | null {
  return isOpen() ? open!.key : null
}

export function vaultEpoch(): number {
  return open?.epoch ?? 0
}

/** Something in the tab was used: the five minutes start again. */
export function touch(): void {
  if (open) lastUse = now()
}

const ACTIVITY = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'input'] as const

function watch(): void {
  if (typeof window === 'undefined') return
  for (const name of ACTIVITY) window.addEventListener(name, touch, { capture: true, passive: true })
  if (!checkTimer) {
    checkTimer = setInterval(() => {
      if (open && now() - lastUse >= AUTO_LOCK_MS) void lockVault('idle')
    }, CHECK_MS)
  }
}

function unwatch(): void {
  if (typeof window !== 'undefined') for (const name of ACTIVITY) window.removeEventListener(name, touch, { capture: true })
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = null
}

/** Called before the key goes: an open note saves what waits, while it still can. */
export function onBeforeLock(save: () => Promise<void>): () => void {
  beforeLock.add(save)
  return () => beforeLock.delete(save)
}

export type LockReason = 'idle' | 'closed' | 'account' | 'changed' | 'manual'
let lastReason: LockReason | null = null

export function lastLockReason(): LockReason | null {
  return lastReason
}

/** Forgets the key (after saving what waits, at most a few seconds). */
export async function lockVault(reason: LockReason = 'manual'): Promise<void> {
  if (!open) return
  const saving = [...beforeLock].map((save) => save().catch(() => undefined))
  if (saving.length && reason !== 'account') await Promise.race([Promise.all(saving), new Promise((resolve) => setTimeout(resolve, 3000))])
  open = null
  lastReason = reason
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  unwatch()
  emit()
}

/** Takes an opened vault key (after setting up, or after the right password). */
export function takeKey(key: CryptoKey, epoch: number): void {
  open = { key, epoch, account: currentAccount() }
  lastUse = now()
  lastReason = null
  watch()
  emit()
}

export type OpenResult =
  | { ok: true }
  | { ok: false; reason: 'wrong'; left: number; wait: number }
  | { ok: false; reason: 'wait'; wait: number }
  | { ok: false; reason: 'missing' }

/** Opens the vault with the password (AC-3, AC-7, AC-8): the server checks the check value and counts wrong ones;
 * the wrapped key it hands out opens only here. */
export async function openVault(password: string): Promise<OpenResult> {
  const status: VaultStatus = await vaultApi.status()
  if (!status.set_up || !status.kdf) return { ok: false, reason: 'missing' }
  const { kek, auth } = await derive(password, status.kdf)
  try {
    const answer = await vaultApi.unlock(toB64Auth(auth))
    const key = await unwrapVault(kek, answer.wrapped_key, currentAccount() ?? 0)
    takeKey(key, answer.epoch)
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'vault_wrong') return { ok: false, reason: 'wrong', left: Number(error.values.left ?? 0), wait: Number(error.values.wait ?? 0) }
    if (error instanceof ApiError && error.code === 'vault_wait') return { ok: false, reason: 'wait', wait: Number(error.values.wait ?? 0) }
    throw error
  } finally {
    auth.fill(0)
  }
}

function toB64Auth(auth: Uint8Array): string {
  let text = ''
  for (const byte of auth) text += String.fromCharCode(byte)
  return btoa(text)
}

/** The derivation and the check value for a password, for changing it (AC-5). */
export async function checkFor(password: string): Promise<{ kek: CryptoKey; auth: string } | null> {
  const status = await vaultApi.status()
  if (!status.kdf) return null
  const { kek, auth } = await derive(password, status.kdf)
  const text = toB64Auth(auth)
  auth.fill(0)
  return { kek, auth: text }
}

/** An open locked note holds the vault open; when the last one goes, it closes (AC-3: closing locks again). */
export function hold(): () => void {
  holders += 1
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    if (holders === 0 && open) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null
        if (holders === 0) void lockVault('closed')
      }, RELEASE_GRACE_MS)
    }
  }
}

/** The vault changed elsewhere (a new password, a new vault): the key of before is no good any more (EC-7). */
export function epochSeen(epoch: number): void {
  if (open && epoch !== open.epoch) void lockVault('changed')
}

/** For tests: the clock, and a closed vault. */
export function setClock(clock: () => number): void {
  now = clock
}

export function forgetVault(): void {
  open = null
  holders = 0
  lastReason = null
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  unwatch()
  beforeLock.clear()
  now = () => Date.now()
  emit()
}

// Signing out, another account in the tab: the key goes at once, before anything of the next account is drawn.
onAccountChange(() => {
  if (open) {
    open = null
    lastReason = 'account'
    unwatch()
    emit()
  }
})
