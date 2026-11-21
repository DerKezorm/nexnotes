/**
 * Who else has the note open (NOTES-12 AC-5, AC-6, EC-6, EC-8).
 *
 * Every person has a colour of their own from a fixed row, never honey. One's own caret is honey. A second window of
 * the same account is not somebody else: it shows as "du, anderes Fenster", in honey too. The same note on the other
 * side of the same window is no other window (fifth review): each editor's state names its window (`window`, a number
 * of this page load, not the browser tab's `X-Nexnotes-Client`, which a duplicated browser tab keeps), and a state of
 * one's own account from one's own window is left out.
 *
 * How a colour is given (`colorsFor`): every account has its place in the row, its id modulo the row's length. Everyone
 * in the note, oneself included, is taken in the order of their account ids; who finds their place taken (ids 1 and 9)
 * takes the next free one along the row. So, up to eight people in a note, nobody shares a colour; everybody sees the
 * same colour for the same person, since every window counts the same people; and a person keeps their colour in every
 * note where nobody with a lower id shares their place, which with a handful of people is nearly always. A colour
 * changes only while such a person comes or goes.
 */
import type { Awareness } from 'y-protocols/awareness'

/** Honey: one's own caret and one's own other windows. */
export const OWN_COLOR = '#f2c14e'
/** The fixed row for the others. No honey, no orange (orange says "warning" in nexnotes). */
export const PERSON_COLORS = ['#60a5fa', '#4ade80', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#2dd4bf', '#a3e635'] as const
/** Initials shown at the top before the rest is counted as "+n". */
export const SHOWN_PEOPLE = 4

/** The colour of every account in one note (see above). Beyond eight people, colours repeat. */
export function colorsFor(accountIds: Iterable<number>): Map<number, string> {
  const ids = [...new Set(accountIds)].filter((id) => Number.isFinite(id)).sort((a, b) => a - b)
  const size = PERSON_COLORS.length
  const taken = new Set<number>()
  const colors = new Map<number, string>()
  for (const id of ids) {
    if (taken.size >= size) taken.clear() // the ninth person starts the row again
    const place = Math.abs(Math.trunc(id)) % size
    let slot = place
    for (let step = 1; taken.has(slot); step++) slot = (place + step) % size
    taken.add(slot)
    colors.set(id, PERSON_COLORS[slot])
  }
  return colors
}

/** One account's colour among the others in the note (`present`, oneself included or not). */
export function colorFor(accountId: number, present: Iterable<number> = []): string {
  return colorsFor([...present, accountId]).get(accountId) ?? PERSON_COLORS[0]
}

/** Every account in the note, from the awareness states (one's own window included). */
export function presentAccounts(awareness: Awareness): number[] {
  return accountsOf(awareness.getStates() as Map<number, Record<string, unknown>>)
}

function accountsOf(states: Map<number, Record<string, unknown>>): number[] {
  const ids: number[] = []
  for (const state of states.values()) {
    const user = state?.user as Partial<PresenceUser> | undefined
    if (user && typeof user.accountId === 'number') ids.push(user.accountId)
  }
  return ids
}

export function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase()
}

/** This window: drawn anew with every page load, never shared with another browser tab. */
export const WINDOW_ID = randomWindow()

function randomWindow(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What a window tells the others about itself. */
export type PresenceUser = { name: string; accountId: number; color: string; avatar?: string | null; window?: string }

export function presenceUser(accountId: number, name: string, avatar: string | null = null): PresenceUser {
  return { name, accountId, color: colorFor(accountId), avatar, window: WINDOW_ID }
}

/** Another editor of one's own in this very window (the same note on the other side): no presence at all. */
export function sameWindow(user: Partial<PresenceUser> | undefined, ownAccount: number, ownWindow = WINDOW_ID): boolean {
  return Boolean(user && user.accountId === ownAccount && typeof user.window === 'string' && user.window === ownWindow)
}

export type Person = { accountId: number; name: string; color: string; initial: string; avatar?: string | null }
export type Presence = {
  /** Other people, each once however many windows they have open, in the order they came. */
  people: Person[]
  /** Other windows of one's own account. */
  ownWindows: number
}

/** The others in the note, from the awareness states (one's own state left out, and the other editors of one's own
 * window). */
export function presenceOf(states: Map<number, Record<string, unknown>>, ownClient: number, ownAccount: number, ownWindow = WINDOW_ID): Presence {
  const people = new Map<number, Person>()
  const colors = colorsFor([ownAccount, ...accountsOf(states)])
  let ownWindows = 0
  for (const [client, state] of states) {
    if (client === ownClient) continue
    const user = state?.user as Partial<PresenceUser> | undefined
    if (!user || typeof user.accountId !== 'number') continue
    if (sameWindow(user, ownAccount, ownWindow)) continue
    if (user.accountId === ownAccount) {
      ownWindows++
      continue
    }
    if (!people.has(user.accountId)) {
      const name = String(user.name ?? '').trim() || '?'
      const avatar = typeof user.avatar === 'string' ? user.avatar : null
      people.set(user.accountId, { accountId: user.accountId, name, color: colors.get(user.accountId) ?? colorFor(user.accountId), initial: initialOf(name), avatar })
    }
  }
  return { people: [...people.values()], ownWindows }
}

export function presenceFromAwareness(awareness: Awareness, ownAccount: number): Presence {
  return presenceOf(awareness.getStates() as Map<number, Record<string, unknown>>, awareness.clientID, ownAccount)
}

/** How a caret of someone else looks to this window: its colour among those `present` and its label. The caret of the
 * same note on the other side of this window has no label: it is no other window. */
export function caretLook(user: Partial<PresenceUser>, ownAccount: number, otherWindow: string, present: Iterable<number> = [], ownWindow = WINDOW_ID): { color: string; label: string } {
  if (sameWindow(user, ownAccount, ownWindow)) return { color: OWN_COLOR, label: '' }
  if (user.accountId === ownAccount) return { color: OWN_COLOR, label: otherWindow }
  return { color: typeof user.accountId === 'number' ? colorFor(user.accountId, [ownAccount, ...present]) : PERSON_COLORS[0], label: String(user.name ?? '?') }
}

/** "Anna ist auch hier", "Anna und Lena sind auch hier", "Anna, Lena und 3 weitere sind auch hier". */
export function presenceSentence(presence: Presence, t: (key: string, values?: Record<string, unknown>) => string): string {
  const names = presence.people.map((person) => person.name)
  if (names.length === 0) return ''
  if (names.length === 1) return t('presence.one', { name: names[0] })
  if (names.length === 2) return t('presence.two', { first: names[0], second: names[1] })
  return t('presence.many', { first: names[0], second: names[1], count: names.length - 2 })
}
