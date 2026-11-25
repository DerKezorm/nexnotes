/**
 * NOTES-26 AC-3: "Make the guide again" under Settings › Appearance asks the server for a fresh guide in the language
 * of the page, says what it made with a way to open it, loads the folders again, and says why when it cannot.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { originText } from '../folders/origin'
import { whoText } from '../history/groups'
import i18n from '../i18n'
import { GuideCard } from './GuideCard'

type Call = { path: string; method: string; body: unknown }
let calls: Call[] = []
let reply: { status: number; body: unknown } = { status: 201, body: { id: 'f-1', name: 'Guide (2)' } }
let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  reply = { status: 201, body: { id: 'f-1', name: 'Guide (2)' } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      const found = path === '/api/guide' ? reply : { status: 200, body: { folders: [], inbox: null } }
      return new Response(JSON.stringify(found.body), { status: found.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
}

async function show(): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <GuideCard />
      </MemoryRouter>,
    ),
  )
  await settle()
}

const $ = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

describe('make the guide again (NOTES-26 AC-3)', () => {
  it('NOTES-26 AC-3 the button makes the guide in the language of the page and links to it', async () => {
    await i18n.changeLanguage('de')
    await show()
    expect($('guide-make')!.textContent).toBe('Anleitung neu anlegen')
    reply = { status: 201, body: { id: 'f-1', name: 'Anleitung (2)' } }
    await act(async () => $('guide-make')!.click())
    await settle()
    const made = calls.filter((call) => call.path === '/api/guide')
    expect(made).toEqual([{ path: '/api/guide', method: 'POST', body: { language: 'de' } }])
    expect($('guide-made')!.textContent).toContain('„Anleitung (2)“ ist angelegt.')
    expect($('guide-made')!.querySelector('a')!.getAttribute('href')).toBe('/folder/f-1')
    // That it worked is the kit's green box, as every card of the settings says it.
    expect($('guide-made')!.getAttribute('role')).toBe('status')
    expect($('guide-made')!.className).toContain('--nexui-ok')
    expect([$('guide-make')!.dataset.kind, $('guide-make')!.dataset.size]).toEqual(['secondary', 'md'])
    // The sidebar learns of the new folder.
    expect(calls.some((call) => call.path === '/api/folders' && call.method === 'GET')).toBe(true)
  })

  it('NOTES-26 AC-3 in English it asks for the English guide', async () => {
    await i18n.changeLanguage('en')
    await show()
    expect($('guide-make')!.textContent).toBe('Make the guide again')
    await act(async () => $('guide-make')!.click())
    await settle()
    expect(calls.find((call) => call.path === '/api/guide')!.body).toEqual({ language: 'en' })
    expect($('guide-made')!.textContent).toContain('“Guide (2)” is ready.')
  })

  it('NOTES-26 AC-5 a full storage is said, nothing is claimed as made', async () => {
    await i18n.changeLanguage('en')
    reply = { status: 507, body: { detail: { code: 'storage_limit_reached', message: 'The storage of the account is full.', used: 10, limit: 10 } } }
    await show()
    await act(async () => $('guide-make')!.click())
    await settle()
    expect($('guide-made')).toBeNull()
    expect(box.textContent).toContain(i18n.t('errors.storage_limit_reached'))
  })
})

describe('where the guide comes from (NOTES-26 AC-8)', () => {
  it('NOTES-26 AC-8 its first version is by nexnotes, its origin the guide', async () => {
    await i18n.changeLanguage('de')
    const t = i18n.t.bind(i18n) as (key: string, values?: Record<string, unknown>) => string
    expect(whoText([{ id: null, name: '', via: 'guide' }], t)).toBe('nexnotes · Anleitung')
    expect(originText('guide', t)).toBe('Aus der Anleitung von nexnotes')
    // NOTESIOS-23: the iOS app's quick ways say where they came from.
    expect(originText('widget', t)).toBe('Über das Widget')
    expect(originText('lockscreen', t)).toBe('Vom Sperrbildschirm')
    expect(originText('control', t)).toBe('Über Kontrollzentrum oder Aktionstaste')
    await i18n.changeLanguage('en')
    expect(whoText([{ id: null, name: '', via: 'guide' }], t)).toBe('nexnotes · Guide')
  })
})
