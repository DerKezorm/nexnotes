/**
 * NOTES-10 in the page: files dropped, pasted and chosen become blocks at their place (AC-1), pictures, PDFs, videos
 * and files as the drawings show them (AC-2, AC-3, AC-4, AC-8, EC-3, EC-7), cards of links (AC-5, AC-9), limits and the
 * full storage (AC-6, AC-11, EC-1), uploads with progress, cancel, waiting and a broken connection (AC-10, EC-2, EC-6),
 * removing (AC-12), names as text (EC-4), the same name twice (EC-8), reading only (EC-10) and the gallery (AC-7, EC-9).
 * The editor runs on a Yjs document as in the app; the server is a stand-in for fetch and XMLHttpRequest.
 */
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { act, useEffect, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as Y from 'yjs'

import { FEATURE_ROUTES, SHELL_BANNERS, SIDEBAR_SECTIONS } from '../extensions'
import i18n from '../i18n'
import { editorExtensions, editorProps } from '../editor/extensions'
import { presenceUser } from '../editor/presence'
import { NoteProvider } from '../editor/provider'
import type { AttachmentInfo, Gallery, Limits } from './api'
import { attachFiles, pastedLink } from './editing'
import { GalleryPage } from './GalleryPage'
import { ASK_AGAIN_MS, forgetAttachments, loadLimits } from './info'
import { AttachButton, DropHint, RefusalList } from './NoteParts'
import '../folders'
import './register'
import { AT_ONCE, forgetUploads, uploadsNow } from './uploads'

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const NOTE = 'note-1'

// --- The server, standing in --------------------------------------------------------------------------------------

let limits: Limits
let known: AttachmentInfo[]
let gallery: Gallery
let cards: Record<string, unknown>
const asked: string[] = []

function info(id: string, kind: AttachmentInfo['kind'], name: string, extra: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return { id, note_id: NOTE, kind, name, mime: 'application/octet-stream', size: 2_516_582, width: null, height: null, pages: null, duration_ms: null, view: false, thumb: false, inline: false, created_at: '2026-11-21T08:00:00+00:00', ...extra }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Every upload the page started, to answer by hand. */
class FakeRequest {
  static made: FakeRequest[] = []
  method = ''
  url = ''
  body: Blob | null = null
  headers: Record<string, string> = {}
  status = 0
  responseText = ''
  aborted = false
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: Blob) {
    this.body = body
    FakeRequest.made.push(this)
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  get id(): string {
    return new URL(this.url, 'http://x').searchParams.get('id') ?? ''
  }
  progress(part: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: part * 100, total: 100 })
  }
  finish(answer: AttachmentInfo) {
    this.status = 201
    this.responseText = JSON.stringify(answer)
    known.push(answer)
    this.onload?.()
  }
  fail(status: number, detail: Record<string, unknown>) {
    this.status = status
    this.responseText = JSON.stringify({ detail })
    this.onload?.()
  }
  breakOff() {
    this.onerror?.()
  }
}

const open = () => FakeRequest.made.filter((request) => !request.aborted && request.status === 0)

beforeAll(async () => {
  await i18n.changeLanguage('en')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  limits = { max_mb: 100, used: 1000, limit: null, full: false, link_previews: true }
  known = []
  cards = {}
  asked.length = 0
  gallery = { total: 0, all: 0, bytes: 0, counts: { image: 0, scan: 0, pdf: 0, recording: 0, drawing: 0, video: 0, file: 0 }, items: [] }
  FakeRequest.made = []
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.startsWith('/api/attachments/limits')) return json(limits)
      if (path.startsWith(`/api/notes/${NOTE}/attachments`)) return json({ items: known })
      if (path.startsWith(`/api/notes/${NOTE}/link-preview`)) {
        const url = JSON.parse(String(init?.body)).url as string
        return json(cards[url] ? { preview: cards[url], reason: null } : { preview: null, reason: 'unreachable' })
      }
      if (path.startsWith('/api/attachments')) {
        const query = new URL(path, 'http://x').searchParams
        const kind = query.get('kind')
        const items = gallery.items.filter((item) => !kind || item.kind === kind)
        const sorted = query.get('sort') === 'largest' ? [...items].sort((a, b) => b.size - a.size) : items
        const offset = Number(query.get('offset') ?? 0)
        return json({ ...gallery, total: items.length, items: sorted.slice(offset, offset + Number(query.get('limit') ?? 120)) })
      }
      return json({})
    }),
  )
  vi.spyOn(window, 'open').mockImplementation(() => null)
  forgetAttachments()
  forgetUploads()
})

afterEach(() => {
  forgetUploads()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// --- An editor in the page -------------------------------------------------------------------------------------------

let root: Root | null = null

function Note({ onEditor, editable = true, withParts = true }: { onEditor: (editor: Editor) => void; editable?: boolean; withParts?: boolean }) {
  const doc = useMemo(() => new Y.Doc(), [])
  const provider = useMemo(() => new NoteProvider(NOTE, doc, { socket: () => { throw new Error('offline in tests') } }), [doc])
  const extensions = useMemo(() => editorExtensions({ doc, provider, me: presenceUser(1, 'Anna'), t, placeholder: '', noteId: NOTE }), [doc, provider])
  const editor = useEditor({ extensions, editorProps, editable })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  return (
    <div>
      {editor && withParts && editable && <AttachButton editor={editor} noteId={NOTE} />}
      <EditorContent editor={editor} />
      {editor && withParts && <DropHint editor={editor} noteId={NOTE} />}
      <RefusalList noteId={NOTE} />
    </div>
  )
}

async function mount(options: { editable?: boolean } = {}): Promise<{ editor: Editor; box: HTMLElement }> {
  const box = document.createElement('div')
  document.body.appendChild(box)
  let made: Editor | null = null
  await act(async () => {
    root = createRoot(box)
    root.render(
      <MemoryRouter>
        <Note onEditor={(editor) => (made = editor)} editable={options.editable ?? true} />
      </MemoryRouter>,
    )
  })
  await settle()
  return { editor: made!, box }
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
})

async function settle(times = 4) {
  for (let index = 0; index < times; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

function file(name: string, size = 1000, type = ''): File {
  const made = new File(['x'], name, { type })
  Object.defineProperty(made, 'size', { value: size })
  return made
}

function blocks(editor: Editor): Array<{ type: string; attrs: Record<string, unknown> }> {
  const out: Array<{ type: string; attrs: Record<string, unknown> }> = []
  editor.state.doc.descendants((node) => {
    if (['image', 'attachment', 'linkPreview'].includes(node.type.name)) out.push({ type: node.type.name, attrs: node.attrs })
  })
  return out
}

function paste(editor: Editor, data: { files?: File[]; text?: string }): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { files: data.files ?? [], getData: (kind: string) => (kind === 'text/plain' ? (data.text ?? '') : ''), types: data.files?.length ? ['Files'] : ['text/plain'] },
  })
  return Boolean(editor.view.someProp('handlePaste', (handler) => handler(editor.view, event, editor.state.doc.slice(0, 0))))
}

function drop(editor: Editor, files: File[]): boolean {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  Object.defineProperty(event, 'clientX', { value: 0 })
  Object.defineProperty(event, 'clientY', { value: 0 })
  return Boolean(editor.view.someProp('handleDrop', (handler) => handler(editor.view, event, editor.state.doc.slice(0, 0), false)))
}

function typeText(editor: Editor, text: string) {
  const { from, to } = editor.state.selection
  editor.view.dispatch(editor.state.tr.insertText(text, from, to))
}

// --- AC-1 -------------------------------------------------------------------------------------------------------------

describe('NOTES-10 AC-1 files come in where they are dropped, pasted or chosen', () => {
  it('NOTES-10 AC-1 a drop puts one block per file at the place and starts their uploads', async () => {
    const { editor } = await mount()
    await act(async () => {
      editor.commands.setContent('<p>Before</p><p>After</p>')
    })
    const before = editor.state.doc.firstChild!.nodeSize
    editor.view.posAtCoords = () => ({ pos: before, inside: -1 })
    await act(async () => {
      expect(drop(editor, [file('Wohnzimmer.heic', 3_355_443), file('Datenblatt Sofa.pdf', 2_400_000, 'application/pdf')])).toBe(true)
    })
    await settle()
    expect(editor.state.doc.child(0).textContent).toBe('Before')
    expect(blocks(editor).map((block) => [block.type, block.attrs.name])).toEqual([
      ['image', 'Wohnzimmer.heic'],
      ['attachment', 'Datenblatt Sofa.pdf'],
    ])
    expect(editor.state.doc.lastChild!.textContent).toBe('After')
    // Each block uploads under its own id, the one in the note.
    expect(FakeRequest.made.map((request) => request.id)).toEqual(blocks(editor).map((block) => block.attrs.id))
    const request = FakeRequest.made[0]
    expect(request.url).toContain(`note_id=${NOTE}`)
    expect(request.headers['X-Nexnotes-Client']).toBeTruthy()
    expect(String(blocks(editor)[0].attrs.id)).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('NOTES-10 AC-1 pasted files and files chosen with "Attach" come in at the cursor', async () => {
    const { editor, box } = await mount()
    await act(async () => {
      expect(paste(editor, { files: [file('Screenshot.png', 500, 'image/png')] })).toBe(true)
    })
    await settle()
    expect(blocks(editor).map((block) => block.type)).toEqual(['image'])
    const input = box.querySelector<HTMLInputElement>('[data-testid="attach-input"]')!
    Object.defineProperty(input, 'files', { value: [file('Grundriss.dwg', 780_000)], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(blocks(editor).map((block) => [block.type, block.attrs.name])).toEqual([
      ['image', 'Screenshot.png'],
      ['attachment', 'Grundriss.dwg'],
    ])
    expect(box.querySelector('[data-testid="attach"]')!.textContent).toBe('Attach')
  })

  it('NOTES-10 AC-1 the area for files names the limit per file', async () => {
    limits.max_mb = 250
    const { box } = await mount()
    await act(async () => loadLimits(true))
    await settle()
    expect(box.querySelector('[data-testid="attach-drop"]')!.textContent).toBe('Drag files here or paste them · at most 250 MB per file')
  })
})

// --- AC-10, EC-6, EC-2 --------------------------------------------------------------------------------------------------

describe('NOTES-10 uploads with progress, a line and a broken connection', () => {
  it('NOTES-10 AC-10 an upload shows percent and a cancel button, and writing goes on meanwhile', async () => {
    const { editor, box } = await mount()
    await act(async () => {
      await attachFiles(editor, NOTE, [file('Strand.heic', 5_000_000, 'image/heic')])
    })
    const request = FakeRequest.made[0]
    await act(async () => request.progress(0.64))
    expect(box.querySelector('[data-testid="attachment-progress"]')!.textContent).toBe('uploading · 64 %')
    // Writing goes on while it uploads.
    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      typeText(editor, 'Weiter')
    })
    expect(editor.state.doc.textContent).toContain('Weiter')
    expect(editor.isEditable).toBe(true)
    await act(async () => (box.querySelector('[data-testid="attachment-cancel"]') as HTMLButtonElement).click())
    expect(request.aborted).toBe(true)
    expect(blocks(editor)).toEqual([])
    expect(uploadsNow()).toEqual([])
  })

  it('NOTES-10 EC-6 forty files at once: three upload, the others wait in line and follow', async () => {
    const { editor, box } = await mount()
    const files = Array.from({ length: 40 }, (_, index) => file(`Foto ${index + 1}.jpg`, 1000, 'image/jpeg'))
    await act(async () => {
      await attachFiles(editor, NOTE, files)
    })
    await settle()
    expect(blocks(editor)).toHaveLength(40)
    expect(open()).toHaveLength(AT_ONCE)
    const states = Array.from(box.querySelectorAll('[data-testid="attachment-upload"]')).map((element) => element.getAttribute('data-state'))
    expect(states.filter((state) => state === 'uploading')).toHaveLength(3)
    expect(states.filter((state) => state === 'waiting')).toHaveLength(37)
    expect(Array.from(box.querySelectorAll('[data-testid="attachment-progress"]')).filter((element) => element.textContent === 'waiting')).toHaveLength(37)
    const first = open()[0]
    await act(async () => first.finish(info(first.id, 'image', 'Foto 1.jpg', { view: false, inline: true })))
    await settle()
    expect(open()).toHaveLength(AT_ONCE)
    expect(FakeRequest.made).toHaveLength(4)
    // Through: the block shows the picture now.
    expect(box.querySelector(`[data-attachment-id="${first.id}"] img`)).not.toBeNull()
  })

  it('NOTES-10 EC-2 a broken connection says so in red and offers to upload again', async () => {
    const { editor, box } = await mount()
    await act(async () => {
      await attachFiles(editor, NOTE, [file('Buchung Ferienwohnung.pdf', 300_000, 'application/pdf')])
    })
    const request = FakeRequest.made[0]
    await act(async () => request.breakOff())
    const card = box.querySelector('[data-testid="attachment-upload"]')!
    expect(card.getAttribute('data-state')).toBe('failed')
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.textContent).toContain('Upload stopped, the connection was gone. The attachment is still missing.')
    await act(async () => (box.querySelector('[data-testid="attachment-retry"]') as HTMLButtonElement).click())
    expect(FakeRequest.made).toHaveLength(2)
    expect(FakeRequest.made[1].id).toBe(request.id)
    await act(async () => FakeRequest.made[1].finish(info(request.id, 'pdf', 'Buchung Ferienwohnung.pdf', { pages: 2 })))
    await settle()
    expect(box.querySelector('[data-testid="attachment-pdf"]')).not.toBeNull()
  })
})

// --- AC-6, EC-1, AC-11 ---------------------------------------------------------------------------------------------------

describe('NOTES-10 the limits', () => {
  it('NOTES-10 AC-6 a file over the limit never becomes a block; the note names it, its size and the limit, to hide', async () => {
    const { editor, box } = await mount()
    await act(async () => {
      await attachFiles(editor, NOTE, [file('Drohnenflug.mp4', 1_503_238_554, 'video/mp4'), file('klein.txt', 10)])
    })
    await settle()
    expect(blocks(editor).map((block) => block.attrs.name)).toEqual(['klein.txt'])
    const refused = box.querySelector('[data-testid="attach-refused"]')!
    expect(refused.textContent).toContain('Drohnenflug.mp4 · 1.4 GB')
    expect(refused.textContent).toContain('Too large. At most 100 MB per file; the operator sets this.')
    await act(async () => (box.querySelector('[data-testid="attach-refused-hide"]') as HTMLButtonElement).click())
    expect(box.querySelector('[data-testid="attach-refused"]')).toBeNull()
    expect(FakeRequest.made.map((request) => request.body && (request.body as File).name)).toEqual(['klein.txt'])
  })

  it('NOTES-10 EC-1 with the storage full nothing is attached and the note says why; writing goes on', async () => {
    limits = { ...limits, used: 5_368_709_120, limit: 5_368_709_120, full: true }
    const { editor, box } = await mount()
    await act(async () => loadLimits(true))
    await act(async () => {
      await attachFiles(editor, NOTE, [file('Strand.heic', 2000)])
    })
    await settle()
    expect(blocks(editor)).toEqual([])
    expect(FakeRequest.made).toEqual([])
    expect(box.querySelector('[data-testid="attach-refused"]')!.textContent).toContain('Your storage is full (5.0 GB of 5.0 GB). New attachments only once there is room.')
    await act(async () => typeText(editor, 'noch Text'))
    expect(editor.state.doc.textContent).toContain('noch Text')
  })

  it('NOTES-10 EC-1 the server refusing for a full storage shows it on the block', async () => {
    const { editor, box } = await mount()
    await act(async () => {
      await attachFiles(editor, NOTE, [file('a.zip', 2000)])
    })
    await act(async () => FakeRequest.made[0].fail(507, { code: 'storage_limit_reached', message: 'x', used: 10, limit: 10 }))
    expect(box.querySelector('[data-testid="attachment-upload"]')!.textContent).toContain('Your storage is full. The attachment is still missing.')
    expect(box.querySelector('[data-testid="attachment-retry"]')).toBeNull()
  })

  it('NOTES-10 AC-11 a full storage puts an orange bar with taken and allowed space over every page', async () => {
    limits = { ...limits, used: 5_368_709_120, limit: 5_368_709_120, full: true }
    await act(async () => loadLimits(true))
    const box = document.createElement('div')
    document.body.appendChild(box)
    await act(async () => {
      root = createRoot(box)
      root.render(<MemoryRouter>{SHELL_BANNERS.map((banner) => <div key={banner.key}>{banner.render()}</div>)}</MemoryRouter>)
    })
    await settle()
    const bar = box.querySelector('[data-testid="storage-full"]')!
    expect(bar.getAttribute('role')).toBe('status')
    expect(bar.className).toContain('text-warn-500')
    expect(bar.textContent).toContain('Your storage is full: 5.0 GB of 5.0 GB. Writing goes on; new attachments only once there is room.')
    expect(box.querySelector('[data-testid="storage-large"]')!.getAttribute('href')).toBe('/attachments?sort=largest')
    expect(box.querySelector('[data-testid="storage-large"]')!.textContent).toBe('See large attachments')
  })

  it('NOTES-10 AC-11 without a full storage there is no bar', async () => {
    await act(async () => loadLimits(true))
    const box = document.createElement('div')
    document.body.appendChild(box)
    await act(async () => {
      root = createRoot(box)
      root.render(<MemoryRouter>{SHELL_BANNERS.map((banner) => <div key={banner.key}>{banner.render()}</div>)}</MemoryRouter>)
    })
    expect(box.querySelector('[data-testid="storage-full"]')).toBeNull()
  })
})

// --- AC-2, AC-3, AC-4, AC-8, EC-3, EC-7, EC-4, EC-8, AC-12 ----------------------------------------------------------------

async function noteWith(items: AttachmentInfo[], content: Array<Record<string, unknown>>, options: { editable?: boolean } = {}) {
  known = items
  const mounted = await mount(options)
  await act(async () => {
    mounted.editor.commands.setContent({ type: 'doc', content })
  })
  await settle(6)
  return mounted
}

describe('NOTES-10 how attachments stand in the note', () => {
  it('NOTES-10 AC-2 a picture is shown in its size with name and size; the size can be chosen and it opens large', async () => {
    const picture = info('Pic1aaaaaaaaaaaaaaaaaa', 'image', 'Alte Fliesen.jpg', { mime: 'image/jpeg', inline: true, size: 2_936_013, width: 800, height: 600 })
    const { editor, box } = await noteWith([picture], [{ type: 'image', attrs: { id: picture.id, name: picture.name } }])
    const figure = box.querySelector('figure.nn-picture') as HTMLElement
    expect(figure.style.width).toBe('62%')
    expect(figure.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${picture.id}/file`)
    expect(box.querySelector('[data-testid="attachment-caption"]')!.textContent).toBe('Alte Fliesen.jpg · 2.8 MB')
    await act(async () => (box.querySelector('[data-testid="attachment-size"]') as HTMLButtonElement).click())
    await act(async () => (document.querySelector('[data-testid="attachment-size-full"]') as HTMLButtonElement).click())
    expect(blocks(editor)[0].attrs.size).toBe('full')
    expect((box.querySelector('figure.nn-picture') as HTMLElement).style.width).toBe('100%')
    await act(async () => (box.querySelector('[data-testid="attachment-open-large"]') as HTMLButtonElement).click())
    const large = document.querySelector('[data-testid="attachment-lightbox"]')!
    expect(large.getAttribute('role')).toBe('dialog')
    // Covering the app, with a bar of its own in both modes (the colours are checked with the sketch's viewer, NOTES-18).
    expect(large.classList.contains('nn-viewer')).toBe(true)
    expect(large.querySelector('[data-testid="viewer-bar"]')!.classList.contains('nn-viewer-bar')).toBe(true)
    expect(large.className).not.toMatch(/\/\d+|bg-black/)
    expect(large.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${picture.id}/file`)
  })

  it('NOTES-10 EC-3 a HEIC photo shows through the picture every browser reads', async () => {
    const heic = info('Heic1aaaaaaaaaaaaaaaaa', 'image', 'Wohnzimmer.heic', { mime: 'image/heic', view: true, size: 3_355_443 })
    const { box } = await noteWith([heic], [{ type: 'image', attrs: { id: heic.id, name: heic.name } }])
    expect(box.querySelector('figure.nn-picture img')!.getAttribute('src')).toBe(`/api/attachments/${heic.id}/view`)
    expect(box.querySelector('[data-testid="attachment-caption"]')!.textContent).toBe('Wohnzimmer.heic · 3.2 MB')
  })

  it('NOTES-10 AC-3 a PDF shows its first page, name, pages and size and opens to browse', async () => {
    const pdf = info('Pdf1aaaaaaaaaaaaaaaaaa', 'pdf', 'Datenblatt Sofa.pdf', { mime: 'application/pdf', pages: 12, thumb: true, inline: true, size: 2_516_582 })
    const { box } = await noteWith([pdf], [{ type: 'attachment', attrs: { id: pdf.id, name: pdf.name } }])
    const card = box.querySelector('[data-testid="attachment-pdf"]')!
    expect(card.textContent).toContain('Datenblatt Sofa.pdf')
    expect(card.textContent).toContain('PDF · 12 pages · 2.4 MB')
    expect(card.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${pdf.id}/thumb`)
    await act(async () => (card.querySelector('button') as HTMLButtonElement).click())
    expect(window.open).toHaveBeenCalledWith(`/api/attachments/${pdf.id}/file`, '_blank', 'noopener,noreferrer')
  })

  it('NOTES-10 AC-4 any other file shows its symbol, name and size and downloads', async () => {
    const zip = info('Zip1aaaaaaaaaaaaaaaaaa', 'file', 'Grundriss.zip', { size: 798_720 })
    const { box } = await noteWith([zip], [{ type: 'attachment', attrs: { id: zip.id, name: zip.name } }])
    const card = box.querySelector('[data-testid="attachment-file"]')!
    expect(card.textContent).toContain('Grundriss.zip')
    expect(card.textContent).toContain('780 KB · Download')
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '')
    })
    await act(async () => (card.querySelector('[data-testid="attachment-download"]') as HTMLButtonElement).click())
    expect(clicked).toEqual([`/api/attachments/${zip.id}/file?download=1`])
  })

  it('NOTES-10 AC-3 a file the server gave up reading (a PDF bomb) is a file to download that says it has no preview', async () => {
    const bomb = info('Bom1aaaaaaaaaaaaaaaaaa', 'file', 'plan.pdf', { size: 633, preview_failed: true })
    const plain = info('Zip2aaaaaaaaaaaaaaaaaa', 'file', 'Grundriss.zip', { size: 798_720 })
    const { box } = await noteWith([bomb, plain], [
      { type: 'attachment', attrs: { id: bomb.id, name: bomb.name } },
      { type: 'attachment', attrs: { id: plain.id, name: plain.name } },
    ])
    const [first, second] = [...box.querySelectorAll('[data-testid="attachment-file"]')]
    expect(first.querySelector('[data-testid="attachment-no-preview"]')!.textContent).toBe('No preview: too demanding to show')
    expect(first.querySelector('[data-testid="attachment-download"]')).not.toBeNull()
    expect(second.querySelector('[data-testid="attachment-no-preview"]')).toBeNull()
  })

  it('NOTES-10 AC-8 a video plays in the note, with its still and length', async () => {
    const video = info('Vid1aaaaaaaaaaaaaaaaaa', 'video', 'Rundgang Wohnzimmer.mov', { mime: 'video/mp4', thumb: true, inline: true, duration_ms: 42_000, size: 50_331_648 })
    const { box } = await noteWith([video], [{ type: 'attachment', attrs: { id: video.id, name: video.name } }])
    const card = box.querySelector('[data-testid="attachment-video"]')!
    expect(card.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${video.id}/thumb`)
    expect(card.textContent).toContain('0:42')
    expect(card.textContent).toContain('Rundgang Wohnzimmer.mov · 48.0 MB')
    await act(async () => (card.querySelector('[data-testid="attachment-play"]') as HTMLButtonElement).click())
    const player = card.querySelector('video')!
    expect(player.getAttribute('src')).toBe(`/api/attachments/${video.id}/file`)
    expect(player.hasAttribute('controls')).toBe(true)
  })

  it('NOTES-10 EC-7 a video the browser cannot play shows its still, name and "Download"', async () => {
    const video = info('Vid2aaaaaaaaaaaaaaaaaa', 'video', 'IMG_0042.MOV', { mime: 'video/mp4', thumb: true, inline: true })
    const { box } = await noteWith([video], [{ type: 'attachment', attrs: { id: video.id, name: video.name } }])
    await act(async () => (box.querySelector('[data-testid="attachment-play"]') as HTMLButtonElement).click())
    await act(async () => box.querySelector('video')!.dispatchEvent(new Event('error')))
    const card = box.querySelector('[data-testid="attachment-video"]')!
    expect(card.getAttribute('data-playable')).toBe('false')
    expect(card.querySelector('video')).toBeNull()
    expect(card.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${video.id}/thumb`)
    expect(card.textContent).toContain('IMG_0042.MOV')
    expect(card.querySelector('[data-testid="attachment-download"]')!.textContent).toBe('Download')
  })

  it('NOTES-10 EC-4 a name with HTML stays text', async () => {
    const hostile = info('Bad1aaaaaaaaaaaaaaaaaa', 'file', '<img src=x onerror="window.hacked=1">.svg')
    const { box } = await noteWith([hostile], [{ type: 'attachment', attrs: { id: hostile.id, name: hostile.name } }])
    expect(box.querySelector('[data-testid="attachment-file"]')!.textContent).toContain('<img src=x onerror="window.hacked=1">.svg')
    expect(box.querySelector('[data-testid="attachment-file"] img')).toBeNull()
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined()
  })

  it('NOTES-10 EC-8 two files of the same name both stay', async () => {
    const one = info('Same1aaaaaaaaaaaaaaaaa', 'file', 'Notiz.txt', { size: 13 })
    const two = info('Same2aaaaaaaaaaaaaaaaa', 'file', 'Notiz.txt', { size: 14 })
    const { box } = await noteWith([one, two], [
      { type: 'attachment', attrs: { id: one.id, name: one.name } },
      { type: 'attachment', attrs: { id: two.id, name: two.name } },
    ])
    expect(box.querySelectorAll('[data-testid="attachment-file"]')).toHaveLength(2)
    expect(Array.from(box.querySelectorAll('[data-attachment-id]')).map((element) => element.getAttribute('data-attachment-id'))).toEqual([one.id, two.id])
  })

  it('NOTES-10 AC-12 removing takes the block out of the note', async () => {
    const zip = info('Zip2aaaaaaaaaaaaaaaaaa', 'file', 'weg.zip')
    const { editor, box } = await noteWith([zip], [{ type: 'paragraph', content: [{ type: 'text', text: 'bleibt' }] }, { type: 'attachment', attrs: { id: zip.id, name: zip.name } }])
    await act(async () => (box.querySelector('[data-testid="attachment-remove"]') as HTMLButtonElement).click())
    expect(blocks(editor)).toEqual([])
    expect(editor.state.doc.textContent).toBe('bleibt')
  })

  it('NOTES-10 an attachment somebody else still uploads says it is missing yet, and shows once it is there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { box } = await noteWith([], [{ type: 'image', attrs: { id: 'Else1aaaaaaaaaaaaaaaaa', name: 'von Anna.jpg' } }])
    const card = box.querySelector('[data-testid="attachment-missing"]')!
    expect(card.textContent).toContain('von Anna.jpg')
    expect(card.textContent).toContain('The attachment is still missing.')
    // Anna's upload takes a while: the note asks again until it is there, then the picture shows.
    try {
      await act(async () => vi.advanceTimersByTimeAsync(ASK_AGAIN_MS + 100))
      await settle()
      expect(box.querySelector('[data-testid="attachment-missing"]')).not.toBeNull()
      known.push(info('Else1aaaaaaaaaaaaaaaaa', 'image', 'von Anna.jpg', { inline: true }))
      await act(async () => vi.advanceTimersByTimeAsync(ASK_AGAIN_MS + 100))
      await settle()
      expect(box.querySelector('[data-testid="attachment-missing"]')).toBeNull()
      expect(box.querySelector('[data-attachment-id="Else1aaaaaaaaaaaaaaaaa"] img')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('NOTES-10 EC-10 a note one only reads', () => {
  it('NOTES-10 EC-10 opens and downloads, but nothing is attached or removed', async () => {
    const zip = info('Read1aaaaaaaaaaaaaaaaa', 'file', 'Plan.zip')
    const picture = info('Read2aaaaaaaaaaaaaaaaa', 'image', 'Foto.jpg', { inline: true })
    known = [zip, picture]
    const { editor, box } = await mount({ editable: false })
    await act(async () => {
      editor.setEditable(true)
      editor.commands.setContent({ type: 'doc', content: [{ type: 'attachment', attrs: { id: zip.id, name: zip.name } }, { type: 'image', attrs: { id: picture.id, name: picture.name } }] })
      editor.setEditable(false)
    })
    await settle(6)
    expect(box.querySelector('[data-testid="attachment-download"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="attachment-open-large"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="attachment-remove"]')).toBeNull()
    expect(box.querySelector('[data-testid="attachment-size"]')).toBeNull()
    expect(box.querySelector('[data-testid="attach"]')).toBeNull()
    await act(async () => {
      expect(drop(editor, [file('neu.pdf')])).toBe(true)
      expect(paste(editor, { files: [file('neu.png', 10, 'image/png')] })).toBe(true)
    })
    await settle()
    expect(blocks(editor)).toHaveLength(2)
    expect(FakeRequest.made).toEqual([])
  })
})

// --- AC-5, AC-9 ---------------------------------------------------------------------------------------------------------

describe('NOTES-10 links', () => {
  const HREF = 'https://moebel-beispiel.example.com/ecksofa'

  it('NOTES-10 AC-5 a link pasted on its own becomes a card with title, description, picture and site', async () => {
    cards[HREF] = { href: HREF, title: 'Ecksofa Beispiel, 3-Sitzer', description: 'Maße, Bezüge und Lieferzeit im Überblick', site: 'moebel-beispiel.example.com', image: 'Card1aaaaaaaaaaaaaaaaa' }
    const { editor, box } = await mount()
    await act(async () => {
      expect(paste(editor, { text: HREF })).toBe(true)
    })
    await settle(6)
    expect(asked).toContain(`POST /api/notes/${NOTE}/link-preview`)
    expect(blocks(editor)).toEqual([{ type: 'linkPreview', attrs: cards[HREF] }])
    const card = box.querySelector('[data-testid="attachment-link"]')!
    expect(card.textContent).toContain('Ecksofa Beispiel, 3-Sitzer')
    expect(card.textContent).toContain('Maße, Bezüge und Lieferzeit im Überblick')
    expect(card.textContent).toContain('moebel-beispiel.example.com')
    expect(card.querySelector('img')!.getAttribute('src')).toBe('/api/attachments/Card1aaaaaaaaaaaaaaaaa/thumb')
    await act(async () => (card.querySelector('button') as HTMLButtonElement).click())
    expect(window.open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer')
    // Kept as a plain link, if the member likes it so.
    await act(async () => (box.querySelector('[data-testid="attachment-plain-link"]') as HTMLButtonElement).click())
    expect(blocks(editor)).toEqual([])
    let marked = ''
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'link')) marked = node.text ?? ''
    })
    expect(marked).toBe(HREF)
  })

  it('NOTES-10 AC-5 a page that gives no card leaves the plain link at once', async () => {
    const { editor } = await mount()
    await act(async () => {
      paste(editor, { text: 'https://unreachable.example.org/' })
    })
    // Right away, before any answer: a link.
    let linked = false
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'link' && mark.attrs.href === 'https://unreachable.example.org/')) linked = true
    })
    expect(linked).toBe(true)
    await settle(6)
    expect(blocks(editor)).toEqual([])
  })

  it('NOTES-10 AC-9 switched off by the operator, a link stays a link and the server is not asked', async () => {
    limits.link_previews = false
    cards[HREF] = { href: HREF, title: 'x', description: null, site: null, image: null }
    const { editor } = await mount()
    await act(async () => loadLimits(true))
    await act(async () => {
      paste(editor, { text: HREF })
    })
    await settle(6)
    expect(blocks(editor)).toEqual([])
    expect(asked.filter((entry) => entry.includes('link-preview'))).toEqual([])
  })

  it('NOTES-10 AC-5 a link inside a sentence stays a link, only an address is taken as one', async () => {
    expect(pastedLink('https://a.example/x')).toBe('https://a.example/x')
    expect(pastedLink('see https://a.example')).toBeNull()
    expect(pastedLink('javascript:alert(1)')).toBeNull()
    expect(pastedLink('ftp://a.example')).toBeNull()
    cards[HREF] = { href: HREF, title: 'T', description: null, site: null, image: null }
    const { editor } = await mount()
    await act(async () => {
      editor.commands.setContent('<p>Schau hier: </p><p> und mehr</p>')
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      paste(editor, { text: HREF })
      // At the start of a line with words after it: still a sentence.
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1)
      paste(editor, { text: HREF })
    })
    await settle(6)
    expect(blocks(editor)).toEqual([])
    expect(asked.filter((entry) => entry.includes('link-preview'))).toHaveLength(2)
  })
})

// --- AC-7, EC-9 ---------------------------------------------------------------------------------------------------------

function Where() {
  const location = useLocation()
  return <span data-testid="where">{location.pathname + location.search}</span>
}

async function showGallery(path = '/attachments'): Promise<HTMLElement> {
  const box = document.createElement('div')
  document.body.appendChild(box)
  await act(async () => {
    root = createRoot(box)
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/attachments" element={<GalleryPage />} />
          <Route path="/notes/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
  return box
}

describe('NOTES-10 AC-7 the gallery', () => {
  function fill(count: number) {
    const kinds: AttachmentInfo['kind'][] = ['image', 'pdf', 'video', 'file']
    const items = Array.from({ length: count }, (_, index) => ({
      ...info(`G${String(index).padStart(21, '0')}`, kinds[index % 4], `Datei ${index}`, { size: 1000 + index, thumb: index % 4 === 0 }),
      note: { id: `n${index % 3}`, title: `Notiz ${index % 3}` },
    }))
    gallery = {
      total: count,
      all: count,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
      counts: { image: items.filter((item) => item.kind === 'image').length, scan: 0, pdf: items.filter((item) => item.kind === 'pdf').length, recording: 0, drawing: 0, video: items.filter((item) => item.kind === 'video').length, file: items.filter((item) => item.kind === 'file').length },
      items,
    }
  }

  it('NOTES-10 AC-7 shows kind, name, note and size, the kinds with their numbers, and leads into the note', async () => {
    fill(400)
    const box = await showGallery()
    expect(box.querySelector('h1')!.textContent).toBe('Attachments')
    expect(box.querySelector('[data-testid="gallery-summary"]')!.textContent).toMatch(/^400 files · /)
    const chips = Array.from(box.querySelectorAll('[data-testid="gallery-kinds"] [role="radio"]')).map((chip) => chip.textContent)
    expect(chips).toEqual(['All400', 'Pictures100', 'Scans0', 'PDFs100', 'Recordings0', 'Sketches0', 'Videos100', 'Files100'])
    const tiles = box.querySelectorAll('[data-testid="gallery-item"]')
    expect(tiles).toHaveLength(120)
    expect(tiles[0].textContent).toContain('Picture')
    expect(tiles[0].textContent).toContain('Datei 0')
    expect(tiles[0].textContent).toContain('in “Notiz 0” · 1,000 B')
    expect(tiles[0].querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/G${'0'.repeat(21)}/thumb`)
    await act(async () => (box.querySelector('[data-testid="gallery-more"]') as HTMLButtonElement).click())
    await settle()
    expect(box.querySelectorAll('[data-testid="gallery-item"]')).toHaveLength(240)
    await act(async () => (tiles[1] as HTMLButtonElement).click())
    expect(document.querySelector('[data-testid="where"]')!.textContent).toBe(`/notes/n1?attachment=G${'0'.repeat(20)}1`)
  })

  it('NOTES-10 AC-7 filters by kind and sorts the largest first', async () => {
    fill(40)
    const box = await showGallery()
    await act(async () => (box.querySelector('[data-testid="gallery-kind-pdf"]') as HTMLButtonElement).click())
    await settle()
    expect(box.querySelector('[data-testid="gallery-kind-pdf"]')!.getAttribute('aria-checked')).toBe('true')
    const kinds = Array.from(box.querySelectorAll('[data-testid="gallery-item"]')).map((tile) => tile.getAttribute('data-kind'))
    expect(new Set(kinds)).toEqual(new Set(['pdf']))
    expect(kinds).toHaveLength(10)
    const select = box.querySelector('[data-testid="gallery-sort"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'largest'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(asked.some((entry) => entry.includes('sort=largest') && entry.includes('kind=pdf'))).toBe(true)
    const names = Array.from(box.querySelectorAll('[data-testid="gallery-item"]')).map((tile) => tile.textContent)
    expect(names[0]).toContain('Datei 37')
  })

  it('NOTES-10 AC-11 "See large attachments" opens the gallery largest first', async () => {
    fill(8)
    await showGallery('/attachments?sort=largest')
    expect(asked.some((entry) => entry.includes('sort=largest'))).toBe(true)
    expect((document.querySelector('[data-testid="gallery-sort"]') as HTMLSelectElement).value).toBe('largest')
  })

  it('NOTES-10 EC-9 an empty gallery says how to attach', async () => {
    const box = await showGallery()
    const empty = box.querySelector('[data-testid="gallery-empty"]')!
    expect(empty.textContent).toContain('No attachments yet')
    expect(empty.textContent).toContain('Drag photos, PDFs, videos or other files into a note, paste them or choose “Attach” there.')
    expect(box.querySelector('[data-testid="gallery-kinds"]')).toBeNull()
  })

  it('NOTES-10 AC-7 NOTES-7 "Attachments" is a smart folder now, not a fixed entry; the gallery stays at its address', () => {
    expect(SIDEBAR_SECTIONS.map((section) => section.key)).not.toContain('attachments')
    expect(FEATURE_ROUTES.map((route) => route.path)).toContain('attachments')
  })
})
