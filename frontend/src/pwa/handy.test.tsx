/**
 * NOTES-23 on a phone (390 px, narrower than the app's `md`): one view after the other with "‹ Back" (AC-1), "New
 * note" as a large button at the bottom right (AC-1), 44 px for every button and field (AC-7), "No connection" (AC-4),
 * the start in the folders and the last place of the installed app (AC-1, EC-6), the bar of a new version.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'

import { registerNoteActions } from '../folders/actions'
import { FolderPage, FoldersPage, InboxPage } from '../folders/pages'
import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import { NotesPage } from '../notes/NotesPage'
// Smart folders docked on, as `main.tsx` does: their section stands on the page "Ordner" too.
import '../smart'
import { forgetSmartFolders } from '../smart/store'
import { followAccount, forgetAccount } from '../state/account'
import { AuthProvider, unreachable as offlineError, useAuth } from '../state/auth'
import { ApiError } from '../api/client'
import { OfflinePage } from './OfflinePage'
import { APP_START, forgetStart, lastPlace, PLACE_KEY, rememberPlace, startPlace } from './place'
import { StartPlace, UpdateBanner } from './register'
import { setPwaState } from './worker'

vi.mock('../editor/NoteEditor', () => ({ NoteEditor: ({ noteId }: { noteId: string }) => <p data-testid="editor">{noteId}</p> }))

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const PHONE_WIDTH = 390

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

// ---- A phone of 390 px ------------------------------------------------------------------------------------------------

/** `matchMedia` as a browser 390 px wide answers it: below every `min-width` above that. */
function phone(width = PHONE_WIDTH) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false
    return { matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }
  })
}

let signedIn = true
const ME = { id: 7, name: 'anna', display_name: 'Anna', email: 'a@example.com', role: 'member', sign_in: 'password', language: '', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let unreachable = false

function server() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (unreachable) throw new TypeError('Failed to fetch')
    const path = String(input)
    if (path.startsWith('/api/setup')) return json({ needs_setup: false, code_required: false, signed_in: signedIn, version: '0.1.0', min_password: 12 })
    if (path.startsWith('/api/auth/me')) return json(ME)
    if (path === '/api/folders')
      return json({
        inbox: { id: 'inbox-1', count: 3 },
        folders: [
          { id: 'f-home', name: 'Haushalt', parent_id: null, icon: '', color: 'honey', position: null, count: 12 },
          { id: 'f-shop', name: 'Einkauf', parent_id: 'f-home', icon: '', color: 'green', position: null, count: 4 },
        ],
      })
    if (path.startsWith('/api/folders/inbox')) return json({ id: 'inbox-1', notes: [] })
    if (path === '/api/smart-folders')
      return json({
        items: [
          { id: 's-open', name: '', preset: 'open_tasks', match: 'all', conditions: [{ kind: 'tasks', op: 'open' }], position: 0 },
          { id: 's-shared', name: '', preset: 'shared_with_me', match: 'all', conditions: [{ kind: 'shared', op: 'with_me' }], position: 1 },
          { id: 's-files', name: '', preset: 'attachments', match: 'all', conditions: [{ kind: 'attachment', type: 'any' }], position: 2 },
          { id: 's-own', name: 'Rezepte offen', preset: '', match: 'all', conditions: [{ kind: 'pinned' }], position: 3 },
        ],
      })
    if (path.startsWith('/api/note-list/stamp')) return json({ stamp: 's' })
    if (path.startsWith('/api/note-list')) return json({ key: 'k', view: { mode: 'list', sort: 'updated', direction: 'desc', grouped: true }, counts: { own: 0, shared: 0 }, items: [] })
    if (path.startsWith('/api/notes')) return json([])
    return json({})
  })
}

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  return <output data-testid="where" data-path={location.pathname + location.search} />
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve())
}

async function render(at: string, extra: React.ReactNode = null): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <AuthProvider>
          <Routes>
            <Route
              element={
                <>
                  <StartPlace />
                  <Outlet />
                </>
              }
            >
              <Route element={<NotesPage />}>
                <Route path="/" element={<p data-testid="all-notes">all</p>} />
                <Route path="/folders" element={<FoldersPage />} />
                <Route path="/folder/:id" element={<FolderPage />} />
                <Route path="/inbox" element={<InboxPage />} />
              </Route>
              <Route path="*" element={null} />
            </Route>
          </Routes>
          {extra}
          <Where />
        </AuthProvider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const find = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const where = () => find('where')?.dataset.path ?? ''
const newNote = vi.fn()

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement).click())
  await settle()
}

beforeAll(async () => {
  await i18n.changeLanguage('de')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  signedIn = true
  unreachable = false
  phone()
  vi.stubGlobal('fetch', server())
  registerNoteActions({ newNote, noteHref: (id: string) => `/notes/${id}` })
  newNote.mockReset()
  forgetFolders()
  forgetSmartFolders()
  forgetAccount()
  forgetStart()
  localStorage.clear()
  setPwaState({ standalone: false, update: false })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

// ---- AC-1 -------------------------------------------------------------------------------------------------------------

describe('NOTES-23 AC-1 on a phone one view after the other', () => {
  it('NOTES-23 AC-1 NOTES-7 AC-8 the page "Ordner" has the section "Intelligent" of the sidebar: same entries, order, symbols, "+"', async () => {
    await render('/folders')
    const section = find('folders-smart')!
    expect(section.querySelector('h2')!.textContent).toBe(t('smart.heading'))
    // After the folders, as in the sidebar.
    const tree = find('folders-page')!.querySelector('a[href="/folder/f-home"]')!
    expect(tree.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const rows = [...section.querySelectorAll<HTMLAnchorElement>('[data-testid="folders-smart-folder"]')]
    expect(rows.map((row) => row.textContent)).toEqual([t('smart.preset.open_tasks') + '›', t('smart.preset.shared_with_me') + '›', t('smart.preset.attachments') + '›', 'Rezepte offen›'])
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/smart/s-open', '/smart/s-shared', '/smart/s-files', '/smart/s-own'])
    expect(rows[0].querySelector('[data-testid="smart-filter-icon"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-testid="smart-icon-shared_with_me"]')).not.toBeNull()
    expect(rows[2].querySelector('[data-testid="smart-icon-attachments"]')).not.toBeNull()
    expect(find('folders-smart-new')!.getAttribute('href')).toBe('/smart/new')
    await click(rows[1])
    expect(where()).toBe('/smart/s-shared')
  })

  it('NOTES-23 AC-1 opened at 390 px, nexnotes starts with the folders, then a folder, then the note, each with "‹ Back"', async () => {
    await render('/')
    // The folders first (drawing "Handy-Ordner"): the inbox, all notes, the tree, then the smart folders as in the sidebar.
    expect(where()).toBe('/folders')
    const page = find('folders-page')!
    expect(page.textContent).toContain(t('folders.inbox.name'))
    expect(find('folders-all')?.getAttribute('href')).toBe('/')
    // What others shared is a smart folder now (NOTES-7), no fixed place of its own.
    expect(find('folders-shared')).toBeNull()
    expect(page.textContent).toContain('Haushalt')
    // "New note" large at the bottom right.
    const fab = page.querySelector<HTMLButtonElement>(`button[aria-label="${t('folders.page.newNote', { name: t('folders.inbox.name') })}"]`)
    expect(fab?.className).toContain('h-[52px]')

    // Then the notes of a folder, with "‹ Ordner" back.
    await click(page.querySelector('a[href="/folder/f-home"]'))
    expect(where()).toBe('/folder/f-home')
    const back = find('phone-back') as HTMLAnchorElement
    expect(back.getAttribute('href')).toBe('/folders')
    expect(back.textContent).toBe(t('folders.section'))
    const folderFab = find('phone-new-note') as HTMLButtonElement
    expect(folderFab.className).toMatch(/fixed.*right-4.*bottom-7.*h-14.*w-14/)
    await click(folderFab)
    expect(newNote).toHaveBeenCalledWith('f-home')

    // Then the note, alone, with "‹ Haushalt" back to its list.
    act(() => root.unmount())
    root = createRoot(box)
    await render('/folder/f-home?note=n-1')
    expect(find('editor')?.textContent).toBe('n-1')
    expect(find('folder-page')).toBeNull()
    const toList = find('phone-back') as HTMLAnchorElement
    expect(toList.getAttribute('href')).toBe('/folder/f-home')
    expect(toList.textContent).toContain('Haushalt')
    await click(toList)
    expect(where()).toBe('/folder/f-home')
    expect(find('folder-page')).not.toBeNull()
  })

  it('NOTES-23 AC-1 a folder inside another goes back to that one; the inbox back to all folders', async () => {
    await render('/folder/f-shop')
    expect(find('phone-back')?.getAttribute('href')).toBe('/folder/f-home')
    expect(find('phone-back')?.textContent).toBe('Haushalt')
    act(() => root.unmount())
    root = createRoot(box)
    await render('/inbox')
    expect(find('phone-back')?.getAttribute('href')).toBe('/folders')
    await click(find('phone-new-note'))
    expect(newNote).toHaveBeenCalledWith('inbox-1')
  })

  it('NOTES-23 AC-1 only the first address of the page is the start: "All notes" later stays all notes', async () => {
    await render('/')
    expect(where()).toBe('/folders')
    await click(find('folders-all'))
    expect(where()).toBe('/')
  })

  it('NOTES-23 AC-1 on a wide screen the start stays where it is', async () => {
    phone(1280)
    await render('/')
    expect(where()).toBe('/')
  })

  it('NOTES-23 AC-1 the start rules', () => {
    expect(startPlace('/', '', true, null)).toBe('/folders')
    expect(startPlace('/', '', false, null)).toBeNull()
    expect(startPlace('/folder/x', '', true, null)).toBeNull()
    expect(startPlace('/', `?${APP_START}=1`, false, null)).toBe('/')
    expect(startPlace('/', `?${APP_START}=1`, true, null)).toBe('/folders')
    expect(startPlace('/', `?${APP_START}=1`, true, '/folder/x?note=y')).toBe('/folder/x?note=y')
    expect(startPlace('/', `?${APP_START}=1`, true, '//evil.example')).toBe('/folders')
    expect(startPlace('/', `?${APP_START}=1`, true, '/login')).toBe('/folders')
  })
})

// ---- EC-6 -------------------------------------------------------------------------------------------------------------

describe('NOTES-23 EC-6 the installed app comes back to where it was', () => {
  it('NOTES-23 EC-6 the installed app keeps its place per account and goes back there at its start', async () => {
    setPwaState({ standalone: true })
    await render('/folder/f-shop')
    expect(JSON.parse(localStorage.getItem(PLACE_KEY)!)).toEqual({ a: 7, p: '/folder/f-shop' })
    act(() => root.unmount())
    root = createRoot(box)
    forgetStart()
    await render(`/?${APP_START}=1`)
    expect(where()).toBe('/folder/f-shop')
  })

  it('NOTES-23 EC-6 a browser tab keeps nothing; another account never gets the place; signing out forgets it', () => {
    rememberPlace(7, '/folder/a')
    expect(lastPlace(7)).toBe('/folder/a')
    expect(lastPlace(8)).toBeNull()
    expect(lastPlace(null)).toBeNull()
    rememberPlace(7, '/login?next=x')
    rememberPlace(7, '/share?shared=abc')
    rememberPlace(7, `/?${APP_START}=1`)
    expect(lastPlace(7)).toBe('/folder/a')
    // The same account signing in again after its session ran out keeps it; signing out does not.
    followAccount(null)
    followAccount(7)
    expect(lastPlace(7)).toBe('/folder/a')
    followAccount(8)
    expect(localStorage.getItem(PLACE_KEY)).toBeNull()
    rememberPlace(8, '/inbox')
    followAccount(null)
    expect(localStorage.getItem(PLACE_KEY)).toBeNull()
  })

  it('NOTES-23 EC-6 in a browser tab the place is not kept', async () => {
    await render('/folder/f-shop')
    expect(localStorage.getItem(PLACE_KEY)).toBeNull()
  })
})

// ---- AC-7 -------------------------------------------------------------------------------------------------------------

const CSS = files.readFileSync('src/styles/index.css', 'utf-8')

/** The selector of the rule for a finger's size, and the conditions it holds under. */
function touchRule(): { media: string; selector: string; body: string } {
  const media = /@media ([^{]*\(max-width: 767px\)[^{]*)\{([\s\S]*?)\n\}/.exec(CSS)
  expect(media, 'the rule for a finger on a phone').not.toBeNull()
  const block = media![2]
  const rule = /(:where\([\s\S]*?\):not\(\.ProseMirror \*\))\s*\{\s*min-height:\s*44px;/.exec(block)
  expect(rule, 'min-height 44px').not.toBeNull()
  return { media: media![1], selector: rule![1].replace(/\s+/g, ' '), body: block }
}

describe('NOTES-23 AC-7 every button and field is 44 px to tap', () => {
  it('NOTES-23 AC-7 one rule below 768 px and for every finger lifts buttons, fields and menu entries to 44 px', () => {
    const rule = touchRule()
    expect(rule.media).toContain('(pointer: coarse)')
    const probe = document.createElement('div')
    probe.innerHTML = [
      '<button>a</button>',
      '<input type="text">',
      '<input type="search">',
      '<input type="password">',
      '<select><option>x</option></select>',
      '<textarea></textarea>',
      '<span role="button">b</span>',
      '<div role="menuitem">c</div>',
      '<div role="tab">d</div>',
      '<div role="radio">e</div>',
      '<div role="option">f</div>',
    ].join('')
    for (const element of probe.children) expect(element.matches(rule.selector), element.outerHTML).toBe(true)
    // The text of a note keeps its lines; a hidden field is no field.
    probe.innerHTML = '<div class="ProseMirror"><p><button>in text</button></p></div><input type="hidden">'
    expect(probe.querySelector('button')!.matches(rule.selector)).toBe(false)
    expect(probe.querySelector('input')!.matches(rule.selector)).toBe(false)
    expect(rule.body).toMatch(/min-width:\s*44px/)
    // A checklist's box gets an area around it.
    expect(rule.body).toMatch(/taskList'\] li > label::after \{[^}]*inset: -12px/)
  })

  it('NOTES-23 AC-7 at 390 px every button and field of the phone views falls under the rule, every way back and row is 44 px', async () => {
    const rule = touchRule()
    const big = /(^|\s)(min-h-11|h-11|min-h-12|h-12|min-h-\[50px\]|h-\[50px\]|h-\[52px\]|h-14)(\s|$)/
    for (const at of ['/folders', '/folder/f-home', '/inbox']) {
      act(() => root.unmount())
      root = createRoot(box)
      forgetStart()
      await render(at)
      const controls = [...box.querySelectorAll('button, input, select, textarea')]
      expect(controls.length, at).toBeGreaterThan(0)
      for (const control of controls) expect(control.matches(rule.selector), `${at}: ${control.outerHTML.slice(0, 120)}`).toBe(true)
      for (const link of box.querySelectorAll('[data-testid="phone-back"], [data-testid="folders-all"], [data-testid="folders-page"] a'))
        expect(link.className, `${at}: ${link.outerHTML.slice(0, 120)}`).toMatch(big)
    }
  })
})

// ---- AC-4 -------------------------------------------------------------------------------------------------------------

describe('NOTES-23 AC-4 without a connection', () => {
  it('NOTES-23 AC-4 says "No connection", offers "Try again" and the hint on the iPhone and iPad app', async () => {
    unreachable = true
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <OfflinePage />
          </AuthProvider>
        </MemoryRouter>,
      ),
    )
    await settle()
    const page = find('offline')!
    expect(page.querySelector('h1')?.textContent).toBe('Keine Verbindung')
    expect(page.textContent).toContain('Ohne Netz schreiben geht mit der iPhone- und iPad-App.')
    const fetched = vi.mocked(fetch).mock.calls.length
    await click(find('offline-retry'))
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(fetched)
  })
})

function Status() {
  return <output data-testid="status">{useAuth().status}</output>
}

describe('NOTES-23 AC-4 the page knows when the server is out of reach', () => {
  it('NOTES-23 AC-4 no network or a server down is "offline", not "signed out"; it asks again when the network is back', async () => {
    expect(offlineError(new TypeError('Failed to fetch'))).toBe(true)
    expect(offlineError(new ApiError(502, 'internal_error'))).toBe(true)
    expect(offlineError(new ApiError(504, 'internal_error'))).toBe(true)
    expect(offlineError(new ApiError(401, 'sign_in_required'))).toBe(false)
    expect(offlineError(new ApiError(500, 'internal_error'))).toBe(false)
    unreachable = true
    await act(async () =>
      root.render(
        <AuthProvider>
          <Status />
        </AuthProvider>,
      ),
    )
    await settle()
    expect(find('status')?.textContent).toBe('offline')
    unreachable = false
    await act(async () => void window.dispatchEvent(new Event('online')))
    await settle()
    expect(find('status')?.textContent).toBe('signedIn')
  })
})

describe('NOTES-23 a new version', () => {
  it('NOTES-23 a waiting version shows the bar with "Reload"', async () => {
    await act(async () => root.render(<UpdateBanner />))
    expect(find('pwa-update')).toBeNull()
    await act(async () => setPwaState({ update: true }))
    expect(find('pwa-update')?.textContent).toContain(t('pwa.reload'))
  })
})
