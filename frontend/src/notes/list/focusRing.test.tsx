/** NOTES-6, review of 21.11.2026: the keyboard's focus ring goes round the whole row or tile, not a part. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { NoteRow } from './NoteRow'
import { NoteTile } from './NoteTile'

const item = { id: 'n1', folder_id: 'f', title: 'Groceries', title_check: false, origin: '', preview: 'milk', created_at: '2026-11-21T08:00:00Z', updated_at: '2026-11-21T08:00:00Z' }

describe('the focus ring of the list', () => {
  it('NOTES-6 AC-2 AC-3 sits on the outer element with its rounding, for the keyboard only', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const box = document.createElement('div')
    document.body.append(box)
    const root = createRoot(box)
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NoteRow item={item} href="/notes/n1" chosen={false} date="8:00" onOpen={() => undefined} onMenu={() => undefined} />
          <NoteTile item={item} href="/notes/n1" chosen={false} date="8:00" onOpen={() => undefined} onMenu={() => undefined} />
        </MemoryRouter>,
      ),
    )
    const row = box.querySelector<HTMLElement>('[data-testid="note-row-box"]')!
    expect(row.className).toContain('rounded-[10px]')
    expect(row.className).toContain('has-[a:focus-visible]:outline-2')
    const link = box.querySelector<HTMLElement>('[data-testid="note-row"]')!
    expect(link.className).toContain('focus-visible:outline-none')
    expect(row.contains(link)).toBe(true)
    const tile = box.querySelector<HTMLElement>('[data-testid="note-tile"]')!
    expect(tile.className).toContain('rounded-[12px]')
    expect(tile.className).toContain('focus-visible:outline-2')
    expect(tile.className).not.toMatch(/(^| )outline-2/)
    await act(async () => root.unmount())
    box.remove()
  })
})
