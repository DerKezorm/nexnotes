/**
 * NOTES-5 on the pages: the tags in the sidebar by frequency (AC-2) with the first twenty and "Show all" (EC-5), the
 * page of a tag with count, own and shared notes, folder and date (AC-2, AC-3, EC-4), renaming with what changes and
 * what stays (AC-4), merging (AC-7), deleting (AC-5), "Save as smart folder" (AC-6), all in the head and "…" every list
 * has, the notes in the four looks with a view kept for the tag (NOTES-6). A small stand-in for the server answers the
 * tag routes.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import i18n from '../i18n'
import { registerSmartFolderSaver } from './actions'
import { forgetFolders } from '../folders/store'
import type { ListItem, ListView } from '../notes/list/api'
import { forgetListLook, saveListLook } from '../notes/list/look'
import type { TagInfo, TagList as Page } from './api'
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
      if (path === '/api/folders') return reply(200, { inbox: { id: 'in', count: 1 }, folders: [{ id: 'f1', parent_id: null, name: 'Shopping', icon: '', color: 'teal', position: 0, count: 1 }] })
      if (path === '/api/me/list-look') return reply(200, { list_style: body?.style ?? 'list', list_hints: body?.hints ?? true })
      const part = /^\/api\/tags\/([^/]+)\/(notes|stamp|view)$/.exec(path)
      if (part) {
        const name = part[1].replace(/^#/, '').toLowerCase()
        const page = pages[name] ?? empty(name)
        if (part[2] === 'stamp') return reply(200, { stamp: String(page.count) })
        if (part[2] === 'view') {
          views[name] = { ...(views[name] ?? page.view), ...(body as Partial<ListView>) }
          return reply(200, views[name])
        }
        return reply(200, { ...page, view: views[name] ?? page.view })
      }
      const one = /^\/api\/tags\/([^/]+)$/.exec(path)
      if (one) {
        const name = one[1].replace(/^#/, '').toLowerCase()
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

const VIEW: ListView = { mode: 'list', sort: 'updated', direction: 'desc', grouped: false }
let views: Record<string, ListView> = {}

function note(id: string, title: string, preview: string, updated: string, folder: string, owner?: { id: number; name: string }): ListItem {
  return { id, folder_id: folder, title, title_check: false, origin: '', preview, created_at: updated, updated_at: updated, pinned: false, color: '', icon: '', tasks: null, ...(owner ? { owner } : {}) }
}

function empty(name: string): Page {
  return { key: `tag:${name}`, view: VIEW, counts: { own: 0, shared: 0 }, items: [], tag: name, label: name, count: 0, mine: 0, others: [] }
}

const EINKAUF: Page = {
  key: 'tag:einkauf',
  view: VIEW,
  counts: { own: 2, shared: 1 },
  items: [
    note('n1', 'Saturday', 'Milk, tomatoes', TODAY, 'f1'),
    note('n2', 'Quick one', '', TODAY, 'in'),
    note('n3', 'Barbecue', 'Halloumi', '2026-11-09T10:00:00Z', 'lena-f', { id: 2, name: 'Lena' }),
  ],
  tag: 'einkauf',
  label: 'einkauf',
  count: 3,
  mine: 2,
  others: [{ id: 2, name: 'Lena', count: 1 }],
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

/** Opens the head's "…" of the tag. */
async function more(): Promise<void> {
  await click(q('[data-testid="tag-more"]')!)
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
  views = {}
  forgetTags()
  forgetFolders()
  forgetListLook()
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
    expect(q('[data-testid="list-head"] h1')?.textContent).toBe('#einkauf')
    expect(q('[data-testid="list-counts"]')?.textContent).toBe('3 notes, 1 of them from Lena')
    const rows = all('[data-testid="note-row"]')
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/notes/n1', '/notes/n2', '/notes/n3'])
    expect(all('[data-testid="note-folder"]').map((cell) => cell.textContent)).toEqual(['Shopping', 'Inbox', 'from Lena'])
    // Every note says when it last changed; an own one shows its folder's stripe, a shared one only whose it is.
    expect(rows.every((row) => /\d/.test(row.textContent ?? ''))).toBe(true)
    const boxes = all('[data-testid="note-row-box"]')
    expect(boxes.map((box) => box.querySelector(':scope > span[aria-hidden][style]') !== null)).toEqual([true, true, false])
    expect(rows[0].textContent).toContain('Milk, tomatoes')
    await click(rows[2])
    expect(where).toBe('/notes/n3')
  })

  it('NOTES-5 AC-3 NOTES-6 AC-1 AC-4 the page of a tag has the head, the menu "View" and the looks of every list', async () => {
    await show('/tags/einkauf')
    const head = q('[data-testid="list-head"]')!
    expect(head.querySelector('[data-testid="list-view"]')).not.toBeNull()
    expect(head.querySelector('[data-testid="tag-more"]')).not.toBeNull()
    // Sorting is kept for this tag on the server.
    await click(q('[data-testid="list-view"]')!)
    await click(q('[data-testid="list-sort-title"]')!)
    expect(calls.filter((call) => call.method === 'PUT' && call.path === '/api/tags/einkauf/view').map((call) => call.body)).toEqual([{ sort: 'title', direction: 'asc' }])
    expect(all('[data-testid="note-row"]').map((row) => row.getAttribute('href'))).toEqual(['/notes/n3', '/notes/n2', '/notes/n1'])
    // The look is the account's, for every list: cards here as anywhere.
    await act(async () => {
      await saveListLook({ style: 'cards' })
    })
    await settle()
    expect(q('[data-testid="note-list"]')?.getAttribute('data-style')).toBe('cards')
    expect(all('[data-testid="note-card"]')).toHaveLength(3)
    expect(all('[data-testid="note-folder"]').map((cell) => cell.textContent)).toEqual(['from Lena', 'Inbox', 'Shopping'])
  })

  it('NOTES-5 AC-4 the rename dialog says beforehand what changes and what stays, then renames', async () => {
    await show('/tags/einkauf')
    await more()
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
    await more()
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
    await more()
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
    pages = { grill: { ...empty('grill'), counts: { own: 0, shared: 1 }, count: 1, others: [{ id: 2, name: 'Lena', count: 1 }], items: [EINKAUF.items[2]] } }
    await show('/tags/grill')
    await more()
    expect(button('Rename').disabled).toBe(true)
    expect(button('Delete').disabled).toBe(true)
  })

  it('NOTES-5 AC-6 "Save as smart folder" hands over the condition "tag has …" and opens the new folder', async () => {
    await show('/tags/einkauf')
    await more()
    expect(q('[data-testid="tag-smart"]')).toBeNull()
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const saver = vi.fn(async () => '/smart/s1')
    registerSmartFolderSaver(saver)
    // Shown in another spelling than its key (EC-2): the condition carries the key.
    pages = { einkauf: { ...EINKAUF, label: 'Einkauf' } }
    await show('/tags/einkauf')
    await more()
    const save = q('[data-testid="tag-smart"]')!
    expect(save.textContent).toBe('Save as smart folder')
    await click(save)
    expect(saver).toHaveBeenCalledWith({ kind: 'tag', op: 'has', key: 'einkauf', label: 'Einkauf' }, '#Einkauf')
    expect(where).toBe('/smart/s1')
  })
})
