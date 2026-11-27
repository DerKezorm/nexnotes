/**
 * NOTES-4 AC-15: the sidebar is as wide as set on this device, for the account signed in: dragged at its edge or moved
 * with the arrow keys, within its least and greatest width; a double click goes back to the drawing's 260 px. The
 * drawer on a phone has no handle. (The list beside a note: NOTES-6 AC-10 in `tabs/tabs.test.tsx`.)
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import i18n from './i18n'
import { COLUMNS } from './lib/columns'
import { forgetPrefs, prefKey } from './lib/devicePref'
import { AuthProvider } from './state/auth'

let root: Root
let box: HTMLDivElement
let me = 1

/** "Was ist neu" of the shared module wasneu, which the frame asks: nothing unread. */
const NOTHING_NEW = { version: '1.2.0', seen: '1.2.0', unread: [], more: false, current: null, earlier: false }

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  forgetPrefs()
  me = 1
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body =
        path === '/api/setup'
          ? { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 }
          : path === '/api/auth/me'
            ? { id: me, name: 'anna', display_name: 'Anna', role: 'member', sign_in: 'password', language: 'en', version: '0.1.0', whats_new_seen: '0.1.0' }
            : path.startsWith('/api/whats-new')
              ? NOTHING_NEW
              : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  const { AppShell } = await import('./components/AppShell')
  await act(async () =>
    root.render(
      <AuthProvider>
        <MemoryRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<p>notes</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    ),
  )
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
}

const handle = () => box.querySelector<HTMLElement>('[data-testid="column-handle-sidebar"]')!
const sidebarWidth = () => box.querySelector<HTMLElement>('nav')!.style.width
const press = (key: string) => act(() => void handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

describe('NOTES-4 AC-15 the width of the sidebar', () => {
  it('NOTES-4 AC-15 arrow keys, Home and End and a double click change the width, within its bounds', async () => {
    await render()
    expect(sidebarWidth()).toBe('260px')
    expect(handle().getAttribute('role')).toBe('separator')
    expect(handle().getAttribute('aria-label')).toBe(i18n.t('columns.sidebar'))
    expect(handle().tabIndex).toBe(0)
    press('ArrowRight')
    expect(sidebarWidth()).toBe('276px')
    expect(handle().getAttribute('aria-valuenow')).toBe('276')
    press('End')
    expect(sidebarWidth()).toBe(`${COLUMNS.sidebar.max}px`)
    press('ArrowRight')
    expect(sidebarWidth()).toBe(`${COLUMNS.sidebar.max}px`)
    press('Home')
    expect(sidebarWidth()).toBe(`${COLUMNS.sidebar.min}px`)
    act(() => void handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(sidebarWidth()).toBe('260px')
  })

  it('NOTES-4 AC-15 dragging the edge sets the width, which this device keeps for this account only', async () => {
    await render()
    await act(async () => handle().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 260, button: 0 })))
    await act(async () => handle().dispatchEvent(new MouseEvent('pointermove', { clientX: 330 })))
    await act(async () => handle().dispatchEvent(new MouseEvent('pointerup', {})))
    expect(sidebarWidth()).toBe('330px')
    expect(localStorage.getItem(prefKey('column.sidebar', 1))).toBe('330')
    // A reload: back as it was. Another account on the same device: its own (the default).
    act(() => root.unmount())
    box.remove()
    forgetPrefs()
    await render()
    expect(sidebarWidth()).toBe('330px')
    act(() => root.unmount())
    box.remove()
    me = 2
    await render()
    expect(sidebarWidth()).toBe('260px')
    // A broken value counts as none.
    localStorage.setItem(prefKey('column.sidebar', 2), 'wide')
    act(() => root.unmount())
    box.remove()
    forgetPrefs()
    await render()
    expect(sidebarWidth()).toBe('260px')
  })

  it('NOTES-4 AC-15 the drawer on a phone has no handle', async () => {
    await render()
    expect(box.querySelectorAll('[data-testid="column-handle-sidebar"]')).toHaveLength(1)
    await act(async () => box.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('app.openMenu')}"]`)!.click())
    const navs = box.querySelectorAll('nav')
    expect(navs).toHaveLength(2)
    expect(box.querySelectorAll('[data-testid="column-handle-sidebar"]')).toHaveLength(1)
    expect((navs[1] as HTMLElement).style.width).toBe('260px')
  })
})
