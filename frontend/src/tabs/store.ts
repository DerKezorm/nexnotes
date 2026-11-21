/**
 * The open tabs of this device, for the account signed in (NOTES-8 AC-5): the rules of `state.ts` applied, kept in
 * `localStorage` under `nexnotes.tabs.<account>` and read back on the next visit. The server keeps nothing: taking the
 * tabs to another device is not part of the briefing.
 *
 * A tab pushed out by a seventh says so in the notice at the bottom (AC-7).
 *
 * Another account in the same tab (signing out, or another tab signed in as someone else): the tabs of the account
 * before are put away, and the notes they showed are remembered as that account's for the rest of the page load. The
 * address may still name one of them; the page does not take it over as a tab of the next account (`TabbedNotes`).
 */
import i18n from 'i18next'
import { useSyncExternalStore } from 'react'

import { showNotice } from '../folders/notice'
import { currentAccount, onAccountChange } from '../state/account'
import { metaOf } from './meta'
import * as rules from './state'
import { EMPTY, MAX_TABS, type Side, type Step, type TabsState } from './state'

const listeners = new Set<() => void>()
let account: number | null = null
let state: TabsState = EMPTY

export function storageKey(accountId: number): string {
  return `nexnotes.tabs.${accountId}`
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A full or blocked storage: the tabs hold until the page is reloaded.
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** The tabs of this account on this device; read once per account (before the first picture of the notes). */
export function loadAccountTabs(accountId: number | null): void {
  if (accountId === null || accountId === account) return
  account = accountId
  state = rules.parse(read(storageKey(accountId)))
}

export function tabsNow(): TabsState {
  return state
}

function commit(next: TabsState, closed?: Step['closed']): void {
  if (next === state) return
  state = next
  if (account !== null) write(storageKey(account), rules.serialize(state))
  emit()
  if (closed) {
    const title = metaOf(closed.note)?.title || i18n.t('notes.untitled')
    showNotice({ text: i18n.t('tabs.closedOldest', { title, max: MAX_TABS }) })
  }
}

function apply(step: Step): void {
  commit(step.state, step.closed)
}

export const tabs = {
  openHere: (note: string, folder?: string) => apply(rules.openHere(state, note, folder)),
  openInNewTab: (note: string, folder?: string) => apply(rules.openInNewTab(state, note, folder)),
  openBeside: (note: string, folder?: string) => apply(rules.openBeside(state, note, folder)),
  show: (key: string) => commit(rules.show(state, key)),
  close: (key: string) => commit(rules.closeTab(state, key)),
  closeNote: (note: string) => commit(rules.closeNote(state, note)),
  endSplit: () => commit(rules.endSplit(state)),
  focus: (side: Side) => commit(rules.setFocus(state, side)),
  move: (key: string, to: number) => commit(rules.moveTab(state, key, to)),
  ratio: (ratio: number) => commit(rules.setRatio(state, ratio)),
}

export function useTabs(): TabsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

/** Notes the tabs of another account showed in this page load, with that account. */
const others = new Map<string, number>()

/** A note an account before had open in this page load, and not the one signed in now. */
export function isOtherAccountsNote(note: string): boolean {
  const owner = others.get(note)
  return owner !== undefined && owner !== currentAccount()
}

onAccountChange(() => {
  if (account !== null) for (const tab of state.tabs) others.set(tab.note, account)
  account = null
  state = EMPTY
  emit()
})

/** For tests: as after a fresh page load. */
export function forgetTabs(): void {
  account = null
  state = EMPTY
  others.clear()
  emit()
}
