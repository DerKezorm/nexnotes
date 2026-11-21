/**
 * NOTES-5 on the pages: the tags in the sidebar by frequency (AC-2) with the first twenty and "Show all" (EC-5), the
 * page of a tag with count, own and shared notes, folder and date (AC-2, AC-3, EC-4), renaming with what changes and
 * what stays (AC-4), merging (AC-7), deleting (AC-5), "Save as smart folder" (AC-6). A small stand-in for the server
 * answers the tag routes.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../i18n'
import { registerSmartFolderSaver } from './actions'
import type { TagInfo, TagPage as Page } from './api'
import { forgetTags } from './store'
import { TagSection } from './TagSection'
import { AllTagsPage, TagPage } from './TagPage'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let tags: TagInfo[] = []
let pages: Record<string, Page> = {}
let renameAnswer: (body: Record<string, unknown>) => [number, unknown] = () => [200, {}]

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function serve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      const path = decodeURIComponent(url.pathname)
      calls.push({ method, path, body })
      if (path === '/api/tags') return reply(200, { tags, total: tags.length })
      const one = /^\/api\/tags\/(.+)$/.exec(path)
      if (one) {
        const name = one[1].replace(/^#/, '').toLowerCase()
        if (method === 'GET') return reply(200, pages[name] ?? { key: name, label: name, count: 0, mine: 0, others: [], notes: [] })
        if (method === 'PUT') {
          const [status, answer] = renameAnswer(body ?? {})
          return reply(status, answer)
        }
        if (method === 'DELETE') return reply(200, { changed: pages[name]?.mine ?? 0, kept: 1 })
      }
      return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    }),
  )
}

const TODAY = new Date().toISOString()

const EINKAUF: Page = {
  key: 'einkauf',
  label: 'einkauf',
  count: 3,
  mine: 2,
  others: [{ id: 2, name: 'Lena', count: 1 }],
  notes: [
    { id: 'n1', title: 'Saturday', preview: 'Milk, tomatoes', updated_at: TODAY, mine: true, folder: { id: 'f1', name: 'Shopping', inbox: false }, owner: null },
    { id: 'n2', title: 'Quick one', preview: '', updated_at: TODAY, mine: true, folder: { id: 'in', name: '', inbox: true }, owner: null },
    { id: 'n3', title: 'Barbecue', preview: 'Halloumi', updated_at: '2026-11-09T10:00:00Z', mine: false, folder: null, owner: { id: 2, name: 'Lena' } },
  ],
}

let root: Root | null = null
let host: HTMLDivElement
let where = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname
  }, [location])
  return null
}

async function show(path: string): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <TagSection />
        <Routes>
          <Route path="/tags" element={<AllTagsPage />} />
          <Route path="/tags/:tag" element={<TagPage />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

function all(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((one) => one.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** The dialog's own button (the page has a "Rename" too). */
function submit(): HTMLButtonElement {
  return q<HTMLButtonElement>('[data-testid="tag-rename"] button[type="submit"]')!
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  calls = []
  forgetTags()
  tags = [
    { key: 'einkauf', label: 'einkauf', count: 3 },
    { key: 'bad', label: 'Bad', count: 2 },
    { key: 'grill', label: 'grill', count: 1 },
  ]
  pages = { einkauf: EINKAUF }
  renameAnswer = (body) => [200, { label: String(body.name), key: String(body.name).toLowerCase(), changed: 2, kept: 1 }]
  registerSmartFolderSaver(null)
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('tags on the pages', () => {
  it('NOTES-5 AC-2 EC-4 the sidebar lists every tag the account sees, the most frequent first', async () => {
    await show('/elsewhere')
    expect(all('[data-testid="sidebar-tag"]').map((tag) => tag.textContent)).toEqual(['#einkauf', '#Bad', '#grill'])
    expect(all('[data-testid="sidebar-tag"]').map((tag) => tag.getAttribute('href'))).toEqual(['/tags/einkauf', '/tags/Bad', '/tags/grill'])
    expect(q('[data-testid="sidebar-tags-all"]')).toBeNull()
    await click(all('[data-testid="sidebar-tag"]')[0])
    expect(where).toBe('/tags/einkauf')
  })

  it('NOTES-5 EC-5 with 500 tags the sidebar shows the first twenty and "Show all" leads to all of them', async () => {
    tags = Array.from({ length: 500 }, (_, index) => ({ key: `t${index}`, label: `t${index}`, count: 500 - index }))
    await show('/elsewhere')
    const shown = all('[data-testid="sidebar-tag"]')
    expect(shown).toHaveLength(20)
    expect(shown[0].textContent).toBe('#t0')
    expect(shown[19].textContent).toBe('#t19')
    const more = q('[data-testid="sidebar-tags-all"]')!
    expect(more.textContent).toBe('Show all (500)')
    await click(more)
    expect(where).toBe('/tags')
    expect(all('[data-testid="all-tags-tag"]')).toHaveLength(500)
  })

  it('NOTES-5 AC-2 the sidebar has no tags section while there are none', async () => {
    tags = []
    await show('/elsewhere')
    expect(q('[data-testid="sidebar-tags"]')).toBeNull()
  })

  it('NOTES-5 AC-2 AC-3 EC-4 the page of a tag names the count and shows own and shared notes with folder and date', async () => {
    await show('/tags/einkauf')
    expect(q('h1')?.textContent).toBe('#einkauf')
    expect(q('[data-testid="tag-count"]')?.textContent).toBe('3 notes, 1 of them from Lena')
    const rows = all('[data-testid="tag-note"]')
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/notes/n1', '/notes/n2', '/notes/n3'])
    const places = all('[data-testid="tag-note-where"]').map((cell) => cell.textContent ?? '')
    expect(places[0]).toMatch(/^Shopping · \d/)
    expect(places[1]).toMatch(/^Inbox · \d/)
    expect(places[2]).toMatch(/^from Lena · /)
    expect(rows[0].textContent).toContain('Milk, tomatoes')
    await click(rows[2])
    expect(where).toBe('/notes/n3')
  })

  it('NOTES-5 AC-4 the rename dialog says beforehand what changes and what stays, then renames', async () => {
    await show('/tags/einkauf')
    await click(button('Rename'))
    expect(q('[data-testid="tag-rename-says"]')?.textContent).toBe('Changes 2 of your notes. In the note from Lena, #einkauf stays as it is.')
    const input = q<HTMLInputElement>('[data-testid="tag-rename"] input')!
    expect(input.value).toBe('einkauf')
    await typeInto(input, 'two words')
    expect(q('[role="alert"]')?.textContent).toContain('A tag is made of letters')
    expect(submit().disabled).toBe(true)
    await typeInto(input, '#einkaufen')
    expect(input.value).toBe('einkaufen')
    expect(submit().textContent).toBe('Rename')
    await click(submit())
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/tags/einkauf', body: { name: 'einkaufen', merge: false } }])
    expect(where).toBe('/tags/einkaufen')
    expect(q('[data-testid="tag-rename"]')).toBeNull()
  })

  it('NOTES-5 AC-7 renaming onto a tag that exists asks once more, then merges', async () => {
    renameAnswer = (body) =>
      body.merge
        ? [200, { label: 'Bad', key: 'bad', changed: 2, kept: 1 }]
        : [409, { detail: { code: 'tag_exists', message: 'This tag exists already.', label: 'Bad', count: 2 } }]
    await show('/tags/einkauf')
    await click(button('Rename'))
    await typeInto(q<HTMLInputElement>('[data-testid="tag-rename"] input')!, 'bad')
    await click(submit())
    expect(q('[data-testid="tag-merge-ask"]')?.textContent).toBe('#Bad exists already. Both become one tag.')
    expect(where).toBe('/tags/einkauf')
    expect(submit().textContent).toBe('Merge')
    await click(submit())
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
      { name: 'bad', merge: false },
      { name: 'bad', merge: true },
    ])
    expect(where).toBe('/tags/Bad')
  })

  it('NOTES-5 AC-5 deleting asks with the numbers, then takes the tag out of the own notes', async () => {
    await show('/tags/einkauf')
    await click(button('Delete'))
    expect(q('[data-testid="tag-delete-says"]')?.textContent).toBe(
      '#einkauf goes from 2 of your notes; the rest of the text stays. In the note from Lena, #einkauf stays as it is.',
    )
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="tag-delete"] button')).find((one) => one.textContent === 'Delete')!
    await click(confirm)
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/tags/einkauf')).toBe(true)
    expect(where).toBe('/tags')
  })

  it('NOTES-5 AC-4 a tag only in notes of others cannot be renamed or deleted from here', async () => {
    pages = { grill: { key: 'grill', label: 'grill', count: 1, mine: 0, others: [{ id: 2, name: 'Lena', count: 1 }], notes: [EINKAUF.notes[2]] } }
    await show('/tags/grill')
    expect(button('Rename').disabled).toBe(true)
    expect(button('Delete').disabled).toBe(true)
  })

  it('NOTES-5 AC-6 "Save as smart folder" hands over the condition "tag has …" and opens the new folder', async () => {
    await show('/tags/einkauf')
    expect(q('[data-testid="tag-smart"]')).toBeNull()
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const saver = vi.fn(async () => '/smart/s1')
    registerSmartFolderSaver(saver)
    // Shown in another spelling than its key (EC-2): the condition carries the key.
    pages = { einkauf: { ...EINKAUF, label: 'Einkauf' } }
    await show('/tags/einkauf')
    const save = q('[data-testid="tag-smart"]')!
    expect(save.textContent).toBe('Save as smart folder')
    await click(save)
    expect(saver).toHaveBeenCalledWith({ kind: 'tag', op: 'has', key: 'einkauf', label: 'Einkauf' }, '#Einkauf')
    expect(where).toBe('/smart/s1')
  })
})
