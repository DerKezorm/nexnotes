/**
 * NOTES-24 in the interface: what a device changes over `/api/app/1` (the share sheet, a widget, a quick note, a
 * shortcut) shows in an open page without reloading it, as a change from a second browser does. The page asks the
 * tree's stamp every few seconds while it is in sight; only a changed stamp loads the tree (tiles, inbox, folders)
 * and the smart folders again. No focus, no reload.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from '../i18n'
import { useSmartFolders } from '../smart/store'
import type { Folder } from './api'
import { FolderTree } from './FolderTree'
import { QuickTiles } from './QuickTiles'
import { CHANGED_ELSEWHERE_EVENT, forgetFolders, TREE_STAMP_EVERY_MS } from './store'

type Call = { method: string; path: string }
let calls: Call[] = []
/** The stand-in server: what the account has, and the number every change takes. */
let inbox = 0
let all = 0
let folders: Folder[] = []
let seq = 1

function folder(id: string, name: string, count = 0): Folder {
  return { id, name, parent_id: null, icon: '', color: '', position: null, count }
}

function stamp(): string {
  return `${seq}`
}

function answer(call: Call): { status: number; body: unknown } {
  if (call.path === '/api/folders/stamp') return { status: 200, body: { stamp: stamp() } }
  if (call.path === '/api/folders') {
    return { status: 200, body: { inbox: { id: 'inbox-1', count: inbox }, folders, places: { all, shared: 0, inbox_title_check: 0 }, stamp: stamp() } }
  }
  if (call.path === '/api/smart-folders') return { status: 200, body: { items: [] } }
  return { status: 404, body: { detail: { code: 'not_found', message: 'Not found.' } } }
}

/** A device puts a note into the inbox (`POST /api/app/1/notes`): the server's numbers move, the page is not told. */
function deviceMakesNote(): void {
  inbox += 1
  all += 1
  seq += 1
}

function Smart() {
  const smart = useSmartFolders()
  return <output data-testid="smart" data-status={smart.status} />
}

let root: Root
let box: HTMLDivElement
let visibility: DocumentVisibilityState = 'visible'

async function settle(): Promise<void> {
  for (let i = 0; i < 15; i++) await act(async () => await Promise.resolve())
}

async function tick(): Promise<void> {
  await act(async () => void vi.advanceTimersByTime(TREE_STAMP_EVERY_MS))
  await settle()
}

const count = (id: string) => box.querySelector(`[data-testid="${id}"] [data-testid="tile-count"]`)?.textContent
const asked = (path: string) => calls.filter((call) => call.path === path).length

// Only the clocks of the polls, for the whole file: the tree's poll is set up once, with the first page that shows it.
// Promises and React's own timing stay real.
beforeAll(() => void vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
afterAll(() => void vi.useRealTimers())

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  inbox = 0
  all = 3
  seq = 1
  folders = [folder('h', 'Haushalt', 3)]
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', path: String(input) }
      calls.push(call)
      const { status, body } = answer(call)
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  forgetFolders()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <QuickTiles />
        <FolderTree />
        <Smart />
      </MemoryRouter>,
    ),
  )
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('changes from a device reach the open page (NOTES-24)', () => {
  it('NOTES-24 a note from the share sheet shows in the inbox tile and "All notes" without reloading', async () => {
    expect([count('sidebar-inbox'), count('sidebar-all')]).toEqual(['0', '3'])
    const told = vi.fn()
    window.addEventListener(CHANGED_ELSEWHERE_EVENT, told)

    deviceMakesNote()
    await tick()

    expect([count('sidebar-inbox'), count('sidebar-all')]).toEqual(['1', '4'])
    // The smart folders look again too.
    expect(told).toHaveBeenCalledTimes(1)
    expect(asked('/api/smart-folders')).toBe(2)
    window.removeEventListener(CHANGED_ELSEWHERE_EVENT, told)
  })

  it('NOTES-24 a folder made on the device shows in the tree', async () => {
    expect(box.textContent).not.toContain('Garten')
    folders = [...folders, folder('g', 'Garten')]
    seq += 1
    await tick()
    expect(box.textContent).toContain('Garten')
  })

  it('NOTES-24 an unchanged stamp loads nothing; a page out of sight asks nothing', async () => {
    const trees = asked('/api/folders')
    await tick()
    await tick()
    expect(asked('/api/folders/stamp')).toBe(2)
    expect(asked('/api/folders')).toBe(trees)

    visibility = 'hidden'
    deviceMakesNote()
    await tick()
    expect(asked('/api/folders/stamp')).toBe(2)
    expect(count('sidebar-inbox')).toBe('0')

    // Back in sight: the next round brings it.
    visibility = 'visible'
    await tick()
    expect(count('sidebar-inbox')).toBe('1')
  })
})
