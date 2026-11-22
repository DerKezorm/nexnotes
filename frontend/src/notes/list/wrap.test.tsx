/**
 * NOTES-6, review of 22.11.2026: on a phone two tiles stand side by side and a title broke inside its words
 * ("Willkomme|n"). A title and the first lines break between words, a word too long for its line with a hyphen in the
 * UI's language, and only as the last way out anywhere; `<html lang>` follows the UI's language for that.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n, { changeLanguage } from '../../i18n'
import { NoteCard } from './NoteCard'
import { NoteTile } from './NoteTile'

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files
const CSS = files.readFileSync('src/styles/index.css', 'utf-8')

const item = {
  id: 'n1', folder_id: 'f', title: 'Willkommen bei nexnotes', title_check: false, origin: '', preview: 'Urlaubsplanung und Wocheneinkauf',
  created_at: '2026-11-22T08:00:00Z', updated_at: '2026-11-22T08:00:00Z',
}

/** Classes that cut a word where it does not have to be cut, or keep a word from breaking at all. */
const CUTTING = /(^|\s)(break-all|break-words|wrap-anywhere|wrap-break-word|break-keep|\[overflow-wrap:anywhere\]|\[word-break:break-all\]|hyphens-none|hyphens-manual)(\s|$)/

async function shown(node: React.ReactNode): Promise<{ box: HTMLElement; done: () => Promise<void> }> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>))
  return {
    box,
    done: async () => {
      await act(async () => root.unmount())
      box.remove()
    },
  }
}

describe('titles and first lines in tiles and cards', () => {
  it('NOTES-6 AC-3 a tile title breaks between words, with hyphens, in two lines at most', async () => {
    const { box, done } = await shown(<NoteTile item={item} href="/notes/n1" date="8:00" />)
    const title = box.querySelector<HTMLElement>('[data-testid="note-tile-title"]')!
    expect(title.textContent).toBe('Willkommen bei nexnotes')
    expect(title.classList).toContain('nn-wrap')
    expect(title.classList).toContain('line-clamp-2')
    expect(title.className).not.toMatch(CUTTING)
    const preview = box.querySelector<HTMLElement>('[data-testid="note-preview"]')!
    expect(preview.classList).toContain('nn-wrap')
    expect(preview.className).not.toMatch(CUTTING)
    // Neither pinned nor locked: no empty place for those marks takes width from the title.
    expect(title.closest('[style]')!.children).toHaveLength(1)
    await done()
  })

  it('NOTES-6 AC-2 the first lines of a card break the same way', async () => {
    const { box, done } = await shown(<NoteCard item={item} href="/notes/n1" date="8:00" />)
    const preview = box.querySelector<HTMLElement>('[data-testid="note-preview"]')!
    expect(preview.classList).toContain('nn-wrap')
    expect(preview.classList).toContain('line-clamp-2')
    expect(preview.className).not.toMatch(CUTTING)
    await done()
  })

  it('NOTES-6 AC-3 the class hyphenates and breaks inside a word only as the last way out', () => {
    const rule = /\.nn-wrap\s*\{([^}]*)\}/.exec(CSS)
    expect(rule, 'the rule .nn-wrap in index.css').not.toBeNull()
    const body = rule![1]
    expect(body).toMatch(/(^|[^-])hyphens:\s*auto;/)
    expect(body).toMatch(/-webkit-hyphens:\s*auto;/)
    expect(body).toMatch(/overflow-wrap:\s*break-word;/)
    expect(body).toMatch(/word-break:\s*normal;/)
    expect(body).not.toMatch(/anywhere|break-all/)
  })
})

describe('the language of the page', () => {
  const before = i18n.language

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  })

  afterEach(async () => {
    await i18n.changeLanguage(before)
    vi.unstubAllGlobals()
  })

  it('NOTES-22 <html lang> follows every switch of the UI language, the hyphenation goes by it', async () => {
    expect(document.documentElement.lang).toBe(i18n.language)
    expect(await changeLanguage('en', false)).toBe(true)
    expect(document.documentElement.lang).toBe('en')
    expect(await changeLanguage('de', false)).toBe(true)
    expect(document.documentElement.lang).toBe('de')
    // Also when something switches i18next itself.
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
