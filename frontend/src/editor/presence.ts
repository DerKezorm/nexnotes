/**
 * Who else has the note open (NOTES-12 AC-5, AC-6, EC-6, EC-8).
 *
 * Every person has a colour of their own from a fixed row, never honey, the same in every window and every note (it
 * follows the account). One's own caret is honey. A second window of the same account is not somebody else: it shows
 * as "du, anderes Fenster", in honey too.
 */
import type { Awareness } from 'y-protocols/awareness'

/** Honey: one's own caret and one's own other windows. */
export const OWN_COLOR = '#f2c14e'
/** The fixed row for the others. No honey, no orange (orange says "warning" in nexnotes). */
export const PERSON_COLORS = ['#60a5fa', '#4ade80', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#2dd4bf', '#a3e635'] as const
/** Initials shown at the top before the rest is counted as "+n". */
export const SHOWN_PEOPLE = 4

export function colorFor(accountId: number): string {
  return PERSON_COLORS[Math.abs(Math.trunc(accountId)) % PERSON_COLORS.length]
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
      people.set(user.accountId, { accountId: user.accountId, name, color: colorFor(user.accountId), initial: initialOf(name) })
    }
  }
  return { people: [...people.values()], ownWindows }
}

export function presenceFromAwareness(awareness: Awareness, ownAccount: number): Presence {
  return presenceOf(awareness.getStates() as Map<number, Record<string, unknown>>, awareness.clientID, ownAccount)
}

/** How a caret of someone else looks to this window: its colour and its label. */
export function caretLook(user: Partial<PresenceUser>, ownAccount: number, otherWindow: string): { color: string; label: string } {
  if (user.accountId === ownAccount) return { color: OWN_COLOR, label: otherWindow }
  return { color: typeof user.accountId === 'number' ? colorFor(user.accountId) : PERSON_COLORS[0], label: String(user.name ?? '?') }
}

/** "Anna ist auch hier", "Anna und Lena sind auch hier", "Anna, Lena und 3 weitere sind auch hier". */
export function presenceSentence(presence: Presence, t: (key: string, values?: Record<string, unknown>) => string): string {
  const names = presence.people.map((person) => person.name)
  if (names.length === 0) return ''
  if (names.length === 1) return t('presence.one', { name: names[0] })
  if (names.length === 2) return t('presence.two', { first: names[0], second: names[1] })
  return t('presence.many', { first: names[0], second: names[1], count: names.length - 2 })
}
