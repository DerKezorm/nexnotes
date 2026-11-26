/**
 * A note into nexlore (module verbinden, Runde 2 V19): "An nexlore" in the note's menu only while nexlore is connected
 * with a click, never for a locked note; the dialog offers nexlore's spaces and sends the note to the one chosen.
 * The server's side is in `backend/tests/test_nexlore_send.py`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { NoteHead } from '../notes/api'
import i18n from '../i18n'
import { forgetNexlore } from './api'
import { NexloreHost, NoteNexloreItem } from './SendToNexlore'

let root: Root
let box: HTMLDivElement
let connected: boolean
let calls: { method: string; path: string; body: unknown }[]

const head = (extra: Partial<NoteHead> = {}) => ({ id: 'n1', title: 'Plan', can_write: true, ...extra }) as unknown as NoteHead

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

const $ = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  forgetNexlore()
  connected = true
  calls = []
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = path === '/api/nexlore/send' ? { sent: true, path: 'Arbeit/Plan.md' } : { connected, spaces: connected ? [{ id: 'Wissen', name: 'Wissen' }, { id: 'Arbeit', name: 'Arbeit' }] : [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('a note into nexlore', () => {
  it('offers "An nexlore" only while nexlore is connected, and never for a locked note', async () => {
    await act(async () => root.render(<NoteNexloreItem noteId="n1" head={head()} sealed={false} mine close={() => undefined} />))
    await settle()
    expect($('note-nexlore')!.textContent).toContain(i18n.t('nexlore.menu'))
    await act(async () => root.render(<NoteNexloreItem noteId="n1" head={head({ locked: true })} sealed={false} mine close={() => undefined} />))
    await settle()
    expect($('note-nexlore')).toBeNull()
    forgetNexlore()
    connected = false
    await act(async () => root.unmount())
    root = createRoot(box)
    await act(async () => root.render(<NoteNexloreItem noteId="n1" head={head()} sealed={false} mine close={() => undefined} />))
    await settle()
    expect($('note-nexlore')).toBeNull()
  })

  it('sends the note to the space chosen', async () => {
    await act(async () => root.render(<><NoteNexloreItem noteId="n1" head={head()} sealed={false} mine close={() => undefined} /><NexloreHost /></>))
    await settle()
    await act(async () => $('note-nexlore')!.click())
    await settle()
    const select = $('nexlore-space') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['Wissen', 'Arbeit'])
    await act(async () => {
      select.value = 'Arbeit'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => $('nexlore-send')!.click())
    await settle()
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ path: '/api/nexlore/send', body: { note_id: 'n1', space: 'Arbeit' } })
    expect($('nexlore-dialog')).toBeNull()
  })
})
