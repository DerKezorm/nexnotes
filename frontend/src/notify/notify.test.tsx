/**
 * NOTES-14 Mitteilungen on the page: the bell of a shared note and its panel (switch, devices, this browser, preview),
 * allowing this browser and what a refusing browser is told, the word "this note is in view", and where a tapped
 * notification opens. The server's part (bundling, who hears what, Web Push, the relay) is in
 * `backend/tests/test_notes14.py`.
 */
import { Editor } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import StarterKit from '@tiptap/starter-kit'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { FolderMenu } from '../folders/FolderMenu'
import i18n from '../i18n'
import type { NotifySettings } from './api'
import { forgetWorker } from './browser'
import { CHANGE_MARK_MS, ChangeFound, textBlockAt, useJumpToChange, useViewing, VIEWING_EVERY_MS } from './hooks'
import { NotifyBell } from './NotifyBell'
import { insidePath } from './open'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let settings: NotifySettings
let subscribed = false
/** A made-up public key of the server, as the page gets it (base64url of 65 bytes). */
const SERVER_KEY = 'B' + 'Q'.repeat(86)
let root: Root
let box: HTMLDivElement

function reply(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer({ method, path, body }: Call): Response {
  if (path === '/api/notify/note/n1' && method === 'GET') return reply(200, settings)
  if (path === '/api/notify/note/n1' && method === 'PUT') {
    settings = { ...settings, on: Boolean(body!.on) }
    return reply(200, settings)
  }
  if (path === '/api/notify/webpush' && method === 'GET') return reply(200, { key: SERVER_KEY, subscribed })
  if (path === '/api/notify/webpush' && method === 'PUT') {
    subscribed = true
    settings = { ...settings, devices: { ...settings.devices, this_browser: true } }
    return reply(204, null)
  }
  if (path === '/api/notify/viewing') return reply(204, null)
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

function click(element: Element | null): Promise<void> {
  return act(async () => (element as HTMLElement).click())
}

const permission = { value: 'default' as NotificationPermission, next: 'granted' as NotificationPermission }

function fakeBrowser(): void {
  const subscription = {
    endpoint: 'https://push.example.com/send/1',
    options: { applicationServerKey: null },
    toJSON: () => ({ keys: { p256dh: 'P256', auth: 'AUTH' } }),
    unsubscribe: vi.fn(async () => true),
  }
  const registration = { pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) } }
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal(
    'Notification',
    Object.assign(function Notification() {}, {
      get permission() {
        return permission.value
      },
      requestPermission: vi.fn(async () => {
        permission.value = permission.next
        return permission.next
      }),
    }),
  )
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('de')
  calls = []
  subscribed = false
  permission.value = 'default'
  permission.next = 'granted'
  settings = {
    kind: 'note',
    id: 'n1',
    on: false,
    via: null,
    shared: true,
    devices: { apps: [{ id: 4, name: 'iPhone von Nora', on: true }], browsers: [], this_browser: false },
    preview: { title: 'Anna in „Einkauf Samstag“', text: '+ Eier, + Butter' },
  }
  forgetWorker()
  fakeBrowser()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost')
      const call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      return answer(call)
    }),
  )
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

async function openBell(shared = true): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <NotifyBell noteId="n1" on={false} shared={shared} />
      </MemoryRouter>,
    ),
  )
  await settle()
  const bell = box.querySelector('[data-testid="notify-bell"]')
  if (bell) {
    await click(bell)
    await settle()
  }
}

describe('NOTES-14 the bell of a shared note', () => {
  it('NOTES-14 AC-1 is off from the start and switches notifications for the note', async () => {
    await openBell()
    const bell = box.querySelector('[data-testid="notify-bell"]')!
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    const toggle = box.querySelector('[data-testid="notify-switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    await settle()
    expect(calls.some((call) => call.method === 'PUT' && call.path === '/api/notify/note/n1' && call.body?.on === true)).toBe(true)
    expect(box.querySelector('[data-testid="notify-switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(bell.getAttribute('aria-pressed')).toBe('true')
    expect(box.textContent).toContain('Gebündelt: Eine Mitteilung kommt, wenn zwei Minuten lang niemand mehr schreibt.')
  })

  it('NOTES-14 AC-1 is not there on a note nobody shares', async () => {
    await openBell(false)
    expect(box.querySelector('[data-testid="notify-bell"]')).toBeNull()
  })

  it('NOTES-14 AC-1 says when the switch comes from a folder above', async () => {
    settings = { ...settings, on: true, via: { id: 'f1', name: 'Haushalt' } }
    await openBell()
    expect(box.querySelector('[data-testid="notify-via"]')!.textContent).toBe('An über den Ordner „Haushalt“')
  })

  it('NOTES-14 AC-8 shows the devices with their state and how a notification looks', async () => {
    await openBell()
    const devices = box.querySelector('[data-testid="notify-devices"]')!
    expect(devices.textContent).toContain('iPhone von Nora')
    expect(devices.textContent).toContain('an')
    expect(box.querySelector('[data-testid="notify-this-browser"]')!.getAttribute('data-state')).toBe('off')
    expect(box.querySelector('[data-testid="notify-preview"]')!.textContent).toBe('Anna in „Einkauf Samstag“+ Eier, + Butter')
  })

  it('NOTES-14 AC-7 "Erlauben" asks the browser and signs it up at the server', async () => {
    await openBell()
    await click(box.querySelector('[data-testid="notify-allow"]'))
    await settle()
    const signUp = calls.find((call) => call.method === 'PUT' && call.path === '/api/notify/webpush')
    expect(signUp?.body).toEqual({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: 'P256', auth: 'AUTH' } })
    expect(box.querySelector('[data-testid="notify-this-browser"]')!.getAttribute('data-state')).toBe('on')
  })

  it('NOTES-14 EC-3 a browser that refuses is explained how to allow it again', async () => {
    permission.next = 'denied'
    await openBell()
    await click(box.querySelector('[data-testid="notify-allow"]'))
    await settle()
    expect(calls.some((call) => call.method === 'PUT' && call.path === '/api/notify/webpush')).toBe(false)
    expect(box.querySelector('[data-testid="notify-this-browser"]')!.textContent).toContain('nicht erlaubt')
    expect(box.querySelector('[data-testid="notify-denied-help"]')!.textContent).toContain('Benachrichtigungen')
  })

  it('NOTES-14 AC-1 a folder has notifications in its menu', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const chosen: string[] = []
    await act(async () =>
      root.render(<FolderMenu folder={{ id: 'f1', name: 'Haushalt' } as never} anchor={anchor} onAction={(action) => chosen.push(action)} onClose={() => {}} />),
    )
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Mitteilungen …')
    await click(entry ?? null)
    expect(chosen).toEqual(['notify'])
    anchor.remove()
  })
})

function Viewer({ noteId }: { noteId: string }) {
  useViewing(noteId)
  return null
}

describe('NOTES-14 the note in view', () => {
  it('NOTES-14 AC-9 an open note in view tells the server again and again, and "none" when hidden or closed', async () => {
    subscribed = true
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let hidden = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    await act(async () => root.render(<Viewer noteId="n1" />))
    await settle()
    const said = () => calls.filter((call) => call.path === '/api/notify/viewing').map((call) => call.body?.note_id)
    expect(said()).toEqual(['n1'])
    await act(async () => vi.advanceTimersByTime(VIEWING_EVERY_MS))
    expect(said()).toEqual(['n1', 'n1'])
    hidden = true
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(said()).toEqual(['n1', 'n1', null])
    hidden = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    act(() => root.unmount())
    root = createRoot(box)
    expect(said()).toEqual(['n1', 'n1', null, 'n1', null])
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('NOTES-14 AC-9 a browser without notifications says nothing', async () => {
    subscribed = false
    await act(async () => root.render(<Viewer noteId="n1" />))
    await settle()
    expect(calls.filter((call) => call.path === '/api/notify/viewing')).toEqual([])
  })
})

describe('NOTES-14 a tapped notification', () => {
  it('NOTES-14 AC-5 opens the note at the line the notification names', () => {
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true })],
      content: '<h2>Obst</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Milch</p></li><li data-type="taskItem" data-checked="false"><p>Eier</p></li></ul><p>Ende</p>',
    })
    const at = textBlockAt(editor as never, 2)!
    expect(editor.state.doc.resolve(at).parent.textContent).toBe('Eier')
    expect(textBlockAt(editor as never, 0)).not.toBeNull()
    expect(textBlockAt(editor as never, 9)).toBeNull()
    editor.destroy()
  })

  it('NOTES-14 AC-5 the named line stays marked while the editor draws it again, and the mark goes after a while', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), ChangeFound],
      content: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Milch</p></li><li data-type="taskItem" data-checked="false"><p>Eier</p></li></ul>',
    })
    function Jumper() {
      useJumpToChange(editor as never, true)
      return null
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/notes/n1?change=1']}>
          <Jumper />
        </MemoryRouter>,
      ),
    )
    // ProseMirror hears changes to its elements a moment later and draws the block again: the mark is still there.
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)))
    const marked = () => Array.from(element.querySelectorAll('.nn-change-found')).map((each) => each.textContent)
    expect(marked()).toEqual(['Eier'])
    expect(editor.state.doc.resolve(editor.state.selection.from).parent.textContent).toBe('Eier')
    // Typing elsewhere keeps it on its line.
    await act(async () => void editor.commands.insertContentAt(1, 'Frische '))
    expect(marked()).toEqual(['Eier'])
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHANGE_MARK_MS)))
    expect(marked()).toEqual([])
    editor.destroy()
    element.remove()
  })

  it('NOTES-14 AC-5 opens only addresses inside nexnotes', () => {
    expect(insidePath('/notes/n1?change=2')).toBe('/notes/n1?change=2')
    expect(insidePath('//evil.example/x')).toBeNull()
    expect(insidePath('https://evil.example/x')).toBeNull()
    expect(insidePath(42)).toBeNull()
  })
})
