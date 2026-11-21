/**
 * NOTES-23 AC-5, EC-3, EC-4: "Save to nexnotes", the page of what another app shared on Android. The service worker
 * that took the share target's form is a stand-in that answers over a MessageChannel; the server is a stand-in for
 * fetch and XMLHttpRequest (the upload of NOTES-10).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { forgetAttachments } from '../../attachments/info'
import { forgetFolders } from '../../folders/store'
import i18n from '../../i18n'
import { forgetAccount } from '../../state/account'
import { AuthProvider } from '../../state/auth'
import { SharePage } from './SharePage'
import { forgetTaken } from './take'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const ID = 'a'.repeat(32)
const ME = { id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0' }

// ---- The worker that took the form ------------------------------------------------------------------------------------

type Message = { type: string; id?: string }
let stash: Record<string, unknown> = {}
let told: Message[] = []

class FakePort {
  other: FakePort | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(data: unknown) {
    this.other?.onmessage?.({ data })
  }
}

class FakeChannel {
  port1 = new FakePort()
  port2 = new FakePort()
  constructor() {
    this.port1.other = this.port2
    this.port2.other = this.port1
  }
}

const worker = {
  postMessage(message: Message, ports?: FakePort[]) {
    told.push(message)
    if (message.type === 'nexnotes-share-take' && ports?.[0]) ports[0].postMessage(stash[message.id ?? ''] ?? null)
  },
}

// ---- The server -------------------------------------------------------------------------------------------------------

let signedIn = true
let offline = false
let created: Record<string, unknown>[] = []
let limits = { max_mb: 100, used: 0, limit: null as number | null, full: false, link_previews: true }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

class FakeRequest {
  static made: FakeRequest[] = []
  url = ''
  status = 0
  responseText = ''
  body: Blob | null = null
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  send(body: Blob) {
    this.body = body
    FakeRequest.made.push(this)
    queueMicrotask(() => {
      if (offline) return this.onerror?.()
      this.status = 201
      const query = new URL(this.url, 'http://x').searchParams
      this.responseText = JSON.stringify({ id: query.get('id'), note_id: query.get('note_id'), name: query.get('name') })
      this.onload?.()
    })
  }
  abort() {}
}

function fakeFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch')
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (path.startsWith('/api/setup')) return json({ needs_setup: false, code_required: false, signed_in: signedIn, version: '0.1.0', min_password: 12 })
    if (path.startsWith('/api/auth/me')) return signedIn ? json(ME) : json({ detail: { code: 'sign_in_required', message: 'x' } }, 401)
    if (path.startsWith('/api/auth/clock')) return json({})
    if (path === '/api/folders') return json({ inbox: { id: 'inbox-1', count: 0 }, folders: [{ id: 'f-garden', name: 'Garten', parent_id: null, icon: '', color: '', position: null, count: 2 }] })
    if (path.startsWith('/api/attachments/limits')) return json(limits)
    if (method === 'POST' && path === '/api/notes') {
      const body = JSON.parse(String(init?.body))
      created.push(body)
      return json({ id: body.id, folder_id: body.folder_id, title: body.title, title_check: body.title_suggested }, 201)
    }
    return json({})
  })
}

// ---- Rendering --------------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  return <output data-testid="where" data-path={location.pathname + location.search} />
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve())
}

async function open(at = `/share?shared=${ID}`): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <AuthProvider>
          <Routes>
            <Route path="/share" element={<SharePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const find = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const where = () => find('where')?.dataset.path ?? ''

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function choose(field: HTMLSelectElement, value: string) {
  act(() => {
    field.value = value
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(element: HTMLElement | null) {
  await act(async () => element!.click())
  await settle()
}

function file(name: string, type: string, size?: number): File {
  const made = new File(['content of ' + name], name, { type })
  if (size !== undefined) Object.defineProperty(made, 'size', { value: size })
  return made
}

beforeAll(async () => {
  await i18n.changeLanguage('de')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  stash = {}
  told = []
  created = []
  signedIn = true
  offline = false
  limits = { max_mb: 100, used: 0, limit: null, full: false, link_previews: true }
  FakeRequest.made = []
  vi.stubGlobal('fetch', fakeFetch())
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  vi.stubGlobal('MessageChannel', FakeChannel)
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: worker, getRegistration: async () => ({ active: worker }) } })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/142.0 Mobile Safari/537.36')
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  forgetTaken()
  forgetAccount()
  forgetFolders()
  forgetAttachments()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NOTES-23 AC-5 Save to nexnotes', () => {
  it('NOTES-23 AC-5 shows the preview, suggests the title, files into the inbox with origin and "Titel prüfen"', async () => {
    const photo = file('photo.jpg', 'image/jpeg')
    const plan = file('Plan.pdf', 'application/pdf')
    stash[ID] = { title: 'Kompost richtig anlegen', text: 'Lesen fürs Frühjahr https://garten.example.com/kompost', url: '', files: [photo, plan] }
    await open()
    expect(find('share-page')).not.toBeNull()
    expect(box.textContent).toContain(t('pwa.share.title'))
    expect(find('share-link')?.textContent).toContain('Kompost richtig anlegen')
    expect(find('share-preview')?.textContent).toContain('garten.example.com')
    expect(find('share-text')?.textContent).toBe('Lesen fürs Frühjahr')
    expect(find('share-preview')?.textContent).toContain('Plan.pdf')
    expect(find('share-preview')?.querySelectorAll('img')).toHaveLength(1)
    expect((find('share-title') as HTMLInputElement).value).toBe('Kompost richtig anlegen')
    const folder = find('share-folder') as HTMLSelectElement
    expect(folder.value).toBe('inbox-1')
    expect([...folder.options].map((option) => option.textContent)).toEqual([t('folders.inbox.name'), 'Garten'])
    type(find('share-note') as HTMLTextAreaElement, 'Für das Hochbeet')

    await click(find('share-save'))
    expect(created).toHaveLength(1)
    const made = created[0]
    expect(made).toMatchObject({ folder_id: 'inbox-1', title: 'Kompost richtig anlegen', title_suggested: true, origin: 'share:Android' })
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/)
    const ids = FakeRequest.made.map((request) => new URL(request.url, 'http://x').searchParams.get('id'))
    expect(FakeRequest.made.map((request) => new URL(request.url, 'http://x').searchParams.get('note_id'))).toEqual([made.id, made.id])
    expect(made.markdown).toBe(
      ['[https://garten.example.com/kompost](https://garten.example.com/kompost)', 'Lesen fürs Frühjahr', 'Für das Hochbeet', `![photo.jpg](attachment:${ids[0]})`, `[Plan.pdf](attachment:${ids[1]})`].join('\n\n'),
    )
    expect(FakeRequest.made.map((request) => request.body)).toEqual([photo, plan])
    // Done: the note opens in its folder, and the worker lets what was shared go.
    expect(where()).toBe(`/folder/inbox-1?note=${made.id}`)
    expect(told).toContainEqual({ type: 'nexnotes-share-done', id: ID })
  })

  it('NOTES-23 AC-5 a title typed by the member and another folder: no "Titel prüfen", that folder', async () => {
    stash[ID] = { title: '', text: 'Milch, Eier und Butter kaufen', url: '', files: [] }
    await open()
    expect((find('share-title') as HTMLInputElement).value).toBe('Milch')
    type(find('share-title') as HTMLInputElement, 'Einkauf Samstag')
    choose(find('share-folder') as HTMLSelectElement, 'f-garden')
    await click(find('share-save'))
    expect(created[0]).toMatchObject({ folder_id: 'f-garden', title: 'Einkauf Samstag', title_suggested: false, origin: 'share:Android', markdown: 'Milch, Eier und Butter kaufen' })
    expect(where()).toBe(`/folder/f-garden?note=${created[0].id}`)
  })

  it('NOTES-23 AC-5 the title is a must: without it nothing is saved', async () => {
    stash[ID] = { title: 'Rezept', text: '', url: 'https://kochen.example/x', files: [] }
    await open()
    type(find('share-title') as HTMLInputElement, '   ')
    expect((find('share-save') as HTMLButtonElement).disabled).toBe(true)
    await click(find('share-save'))
    expect(created).toHaveLength(0)
  })

  it('NOTES-23 AC-5 shared text is kept as text, never read as Markdown', async () => {
    stash[ID] = { title: 'Notiz', text: '# keine Überschrift\n- kein Punkt\n**nicht fett** [kein](link)', url: '', files: [] }
    await open()
    await click(find('share-save'))
    expect(created[0].markdown).toBe('\\# keine Überschrift\n\\- kein Punkt\n\\*\\*nicht fett\\*\\* \\[kein\\](link)')
  })

  it('NOTES-23 EC-3 without a connection it says so, the form stays, and "Save" again makes the same note once', async () => {
    const photo = file('photo.jpg', 'image/jpeg')
    stash[ID] = { title: 'Foto', text: '', url: '', files: [photo] }
    await open()
    type(find('share-note') as HTMLTextAreaElement, 'bleibt hier')
    offline = true
    await click(find('share-save'))
    expect(find('share-offline')?.textContent).toBe(t('pwa.share.offline'))
    expect(find('share-page')).not.toBeNull()
    expect((find('share-note') as HTMLTextAreaElement).value).toBe('bleibt hier')
    expect((find('share-title') as HTMLInputElement).value).toBe('Foto')
    expect(told).not.toContainEqual({ type: 'nexnotes-share-done', id: ID })
    offline = false
    await click(find('share-save'))
    expect(created).toHaveLength(1)
    expect(FakeRequest.made.filter((request) => request.status === 201)).toHaveLength(1)
    expect(where()).toBe(`/folder/inbox-1?note=${created[0].id}`)
  })

  it('NOTES-23 EC-3 a connection lost during the upload: "Save" again sends only what is missing, to the same note', async () => {
    const one = file('eins.jpg', 'image/jpeg')
    const two = file('zwei.jpg', 'image/jpeg')
    stash[ID] = { title: 'Fotos', text: '', url: '', files: [one, two] }
    await open()
    // The note is made, then the network goes before the files.
    const realSend = FakeRequest.prototype.send
    FakeRequest.prototype.send = function (this: FakeRequest, body: Blob) {
      if (body === two) {
        this.body = body
        FakeRequest.made.push(this)
        queueMicrotask(() => this.onerror?.())
        return
      }
      realSend.call(this, body)
    }
    await click(find('share-save'))
    expect(find('share-offline')).not.toBeNull()
    FakeRequest.prototype.send = realSend
    await click(find('share-save'))
    expect(created).toHaveLength(1)
    const sent = FakeRequest.made.map((request) => request.body)
    expect(sent).toEqual([one, two, two])
    expect(where()).toBe(`/folder/inbox-1?note=${created[0].id}`)
  })

  it('NOTES-23 EC-4 a file over the limit is refused with a message and not saved; the rest is', async () => {
    const big = file('video.mp4', 'video/mp4', 101 * 1024 * 1024)
    const small = file('photo.jpg', 'image/jpeg')
    stash[ID] = { title: 'Urlaub', text: '', url: '', files: [big, small] }
    await open()
    expect(find('share-too-large')?.textContent).toBe(t('pwa.share.tooLarge', { name: 'video.mp4', max_mb: 100 }))
    await click(find('share-save'))
    expect(created[0].markdown).not.toContain('video.mp4')
    expect(FakeRequest.made.map((request) => request.body)).toEqual([small])
  })

  it('NOTES-23 EC-4 a full storage says so and saves nothing', async () => {
    stash[ID] = { title: 'Datei', text: '', url: '', files: [file('a.pdf', 'application/pdf')] }
    await open()
    limits = { ...limits, full: true, limit: 10, used: 10 }
    await click(find('share-save'))
    expect(find('share-problem')?.textContent).toBe(t('errors.storage_limit_reached'))
    expect(created).toHaveLength(0)
  })

  it('NOTES-23 AC-5 nothing shared (lost, run out, saved before) says so', async () => {
    await open()
    expect(find('share-gone')?.textContent).toContain(t('pwa.share.lost'))
    act(() => root.unmount())
    root = createRoot(box)
    await open('/share?shared=lost')
    expect(find('share-gone')).not.toBeNull()
  })

  it('NOTES-23 AC-5 without a session it goes to the sign-in and comes back here', async () => {
    signedIn = false
    stash[ID] = { title: 'Später', text: '', url: '', files: [] }
    await open()
    expect(where()).toBe(`/login?next=${encodeURIComponent(`/share?shared=${ID}`)}`)
  })

  it('NOTES-23 AC-5 "Cancel" lets what was shared go and saves nothing', async () => {
    stash[ID] = { title: 'Nein', text: 'x', url: '', files: [] }
    await open()
    await click(find('share-cancel'))
    expect(created).toHaveLength(0)
    expect(told).toContainEqual({ type: 'nexnotes-share-done', id: ID })
    expect(where()).toBe('/')
  })

  it('NOTES-23 EC-3 opened without a connection, the form shows with the notice', async () => {
    stash[ID] = { title: 'Offline geteilt', text: '', url: '', files: [] }
    offline = true
    await open()
    expect(find('share-page')).not.toBeNull()
    expect(find('share-offline')).not.toBeNull()
    expect((find('share-title') as HTMLInputElement).value).toBe('Offline geteilt')
  })
})
