/**
 * NOTES-11 in the page: a picture, a scan or a PDF opened large shows its recognised text beside it, page by page with
 * its language, to copy or to put into the note (AC-3); pages still being read say so and the view asks again (AC-7);
 * no text says so (EC-2); a hit of the search in an attachment opens its note and the view at the page with the place
 * marked (AC-8). The editor runs on a Yjs document as in the app; the server is a stand-in for fetch.
 */
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { act, useEffect, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as Y from 'yjs'

import type { AttachmentInfo } from '../attachments/api'
import { forgetAttachments } from '../attachments/info'
import '../attachments/register'
import { editorExtensions, editorProps } from '../editor/extensions'
import { presenceUser } from '../editor/presence'
import { NoteProvider } from '../editor/provider'
import { SHELL_PARTS } from '../extensions'
import i18n from '../i18n'
import type { Hit } from '../search/api'
import { attachmentOpenerFor } from '../search/registry'
import type { AttachmentText } from './api'
import { paragraphsOf } from './insert'
import { ASK_EVERY_MS, askAgainIn } from './marks'
import './register'
import { closeViewer } from './store'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const NOTE = 'note-1'

let known: AttachmentInfo[]
let texts: Record<string, AttachmentText>
const asked: string[] = []

function info(id: string, kind: AttachmentInfo['kind'], name: string, extra: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return { id, note_id: NOTE, kind, name, mime: 'image/png', size: 2_516_582, width: 800, height: 600, pages: null, duration_ms: null, view: false, thumb: true, inline: true, created_at: '2026-11-21T08:00:00+00:00', ...extra }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  known = []
  texts = {}
  asked.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      asked.push(path)
      if (path.startsWith('/api/attachments/limits')) return json({ max_mb: 100, used: 0, limit: null, full: false, link_previews: true })
      if (path.startsWith(`/api/notes/${NOTE}/attachments`)) return json({ items: known })
      const text = path.match(/^\/api\/attachments\/([^/]+)\/text$/)
      if (text) return texts[text[1]] ? json(texts[text[1]]) : json({ detail: { code: 'not_found' } }, 404)
      const one = path.match(/^\/api\/attachments\/([^/?]+)$/)
      if (one) {
        const found = known.find((item) => item.id === one[1])
        return found ? json(found) : json({ detail: { code: 'not_found' } }, 404)
      }
      return json({})
    }),
  )
  forgetAttachments()
})

afterEach(async () => {
  await act(async () => closeViewer())
  if (root) await act(async () => root!.unmount())
  root = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// --- A note in the page, with the shell's parts -------------------------------------------------------------------

let root: Root | null = null
let path = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    path = location.pathname
  }, [location])
  return null
}

function Note({ onEditor, editable }: { onEditor: (editor: Editor) => void; editable: boolean }) {
  const doc = useMemo(() => new Y.Doc(), [])
  const provider = useMemo(() => new NoteProvider(NOTE, doc, { socket: () => { throw new Error('offline in tests') } }), [doc])
  const extensions = useMemo(() => editorExtensions({ doc, provider, me: presenceUser(1, 'Anna'), t, placeholder: '', noteId: NOTE }), [doc, provider])
  const editor = useEditor({ extensions, editorProps, editable })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  return <EditorContent editor={editor} />
}

async function settle(times = 6) {
  for (let index = 0; index < times; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function noteWith(items: AttachmentInfo[], content: Array<Record<string, unknown>>, editable = true): Promise<{ editor: Editor; box: HTMLElement }> {
  known = items
  const box = document.createElement('div')
  document.body.appendChild(box)
  let made: Editor | null = null
  await act(async () => {
    root = createRoot(box)
    root.render(
      <MemoryRouter initialEntries={['/search']}>
        <Where />
        <Routes>
          <Route path="*" element={<Note onEditor={(editor) => (made = editor)} editable={editable} />} />
        </Routes>
        {SHELL_PARTS.map((part) => (
          <div key={part.key}>{part.render()}</div>
        ))}
      </MemoryRouter>,
    )
  })
  await settle()
  await act(async () => {
    made!.commands.setContent({ type: 'doc', content })
  })
  await settle()
  return { editor: made!, box }
}

const viewer = () => document.querySelector('[data-testid="ocr-viewer"]') as HTMLElement | null
const panel = () => document.querySelector('[data-testid="ocr-panel"]') as HTMLElement | null
const click = async (selector: string, within: ParentNode = document) => {
  await act(async () => (within.querySelector(selector) as HTMLButtonElement).click())
  await settle()
}

function pageText(page: number, text: string, language = 'de', state: 'done' | 'pending' | 'empty' | 'failed' = 'done') {
  return { page, state, text, language, source: 'ocr' }
}

const RECEIPT = 'Bäckerei Sonnenschein\nKassenbon Nr. 4711\n\nSumme 12,40 EUR'

// --- AC-3 ---------------------------------------------------------------------------------------------------------

describe('NOTES-11 AC-3 the recognised text beside the picture', () => {
  it('NOTES-11 AC-3 a picture opened large shows its text with the language, copies it and puts it into the note', async () => {
    const photo = info('Bon1aaaaaaaaaaaaaaaaaa', 'image', 'Bon.jpg')
    texts[photo.id] = { id: photo.id, state: 'done', pages: 1, items: [pageText(1, RECEIPT, 'de')] }
    const { editor, box } = await noteWith([photo], [{ type: 'image', attrs: { id: photo.id, name: photo.name } }, { type: 'paragraph', content: [{ type: 'text', text: 'Danach' }] }])
    await click('[data-testid="attachment-open-large"]', box)
    expect(viewer()).not.toBeNull()
    expect(viewer()!.getAttribute('role')).toBe('dialog')
    expect(document.querySelector('[data-testid="attachment-lightbox"]')).toBeNull()
    expect(document.querySelector('[data-testid="ocr-picture"]')!.getAttribute('src')).toBe(`/api/attachments/${photo.id}/file`)
    expect(panel()).toBeNull()
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-show-text"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(panel()!.querySelector('h2')!.textContent).toBe('Recognized text')
    expect(document.querySelector('[data-testid="ocr-text"]')!.textContent).toBe(RECEIPT)
    expect(document.querySelector('[data-testid="ocr-language"]')!.textContent).toBe('German')

    const copied: string[] = []
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => void copied.push(value) }, configurable: true })
    await click('[data-testid="ocr-copy"]')
    expect(copied).toEqual([RECEIPT])
    expect(document.querySelector('[data-testid="ocr-copy"]')!.textContent).toBe('Copied')

    await click('[data-testid="ocr-insert"]')
    expect(document.querySelector('[data-testid="ocr-insert"]')!.textContent).toBe('Inserted into the note')
    const names: string[] = []
    editor.state.doc.forEach((node) => names.push(node.type.name === 'paragraph' ? `p:${node.textContent}` : node.type.name))
    expect(names).toEqual(['image', 'p:Bäckerei SonnenscheinKassenbon Nr. 4711', 'p:Summe 12,40 EUR', 'p:Danach'])
    expect(editor.state.doc.child(1).child(1).type.name).toBe('hardBreak')
  })

  it('NOTES-11 AC-3 a PDF opens large page by page, each page with its own text', async () => {
    const pdf = info('Pdf1aaaaaaaaaaaaaaaaaa', 'pdf', 'Wasser.pdf', { mime: 'application/pdf', pages: 2 })
    texts[pdf.id] = { id: pdf.id, state: 'done', pages: 2, items: [pageText(1, 'Deckblatt'), pageText(2, 'Thank you for your order', 'en')] }
    const { box } = await noteWith([pdf], [{ type: 'attachment', attrs: { id: pdf.id, name: pdf.name } }])
    await click('[data-testid="attachment-pdf-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-where"]')!.textContent).toBe('PDF · Page 1 of 2')
    expect(document.querySelector('[data-testid="ocr-picture"]')!.getAttribute('src')).toBe(`/api/attachments/${pdf.id}/pages/1?width=1400`)
    expect(document.querySelector('[data-testid="ocr-text"]')!.textContent).toBe('Deckblatt')
    await click('[data-testid="ocr-next"]')
    expect(document.querySelector('[data-testid="ocr-where"]')!.textContent).toBe('PDF · Page 2 of 2')
    expect(document.querySelector('[data-testid="ocr-picture"]')!.getAttribute('src')).toBe(`/api/attachments/${pdf.id}/pages/2?width=1400`)
    expect(document.querySelector('[data-testid="ocr-text"]')!.textContent).toBe('Thank you for your order')
    expect(document.querySelector('[data-testid="ocr-language"]')!.textContent).toBe('English')
    expect((document.querySelector('[data-testid="ocr-next"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NOTES-11 AC-3 who only reads the note copies but cannot put the text into it', async () => {
    const photo = info('Bon2aaaaaaaaaaaaaaaaaa', 'image', 'Bon.jpg')
    texts[photo.id] = { id: photo.id, state: 'done', pages: 1, items: [pageText(1, RECEIPT)] }
    const { box } = await noteWith([photo], [{ type: 'image', attrs: { id: photo.id, name: photo.name } }], false)
    await click('[data-testid="attachment-open-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-copy"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="ocr-insert"]')).toBeNull()
  })

  it('NOTES-11 AC-3 Escape and the close button end the view, and the text stays text', async () => {
    const photo = info('Bon3aaaaaaaaaaaaaaaaaa', 'image', 'Bon.jpg')
    texts[photo.id] = { id: photo.id, state: 'done', pages: 1, items: [pageText(1, '<img src=x onerror="alert(1)"> Kassenbon')] }
    const { box } = await noteWith([photo], [{ type: 'image', attrs: { id: photo.id, name: photo.name } }])
    await click('[data-testid="attachment-open-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-text"] img')).toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(viewer()).toBeNull()
    await click('[data-testid="attachment-open-large"]', box)
    await click('[data-testid="ocr-close"]')
    expect(viewer()).toBeNull()
  })

  it('NOTES-11 AC-3 the paragraphs put into the note follow the lines of the text', () => {
    expect(paragraphsOf('Zeile eins\r\nZeile zwei\n\n\nNeuer Absatz\n')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Zeile eins' }, { type: 'hardBreak' }, { type: 'text', text: 'Zeile zwei' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Neuer Absatz' }] },
    ])
    expect(paragraphsOf('  \n  ')).toEqual([])
  })
})

// --- AC-7, EC-2 ---------------------------------------------------------------------------------------------------

describe('NOTES-11 AC-7 EC-2 what is still being read, and what has no text', () => {
  it('NOTES-11 AC-7 a page still being read says so for that page, and the view asks again until it is there', async () => {
    const pdf = info('Pdf2aaaaaaaaaaaaaaaaaa', 'pdf', 'Scan.pdf', { mime: 'application/pdf', pages: 2 })
    texts[pdf.id] = { id: pdf.id, state: 'working', pages: 2, items: [pageText(1, 'Jahresrechnung Wasser 2026'), pageText(2, '', '', 'pending')] }
    const { box } = await noteWith([pdf], [{ type: 'attachment', attrs: { id: pdf.id, name: pdf.name } }])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await click('[data-testid="attachment-pdf-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-pending"]')!.textContent).toBe('Page 2: text is still being recognized. Search finds it as soon as it is done.')
    await click('[data-testid="ocr-next"]')
    expect(document.querySelector('[data-testid="ocr-text"] [data-testid="ocr-reading"]')!.textContent).toBe('Text is still being recognized. Search finds it as soon as it is done.')
    expect(document.querySelector('[data-testid="ocr-pending"]')).toBeNull()
    const before = asked.filter((url) => url.endsWith('/text')).length
    texts[pdf.id] = { id: pdf.id, state: 'done', pages: 2, items: [pageText(1, 'Jahresrechnung Wasser 2026'), pageText(2, 'Abschläge und Verbrauch')] }
    await act(async () => vi.advanceTimersByTime(ASK_EVERY_MS + 10))
    await settle()
    expect(asked.filter((url) => url.endsWith('/text')).length).toBe(before + 1)
    expect(document.querySelector('[data-testid="ocr-text"]')!.textContent).toBe('Abschläge und Verbrauch')
    // Done: nobody asks any more.
    await act(async () => vi.advanceTimersByTime(ASK_EVERY_MS * 3))
    await settle()
    expect(asked.filter((url) => url.endsWith('/text')).length).toBe(before + 1)
  })

  it('NOTES-11 AC-5 while the text of the iOS app is awaited the view asks ever less often, at most once a minute', async () => {
    const scan = info('Dev1aaaaaaaaaaaaaaaaaa', 'scan', 'Brief.jpg', { thumb: true, view: true, inline: true })
    texts[scan.id] = { id: scan.id, state: 'device', pages: 1, items: [] }
    const { box } = await noteWith([scan], [{ type: 'image', attrs: { id: scan.id, name: scan.name } }])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await click('[data-testid="attachment-open-large"]', box)
    await settle()
    const before = asked.filter((url) => url.endsWith('/text')).length
    // Ten minutes: every 3 s would be 200 questions; 3, 6, 12, 24, 48 s and then once a minute are 14.
    for (let second = 0; second < 600; second += 1) await act(async () => vi.advanceTimersByTime(1000))
    await settle()
    const more = asked.filter((url) => url.endsWith('/text')).length - before
    expect(more).toBeGreaterThanOrEqual(10)
    expect(more).toBeLessThanOrEqual(16)
    expect(askAgainIn('device', 0)).toBe(ASK_EVERY_MS)
    expect(askAgainIn('device', 10)).toBe(60_000)
    expect(askAgainIn('working', 10)).toBe(ASK_EVERY_MS)
  })

  it('NOTES-11 EC-2 a picture whose recognition failed stays a picture and says no text was recognised', async () => {
    const photo = info('Kap1aaaaaaaaaaaaaaaaaa', 'image', 'Kaputt.png')
    texts[photo.id] = { id: photo.id, state: 'failed', pages: 1, items: [pageText(1, '', '', 'failed')] }
    const { box } = await noteWith([photo], [{ type: 'image', attrs: { id: photo.id, name: photo.name } }])
    expect(box.querySelector('figure.nn-picture img')).not.toBeNull()
    await click('[data-testid="attachment-open-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-none"]')!.textContent).toBe('No text recognized')
    expect(document.querySelector('[data-testid="ocr-copy"]')).toBeNull()
    await act(async () => i18n.changeLanguage('de'))
    expect(document.querySelector('[data-testid="ocr-none"]')!.textContent).toBe('Kein Text erkannt')
    await act(async () => i18n.changeLanguage('en'))
  })

  it('NOTES-11 EC-3 a photo without text says no text was recognised', async () => {
    const photo = info('Urlb1aaaaaaaaaaaaaaaaa', 'image', 'Strand.jpg')
    texts[photo.id] = { id: photo.id, state: 'done', pages: 1, items: [pageText(1, '', '', 'empty')] }
    const { box } = await noteWith([photo], [{ type: 'image', attrs: { id: photo.id, name: photo.name } }])
    await click('[data-testid="attachment-open-large"]', box)
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-none"]')).not.toBeNull()
  })

  it('NOTES-11 EC-7 a locked note and a server without recognition say so', async () => {
    const locked = info('Lock1aaaaaaaaaaaaaaaaa', 'image', 'Geheim.png')
    const missing = info('Miss1aaaaaaaaaaaaaaaaa', 'image', 'Ohne.png')
    texts[locked.id] = { id: locked.id, state: 'locked', pages: 1, items: [] }
    texts[missing.id] = { id: missing.id, state: 'unavailable', pages: 1, items: [pageText(1, '', '', 'pending')] }
    const { box } = await noteWith([locked, missing], [
      { type: 'image', attrs: { id: locked.id, name: locked.name } },
      { type: 'image', attrs: { id: missing.id, name: missing.name } },
    ])
    const large = box.querySelectorAll('[data-testid="attachment-open-large"]')
    await act(async () => (large[0] as HTMLButtonElement).click())
    await settle()
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-locked"]')!.textContent).toBe('The note is locked. Its text is not recognized.')
    await click('[data-testid="ocr-close"]')
    await act(async () => (large[1] as HTMLButtonElement).click())
    await settle()
    await click('[data-testid="ocr-show-text"]')
    expect(document.querySelector('[data-testid="ocr-unavailable"]')!.textContent).toBe('Text recognition is not set up on this server.')
  })
})

// --- AC-8 ---------------------------------------------------------------------------------------------------------

describe('NOTES-11 AC-8 from a hit of the search to its place in the attachment', () => {
  it('NOTES-11 AC-8 a hit in an attachment opens its note and the view at the page, the place marked', async () => {
    const pdf = info('Pdf3aaaaaaaaaaaaaaaaaa', 'pdf', 'Wasser.pdf', { mime: 'application/pdf', pages: 3 })
    texts[pdf.id] = {
      id: pdf.id,
      state: 'done',
      pages: 3,
      items: [pageText(1, 'Deckblatt'), pageText(2, 'Wasser 2025 und Wasser 2026 im Vergleich'), pageText(3, 'Ende')],
    }
    await noteWith([pdf], [{ type: 'attachment', attrs: { id: pdf.id, name: pdf.name } }])
    expect(path).toBe('/search')
    const hit = {
      id: 'note-7', title: 'Post', title_parts: [], excerpt: [], where: 'attachment', jump: { text: 'Wasser', nth: 1 },
      attachment: { kind: 'pdf', name: 'Wasser.pdf', page: 2, ref: pdf.id }, folder: null, owner_id: 1, created_at: null, updated_at: null,
    } as Hit
    const opener = attachmentOpenerFor()
    expect(opener).not.toBeNull()
    await act(async () => opener!(hit))
    await settle()
    expect(path).toBe('/notes/note-7')
    expect(document.querySelector('[data-testid="ocr-name"]')!.textContent).toBe('Wasser.pdf')
    expect(document.querySelector('[data-testid="ocr-where"]')!.textContent).toBe('PDF · Page 2 of 3')
    expect(panel()).not.toBeNull()
    const mark = document.querySelector('[data-testid="ocr-mark"]')!
    expect(mark.textContent).toBe('Wasser')
    // The second "Wasser" of the page, as the server counted.
    expect(document.querySelector('[data-testid="ocr-text"]')!.innerHTML.indexOf('<mark')).toBeGreaterThan('Wasser 2025 und '.length - 1)
  })

  it('NOTES-11 AC-8 a hit in the words of a recording opens only its note, no view', async () => {
    await noteWith([], [{ type: 'paragraph' }])
    const hit = {
      id: 'note-8', title: 'Besprechung', title_parts: [], excerpt: [], where: 'attachment', jump: { text: 'Budget', nth: 0 },
      attachment: { kind: 'recording', name: 'Besprechung.m4a', page: null, ref: 'Rec1aaaaaaaaaaaaaaaaaa' }, folder: null, owner_id: 1, created_at: null, updated_at: null,
    } as Hit
    await act(async () => attachmentOpenerFor()!(hit))
    await settle()
    expect(path).toBe('/notes/note-8')
    expect(viewer()).toBeNull()
    expect(asked.some((url) => url.includes('Rec1aaaaaaaaaaaaaaaaaa'))).toBe(false)
  })
})
