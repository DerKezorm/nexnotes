/**
 * NOTES-1 in the server tab: before a restore the question names what happens to the notes (numbers for all, the
 * first titles of the operator's own), and "No backups yet." stands there once, not twice.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { BackupBrief } from './api/client'
import i18n from './i18n'
import { bytes } from './lib/format'
import { AuthProvider } from './state/auth'

type Answer = { status: number; body: unknown }
let handler: (method: string, path: string) => Answer | undefined = () => undefined
let root: Root
let box: HTMLDivElement

const ME = {
  id: 1, name: 'tester', display_name: 'Tester', email: 'tester@example.com', role: 'operator', sign_in: 'password',
  language: '', two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0',
}
const SETTINGS = {
  public_url: '', password_login: true, two_factor_required: false, backup_schedule: 'daily', backup_keep: 7,
  smtp_host: '', smtp_port: 587, smtp_security: 'starttls', smtp_user: '', smtp_password_set: false, smtp_from: '',
  upload_max_mb: 100, history_days: 365, trash_days: 90, link_previews: true, share_links: true, mcp_enabled: true,
  ocr_languages: [], update_check: true, data_total: 1e12, data_used: 1e11, data_free: 9e11, data_on_share: false,
  nexnotes_used: 3_500_000, nexnotes_parts: { database: 1_000_000, attachments: 2_000_000, backups: 500_000, exports: 0, other: 0 },
}
const ENTRY = { name: 'nexnotes-backup-1.zip', size: 2048, created: '2026-11-20T03:00:00Z', kind: 'scheduled', note: '', notes: 4, files: 1, version: '0.1.0', uploaded: false }
const BRIEF: BackupBrief = {
  name: ENTRY.name, version: '0.1.0', created: ENTRY.created, kind: 'scheduled', notes: 4, files: 1, database_ok: true,
  files_ok: true, damaged: [], would_add: 0, would_change: 0, would_remove: 1, usable: true,
  notes_add: 2, notes_change: 1, notes_remove: 3,
  notes_add_titles: ['Recipe for bread', ''], notes_change_titles: ['Shopping list'], notes_remove_titles: ['Written later'],
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = handler(init?.method ?? 'GET', String(input)) ?? { status: 200, body: [] }
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

async function backupsCard(list: unknown[]) {
  handler = (method, path) => {
    if (path === '/api/setup') return { status: 200, body: { needs_setup: false, signed_in: true, code_required: true, version: '0.1.0', min_password: 12 } }
    if (path === '/api/auth/me') return { status: 200, body: ME }
    if (path === '/api/settings') return { status: 200, body: SETTINGS }
    if (path === '/api/backups' && method === 'POST') return { status: 201, body: ENTRY }
    if (path === '/api/backups') return { status: 200, body: list }
    if (path.endsWith('/check') && method === 'POST') return { status: 200, body: BRIEF }
    return undefined
  }
  const { BackupsCard, useServerSettings } = await import('./pages/settings/ServerCards')
  function Card() {
    return <BackupsCard server={useServerSettings()} />
  }
  await act(async () => root.render(<MemoryRouter><AuthProvider><Card /></AuthProvider></MemoryRouter>))
  await settle()
}

describe.each(['en', 'de'])('the server tab (%s)', (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })

  it('NOTES-1 AC-5 the question before a restore names the notes that come, change and go', async () => {
    await backupsCard([ENTRY])
    const restore = [...box.querySelectorAll('button')].find((button) => button.textContent === i18n.t('server.restore'))!
    await act(async () => restore.click())
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(i18n.t('server.restoreNotes', { add: 2, change: 1, remove: 3 }))
    expect(dialog.textContent).toContain(i18n.t('server.restoreTitles.add', { titles: `Recipe for bread, ${i18n.t('server.untitled')}` }))
    expect(dialog.textContent).toContain(i18n.t('server.restoreTitles.change', { titles: 'Shopping list' }))
    expect(dialog.textContent).toContain(i18n.t('server.restoreTitles.remove', { titles: 'Written later' }))
    expect(dialog.textContent).toContain(i18n.t('server.restoreTitles.own'))
  })

  it('NOTES-1 AC-11 the card shows what nexnotes takes, by part, and what is still free on the disk', async () => {
    await backupsCard([ENTRY])
    const lang = i18n.language
    const card = box.querySelector('[data-testid="data-folder"]')!
    expect(card.textContent).toContain(i18n.t('server.nexnotesUses'))
    expect(box.querySelector('[data-testid="nexnotes-used"]')!.textContent).toBe(bytes(3_500_000, lang))
    const parts = box.querySelector('[data-testid="nexnotes-parts"]')!.textContent!
    expect(parts).toContain(i18n.t('server.part', { name: i18n.t('server.parts.database'), size: bytes(1_000_000, lang) }))
    expect(parts).toContain(i18n.t('server.part', { name: i18n.t('server.parts.attachments'), size: bytes(2_000_000, lang) }))
    expect(parts).toContain(i18n.t('server.parts.backups'))
    // Parts that take nothing are left out.
    expect(parts).not.toContain(i18n.t('server.parts.exports'))
    expect(box.querySelector('[data-testid="disk-free"]')!.textContent).toBe(i18n.t('server.diskFree', { free: bytes(9e11, lang), total: bytes(1e12, lang) }))
    // The whole disk's use is no longer the headline of the card.
    expect(card.textContent).not.toContain(bytes(1e11, lang) + ' ')
    // The bar: nexnotes' share of the disk, then what else lies there.
    const bar = card.querySelector('[role="img"]')!
    const [own, other] = [...bar.children] as HTMLElement[]
    expect(parseFloat(own.style.width)).toBeCloseTo((3_500_000 / 1e12) * 100)
    expect(parseFloat(other.style.width)).toBeCloseTo(((1e11 - 3_500_000) / 1e12) * 100)
  })

  it('NOTES-1 AC-14 the card says what a backup holds and what it leaves out', async () => {
    await backupsCard([ENTRY])
    expect(box.textContent).toContain(i18n.t('server.backupHolds'))
    expect(i18n.t('server.backupHolds')).toMatch(/NEXNOTES_SECRET_KEY/)
  })

  it('NOTES-1 AC-11 a backup made here brings the numbers up to date at once', async () => {
    await backupsCard([ENTRY])
    const fetches = () => (fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit?][] } }).mock.calls.filter(([url, init]) => String(url) === '/api/settings' && (init?.method ?? 'GET') === 'GET').length
    const before = fetches()
    const now = [...box.querySelectorAll('button')].find((button) => button.textContent === i18n.t('server.backupNow'))!
    await act(async () => now.click())
    await settle()
    expect(fetches()).toBe(before + 1)
  })

  it('NOTES-1 AC-4 without backups "No backups yet." stands there once', async () => {
    await backupsCard([])
    expect(box.textContent!.split(i18n.t('server.noBackups')).length - 1).toBe(1)
  })
})
