/**
 * NOTES-12 who else is in a note: initials and "… sind auch hier" (AC-5), a colour of one's own per person from a
 * fixed row, never honey, one's own honey (AC-6), four initials and "+n" (EC-6), one's other window (EC-8).
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

import i18n from '../i18n'
import { caretLook, colorFor, OWN_COLOR, PERSON_COLORS, presenceFromAwareness, presenceOf, presenceSentence } from './presence'
import { PresenceBar } from './PresenceBar'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)

function states(entries: Array<[number, number, string]>): Map<number, Record<string, unknown>> {
  return new Map(entries.map(([client, accountId, name]) => [client, { user: { accountId, name, color: colorFor(accountId) } }]))
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

describe('presence', () => {
  it('NOTES-12 AC-6 every person has a colour of their own from a fixed row, never honey, the same each time', () => {
    expect(PERSON_COLORS.map((color) => color.toLowerCase())).not.toContain(OWN_COLOR)
    expect(PERSON_COLORS.some((color) => /f2c14e|fb923c/i.test(color))).toBe(false)
    for (let account = 1; account < 200; account++) {
      expect(PERSON_COLORS).toContain(colorFor(account))
      expect(colorFor(account)).toBe(colorFor(account))
    }
    const seen = new Set(Array.from({ length: PERSON_COLORS.length }, (_, index) => colorFor(index + 1)))
    expect(seen.size).toBe(PERSON_COLORS.length)
    // Another's caret in their colour with their name; one's own other window in honey.
    expect(caretLook({ accountId: 7, name: 'Anna' }, 1, 'you, other window')).toEqual({ color: colorFor(7), label: 'Anna' })
    expect(caretLook({ accountId: 1, name: 'Me' }, 1, 'you, other window')).toEqual({ color: OWN_COLOR, label: 'you, other window' })
    // One's own caret in the text is honey.
    type Files = { readFileSync: (file: string, encoding: string) => string }
    const fsName = 'node:fs'
    return import(/* @vite-ignore */ fsName).then((fs) => {
      expect((fs as Files).readFileSync('src/editor/editor.css', 'utf-8')).toMatch(/caret-color: var\(--color-accent-500\)/)
    })
  })

  it('NOTES-12 AC-5 the others at the top: initials and who is here too', async () => {
    const presence = presenceOf(states([[1, 1, 'Me'], [2, 7, 'Anna'], [3, 8, 'Lena'], [4, 7, 'Anna']]), 1, 1)
    expect(presence.people.map((person) => person.name)).toEqual(['Anna', 'Lena'])
    expect(presenceSentence(presence, t)).toBe('Anna and Lena are here too')
    expect(presenceSentence(presenceOf(states([[2, 7, 'Anna']]), 1, 1), t)).toBe('Anna is here too')
    const box = document.createElement('div')
    const root = createRoot(box)
    await act(async () => root.render(<PresenceBar presence={presence} />))
    expect(Array.from(box.querySelectorAll('[data-testid="presence-person"]')).map((node) => node.textContent)).toEqual(['A', 'L'])
    expect(box.textContent).toContain('Anna and Lena are here too')
    await act(async () => root.unmount())
  })

  it('NOTES-12 EC-6 more than five people: four initials and "+n"', async () => {
    const entries: Array<[number, number, string]> = [[1, 1, 'Me']]
    for (let i = 0; i < 6; i++) entries.push([10 + i, 20 + i, `Person ${i}`])
    const presence = presenceOf(states(entries), 1, 1)
    const box = document.createElement('div')
    const root = createRoot(box)
    await act(async () => root.render(<PresenceBar presence={presence} />))
    expect(box.querySelectorAll('[data-testid="presence-person"]')).toHaveLength(4)
    expect(box.querySelector('[data-testid="presence-more"]')?.textContent).toBe('+2')
    expect(presenceSentence(presence, t)).toBe('Person 0, Person 1 and 4 others are here too')
    // Five people in all (four others): four initials, no "+n".
    await act(async () => root.render(<PresenceBar presence={presenceOf(states(entries.slice(0, 5)), 1, 1)} />))
    expect(box.querySelectorAll('[data-testid="presence-person"]')).toHaveLength(4)
    expect(box.querySelector('[data-testid="presence-more"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('NOTES-12 EC-8 the same person in two windows sees the other window as "you, other window", not as somebody else', async () => {
    const one = new Awareness(new Y.Doc())
    one.setLocalStateField('user', { accountId: 1, name: 'Me', color: colorFor(1) })
    const remote = new Map(one.getStates())
    remote.set(999, { user: { accountId: 1, name: 'Me', color: colorFor(1) } })
    const presence = presenceOf(remote as Map<number, Record<string, unknown>>, one.clientID, 1)
    expect(presence.people).toEqual([])
    expect(presence.ownWindows).toBe(1)
    expect(presenceFromAwareness(one, 1)).toEqual({ people: [], ownWindows: 0 })
    const box = document.createElement('div')
    const root = createRoot(box)
    await act(async () => root.render(<PresenceBar presence={presence} />))
    expect(box.querySelector('[data-testid="presence-own"]')?.textContent).toBe('you, other window')
    expect(box.querySelector('[data-testid="presence-person"]')).toBeNull()
    await act(async () => root.unmount())
    one.destroy()
  })
})
