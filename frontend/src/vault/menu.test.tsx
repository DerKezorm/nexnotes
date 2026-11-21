/**
 * NOTES-16 in the note's menu: "Sperren" for the owner's own note, "Sperre aufheben" for an open locked note,
 * nothing for a note of somebody else (NOTES-13 EC-3: a shared note cannot be locked) or one only read.
 */
import { act, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { NOTE_MENU_ITEMS, type NoteMenuContext } from '../editor/noteParts'
import i18n from '../i18n'
import type { NoteHead } from '../notes/api'
import { VAULT_DIALOG_EVENT } from './register'

let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

const HEAD = { id: 'n1', title: 'Haushalt', can_write: true, deleted_at: null, owner: { id: 1, name: 'Me' } } as unknown as NoteHead

function draw(context: Partial<NoteMenuContext>) {
  const full: NoteMenuContext = { noteId: 'n1', head: HEAD, sealed: false, mine: true, close: () => undefined, ...context }
  act(() => root.render(<>{NOTE_MENU_ITEMS.map((Item, index) => <Fragment key={index}><Item {...full} /></Fragment>)}</>))
}

describe('the note menu', () => {
  it('NOTES-16 AC-2 the owner locks a note; an open locked note offers to take the lock off', () => {
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(VAULT_DIALOG_EVENT, listen)
    let closed = 0
    draw({ close: () => (closed += 1) })
    expect(box.querySelector('[data-testid="note-lock"]')!.textContent).toBe('Lock')
    act(() => box.querySelector<HTMLButtonElement>('[data-testid="note-lock"]')!.click())
    expect(asked).toEqual([{ kind: 'lock', noteId: 'n1' }])
    expect(closed).toBe(1)
    window.removeEventListener(VAULT_DIALOG_EVENT, listen)
    draw({ sealed: true })
    expect(box.querySelector('[data-testid="note-unlock"]')!.textContent).toBe('Remove lock')
    expect(box.querySelector('[data-testid="note-lock"]')).toBeNull()
  })

  it('NOTES-16 AC-2 nothing to lock in a note of somebody else, one only read or one in the trash', () => {
    draw({ mine: false })
    expect(box.textContent).toBe('')
    draw({ head: { ...HEAD, can_write: false } })
    expect(box.textContent).toBe('')
    draw({ head: { ...HEAD, deleted_at: '2026-11-21T08:00:00Z' } })
    expect(box.textContent).toBe('')
  })
})
