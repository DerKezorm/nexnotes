/**
 * NOTES-3 and NOTES-12 on the page: a new note opens with the cursor in the title (AC-1), a double click makes one
 * note (EC-9), the line under the title (AC-8, NOTES-12 AC-9), leaving without a title (AC-9, EC-4), "Titel prüfen"
 * and "Titel ok" (AC-10, EC-12), deleting with "Undo" (AC-6), duplicating (AC-7), the title's limits (EC-5, EC-7).
 *
 * A small stand-in for the server answers the notes routes, and one for the live room answers the y-websocket sync
 * with its own Yjs document per note.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { MAX_TITLE, cleanTitle, suggestTitle } from '../editor/title'
import { forgetFolders } from '../folders/store'
import { hideNotice, UNDO_MS } from '../folders/notice'
import i18n from '../i18n'
import { AuthProvider } from '../state/auth'
import type { NoteHead } from './api'
import { tryLeave } from './context'
import { NotesPage } from './NotesPage'
import { NewNoteButton } from './register'

// ---- The stand-in server -------------------------------------------------------------------------------------------

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let notes: Map<string, NoteHead>
const rooms = new Map<string, Y.Doc>()
let createDelay = 0
const INBOX = 'inbox-1'
const NOW = new Date().toISOString()

function note(id: string, extra: Partial<NoteHead> = {}): NoteHead {
  return {
    id,
    folder_id: INBOX,
    title: '',
    title_check: false,
    origin: '',
    preview: '',
    created_at: '2026-11-14T08:00:00Z',
    updated_at: NOW,
    path: [{ id: INBOX, name: '', kind: 'inbox', inbox: true }],
    updated_by: { id: 1, name: 'Me' },
    owner: { id: 1, name: 'Me' },
    deleted_at: null,
    can_write: true,
    ...extra,
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function answer(call: Call): Promise<Response> {
  const { method, path, body } = call
  if (path === '/api/setup') return reply(200, { needs_setup: false, signed_in: true, version: '1', min_password: 12, code_required: false })
  if (path === '/api/auth/me') return reply(200, { id: 1, name: 'me', display_name: 'Me', role: 'member', language: 'en', version: '1', whats_new_seen: '1' })
  if (path === '/api/folders') return reply(200, { inbox: { id: INBOX, count: notes.size }, folders: [{ id: 'garden', name: 'Garden', parent_id: null, icon: '', color: '', position: null, count: 0 }] })
  if (method === 'GET' && path === '/api/notes') return reply(200, [...notes.values()].filter((n) => !n.deleted_at))
  // The list of NOTES-6: the same notes, with a view and the counts.
  if (method === 'GET' && path === '/api/note-list') {
    const alive = [...notes.values()].filter((n) => !n.deleted_at)
    return reply(200, { key: 'all', view: { mode: 'list', sort: 'updated', direction: 'desc', grouped: true }, counts: { own: alive.length, shared: 0 }, items: alive })
  }
  if (method === 'GET' && path === '/api/note-list/stamp') return reply(200, { stamp: String(notes.size) })
  if (method === 'POST' && path === '/api/notes') {
    if (createDelay) await new Promise((resolve) => setTimeout(resolve, createDelay))
    const id = String(body?.id)
    const existing = notes.get(id)
    if (existing) return reply(200, existing)
    const made = note(id, { folder_id: String(body?.folder_id ?? INBOX) })
    notes.set(id, made)
    return reply(201, made)
  }
  const one = /^\/api\/notes\/([^/]+)(\/.*)?$/.exec(path)
  if (one) {
    const [, id, tail = ''] = one
    const found = notes.get(id)
    if (!found) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET' && !tail) return reply(200, found)
    if (method === 'POST' && tail === '/title/suggestion') {
      const title = String(body?.title ?? '')
      notes.set(id, { ...found, title, title_check: true })
      return reply(200, notes.get(id))
    }
    if (method === 'POST' && tail === '/title/ok') {
      notes.set(id, { ...found, title_check: false })
      return reply(200, notes.get(id))
    }
    if (method === 'POST' && tail === '/duplicate') {
      const copy = note(`${id}-copy`, { title: `${found.title} (Copy)`, folder_id: found.folder_id })
      notes.set(copy.id, copy)
      return reply(201, copy)
    }
    if (method === 'DELETE') {
      notes.set(id, { ...found, deleted_at: NOW })
      return reply(204, null)
    }
    if (method === 'POST' && tail === '/restore') {
      notes.set(id, { ...found, deleted_at: null })
      return reply(200, notes.get(id))
    }
    if (method === 'POST' && tail === '/discard') {
      notes.delete(id)
      return reply(200, { discarded: true })
    }
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

// ---- The stand-in room ---------------------------------------------------------------------------------------------

class RoomSocket {
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  doc: Y.Doc
  constructor(url: string) {
    const id = decodeURIComponent(/\/api\/notes\/([^/]+)\/live/.exec(url)![1])
    if (!rooms.has(id)) rooms.set(id, new Y.Doc())
    this.doc = rooms.get(id)!
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.deliver(encoding.toUint8Array(encoder))
    }, 0)
  }
  deliver(data: Uint8Array) {
    this.onmessage?.({ data: data.slice().buffer } as MessageEvent)
  }
  send(data: Uint8Array) {
    const decoder = decoding.createDecoder(data)
    if (decoding.readVarUint(decoder) !== 0) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 0)
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'room')
    if (encoding.length(encoder) > 1) {
      const out = encoding.toUint8Array(encoder)
      setTimeout(() => this.deliver(out), 0)
    }
  }
  close() {
    this.readyState = 3
  }
}

// ---- Rendering -----------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement
let where = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname + location.search
  }, [location])
  return null
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render(path: string, state?: unknown): Promise<void> {
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <AuthProvider>
        <MemoryRouter initialEntries={[{ pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }]}>
          <Where />
          <NewNoteButton />
          <Routes>
            <Route path="/" element={<NotesPage />} />
            <Route path="/notes/:noteId" element={<NotesPage />} />
            <Route path="/folder/:id" element={<div data-testid="folder-page" />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )
  })
  await settle(60)
}

const $ = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null

function typeTitle(value: string) {
  const input = $('note-title') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function bodyOf(id: string): Y.XmlFragment {
  return rooms.get(id)!.getXmlFragment('body')
}

function writeInRoom(id: string, words: string) {
  // Somebody else writes: through a second document, as their browser would.
  const theirs = new Y.Doc()
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(rooms.get(id)!))
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(words)])
  theirs.getXmlFragment('body').insert(0, [paragraph])
  Y.applyUpdate(rooms.get(id)!, Y.encodeStateAsUpdate(theirs))
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
})

beforeEach(() => {
  calls = []
  notes = new Map()
  rooms.clear()
  createDelay = 0
  forgetFolders()
  vi.stubGlobal('WebSocket', RoomSocket)
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    return answer(call)
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  hideNotice()
  box?.remove()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 80))
})

// ---- The tests -----------------------------------------------------------------------------------------------------

describe('a note on the page', () => {
  it('NOTES-3 AC-1 "New note" opens an empty note at once with the cursor in the title; Enter goes into the text', async () => {
    await render('/')
    await act(async () => $('new-note')!.click())
    await settle(80)
    expect(where).toMatch(/^\/notes\/[0-9a-f-]{36}\?folder=inbox-1$|^\/notes\/[0-9a-f-]{36}$/)
    const title = $('note-title') as HTMLInputElement
    expect(title.value).toBe('')
    expect(document.activeElement).toBe(title)
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle(40)
    expect(document.activeElement?.closest('[data-testid="note-body"]')).not.toBeNull()
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/notes')).toHaveLength(1)
    // The new note goes into the inbox when no folder is open.
    expect(calls.find((call) => call.method === 'POST' && call.path === '/api/notes')?.body?.folder_id).toBe(INBOX)
  })

  it('NOTES-3 EC-9 two quick clicks on "New note" make one note', async () => {
    createDelay = 40
    await render('/')
    await act(async () => {
      $('new-note')!.click()
      $('new-note')!.click()
    })
    await settle(120)
    const made = calls.filter((call) => call.method === 'POST' && call.path === '/api/notes')
    expect(made).toHaveLength(1)
    expect(notes.size).toBe(1)
  })

  it('NOTES-3 AC-8 NOTES-12 AC-9 under the title: the path, created, changed, and by whom when it was somebody else', async () => {
    notes.set('n1', note('n1', { title: 'Bathroom', path: [{ id: 'h', name: 'Home', kind: 'normal', inbox: false }, { id: 'w', name: 'Workers', kind: 'normal', inbox: false }], updated_by: { id: 7, name: 'Anna' } }))
    await render('/notes/n1')
    const meta = $('note-meta')!.textContent ?? ''
    expect(meta).toContain('Home › Workers')
    expect(meta).toContain(`created ${new Date('2026-11-14T08:00:00Z').toLocaleDateString('en')}`)
    expect($('note-changed')!.textContent).toBe('changed just now by Anna')
    await settle(30)
    expect($('note-saved')!.textContent).toBe('saved')
    // Changed by oneself: no name.
    notes.set('n2', note('n2', { title: 'Mine' }))
    await act(async () => root.unmount())
    await render('/notes/n2')
    expect($('note-changed')!.textContent).toBe('changed just now')
  })

  it('NOTES-3 AC-9 leaving without a title asks, with a suggestion from the first words, and goes on with it', async () => {
    notes.set('n1', note('n1'))
    rooms.set('n1', new Y.Doc())
    writeInRoom('n1', 'Dentist Tuesday 15:30 confirm, bring the booklet.')
    await render('/notes/n1')
    await settle(50)
    let left = false
    await act(async () => tryLeave(() => (left = true)))
    expect(left).toBe(false)
    expect($('leave-dialog')).not.toBeNull()
    expect($('leave-suggestion')!.textContent).toBe('Dentist Tuesday 15:30 confirm')
    expect(($('note-title') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true')
    // "Enter a title": back into the field, nothing left.
    await act(async () => $('leave-type')!.click())
    expect($('leave-dialog')).toBeNull()
    expect(left).toBe(false)
    // Asked again, "Use suggestion": the server gets it as a suggestion ("Check title"), then the way out goes on.
    await act(async () => tryLeave(() => (left = true)))
    await act(async () => $('leave-take')!.click())
    await settle(20)
    expect(left).toBe(true)
    expect(calls.find((call) => call.path === '/api/notes/n1/title/suggestion')?.body).toEqual({ title: 'Dentist Tuesday 15:30 confirm' })
    // A link of the page counts as leaving too.
    notes.set('n2', note('n2'))
    rooms.set('n2', new Y.Doc())
    writeInRoom('n2', 'More text')
    await act(async () => root.unmount())
    await render('/notes/n2')
    await settle(50)
    const link = box.querySelector('a[href="/"]') as HTMLAnchorElement
    await act(async () => link.click())
    expect($('leave-dialog')).not.toBeNull()
    expect(where).toBe('/notes/n2')
  })

  it('NOTES-3 EC-4 EC-5 a note with neither title nor text is left without a question and goes', async () => {
    notes.set('n1', note('n1'))
    await render('/notes/n1')
    await settle(50)
    // A title of spaces is no title.
    typeTitle('    ')
    let left = false
    await act(async () => tryLeave(() => (left = true)))
    expect(left).toBe(true)
    expect($('leave-dialog')).toBeNull()
    await act(async () => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(calls.some((call) => call.path === '/api/notes/n1/discard')).toBe(true)
    expect(notes.has('n1')).toBe(false)
  })

  it('NOTES-3 AC-10 EC-12 "Check title" until the title changes, here or on another device, or "Title OK"', async () => {
    notes.set('n1', note('n1', { title: 'Compost in layers', title_check: true }))
    rooms.set('n1', new Y.Doc())
    rooms.get('n1')!.getText('title').insert(0, 'Compost in layers')
    await render('/notes/n1')
    await settle(50)
    expect($('title-check')?.textContent).toBe('Check title')
    // The title changes on the phone: the mark goes here too.
    const phone = new Y.Doc()
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(rooms.get('n1')!))
    phone.getText('title').insert(17, ' at home')
    Y.applyUpdate(rooms.get('n1')!, Y.encodeStateAsUpdate(phone))
    // The stand-in room passes changes on only when asked; a fresh step 1 of the editor fetches them.
    await act(async () => window.dispatchEvent(new Event('offline')))
    await act(async () => window.dispatchEvent(new Event('online')))
    await settle(80)
    expect(($('note-title') as HTMLInputElement).value).toBe('Compost in layers at home')
    expect($('title-check')).toBeNull()

    // "Title OK" on another note.
    notes.set('n2', note('n2', { title: 'From the share menu', title_check: true }))
    rooms.set('n2', new Y.Doc())
    rooms.get('n2')!.getText('title').insert(0, 'From the share menu')
    await act(async () => root.unmount())
    await render('/notes/n2')
    await settle(50)
    await act(async () => $('title-ok')!.click())
    await settle(20)
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/notes/n2/title/ok')).toBe(true)
    expect($('title-check')).toBeNull()
  })

  it('NOTES-3 EC-7 the title field takes at most 120 characters, a longer suggestion is cut', async () => {
    notes.set('n1', note('n1'))
    await render('/notes/n1')
    expect(($('note-title') as HTMLInputElement).maxLength).toBe(MAX_TITLE)
    expect(MAX_TITLE).toBe(120)
    expect(cleanTitle('x'.repeat(300))).toHaveLength(120)
    expect(suggestTitle('y'.repeat(300))).toHaveLength(120)
    expect(cleanTitle('  \t ')).toBe('')
    // In the list a long title is cut with "…" (the row truncates).
    expect(box.querySelector('[data-testid="note-row"] .truncate')).not.toBeNull()
  })

  it('NOTES-3 EC-10 the title keeps umlauts, emoji and right-to-left script in the shared document', async () => {
    notes.set('n1', note('n1'))
    await render('/notes/n1')
    await settle(40)
    typeTitle('Grüße 👋🏽 שלום')
    await settle(30)
    expect(rooms.get('n1')!.getText('title').toString()).toBe('Grüße 👋🏽 שלום')
    expect(($('note-title') as HTMLInputElement).getAttribute('dir')).toBe('auto')
  })

  it('NOTES-3 AC-6 deleting moves the note to the trash with "Undo" for ten seconds', async () => {
    notes.set('n1', note('n1', { title: 'Throw away' }))
    await render('/notes/n1')
    await act(async () => $('note-menu')!.click())
    await act(async () => $('note-delete')!.click())
    await settle(30)
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/notes/n1')).toBe(true)
    expect(where).toBe('/')
    const notice = document.querySelector('[data-testid="folder-notice"]') as HTMLElement
    expect(notice.textContent).toContain('Note moved to the trash.')
    expect(UNDO_MS).toBe(10_000)
    await act(async () => (notice.querySelector('button') as HTMLButtonElement).click())
    await settle(30)
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/notes/n1/restore')).toBe(true)
    expect(where).toBe('/notes/n1')
  })

  it('NOTES-3 AC-7 duplicating opens the copy, in the same folder with "(Copy)"', async () => {
    notes.set('n1', note('n1', { title: 'Shopping', folder_id: 'garden' }))
    await render('/notes/n1')
    await act(async () => $('note-menu')!.click())
    await act(async () => $('note-duplicate')!.click())
    await settle(30)
    expect(where).toBe('/notes/n1-copy')
    expect(notes.get('n1-copy')).toMatchObject({ title: 'Shopping (Copy)', folder_id: 'garden' })
  })

  it('NOTES-3 AC-2 what is typed goes into the shared document without a save button', async () => {
    notes.set('n1', note('n1', { title: 'Typing' }))
    await render('/notes/n1')
    await settle(40)
    expect(box.querySelector('button[type="submit"]')).toBeNull()
    typeTitle('Typing more')
    await settle(30)
    expect(rooms.get('n1')!.getText('title').toString()).toBe('Typing more')
    expect(bodyOf('n1')).toBeTruthy()
    await settle(400)
    expect($('note-saved')!.textContent).toBe('saved')
  })
})
