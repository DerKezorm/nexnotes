/**
 * Who else has the note open (NOTES-12 AC-5, AC-6, EC-6, EC-8).
 *
 * Every person has a colour of their own from a fixed row, never honey. One's own caret is honey. A second window of
 * the same account is not somebody else: it shows as "du, anderes Fenster", in honey too.
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

/** What a window tells the others about itself. */
export type PresenceUser = { name: string; accountId: number; color: string }

export function presenceUser(accountId: number, name: string): PresenceUser {
  return { name, accountId, color: colorFor(accountId) }
}

export type Person = { accountId: number; name: string; color: string; initial: string }
export type Presence = {
  /** Other people, each once however many windows they have open, in the order they came. */
  people: Person[]
  /** Other windows of one's own account. */
  ownWindows: number
}

/** The others in the note, from the awareness states (one's own state left out). */
export function presenceOf(states: Map<number, Record<string, unknown>>, ownClient: number, ownAccount: number): Presence {
  const people = new Map<number, Person>()
  const colors = colorsFor([ownAccount, ...accountsOf(states)])
  let ownWindows = 0
  for (const [client, state] of states) {
    if (client === ownClient) continue
    const user = state?.user as Partial<PresenceUser> | undefined
    if (!user || typeof user.accountId !== 'number') continue
    if (user.accountId === ownAccount) {
      ownWindows++
      continue
    }
    if (!people.has(user.accountId)) {
      const name = String(user.name ?? '').trim() || '?'
      people.set(user.accountId, { accountId: user.accountId, name, color: colors.get(user.accountId) ?? colorFor(user.accountId), initial: initialOf(name) })
    }
  }
  return { people: [...people.values()], ownWindows }
}

export function presenceFromAwareness(awareness: Awareness, ownAccount: number): Presence {
  return presenceOf(awareness.getStates() as Map<number, Record<string, unknown>>, awareness.clientID, ownAccount)
}

/** How a caret of someone else looks to this window: its colour among those `present` and its label. */
export function caretLook(user: Partial<PresenceUser>, ownAccount: number, otherWindow: string, present: Iterable<number> = []): { color: string; label: string } {
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
