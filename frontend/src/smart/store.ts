/**
 * The smart folders of the signed-in account, for the sidebar, the phone's way back and the editor: loaded once,
 * again after a change made here and when the window comes back to the front (another device may have changed them).
 */
import { useSyncExternalStore } from 'react'

import { onAccountChange } from '../state/account'
import { smartApi, type SmartFolder } from './api'

export type SmartState = { status: 'idle' | 'loading' | 'ready' | 'failed'; folders: SmartFolder[] }

let state: SmartState = { status: 'idle', folders: [] }
const listeners = new Set<() => void>()
let pending: Promise<void> | null = null
let watching = false
/** Counts up whenever the account changes: an answer asked for the account before is dropped when it comes. */
let generation = 0

function publish(next: SmartState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Asks the server again; one request at a time. */
export function refreshSmartFolders(): Promise<void> {
  if (pending) return pending
  if (state.status === 'idle') publish({ ...state, status: 'loading' })
  const asked = generation
  const request: Promise<void> = smartApi
    .list()
    .then((answer) => {
      if (asked === generation) publish({ status: 'ready', folders: answer.items })
    })
    .catch(() => {
      if (asked === generation) publish({ ...state, status: state.status === 'ready' ? 'ready' : 'failed' })
    })
    .finally(() => {
      if (pending === request) pending = null
    })
  pending = request
  return request
}

/** The order changed here (AC-8): shown at once, while the server keeps it. */
export function showOrder(ids: string[]): void {
  const byId = new Map(state.folders.map((folder) => [folder.id, folder]))
  const ordered = ids.map((id) => byId.get(id)).filter((folder): folder is SmartFolder => Boolean(folder))
  const rest = state.folders.filter((folder) => !ids.includes(folder.id))
  publish({ ...state, folders: [...ordered, ...rest] })
}

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('focus', () => void refreshSmartFolders())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  watch()
  if (state.status === 'idle') void refreshSmartFolders()
  return () => listeners.delete(listener)
}

export function useSmartFolders(): SmartState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The smart folders as they are now, for code outside React (the phone's way back to a list). */
export function currentSmartFolders(): SmartFolder[] {
  return state.folders
}

/** Forgets what was loaded: when the account changes or signs out, and in tests. */
export function forgetSmartFolders(): void {
  generation += 1
  pending = null
  publish({ status: 'idle', folders: [] })
}

onAccountChange(forgetSmartFolders)
