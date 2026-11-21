/**
 * NOTES-17 in the interface: the dialog with its four ways (drawing N17-Export), the size before a ZIP, one note as a
 * file at once, a folder or everything in the background, the notices while it runs and when it is ready or broke
 * off, and the ready exports to fetch again. A stand-in for the server answers the export routes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import i18n from '../i18n'
import { accountChanged } from '../state/account'
import type { ExportJob } from './api'
import { ExportDialog } from './ExportDialog'
import { ExportNotices } from './ExportNotices'
import { POLL_MS, refreshExports } from './watch'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let jobs: ExportJob[] = []
let fail: ((call: Call) => { status: number; body: unknown } | undefined) | null = null
let saved: { name: string; href: string }[] = []

function job(extra: Partial<ExportJob> = {}): ExportJob {
  return {
    id: 'j1', folder_id: 'h', label: 'Haushalt', filename: 'Haushalt.zip', status: 'queued', problem: '', estimate: 2_254_857_830,
    size: 0, notes: 12, created_at: '2026-11-21T10:00:00+00:00', finished_at: null, expires_at: null, seen: false, ...extra,
  }
}

function answer(call: Call): Response {
  const refused = fail?.(call)
  if (refused) return new Response(JSON.stringify(refused.body), { status: refused.status, headers: { 'Content-Type': 'application/json' } })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (call.path.startsWith('/api/export/estimate')) return json({ bytes: 2_254_857_830, notes: 12 })
  if (call.method === 'GET' && call.path === '/api/export/jobs') return json(jobs)
  if (call.method === 'POST' && call.path === '/api/export/jobs') {
    const made = job({ id: `j${jobs.length + 1}`, folder_id: (call.body?.folder_id as string | null) ?? null, label: call.body?.folder_id ? 'Haushalt' : '' })
    jobs = [made, ...jobs]
    return json(made, 202)
  }
  const one = /^\/api\/export\/jobs\/([^/]+)\/(seen|restart)$/.exec(call.path)
  if (one && call.method === 'POST') {
    if (one[2] === 'seen') {
      jobs = jobs.map((item) => (item.id === one[1] ? { ...item, seen: true } : item))
      return json(jobs.find((item) => item.id === one[1]))
    }
    const made = job({ id: 'again', status: 'queued' })
    jobs = [made, ...jobs.map((item) => (item.id === one[1] ? { ...item, seen: true } : item))]
    return json(made, 202)
  }
  const note = /^\/api\/export\/notes\/([^/]+)\/(markdown|pdf)$/.exec(call.path)
  if (note) {
    const name = note[2] === 'pdf' ? 'Sofa%20ausmessen.pdf' : 'Sofa%20ausmessen.md'
    return new Response(note[2] === 'pdf' ? '%PDF-1.7' : '# Sofa', {
      status: 200,
      headers: { 'Content-Type': note[2] === 'pdf' ? 'application/pdf' : 'text/markdown', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` },
    })
  }
  return json({ detail: { code: 'not_found', message: 'Not found.' } }, 404)
}

let root: Root
let box: HTMLDivElement

async function settle(): Promise<void> {
  for (let i = 0; i < 15; i++) await act(async () => await Promise.resolve())
}

const button = (text: string) => [...document.querySelectorAll<HTMLElement>('button, a')].find((element) => element.textContent?.trim() === text)!
const radios = () => [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')]
const optionText = (input: HTMLInputElement) => input.closest('label')!.querySelector('span span')!.textContent

function click(element: Element) {
  act(() => void (element as HTMLElement).click())
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  jobs = []
  fail = null
  saved = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', path: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
      calls.push(call)
      return answer(call)
    }),
  )
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, href: this.getAttribute('href') ?? '' })
  })
  accountChanged()
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  accountChanged()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openDialog(props: Parameters<typeof ExportDialog>[0]): Promise<void> {
  await act(async () => root.render(null))
  await act(async () => root.render(<ExportDialog {...props} />))
  await settle()
}

describe('NOTES-17 the export dialog', () => {
  it('NOTES-17 AC-7 a note offers four ways; a folder or everything names the size before', async () => {
    const onClose = vi.fn()
    await openDialog({ note: { id: 'n1', title: 'Sofa ausmessen' }, folder: { id: 'h', name: 'Haushalt' }, onClose })
    expect(radios().map(optionText)).toEqual(['This note as Markdown', 'This note as PDF', 'Folder “Haushalt” as ZIP', 'Export everything'])
    expect(radios()[0].checked).toBe(true)
    expect(document.querySelector('[data-testid="export-estimate"]')).toBeNull()
    click(radios()[2])
    await settle()
    expect(calls.some((call) => call.path === '/api/export/estimate?folder_id=h')).toBe(true)
    const status = document.querySelector('[data-testid="export-estimate"]')!.textContent!
    expect(status).toContain('About 2.1 GB, 12 notes.')
    expect(status).toContain('runs in the background')
    expect(status).toContain('Locked notes come with their title and a note only.')
    click(radios()[3])
    await settle()
    expect(calls.some((call) => call.path === '/api/export/estimate')).toBe(true)
  })

  it('NOTES-17 AC-1 "as Markdown" saves the file the server names', async () => {
    const onClose = vi.fn()
    await openDialog({ note: { id: 'n1', title: 'Sofa ausmessen' }, onClose })
    click(button('Start export'))
    await settle()
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/export/notes/n1/markdown' })
    expect(saved).toEqual([{ name: 'Sofa ausmessen.md', href: 'blob:export' }])
    expect(onClose).toHaveBeenCalled()
  })

  it('NOTES-17 AC-2 "as PDF" saves the PDF; when it cannot be set, the dialog says so and stays', async () => {
    const onClose = vi.fn()
    await openDialog({ note: { id: 'n1', title: 'Sofa ausmessen' }, onClose })
    click(radios()[1])
    click(button('Start export'))
    await settle()
    expect(saved).toEqual([{ name: 'Sofa ausmessen.pdf', href: 'blob:export' }])
    onClose.mockClear()
    saved = []
    fail = (call) => (call.path.endsWith('/pdf') ? { status: 500, body: { detail: { code: 'typeset_failed', message: '' } } } : undefined)
    click(button('Start export'))
    await settle()
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The PDF could not be made.')
    expect(onClose).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('NOTES-17 AC-3 AC-4 a folder or everything starts in the background and the dialog closes at once', async () => {
    const onClose = vi.fn()
    await openDialog({ folder: { id: 'h', name: 'Haushalt' }, onClose })
    expect(radios().map(optionText)).toEqual(['Folder “Haushalt” as ZIP', 'Export everything'])
    click(button('Start export'))
    await settle()
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ path: '/api/export/jobs', body: { folder_id: 'h' } })
    expect(onClose).toHaveBeenCalledTimes(1)
    await openDialog({ onClose })
    expect(radios().map(optionText)).toEqual(['Export everything'])
    click(button('Start export'))
    await settle()
    expect(calls.filter((call) => call.method === 'POST').at(-1)).toMatchObject({ path: '/api/export/jobs', body: { folder_id: null } })
  })

  it('NOTES-17 AC-4 the inbox is named as such', async () => {
    await openDialog({ folder: { id: 'i', name: '', inbox: true }, onClose: vi.fn() })
    expect(radios().map(optionText)[0]).toBe('Folder “Inbox” as ZIP')
  })

  it('NOTES-17 AC-8 ready exports stand in the dialog to be fetched again', async () => {
    jobs = [job({ status: 'ready', size: 12_582_912, seen: true, expires_at: '2026-11-22T10:00:00+00:00' })]
    await openDialog({ onClose: vi.fn() })
    const ready = document.querySelector('[data-testid="export-ready"]')!
    expect(ready.textContent).toContain('Haushalt.zip · 12.0 MB')
    const link = ready.querySelector<HTMLAnchorElement>('a')!
    expect(link.getAttribute('href')).toBe('/api/export/jobs/j1/download')
    expect(link.getAttribute('download')).toBe('Haushalt.zip')
  })
})

describe('NOTES-17 the notices of exports', () => {
  async function renderNotices(): Promise<void> {
    await act(async () => root.render(<ExportNotices />))
    await settle()
  }

  it('NOTES-17 AC-7 a running export says so, and a notice comes when the ZIP is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    jobs = [job({ status: 'running' })]
    await renderNotices()
    expect(document.querySelector('[data-testid="export-running"]')!.textContent).toBe('Export “Haushalt” runs in the background …')
    jobs = [job({ status: 'ready', size: 12_582_912, finished_at: '2026-11-21T10:05:00+00:00' })]
    await act(async () => void vi.advanceTimersByTime(POLL_MS))
    await settle()
    expect(document.querySelector('[data-testid="export-running"]')).toBeNull()
    const notice = document.querySelector('[data-testid="export-ready"]')!
    expect(notice.textContent).toContain('Your export “Haushalt” is ready (12.0 MB). You can download it for 24 hours.')
    const link = notice.querySelector<HTMLAnchorElement>('a[download]')!
    expect(link.getAttribute('href')).toBe('/api/export/jobs/j1/download')
    // Fetching it is seeing it: the notice goes, on every device.
    link.addEventListener('click', (event) => event.preventDefault())
    act(() => void link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/export/jobs/j1/seen')).toBe(true)
    expect(document.querySelector('[data-testid="export-ready"]')).toBeNull()
  })

  it('NOTES-17 AC-7 nothing to tell, nothing shown; it stops asking once nothing runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    jobs = [job({ status: 'ready', seen: true })]
    await renderNotices()
    expect(document.querySelector('[data-testid="export-notices"]')).toBeNull()
    const asked = calls.length
    await act(async () => void vi.advanceTimersByTime(POLL_MS * 5))
    expect(calls.length).toBe(asked)
  })

  it('NOTES-17 EC-2 a second export of the member waits, and says so', async () => {
    jobs = [job({ id: 'j2', status: 'queued', label: 'Arbeit' }), job({ status: 'running' })]
    await renderNotices()
    const lines = [...document.querySelectorAll('[data-testid="export-running"]')].map((element) => element.textContent)
    expect(lines).toEqual(['Export “Arbeit” waits until your other export is done …', 'Export “Haushalt” runs in the background …'])
  })

  it('NOTES-17 EC-6 an export broken off by a restart says so and starts again', async () => {
    jobs = [job({ status: 'failed', problem: 'interrupted', folder_id: null, label: '' })]
    await renderNotices()
    const notice = document.querySelector('[data-testid="export-failed"]')!
    expect(notice.textContent).toContain('The export “Everything” broke off because the server started anew.')
    click(button('Start again'))
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/export/jobs/j1/restart')).toBe(true)
    expect(document.querySelector('[data-testid="export-failed"]')).toBeNull()
    expect(document.querySelector('[data-testid="export-running"]')!.textContent).toContain('waits')
  })

  it('NOTES-17 EC-7 a disk too full says why; put away, it does not come again', async () => {
    jobs = [job({ status: 'failed', problem: 'disk_full' })]
    await renderNotices()
    expect(document.querySelector('[data-testid="export-failed"]')!.textContent).toContain('the server has not enough room for the ZIP')
    click(document.querySelector('[data-testid="export-failed"] button[aria-label="Close"]')!)
    await settle()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/export/jobs/j1/seen')).toBe(true)
    expect(document.querySelector('[data-testid="export-failed"]')).toBeNull()
  })

  it('NOTES-17 NOTES-2 another account in the tab sees nothing of the exports before', async () => {
    jobs = [job({ status: 'ready', size: 100 })]
    await renderNotices()
    expect(document.querySelector('[data-testid="export-ready"]')).not.toBeNull()
    jobs = []
    act(() => accountChanged())
    expect(document.querySelector('[data-testid="export-ready"]')).toBeNull()
    await act(async () => void (await refreshExports()))
    expect(document.querySelector('[data-testid="export-notices"]')).toBeNull()
  })
})
