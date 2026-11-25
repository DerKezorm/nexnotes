/**
 * NOTES-1 in Server › Storage and backups (the cards of the shared module sicherung, `pages/settings/StorageArea.tsx`):
 * the check of a backup names what a restore does to the notes (numbers for all, the first titles of the operator's
 * own), the entry names its notes and files, the card says what a backup holds, and "No backup yet." stands there
 * once. The requests go over nexnotes' own client (its tab header) to the module's routes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from './i18n'
import { StorageArea } from './pages/settings/StorageArea'
import { AuthProvider } from './state/auth'
import { NexuiLanguage } from './vendor/nexui'
import { SICHERUNG_TEXTS } from './vendor/nexsicherung/sicherung'

type Answer = { status: number; body: unknown }
let handler: (method: string, path: string) => Answer | undefined = () => undefined
let root: Root
let box: HTMLDivElement
const sent: { path: string; client: string | null }[] = []

const ME = {
  id: 1, name: 'tester', display_name: 'Tester', email: 'tester@example.com', role: 'operator', sign_in: 'password',
  language: '', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}
const OVERVIEW = {
  app: 'nexnotes', used: 3_500_000, complete: true, total: 1e12, disk_used: 1e11, free: 9e11, nearly_full: false, where: {}, network: [],
  parts: [
    { key: 'database', bytes: 1_000_000, within: '', complete: true },
    { key: 'attachments', bytes: 2_000_000, within: '', complete: true },
    { key: 'backups', bytes: 500_000, within: '', complete: true },
  ],
}
const ENTRY = {
  name: 'nexnotes-2026-11-20-030000.zip', size: 2048, created: '2026-11-20T03:00:00+00:00', kind: 'scheduled', note: '', version: '0.1.0',
  uploaded: false, locked: false, readable: true, facts: { notes: 4, files: 1 },
}
const BRIEF = {
  name: ENTRY.name, created: ENTRY.created, kind: 'scheduled', note: '', version: '0.1.0', uploaded: false, database_ok: true, files_ok: true,
  damaged: [], too_new: false, blocked: '', blocked_text: '', usable: true, facts: { notes: 4, files: 1 },
  details: {
    would_add: 0, would_change: 0, would_remove: 1, notes_add: 2, notes_change: 1, notes_remove: 3,
    notes_add_titles: ['Recipe for bread', ''], notes_change_titles: ['Shopping list'], notes_remove_titles: ['Written later'],
  },
}
const backups = (list: unknown[]) => ({
  schedule: { every: 'daily', time: '03:00', keep: 7 }, zone: 'Europe/Berlin', last: list.length ? { created: ENTRY.created, size: 2048, kind: 'scheduled' } : null,
  count: list.length, kept: list.length, failure: null, running: false, restore_failure: null, restored: null, restore: 'restart', download_password: false,
  backups: list,
})

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      sent.push({ path, client: new Headers(init?.headers).get('X-Nexnotes-Client') })
      const answer = handler(init?.method ?? 'GET', path) ?? { status: 200, body: [] }
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
}

async function storageArea(list: unknown[]) {
  handler = (method, path) => {
    if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
    if (path === '/api/auth/me') return { status: 200, body: ME }
    if (path === '/api/server/storage') return { status: 200, body: OVERVIEW }
    if (path === '/api/server/storage/backups') return { status: 200, body: backups(list) }
    if (path.endsWith('/check') && method === 'POST') return { status: 200, body: BRIEF }
    return undefined
  }
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AuthProvider>
          <NexuiLanguage language={i18n.language}>
            <StorageArea />
          </NexuiLanguage>
        </AuthProvider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

describe.each(['en', 'de'] as const)('Server › Storage and backups (%s)', (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })

  it('NOTES-1 AC-5 the check of a backup names the notes that come, change and go', async () => {
    await storageArea([ENTRY])
    const check = [...box.querySelectorAll('button')].find((button) => button.textContent === SICHERUNG_TEXTS[language].backup.check)!
    await act(async () => check.click())
    await settle()
    const brief = box.querySelector('[data-testid="backup-brief"]')!
    expect(brief.textContent).toContain(i18n.t('server.restoreNotes', { add: 2, change: 1, remove: 3 }))
    expect(brief.textContent).toContain(i18n.t('server.restoreTitles.add', { titles: `Recipe for bread, ${i18n.t('server.untitled')}` }))
    expect(brief.textContent).toContain(i18n.t('server.restoreTitles.change', { titles: 'Shopping list' }))
    expect(brief.textContent).toContain(i18n.t('server.restoreTitles.remove', { titles: 'Written later' }))
    expect(brief.textContent).toContain(i18n.t('server.restoreTitles.own'))
    expect(brief.textContent).toContain(i18n.t('server.restoreChanges', { add: i18n.t('server.countFiles', { count: 0 }), change: i18n.t('server.countFiles', { count: 0 }), remove: i18n.t('server.countFiles', { count: 1 }) }))
  })

  it('NOTES-1 AC-11 the cards "Storage" and "Backup" of the module, over nexnotes\' own client', async () => {
    await storageArea([ENTRY])
    expect(box.querySelector('[data-card="storage"]')).not.toBeNull()
    expect(box.querySelector('[data-card="backup"], [data-card="backups"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="storage-parts"]')!.textContent).toContain(SICHERUNG_TEXTS[language].storage.parts.attachments)
    const asked = sent.filter((one) => one.path.startsWith('/api/server/storage'))
    expect(asked.length).toBeGreaterThanOrEqual(2)
    expect(asked.every((one) => one.client)).toBe(true)
    // The entry names its notes and files in nexnotes' words.
    const row = box.querySelector(`[data-testid="backup-${ENTRY.name}"]`)!
    expect(row.textContent).toContain(i18n.t('server.backupContent', { notes: i18n.t('server.countNotes', { count: 4 }), files: i18n.t('server.countFiles', { count: 1 }) }))
  })

  it('NOTES-1 AC-14 the card says what a backup holds and what it leaves out', async () => {
    await storageArea([ENTRY])
    expect(box.textContent).toContain(i18n.t('server.backupHolds'))
    expect(i18n.t('server.backupHolds')).toMatch(/NEXNOTES_SECRET_KEY/)
  })

  it('NOTES-1 AC-4 without backups "No backup yet." stands there once', async () => {
    await storageArea([])
    const never = SICHERUNG_TEXTS[language].backup.never
    expect(box.textContent!.split(never).length - 1).toBe(1)
  })
})
