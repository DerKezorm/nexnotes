/**
 * NOTES-9 on the page: hits while typing with marks and a count (AC-1), filters as honey chips (AC-4), from a hit to
 * its place in the note (AC-5), nothing found (EC-2), many hits loaded on (EC-4), odd input (EC-5), a list that follows
 * changes (EC-6), the keys and the phone.
 *
 * A small stand-in for the server answers `/api/search` from a list of notes; what it finds is plain substring work,
 * the real rules (parts of words, umlauts, phrases) are the server's and tested there.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'

import { forgetFolders } from '../folders/store'
import i18n from '../i18n'
import type { Hit, Piece } from './api'
import { NO_CONDITIONS, periodRange, readConditions, toQuery, writeConditions } from './conditions'
import { findInText, jumpToHit } from './jump'
import { SearchEntry } from './register'
import { registerAttachmentOpener, registerSmartFolderSave } from './registry'
import { REFRESH_MS, SearchPage } from './SearchPage'

// ---- The stand-in server -------------------------------------------------------------------------------------------

type Stored = { id: string; title: string; text: string; folder: string; updated: string; attachment?: Hit['attachment']; icon?: string; color?: string }
type Call = { path: string; params: URLSearchParams }

let calls: Call[] = []
let stored: Stored[] = []
let tags = [{ label: 'urlaub', key: 'urlaub', count: 3 }, { label: 'bad', key: 'bad', count: 1 }]
/** Answers held back until released: to send an old answer after a newer one. */
let holdNext: ((release: () => void) => void) | null = null
const INBOX = 'inbox-1'
const FOLDERS = [
  { id: 'home', name: 'Haushalt', parent_id: null, icon: '', color: '', position: null, count: 2 },
  { id: 'power', name: 'Strom', parent_id: 'home', icon: '', color: '', position: null, count: 1 },
  { id: 'work', name: 'Arbeit', parent_id: null, icon: '', color: '', position: null, count: 1 },
]

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function pieces(text: string, words: string[]): Piece[] {
  const lower = text.toLowerCase()
  const out: Piece[] = []
  let at = 0
  while (at < text.length) {
    let next = -1
    let word = ''
    for (const candidate of words) {
      const found = lower.indexOf(candidate, at)
      if (found >= 0 && (next < 0 || found < next)) {
        next = found
        word = candidate
      }
    }
    if (next < 0) break
    if (next > at) out.push({ text: text.slice(at, next), hit: false })
    out.push({ text: text.slice(next, next + word.length), hit: true })
    at = next + word.length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

function subtree(id: string): string[] {
  return [id, ...FOLDERS.filter((folder) => folder.parent_id === id).flatMap((folder) => subtree(folder.id))]
}

function answerSearch(params: URLSearchParams): Response {
  const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const folder = params.get('folder_id')
  const tag = params.get('tag')
  // The server's refusals (backend `services/search.py`): no tag in the filter, more than sixteen words.
  if (tag && !/[\p{L}\p{Extended_Pictographic}]/u.test(tag)) return reply(422, { detail: { code: 'search_tag_invalid', message: 'This is not a tag.' } })
  if (words.length > 16) return reply(422, { detail: { code: 'search_too_many_terms', message: 'Too many.', maximum: 16 } })
  const since = params.get('since')
  const match = (note: Stored, filtered: boolean) => {
    const all = `${note.title} ${note.text}`.toLowerCase()
    if (!words.every((word) => all.includes(word))) return false
    if (!filtered) return true
    if (folder && !subtree(folder).includes(note.folder)) return false
    if (tag && !all.includes(`#${tag.toLowerCase()}`)) return false
    if (since && note.updated < since) return false
    return true
  }
  const found = stored.filter((note) => match(note, true))
  const offset = Number(params.get('offset') ?? 0)
  const limit = Number(params.get('limit') ?? 50)
  const items: Hit[] = found.slice(offset, offset + limit).map((note) => ({
    id: note.id,
    title: note.title,
    title_parts: pieces(note.title, words),
    icon: note.icon ?? '',
    color: note.color ?? '',
    excerpt: pieces(note.text, words),
    where: note.attachment ? 'attachment' : 'text',
    attachment: note.attachment ?? null,
    jump: words.length ? { text: words[0], nth: 0 } : null,
    folder: note.folder === INBOX ? { id: INBOX, name: '', inbox: true } : { id: note.folder, name: FOLDERS.find((f) => f.id === note.folder)?.name ?? '', inbox: false },
    owner_id: 1,
    created_at: note.updated,
    updated_at: note.updated,
  }))
  const filtered = Boolean(folder || tag || since)
  return reply(200, {
    total: found.length,
    offset,
    items,
    unfiltered: found.length === 0 && filtered ? stored.filter((note) => match(note, false)).length : null,
    terms: words,
    tags: [],
  })
}

async function serve(url: string): Promise<Response> {
  const parsed = new URL(url, 'http://localhost')
  calls.push({ path: parsed.pathname, params: parsed.searchParams })
  if (parsed.pathname === '/api/folders') return reply(200, { inbox: { id: INBOX, count: 0 }, folders: FOLDERS })
  if (parsed.pathname === '/api/tags') return reply(200, { tags, total: tags.length })
  if (parsed.pathname === '/api/search') {
    const hold = holdNext
    holdNext = null
    if (hold) await new Promise<void>((release) => hold(release))
    return answerSearch(parsed.searchParams)
  }
  return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
}

// ---- Rendering -----------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement
let where = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.pathname + location.search
  }, [location])
  return null
}

function Editor() {
  // The note's text arrives a moment after the page (over the live connection).
  useEffect(() => {
    const timer = setTimeout(() => {
      const editor = document.createElement('div')
      editor.className = 'ProseMirror'
      editor.innerHTML = '<p>Die rechnung vom März.</p><p>Noch eine <strong>rech</strong>nung im <em>Text</em>.</p>'
      document.getElementById('editor-box')?.appendChild(editor)
    }, 40)
    return () => clearTimeout(timer)
  }, [])
  return <div id="editor-box" data-testid="editor" />
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/** Long enough for the pause after typing and the answer. */
const answered = () => settle(200)

async function render(path: string): Promise<void> {
  window.history.replaceState({ idx: 0 }, '', path)
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <BrowserRouter>
        <Where />
        <SearchEntry />
        <Routes>
          <Route path="/" element={<div data-testid="home" />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/notes/:noteId" element={<Editor />} />
        </Routes>
      </BrowserRouter>,
    )
  })
  await answered()
}

const $ = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
const $$ = (testId: string) => Array.from(box.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLElement[]

async function type(value: string): Promise<void> {
  const input = $('search-field') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(target: Element | Window, key: string, extra: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  })
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

const searches = () => calls.filter((call) => call.path === '/api/search')
const marks = (element: Element | null) => Array.from(element?.querySelectorAll('mark') ?? []).map((mark) => mark.textContent)

beforeEach(async () => {
  calls = []
  holdNext = null
  stored = [
    { id: 'n1', title: 'Nebenkosten 2026', text: 'Die Stromrechnung kam am 12. Nov. #haushalt', folder: 'home', updated: '2026-11-17T10:00:00Z' },
    { id: 'n2', title: 'Rechnungen Handwerker', text: 'Fliesen und Sanitär #bad', folder: 'power', updated: '2026-11-16T10:00:00Z' },
    { id: 'n3', title: 'Einkauf', text: 'Milch und Brot', folder: INBOX, updated: '2026-11-15T10:00:00Z' },
    { id: 'n4', title: 'Kostenübersicht Q4', text: 'Hotelrechnungen nachreichen #urlaub', folder: 'work', updated: '2025-01-01T10:00:00Z' },
  ]
  tags = [{ label: 'urlaub', key: 'urlaub', count: 3 }, { label: 'bad', key: 'bad', count: 1 }]
  forgetFolders()
  vi.stubGlobal('fetch', vi.fn((url: string) => serve(url)))
  await i18n.changeLanguage('de')
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  registerSmartFolderSave(null)
  registerAttachmentOpener(null)
  document.body.innerHTML = ''
})

// ---- AC-1 ------------------------------------------------------------------------------------------------------

describe('NOTES-9 search page', () => {
  it('NOTES-9 AC-1 shows hits while typing, the place marked in title and excerpt, the count above', async () => {
    await render('/search')
    expect($('search-hint')).not.toBeNull()
    await type('rechn')
    // Before the answer: nothing asked yet for every single letter, then once after the pause.
    await answered()
    expect(searches().at(-1)!.params.get('q')).toBe('rechn')
    expect($('search-count')!.textContent).toBe('3 Treffer')
    const hits = $$('search-hit')
    expect(hits).toHaveLength(3)
    expect(marks(hits[0])).toEqual(['rechn'])
    expect(hits[0].textContent).toContain('Nebenkosten 2026')
    expect(hits[0].textContent).toContain('Haushalt')
    expect(marks(hits[1].querySelector('[data-testid="search-hit-title"]'))).toEqual(['Rechn'])
    expect(where).toBe('/search?q=rechn')
    // Typing on narrows at once.
    await type('rechn hotel')
    await answered()
    expect($$('search-hit')).toHaveLength(1)
    expect($('search-count')!.textContent).toBe('1 Treffer')
  })

  it('NOTES-3 AC-18 a hit shows the symbol of its note before the title, in the color of the note', async () => {
    stored = stored.map((note, index) => (index === 0 ? { ...note, icon: 'receipt', color: 'green' } : note))
    await render('/search')
    await type('rechn')
    await answered()
    const marks = $$('search-hit').map((hit) => hit.querySelector('[data-testid="note-icon"]')?.getAttribute('data-icon') ?? '')
    expect(marks.filter(Boolean)).toEqual(['receipt'])
    const drawn = $$('search-hit').find((hit) => hit.querySelector('[data-testid="note-icon"]'))!.querySelector('svg') as SVGElement
    expect(drawn.style.color).toBe('rgb(74, 222, 128)')
  })

  it('NOTES-9 AC-1 an answer that comes late never replaces a newer one', async () => {
    await render('/search')
    let release: () => void = () => undefined
    holdNext = (go) => {
      release = go
    }
    await type('milch')
    await answered()
    await type('rechn')
    await answered()
    expect($$('search-hit')).toHaveLength(3)
    release()
    await answered()
    expect($$('search-hit')).toHaveLength(3)
    expect($('search-count')!.textContent).toBe('3 Treffer')
  })

  // ---- AC-4 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 AC-4 narrows to a folder with its subfolders, a tag and a period; active chips are honey', async () => {
    await render('/search?q=rechn')
    expect($('filter-folder')!.textContent).toBe('Alle Ordner')
    expect($('filter-folder')!.className).not.toContain('border-accent-500')
    await click($('filter-folder'))
    await click($('filter-folder-home'))
    await answered()
    expect(searches().at(-1)!.params.get('folder_id')).toBe('home')
    expect($('filter-folder')!.textContent).toBe('In: Haushalt')
    expect($('filter-folder')!.className).toContain('border-accent-500')
    // Haushalt and its subfolder Strom.
    expect($$('search-hit').map((hit) => hit.getAttribute('data-hit'))).toEqual(['n1', 'n2'])

    await click($('filter-tag'))
    await settle()
    const tagMenu = $('filter-tag-menu')!
    expect(tagMenu.textContent).toContain('#urlaub')
    await click(Array.from(tagMenu.querySelectorAll('button')).find((button) => button.textContent?.includes('#bad'))!)
    await answered()
    expect(searches().at(-1)!.params.get('tag')).toBe('bad')
    expect($('filter-tag')!.textContent).toBe('#bad')
    expect($('filter-tag')!.className).toContain('border-accent-500')
    expect($$('search-hit').map((hit) => hit.getAttribute('data-hit'))).toEqual(['n2'])

    await click($('filter-period'))
    await click(Array.from($('filter-period-menu')!.querySelectorAll('button')).find((button) => button.textContent === 'Letzte 12 Monate')!)
    await answered()
    const since = searches().at(-1)!.params.get('since')!
    const days = (Date.now() - new Date(since).getTime()) / 86_400_000
    expect(days).toBeGreaterThan(363)
    expect(days).toBeLessThan(366)
    expect($('filter-period')!.textContent).toBe('Letzte 12 Monate')
    expect($('filter-period')!.className).toContain('border-accent-500')
    expect(where).toBe('/search?q=rechn&folder=home&tag=bad&period=year')
  })

  it('NOTES-9 AC-4 a tag can be typed, and filters alone search without words', async () => {
    await render('/search')
    await click($('filter-tag'))
    const input = $('filter-tag-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '#urlaub')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.form!.requestSubmit()
    })
    await answered()
    expect(searches().at(-1)!.params.get('tag')).toBe('urlaub')
    expect($$('search-hit').map((hit) => hit.getAttribute('data-hit'))).toEqual(['n4'])
  })

  // ---- AC-5 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 AC-5 opening a hit jumps to the place in the note and marks it', async () => {
    await render('/search?q=rechn')
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    await click($$('search-hit')[0])
    expect(where).toBe('/notes/n1')
    await settle(120)
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].textContent).toBe('Die rechnung vom März.')
    expect(scrolled[0].hasAttribute('data-search-hit')).toBe(true)
  })

  it('NOTES-9 AC-5 finds the how-manieth place, also across marks', () => {
    const editor = document.createElement('div')
    editor.innerHTML = '<p>Die rechnung vom März.</p><p>Noch eine <strong>rech</strong>nung im Text.</p>'
    const second = findInText(editor, 'rechnung', 1)!
    expect(second.range.toString()).toBe('rechnung')
    expect(second.range.startContainer.parentElement!.tagName).toBe('STRONG')
    expect(findInText(editor, 'rechnung', 0)!.range.startContainer.textContent).toBe('Die rechnung vom März.')
    // More counted than there are: the first one.
    expect(findInText(editor, 'rechnung', 7)!.range.startContainer.textContent).toBe('Die rechnung vom März.')
    expect(findInText(editor, 'zebra', 0)).toBeNull()
  })

  it('NOTES-9 AC-5 gives up quietly when the text never comes', async () => {
    vi.useFakeTimers()
    try {
      jumpToHit({ text: 'nirgends', nth: 0 })
      vi.advanceTimersByTime(9000)
    } finally {
      vi.useRealTimers()
    }
    expect(document.querySelector('[data-search-hit]')).toBeNull()
  })

  // ---- EC-2 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 EC-2 nothing found names the filters, the count without them and the locked notes, and drops filters', async () => {
    stored.push({ id: 'b1', title: 'Hochbeet', text: 'Hochbeet bauen', folder: 'home', updated: '2026-11-01T10:00:00Z' })
    stored.push({ id: 'b2', title: 'Hochbeet 2', text: 'Hochbeet Erde', folder: 'home', updated: '2026-11-01T10:00:00Z' })
    stored.push({ id: 'b3', title: 'Hochbeet 3', text: 'Hochbeet Holz', folder: INBOX, updated: '2026-11-01T10:00:00Z' })
    await render('/search?q=Hochbeet&folder=work&tag=urlaub')
    const empty = $('search-empty')!
    expect(empty.textContent).toContain('Nichts zu „Hochbeet“ in „Arbeit“ mit #urlaub')
    expect(empty.textContent).toContain('Ohne Eingrenzung gäbe es 3 Treffer.')
    expect(empty.textContent).toContain('Gesperrte Notizen werden nicht durchsucht.')
    await click($('search-clear-filters'))
    await answered()
    expect(where).toBe('/search?q=Hochbeet')
    expect($$('search-hit')).toHaveLength(3)
  })

  it('NOTES-9 EC-2 without filters there is nothing to drop', async () => {
    await render('/search?q=zebra')
    expect($('search-empty')!.textContent).toContain('Nichts zu „zebra“')
    expect($('search-empty')!.textContent).toContain('Gesperrte Notizen werden nicht durchsucht.')
    expect($('search-clear-filters')).toBeNull()
  })

  // ---- EC-4 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 EC-4 shows 50 of 2,000 hits and loads on when the end comes into view', async () => {
    stored = Array.from({ length: 2000 }, (_, index) => ({
      id: `m${index}`, title: `Rechnung ${index}`, text: 'Strom', folder: INBOX, updated: '2026-11-01T10:00:00Z',
    }))
    const seen: IntersectionObserverCallback[] = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        seen.push(callback)
      }
      observe() {}
      disconnect() {}
    })
    await render('/search?q=rechnung')
    expect($('search-count')!.textContent).toBe('2000 Treffer')
    expect($$('search-hit')).toHaveLength(50)
    await act(async () => {
      seen.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await answered()
    expect($$('search-hit')).toHaveLength(100)
    expect(searches().at(-1)!.params.get('offset')).toBe('50')
    // The button does the same where nothing watches the end.
    await click($('search-more'))
    await answered()
    expect($$('search-hit')).toHaveLength(150)
    expect(new Set($$('search-hit').map((hit) => hit.getAttribute('data-hit'))).size).toBe(150)
  })

  // ---- EC-5 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 EC-5 odd characters go to the server as typed and found markup shows as text', async () => {
    stored.push({ id: 'x1', title: 'Vergleich', text: 'a <b>fett</b> "zitat" * #tag', folder: INBOX, updated: '2026-11-01T10:00:00Z' })
    await render('/search')
    for (const odd of ['#tag', '"zitat"', '*', '<b>', 'NEAR(a b)', '"offen']) {
      await type(odd)
      await answered()
      expect(searches().at(-1)!.params.get('q')).toBe(odd)
      expect($('search-page')).not.toBeNull()
    }
    await type('<b>')
    await answered()
    const hit = $$('search-hit')[0]
    expect(hit.querySelector('b')).toBeNull()
    expect(marks(hit)).toEqual(['<b>'])
  })

  // ---- EC-6 ----------------------------------------------------------------------------------------------------

  it('NOTES-9 EC-6 an open list asks again when the window comes back and every few seconds', async () => {
    const every = vi.spyOn(window, 'setInterval')
    await render('/search?q=brot')
    expect($$('search-hit')).toHaveLength(1)
    expect(every.mock.calls.some(([, ms]) => ms === REFRESH_MS)).toBe(true)
    // Meanwhile somebody else writes "Brot" into another note.
    stored.push({ id: 'n9', title: 'Frühstück', text: 'Brot und Honig', folder: INBOX, updated: '2026-11-18T10:00:00Z' })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await answered()
    expect($$('search-hit')).toHaveLength(2)
    expect($('search-count')!.textContent).toBe('2 Treffer')
  })

  it('NOTES-9 EC-6 EC-4 asking again takes the first page and the count only, however many pages are loaded', async () => {
    stored = Array.from({ length: 400 }, (_, index) => ({
      id: `m${index}`, title: `Rechnung ${index}`, text: 'Strom', folder: INBOX, updated: '2026-11-01T10:00:00Z',
    }))
    await render('/search?q=rechnung')
    await click($('search-more'))
    await answered()
    await click($('search-more'))
    await answered()
    expect($$('search-hit')).toHaveLength(150)
    // Meanwhile a new note comes first, and one from further down was changed and comes second.
    const moved = stored.find((note) => note.id === 'm100')!
    stored = [{ id: 'new', title: 'Rechnung neu', text: 'Gas', folder: INBOX, updated: '2026-11-19T10:00:00Z' }, moved, ...stored.filter((note) => note !== moved)]
    calls = []
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await answered()
    expect(searches().map((call) => [call.params.get('offset'), call.params.get('limit')])).toEqual([['0', '50']])
    const ids = $$('search-hit').map((hit) => hit.getAttribute('data-hit'))
    expect(ids.slice(0, 3)).toEqual(['new', 'm100', 'm0'])
    // Nothing lost at the seam of the first page, nothing twice.
    expect(ids.slice(49, 52)).toEqual(['m47', 'm48', 'm49'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(151)
    expect($('search-count')!.textContent).toBe('401 Treffer')
  })

  it('NOTES-9 AC-4 a tag filter the server refuses says why, and the tag can be dropped', async () => {
    await render('/search?q=rechnung&tag=2026')
    expect($('search-failed')!.textContent).toContain('Das ist kein Schlagwort')
    expect($$('search-hit')).toHaveLength(0)
    await click($('search-drop-tag'))
    await answered()
    expect(where).toBe('/search?q=rechnung')
    expect($('search-failed')).toBeNull()
    expect($$('search-hit').length).toBeGreaterThan(0)
  })

  it('NOTES-9 AC-4 the tag field takes only a tag', async () => {
    await render('/search?q=rechnung')
    await click($('filter-tag'))
    const input = $('filter-tag-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '#2026')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.form!.requestSubmit()
    })
    await answered()
    expect($('filter-tag-wrong')!.textContent).toContain('Das ist kein Schlagwort')
    expect(where).toBe('/search?q=rechnung')
  })

  it('NOTES-9 AC-7 more than sixteen words: the server says so with its number, nothing is cut', async () => {
    await render('/search')
    await type(Array.from({ length: 17 }, (_, index) => `wort${index}`).join(' '))
    await answered()
    expect($('search-failed')!.textContent).toContain('höchstens 16 Wörter')
    expect($('search-failed')!.textContent).not.toContain('{{')
  })

  // ---- Keys and phone ------------------------------------------------------------------------------------------

  it('NOTES-9 keys: Ctrl+Shift+F and / open the search, arrows walk the hits, Enter opens, Escape empties and leaves', async () => {
    await render('/')
    await press(window, 'f', { ctrlKey: true, shiftKey: true })
    await answered()
    expect(where).toBe('/search')
    await act(async () => {
      window.history.back()
    })
    await settle()
    expect(where).toBe('/')
    // "/" inside a field is a slash, not the search.
    const other = document.createElement('input')
    document.body.appendChild(other)
    await press(other, '/')
    expect(where).toBe('/')
    await press(window, '/')
    await answered()
    expect(where).toBe('/search')

    await type('rechn')
    await answered()
    const field = $('search-field')!
    await press(field, 'ArrowDown')
    const hits = $$('search-hit')
    expect(document.activeElement).toBe(hits[0])
    await press(hits[0], 'ArrowDown')
    expect(document.activeElement).toBe(hits[1])
    await press(hits[1], 'ArrowUp')
    await press(hits[0], 'ArrowUp')
    expect(document.activeElement).toBe(field)
    await press(field, 'Escape')
    expect((field as HTMLInputElement).value).toBe('')
    expect(where).toBe('/search')
    await type('milch')
    await answered()
    await press($('search-field')!, 'Enter')
    expect(where).toBe('/notes/n3')
  })

  it('NOTES-9 the sidebar field leads to the search and marks it while open', async () => {
    await render('/')
    expect($('sidebar-search')!.textContent).toContain('Suchen')
    await click($('sidebar-search'))
    await answered()
    expect(where).toBe('/search')
    expect($('sidebar-search')!.className).toContain('border-accent-500')
  })

  it('NOTES-9 on the phone "Fertig" leaves the search and the count stands above the list', async () => {
    await render('/search?q=rechn')
    expect($('search-count-phone')!.textContent).toBe('3 Treffer')
    await click($('search-done'))
    await settle()
    expect(where).toBe('/')
  })

  // ---- Docking points ------------------------------------------------------------------------------------------

  it('NOTES-9 a hit in an attachment says so with name and page, and opens its view when one is there', async () => {
    stored.push({
      id: 'a1', title: 'Scan Wasserzähler', text: 'Jahresrechnung Wasser 2026', folder: 'home', updated: '2026-11-03T10:00:00Z',
      attachment: { kind: 'pdf', name: 'Wasser.pdf', page: 2, ref: 'att-1' },
    })
    await render('/search?q=jahresrechnung')
    const hit = $$('search-hit')[0]
    expect(hit.querySelector('[data-testid="search-hit-excerpt"]')!.textContent).toBe('im Anhang: „Jahresrechnung Wasser 2026“, Seite 2')
    expect(hit.querySelector('[data-testid="search-hit-attachment"]')!.textContent).toBe('Wasser.pdf')
    const opened: string[] = []
    registerAttachmentOpener((found) => opened.push(found.attachment!.ref))
    await click(hit)
    expect(opened).toEqual(['att-1'])
    expect(where).toBe('/search?q=jahresrechnung')
  })

  it('NOTES-9 "Als intelligenten Ordner sichern" is there once smart folders dock on, with exactly these conditions', async () => {
    await render('/search?q=rechn&tag=bad')
    expect($('search-save-smart')).toBeNull()
    act(() => root.unmount())
    box.remove()
    const saved: unknown[] = []
    registerSmartFolderSave((conditions) => {
      saved.push(conditions)
    })
    await render('/search?q=rechn&tag=bad&period=week')
    await click($('search-save-smart'))
    expect(saved).toEqual([{ ...NO_CONDITIONS, q: 'rechn', tag: 'bad', period: 'week' }])
  })
})

describe('NOTES-9 conditions', () => {
  it('go into the address and back unchanged', () => {
    const conditions = { q: 'a "b" #c', folderId: 'f1', tag: 'urlaub', period: 'custom' as const, from: '2026-01-01', to: '2026-02-01' }
    expect(readConditions(writeConditions(conditions))).toEqual(conditions)
    expect(readConditions(new URLSearchParams('period=nonsense&from=gestern&tag=%23x'))).toEqual({ ...NO_CONDITIONS, tag: 'x' })
  })

  it('count a period from today in the device time zone', () => {
    const now = new Date(2026, 10, 21, 15, 30)
    expect(new Date(periodRange({ ...NO_CONDITIONS, period: 'week' }, now).since!)).toEqual(new Date(2026, 10, 15))
    expect(new Date(periodRange({ ...NO_CONDITIONS, period: 'month' }, now).since!)).toEqual(new Date(2026, 9, 23))
    expect(new Date(periodRange({ ...NO_CONDITIONS, period: 'year' }, now).since!)).toEqual(new Date(2025, 10, 22))
    const custom = periodRange({ ...NO_CONDITIONS, period: 'custom', from: '2026-03-01', to: '2026-03-31' }, now)
    expect(new Date(custom.since!)).toEqual(new Date(2026, 2, 1))
    expect(new Date(custom.until!)).toEqual(new Date(2026, 2, 31, 23, 59, 59, 999))
    expect(toQuery({ ...NO_CONDITIONS, q: 'x' }, now)).toEqual({ q: 'x' })
  })
})
