/**
 * The ways into the tabs (NOTES-8), for the list's menu, the middle button, the tab bar and the keys: each changes
 * the tabs, asks first the open note that would go out of view (a missing title, NOTES-3 AC-9), and then moves the
 * address to the note on the side used last.
 */
import type { LeaveGuard } from '../notes/context'
import { goTo } from '../notes/context'
import { currentList, hrefIn } from '../notes/workspace'
import * as rules from './state'
import { focusedKey, tabOf, visibleKeys, type Side, type Step, type TabsState } from './state'
import { tabs, tabsNow } from './store'

type Go = (path: string, options?: { replace?: boolean; state?: unknown }) => void

// Outside the notes page the app's own history step; on it the router's `navigate` (set by the page).
let go: Go = (path, options) => goTo(path, options?.state)

export function setNavigation(next: Go | null): void {
  go = next ?? ((path, options) => goTo(path, options?.state))
}

// ---- Guards of the open sides -------------------------------------------------------------------------------------

const guards = new Map<string, LeaveGuard>()

/** The editor of a tab hands in its guard (and takes it back with null). */
export function setTabGuard(key: string, guard: LeaveGuard | null, previous?: LeaveGuard | null): void {
  if (guard) guards.set(key, guard)
  else if (!previous || guards.get(key) === previous) guards.delete(key)
}

/** Asks the editors of these tabs one after the other; `proceed` once all of them let go. */
function askAll(keys: string[], proceed: () => void): void {
  const [first, ...rest] = keys
  if (!first) return proceed()
  const guard = guards.get(first)
  const next = () => askAll(rest, proceed)
  if (guard && guard(next)) return
  next()
}

// ---- Changing -----------------------------------------------------------------------------------------------------

/** The address of the list on show with the note of the side used last (NOTES-8 AC-9): the tabs never change the
 * list. */
export function hrefOf(state: TabsState): string | null {
  const tab = tabOf(state, focusedKey(state))
  return tab ? hrefIn(currentList(), tab.note) : null
}

/** The address follows the side used last; without any tab, the list alone. */
export function follow(replace: boolean, state?: unknown): void {
  const href = hrefOf(tabsNow())
  const here = window.location.pathname + window.location.search
  if (!href) {
    if (here !== currentList()) go(currentList(), { replace: true })
    return
  }
  if (href !== here || state) go(href, { replace, state })
}

/** Works out a change first, asks the notes that would go out of view, then makes it. */
function change(compute: (state: TabsState) => Step | TabsState, apply: () => void, replace: boolean, navState?: unknown): void {
  const before = tabsNow()
  const result = compute(before)
  const after = 'state' in result ? result.state : result
  const leaving = visibleKeys(before).filter((key) => !visibleKeys(after).includes(key))
  askAll(leaving, () => {
    apply()
    follow(replace, navState)
  })
}

/** `navState` goes with the step in the history (`{ fresh: true }`: the cursor into the title of a new note). */
export function openNoteInNewTab(note: string, folder?: string, navState?: unknown): void {
  change((state) => rules.openInNewTab(state, note, folder), () => tabs.openInNewTab(note, folder), false, navState)
}

export function openNoteBeside(note: string, folder?: string): void {
  change((state) => rules.openBeside(state, note, folder), () => tabs.openBeside(note, folder), false)
}

export function showTab(key: string): void {
  change((state) => rules.show(state, key), () => tabs.show(key), false)
}

export function closeTab(key: string): void {
  change((state) => rules.closeTab(state, key), () => tabs.close(key), true)
}

/** A tab whose note was just deleted here closes without asking. */
export function closeDeletedTab(key: string): void {
  tabs.close(key)
  follow(true)
}

export function endSplit(): void {
  change(rules.endSplit, tabs.endSplit, true)
}

export function focusSide(side: Side): void {
  tabs.focus(side)
  follow(true)
}

export function stepTab(step: 1 | -1): void {
  const key = rules.neighbour(tabsNow(), step)
  if (key) showTab(key)
}

export function nthTab(index: number): void {
  const tab = tabsNow().tabs[index]
  if (tab) showTab(tab.key)
}

export function otherSide(): void {
  const state = tabsNow()
  if (state.right) focusSide(rules.focusSide(state) === 'left' ? 'right' : 'left')
}

export function closeFocusedTab(): void {
  const key = focusedKey(tabsNow())
  if (key) closeTab(key)
}
