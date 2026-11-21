/**
 * The rules of the open tabs and the two sides (NOTES-8), as plain functions over a plain value: what opening,
 * closing and moving do, which tab goes when a seventh one comes, and how the value is kept on the device.
 *
 * - A tab has a key of its own, so that the same note can stand on both sides (EC-1).
 * - `left` and `right` are the tabs on show; `focus` is the side used last (the address names its note).
 * - `used` is a running number: the tab with the smallest one is the one not used for the longest (AC-7).
 */

export const MAX_TABS = 6
/** The share of the left side, kept between these. The panes themselves never go below `MIN_PANE` pixels. */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8

export type Side = 'left' | 'right'
export type Tab = { key: string; note: string; folder?: string; used: number }
export type TabsState = {
  tabs: Tab[]
  left: string | null
  right: string | null
  focus: Side
  ratio: number
  seq: number
}
/** A change, and the tab it pushed out (AC-7), if any. */
export type Step = { state: TabsState; closed?: Tab }

export const EMPTY: TabsState = { tabs: [], left: null, right: null, focus: 'left', ratio: 0.5, seq: 0 }

let counter = 0
export function newKey(): string {
  counter += 1
  return `t${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function tabOf(state: TabsState, key: string | null): Tab | undefined {
  return key ? state.tabs.find((tab) => tab.key === key) : undefined
}

/** The side used last; the left one when there is no right. */
export function focusSide(state: TabsState): Side {
  return state.focus === 'right' && state.right ? 'right' : 'left'
}

export function focusedKey(state: TabsState): string | null {
  return focusSide(state) === 'right' ? state.right : state.left
}

export function visibleKeys(state: TabsState): string[] {
  return [state.left, state.right].filter((key): key is string => Boolean(key))
}

function sideOf(state: TabsState, key: string): Side | null {
  if (state.left === key) return 'left'
  if (state.right === key) return 'right'
  return null
}

function touch(state: TabsState, key: string, folder?: string): TabsState {
  const seq = state.seq + 1
  return { ...state, seq, tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, used: seq, ...(folder !== undefined ? { folder: folder || undefined } : {}) } : tab)) }
}

function place(state: TabsState, side: Side, key: string): TabsState {
  return side === 'right' ? { ...state, right: key, focus: 'right' } : { ...state, left: key, focus: 'left' }
}

/** More than six: the tab not used for the longest goes, never one on show (AC-7). */
function evict(state: TabsState): Step {
  let next = state
  let closed: Tab | undefined
  while (next.tabs.length > MAX_TABS) {
    const keep = visibleKeys(next)
    const candidates = next.tabs.filter((tab) => !keep.includes(tab.key))
    if (!candidates.length) break
    const oldest = candidates.reduce((a, b) => (b.used < a.used ? b : a))
    closed = oldest
    next = { ...next, tabs: next.tabs.filter((tab) => tab.key !== oldest.key) }
  }
  return { state: next, closed }
}

function insertAfter(state: TabsState, tab: Tab, after: string | null): TabsState {
  const index = after ? state.tabs.findIndex((one) => one.key === after) : -1
  const tabs = [...state.tabs]
  if (index < 0) tabs.push(tab)
  else tabs.splice(index + 1, 0, tab)
  return { ...state, tabs }
}

/** Shows a tab: on its side if it is on show already, otherwise on the side used last. */
export function show(state: TabsState, key: string, folder?: string): TabsState {
  if (!tabOf(state, key)) return state
  const side = sideOf(state, key)
  if (side) return touch({ ...state, focus: side }, key, folder)
  if (!state.left) return touch(place(state, 'left', key), key, folder)
  return touch(place(state, focusSide(state), key), key, folder)
}

/**
 * A note opened the ordinary way (the list, a link, the search, the address): its tab if it has one, otherwise in
 * place of the note on the side used last, as a click on a title in the drawing "N8-Tabs-Probe" does.
 */
export function openHere(state: TabsState, note: string, folder?: string): Step {
  const current = tabOf(state, focusedKey(state))
  if (current?.note === note) return { state: touch(state, current.key, folder) }
  const other = [state.left, state.right].map((key) => tabOf(state, key)).find((tab) => tab?.note === note)
  if (other) return { state: show(state, other.key, folder) }
  const existing = state.tabs.find((tab) => tab.note === note)
  if (existing) return { state: show(state, existing.key, folder) }
  if (current) {
    const seq = state.seq + 1
    const key = newKey()
    const tabs = state.tabs.map((tab) => (tab.key === current.key ? { key, note, folder: folder || undefined, used: seq } : tab))
    return { state: { ...state, seq, tabs, [focusSide(state)]: key } }
  }
  return openInNewTab(state, note, folder)
}

/** "In neuem Tab" (also the middle button, Ctrl or ⌘ with a click): a tab of its own, shown on the side used last (AC-3). */
export function openInNewTab(state: TabsState, note: string, folder?: string): Step {
  const existing = state.tabs.find((tab) => tab.note === note)
  if (existing) return { state: show(state, existing.key, folder) }
  const seq = state.seq + 1
  const tab: Tab = { key: newKey(), note, folder: folder || undefined, used: seq }
  let next = insertAfter({ ...state, seq }, tab, focusedKey(state))
  next = place(next, state.left ? focusSide(state) : 'left', tab.key)
  return evict(next)
}

/** "Daneben öffnen", or dragged to the right edge: the note on the right side, the other one stays left (AC-1). The
 * same note may stand on both sides (EC-1). */
export function openBeside(state: TabsState, note: string, folder?: string): Step {
  if (!state.left) return openInNewTab(state, note, folder)
  const right = tabOf(state, state.right)
  if (right?.note === note) return { state: touch({ ...state, focus: 'right' }, right.key, folder) }
  const hidden = state.tabs.find((tab) => tab.note === note && !visibleKeys(state).includes(tab.key))
  if (hidden) return { state: touch(place(state, 'right', hidden.key), hidden.key, folder) }
  const seq = state.seq + 1
  const tab: Tab = { key: newKey(), note, folder: folder || undefined, used: seq }
  const next = place(insertAfter({ ...state, seq }, tab, state.right ?? state.left), 'right', tab.key)
  return evict(next)
}

/** Closes a tab. A tab on the left is followed by the right one, or else by the tab used last. */
export function closeTab(state: TabsState, key: string): TabsState {
  if (!tabOf(state, key)) return state
  const tabs = state.tabs.filter((tab) => tab.key !== key)
  let { left, right, focus } = state
  if (key === right) {
    right = null
    focus = 'left'
  } else if (key === left) {
    if (right) {
      left = right
      right = null
    } else {
      left = tabs.length ? tabs.reduce((a, b) => (b.used > a.used ? b : a)).key : null
    }
    focus = 'left'
  }
  return { ...state, tabs, left, right, focus }
}

/** "Nebeneinander beenden": the right tab stays a tab, the left one is alone on show. */
export function endSplit(state: TabsState): TabsState {
  return state.right ? { ...state, right: null, focus: 'left' } : state
}

export function setFocus(state: TabsState, side: Side): TabsState {
  if (side === 'right' && !state.right) return state
  const key = side === 'right' ? state.right : state.left
  return key ? touch({ ...state, focus: side }, key) : state
}

/** Moves a tab to another place in the row. */
export function moveTab(state: TabsState, key: string, to: number): TabsState {
  const from = state.tabs.findIndex((tab) => tab.key === key)
  if (from < 0) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab)
  return { ...state, tabs }
}

export function setRatio(state: TabsState, ratio: number): TabsState {
  if (!Number.isFinite(ratio)) return state
  return { ...state, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) }
}

/** The neighbour of the tab on the side used last, in the row's order (the keys for the next and the previous tab). */
export function neighbour(state: TabsState, step: 1 | -1): string | null {
  if (!state.tabs.length) return null
  const index = state.tabs.findIndex((tab) => tab.key === focusedKey(state))
  const next = (index + step + state.tabs.length) % state.tabs.length
  return state.tabs[index < 0 ? 0 : next].key
}

/** Keeps a note's tabs, after it was deleted for good or a tab points at it no more: every tab of it goes. */
export function closeNote(state: TabsState, note: string): TabsState {
  return state.tabs.filter((tab) => tab.note === note).reduce((next, tab) => closeTab(next, tab.key), state)
}

// ---- Kept on the device (AC-5) ----------------------------------------------------------------------------------

export function serialize(state: TabsState): string {
  return JSON.stringify({ v: 1, ...state })
}

/** Reads what was kept; anything odd counts as no tabs at all. */
export function parse(text: string | null): TabsState {
  if (!text) return EMPTY
  try {
    const raw = JSON.parse(text) as Partial<TabsState> & { v?: number }
    if (raw.v !== 1 || !Array.isArray(raw.tabs)) return EMPTY
    const seen = new Set<string>()
    const tabs: Tab[] = []
    for (const one of raw.tabs.slice(0, MAX_TABS)) {
      if (!one || typeof one.key !== 'string' || typeof one.note !== 'string' || !one.note || seen.has(one.key)) continue
      seen.add(one.key)
      tabs.push({ key: one.key, note: one.note, folder: typeof one.folder === 'string' && one.folder ? one.folder : undefined, used: Number(one.used) || 0 })
    }
    const has = (key: unknown) => typeof key === 'string' && seen.has(key)
    let left = has(raw.left) ? (raw.left as string) : null
    let right = has(raw.right) && raw.right !== raw.left ? (raw.right as string) : null
    if (!left && right) {
      left = right
      right = null
    }
    if (!left && tabs.length) left = tabs.reduce((a, b) => (b.used > a.used ? b : a)).key
    const seq = Math.max(Number(raw.seq) || 0, ...tabs.map((tab) => tab.used))
    const ratio = Number(raw.ratio)
    return {
      tabs,
      left,
      right,
      focus: raw.focus === 'right' && right ? 'right' : 'left',
      ratio: Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 0.5,
      seq,
    }
  } catch {
    return EMPTY
  }
}
