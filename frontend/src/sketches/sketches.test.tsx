/**
 * NOTES-18 in the page: a sketch from the iPad shown sharp and large, to zoom (AC-1, EC-5), a new version without
 * reloading (AC-2), moved, removed and downloaded like any attachment (AC-6); a recording played with its text read
 * along (AC-3), a word that jumps (AC-4), speeds per device (AC-5), the player's parts (AC-7), a corrected text (EC-1),
 * a format the browser cannot play (EC-3), one recording at a time (EC-4), the keyboard (EC-6), and that playing is
 * nobody else's business (EC-7). The editor runs on a Yjs document as in the app; the server is a stand-in for fetch.
 */
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { act, useEffect, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import * as Y from 'yjs'

import type { AttachmentInfo } from '../attachments/api'
import { forgetAttachments } from '../attachments/info'
import { editorExtensions, editorProps } from '../editor/extensions'
import { presenceUser } from '../editor/presence'
import { NoteProvider } from '../editor/provider'
import i18n from '../i18n'
import { RATE_KEY, reloadRate } from './playback'
import { JUMP_MS } from './RecordingBlock'
import { activeIndex, forgetTranscripts, jumpTarget, timedIndexes, tokensOf, type Transcript } from './transcript'
import { contrast } from '../lib/color'

/** `styles/index.css` as the browser gets it. */
async function pageCss(): Promise<string> {
  const fsName = 'node:fs'
  const files = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (file: string, encoding: string) => string }
  return files.readFileSync('src/styles/index.css', 'utf-8').replace(/\r\n/g, '\n')
}

/** The colours a theme block sets (`@theme` dark, `:root[data-theme='light']` light). */
function themeColors(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1], match[2]]))
}

/** The body of a rule in the components layer. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`  ${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

function token(body: string, property: string): string {
  return new RegExp(`(?:^|\\s)${property}: var\\((--[\\w-]+)\\)`).exec(body)?.[1] ?? ''
}

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values)
const NOTE = 'note-18'
const PICTURE = 'Sk3tchP1ctur3_0000000a'
const NEW_PICTURE = 'Sk3tchP1ctur3_0000000b'
const THIRD_PICTURE = 'Sk3tchP1ctur3_0000000c'
const DATA = 'Sk3tchD4t4_00000000000a'
const SOUND = 'R3c0rd1ngS0und_000000a'
const SECOND = 'R3c0rd1ngS0und_000000b'
const WORDS = 'R3c0rd1ngT3xt_0000000a'

// --- The server, standing in --------------------------------------------------------------------------------------

let known: AttachmentInfo[]
let transcripts: Record<string, Transcript>
let asked: string[]

function info(id: string, kind: AttachmentInfo['kind'], name: string, extra: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return { id, note_id: NOTE, kind, name, mime: 'application/octet-stream', size: 48_000, width: null, height: null, pages: null, duration_ms: null, view: false, thumb: true, inline: true, created_at: '2026-11-21T08:00:00+00:00', ...extra }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Eight words over three seconds, the second sentence after the fourth word. */
const SPOKEN: Transcript = {
  format: 1,
  language: 'de-DE',
  text: null,
  words: ['Der', 'erste', 'Termin.', 'Dann', 'kommt', 'der', 'zweite', 'Januar.'].map((text, index) => ({ text, start: index * 400, end: index * 400 + 350 })),
}

// --- Media, standing in (jsdom plays nothing) -------------------------------------------------------------------------

type FakeMedia = HTMLMediaElement & { _paused?: boolean; _time?: number }
let playable = true
const played: FakeMedia[] = []
const paused: FakeMedia[] = []

beforeAll(async () => {
  await i18n.changeLanguage('de')
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = noRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getClientRects = noRects
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const proto = HTMLMediaElement.prototype as FakeMedia
  Object.defineProperty(proto, 'paused', { configurable: true, get(this: FakeMedia) { return this._paused ?? true } })
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 1 })
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: FakeMedia) { return this._time ?? 0 },
    set(this: FakeMedia, value: number) { this._time = value },
  })
  proto.play = function play(this: FakeMedia) {
    this._paused = false
    played.push(this)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  proto.pause = function pause(this: FakeMedia) {
    if (this._paused === false) paused.push(this)
    this._paused = true
    this.dispatchEvent(new Event('pause'))
  }
  proto.canPlayType = () => (playable ? 'maybe' : '')
  proto.load = () => undefined
})

beforeEach(() => {
  known = [
    info(PICTURE, 'drawing', 'Skizze.png', { mime: 'image/png', width: 1600, height: 900 }),
    info(DATA, 'drawingdata', 'Skizze.drawing', { inline: false }),
    info(SOUND, 'recording', 'Besprechung.m4a', { mime: 'audio/mp4', duration_ms: 3_130_000 }),
    info(SECOND, 'recording', 'Nachtrag.m4a', { mime: 'audio/mp4', duration_ms: 60_000 }),
  ]
  transcripts = { [WORDS]: SPOKEN }
  asked = []
  playable = true
  played.length = 0
  paused.length = 0
  try {
    window.localStorage.removeItem(RATE_KEY)
  } catch {
    // no storage
  }
  reloadRate()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.startsWith(`/api/notes/${NOTE}/attachments`)) return json({ items: known })
      const file = /^\/api\/attachments\/([^/]+)\/file$/.exec(path)
      if (file && transcripts[file[1]]) return json(transcripts[file[1]])
      if (path.startsWith('/api/attachments/limits')) return json({ max_mb: 100, used: 0, limit: null, full: false, link_previews: false })
      return json({}, 404)
    }),
  )
  forgetAttachments()
  forgetTranscripts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- An editor in the page -------------------------------------------------------------------------------------------

let root: Root | null = null
let doc: Y.Doc

function Note({ onEditor, editable }: { onEditor: (editor: Editor) => void; editable: boolean }) {
  const ydoc = useMemo(() => doc, [])
  const provider = useMemo(() => new NoteProvider(NOTE, ydoc, { socket: () => { throw new Error('offline in tests') } }), [ydoc])
  const extensions = useMemo(() => editorExtensions({ doc: ydoc, provider, me: presenceUser(1, 'Anna'), t, placeholder: '', noteId: NOTE }), [ydoc, provider])
  const editor = useEditor({ extensions, editorProps, editable })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  return <EditorContent editor={editor} />
}

async function settle(times = 6) {
  for (let index = 0; index < times; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function mount(blocks: object[], options: { editable?: boolean } = {}): Promise<{ editor: Editor; box: HTMLElement }> {
  doc = new Y.Doc()
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
  const editor = made! as Editor
  await act(async () => {
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Besprechung' }] }, ...blocks] })
  })
  await settle()
  return { editor, box }
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

const sketch = (attrs: Record<string, unknown> = {}) => ({ type: 'drawing', attrs: { id: PICTURE, data: DATA, name: 'Skizze.png', ...attrs } })
const recording = (attrs: Record<string, unknown> = {}) => ({ type: 'recording', attrs: { id: SOUND, name: 'Besprechung.m4a', duration: 3_130_000, transcript: WORDS, ...attrs } })

function byTest(box: ParentNode, id: string): HTMLElement {
  const found = box.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!found) throw new Error(`no ${id}`)
  return found
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function key(element: Element, name: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })
}

function audioOf(box: ParentNode, index = 0): FakeMedia {
  return box.querySelectorAll<HTMLAudioElement>('[data-testid="recording-audio"]')[index] as FakeMedia
}

/** The recording reached `ms`, as the browser says while it plays. */
async function playedTo(media: FakeMedia, ms: number) {
  await act(async () => {
    media._time = ms / 1000
    media.dispatchEvent(new Event('timeupdate'))
  })
}

function words(box: ParentNode): HTMLElement[] {
  return Array.from(box.querySelectorAll<HTMLElement>('[data-testid="recording-transcript"] [data-i]'))
}

function stateOf(word: HTMLElement): string {
  if (word.classList.contains('nn-w-now')) return 'now'
  if (word.classList.contains('nn-w-sentence')) return 'sentence'
  if (word.classList.contains('nn-w-heard')) return 'heard'
  return 'coming'
}

// --- Sketches ---------------------------------------------------------------------------------------------------------

describe('NOTES-18 sketches', () => {
  it('NOTES-18 AC-1 a sketch from the iPad stands as a sharp picture at its place, says it is only to look at here and saves as a picture', async () => {
    const { box } = await mount([sketch(), { type: 'paragraph', content: [{ type: 'text', text: 'danach' }] }])
    const shown = byTest(box, 'sketch')
    const image = byTest(shown, 'sketch-image') as HTMLImageElement
    // The picture itself (not a reduced preview), on light paper in both themes.
    expect(image.getAttribute('src')).toBe(`/api/attachments/${PICTURE}/file`)
    expect(byTest(shown, 'sketch-open').className).toContain('nn-sketch-paper')
    expect(byTest(shown, 'sketch-caption').textContent).toBe('Skizze · im Browser nur ansehen, zeichnen auf iPhone und iPad')
    expect(byTest(shown, 'sketch-download').textContent).toBe('Als Bild laden')
    // At its place: after the paragraph before it, before the one after it.
    const order = Array.from(box.querySelectorAll('p, [data-testid="sketch"]')).map((node) => node.textContent?.slice(0, 11))
    expect(order[0]).toBe('Besprechung')
    expect(order[order.length - 1]).toBe('danach')
    // Saving it downloads the file, the page stays.
    const anchors: HTMLAnchorElement[] = []
    const real = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function clickAnchor(this: HTMLAnchorElement) {
      anchors.push(this)
    }
    await click(byTest(shown, 'sketch-download'))
    HTMLAnchorElement.prototype.click = real
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([`/api/attachments/${PICTURE}/file?download=1`])
    // Large: the original over the whole page.
    await click(byTest(shown, 'sketch-open'))
    const viewer = byTest(document, 'sketch-viewer')
    expect((byTest(viewer, 'sketch-viewer-image') as HTMLImageElement).getAttribute('src')).toBe(`/api/attachments/${PICTURE}/file`)
    await key(document.body, 'Escape')
    expect(document.querySelector('[data-testid="sketch-viewer"]')).toBeNull()
  })

  it('NOTES-18 AC-1 a large sketch shows its view in the note and the original when opened', async () => {
    known[0] = { ...known[0], view: true, width: 6000, height: 4000 }
    const { box } = await mount([sketch()])
    expect(byTest(box, 'sketch-image').getAttribute('src')).toBe(`/api/attachments/${PICTURE}/view`)
    await click(byTest(box, 'sketch-open'))
    expect(byTest(document, 'sketch-viewer-image').getAttribute('src')).toBe(`/api/attachments/${PICTURE}/file`)
  })

  it('NOTES-18 EC-5 a sketch of a large area zooms and moves when opened large', async () => {
    const { box } = await mount([sketch()])
    await click(byTest(box, 'sketch-open'))
    const viewer = byTest(document, 'sketch-viewer')
    const image = byTest(viewer, 'sketch-viewer-image')
    expect(byTest(viewer, 'sketch-zoom').textContent).toBe('100 %')
    await click(byTest(viewer, 'sketch-zoom-in'))
    await click(byTest(viewer, 'sketch-zoom-in'))
    expect(byTest(viewer, 'sketch-zoom').textContent).toBe('156 %')
    expect(image.style.transform).toContain('scale(1.5625)')
    // Dragging moves it.
    const stage = byTest(viewer, 'sketch-stage')
    await act(async () => {
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }))
      stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 160, clientY: 70, pointerId: 1 }))
      stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 160, clientY: 70, pointerId: 1 }))
    })
    expect(image.style.transform).toContain('translate(60px, -30px)')
    // The wheel and the keys zoom too; 0 fits it again.
    await act(async () => {
      stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
    })
    expect(byTest(viewer, 'sketch-zoom').textContent).toBe('125 %')
    await key(document.body, '+')
    expect(byTest(viewer, 'sketch-zoom').textContent).toBe('156 %')
    await key(document.body, 'ArrowLeft')
    expect(image.style.transform).toContain('translate(120px, -30px)')
    await key(document.body, '0')
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')
    // Never smaller than a quarter.
    for (let step = 0; step < 12; step++) await click(byTest(viewer, 'sketch-zoom-out'))
    expect(byTest(viewer, 'sketch-zoom').textContent).toBe('25 %')
  })

  it('NOTES-18 EC-5 the viewer covers the app and its bar is readable in light and dark (WCAG AA)', async () => {
    const { box } = await mount([sketch()])
    await click(byTest(box, 'sketch-open'))
    const viewer = byTest(document, 'sketch-viewer')
    const bar = byTest(viewer, 'viewer-bar')
    // The whole page has a ground of its own, the bar too; nothing half-transparent, no colour fixed for one mode.
    expect(viewer.classList.contains('nn-viewer')).toBe(true)
    expect(bar.classList.contains('nn-viewer-bar')).toBe(true)
    expect(`${viewer.className} ${bar.className}`).not.toMatch(/\/\d+|bg-black|text-mist-\d+/)
    const buttons = [...bar.querySelectorAll('button')]
    expect(buttons.length).toBe(5)
    for (const button of buttons) expect(button.className).toContain('nn-btn-ghost')

    const css = await pageCss()
    const ground = token(rule(css, '.nn-viewer'), 'background-color')
    const barGround = token(rule(css, '.nn-viewer-bar'), 'background-color')
    const text = token(rule(css, '.nn-viewer-bar'), 'color')
    const ghost = /\.nn-btn-ghost \{\s*@apply ([^;]+);/.exec(css)![1]
    const ghostText = `--color-${/(?:^| )text-([\w-]+)/.exec(ghost)![1]}`
    const ghostEdge = `--color-${/border-([\w-]+)/.exec(ghost)![1]}`
    for (const selector of ['@theme', ":root[data-theme='light']"]) {
      const colors = themeColors(css, selector)
      // Every colour a plain hex: fully covering.
      for (const name of [ground, barGround, text, ghostText, ghostEdge]) expect(colors[name], `${selector} ${name}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrast(colors[text], colors[barGround]), `${selector} name`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors[ghostText], colors[barGround]), `${selector} buttons`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors[ghostEdge], colors[barGround]), `${selector} edge of the buttons`).toBeGreaterThanOrEqual(3)
    }
  })

  it('NOTES-18 AC-2 a sketch changed on the iPad shows its new version without reloading, the old one until the new is known', async () => {
    const { editor, box } = await mount([sketch()])
    expect(byTest(box, 'sketch-image').getAttribute('src')).toBe(`/api/attachments/${PICTURE}/file`)
    const rename = (id: string) =>
      act(async () => {
        editor.commands.command(({ tr, state }) => {
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'drawing') tr.setNodeMarkup(pos, undefined, { ...node.attrs, id })
          })
          return true
        })
      })
    // The block names a picture that is not there (yet): the old picture stays.
    await rename(NEW_PICTURE)
    await settle()
    expect(byTest(box, 'sketch-image').getAttribute('src')).toBe(`/api/attachments/${PICTURE}/file`)
    // The app uploads first and names it then: asked for at once (not after a pause), the new version stands there.
    known.push(info(THIRD_PICTURE, 'drawing', 'Skizze.png', { mime: 'image/png' }))
    const before = asked.filter((line) => line.includes(`/api/notes/${NOTE}/attachments`)).length
    await rename(THIRD_PICTURE)
    await settle(10)
    expect(asked.filter((line) => line.includes(`/api/notes/${NOTE}/attachments`)).length).toBe(before + 1)
    expect(byTest(box, 'sketch-image').getAttribute('src')).toBe(`/api/attachments/${THIRD_PICTURE}/file`)
    expect(byTest(box, 'sketch').getAttribute('data-attachment-id')).toBe(THIRD_PICTURE)
  })

  it('NOTES-18 AC-6 a sketch and a recording are removed, moved and downloaded like any attachment', async () => {
    const { editor, box } = await mount([sketch(), recording()])
    expect(editor.schema.nodes.drawing.spec.draggable).toBe(true)
    expect(editor.schema.nodes.recording.spec.draggable).toBe(true)
    expect(box.querySelectorAll('[data-testid="attachment-remove"]').length).toBe(2)
    // Downloading the sound.
    const anchors: string[] = []
    const real = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function clickAnchor(this: HTMLAnchorElement) {
      anchors.push(this.getAttribute('href') ?? '')
    }
    await click(byTest(box, 'recording-download'))
    HTMLAnchorElement.prototype.click = real
    expect(anchors).toEqual([`/api/attachments/${SOUND}/file?download=1`])
    // Removing takes the block out of the note.
    const blocks = () => editor.getJSON().content?.map((node) => node.type).filter((type) => type !== 'paragraph')
    expect(blocks()).toEqual(['drawing', 'recording'])
    await click(box.querySelector('[data-testid="sketch"] [data-testid="attachment-remove"]')!)
    expect(blocks()).toEqual(['recording'])
    await click(box.querySelector('[data-testid="recording"] [data-testid="attachment-remove"]')!)
    expect(blocks()).toEqual([])
  })

  it('NOTES-18 AC-6 a note one only reads shows both without a way to remove them', async () => {
    const { box } = await mount([sketch(), recording()], { editable: false })
    expect(box.querySelector('[data-testid="sketch"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="recording"]')).not.toBeNull()
    expect(box.querySelectorAll('[data-testid="attachment-remove"]').length).toBe(0)
  })

  it('NOTES-18 a sketch whose picture is not there yet says so', async () => {
    known = known.filter((item) => item.id !== PICTURE)
    const { box } = await mount([sketch()])
    expect(byTest(box, 'sketch-missing').textContent).toContain('Der Anhang fehlt noch.')
  })
})

// --- Recordings -------------------------------------------------------------------------------------------------------

describe('NOTES-18 recordings', () => {
  it('NOTES-18 AC-7 a playing recording shows pause, the position to drag, the time gone and the whole time', async () => {
    const { box } = await mount([recording()])
    const player = byTest(box, 'recording')
    const toggle = byTest(player, 'recording-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Abspielen')
    expect(byTest(player, 'recording-total').textContent).toBe('52:10')
    expect(byTest(player, 'recording-elapsed').textContent).toBe('0:00')
    await click(toggle)
    expect(played).toHaveLength(1)
    expect(toggle.getAttribute('aria-label')).toBe('Anhalten')
    expect(player.getAttribute('data-playing')).toBe('true')
    await playedTo(audioOf(box), 760_000)
    expect(byTest(player, 'recording-elapsed').textContent).toBe('12:40')
    const position = byTest(player, 'recording-position') as HTMLInputElement
    expect(position.type).toBe('range')
    expect(position.getAttribute('aria-valuetext')).toBe('12:40 von 52:10')
    // Dragging the position moves the recording there.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(position, '1800000')
      position.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(audioOf(box).currentTime).toBe(1800)
    expect(byTest(player, 'recording-elapsed').textContent).toBe('30:00')
    await click(toggle)
    expect(toggle.getAttribute('aria-label')).toBe('Abspielen')
  })

  it('NOTES-18 AC-3 while it plays the spoken word is marked, its sentence stands out, what was heard is dimmer than what comes', async () => {
    const { box } = await mount([recording()])
    await settle()
    const shown = words(box)
    expect(shown.map((word) => word.textContent).join('')).toBe('Der erste Termin. Dann kommt der zweite Januar.')
    expect(shown.map(stateOf)).toEqual(Array(8).fill('coming'))
    await click(byTest(box, 'recording-toggle'))
    await playedTo(audioOf(box), 450)
    expect(shown.map(stateOf)).toEqual(['sentence', 'now', 'sentence', 'coming', 'coming', 'coming', 'coming', 'coming'])
    await playedTo(audioOf(box), 2100)
    expect(shown.map(stateOf)).toEqual(['heard', 'heard', 'heard', 'sentence', 'sentence', 'now', 'sentence', 'sentence'])
    // Back to the start: everything comes again.
    await playedTo(audioOf(box), 0)
    expect(shown.map(stateOf)).toEqual(['now', 'sentence', 'sentence', 'coming', 'coming', 'coming', 'coming', 'coming'])
    // The colours: heard dimmer than coming, the word in honey.
    const fsName = 'node:fs'
    const files = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (file: string, encoding: string) => string }
    const css = files.readFileSync('src/sketches/sketches.css', 'utf-8')
    expect(css).toMatch(/\.nn-w-heard \{\s*color: var\(--color-mist-500\)/)
    expect(css).toMatch(/\.nn-transcript \.nn-w \{\s*color: var\(--color-mist-300\)/)
    expect(css).toMatch(/\.nn-w-now \{[^}]*rgb\(242 193 78/)
  })

  it('NOTES-18 AC-4 a word tapped in the text moves the recording there', async () => {
    const { box } = await mount([recording()])
    await settle()
    await click(words(box)[6])
    expect(audioOf(box).currentTime).toBe(2.4)
    expect(byTest(box, 'recording-elapsed').textContent).toBe('0:02')
    expect(words(box).map(stateOf)[6]).toBe('now')
    expect(byTest(box, 'recording').textContent).toContain('Ein Wort antippen springt an diese Stelle der Aufnahme.')
  })

  it('NOTES-18 AC-5 the speed is 1×, 1,5× or 2× and stays the choice of the device', async () => {
    const { box } = await mount([recording()])
    const speeds = byTest(box, 'recording-speeds')
    expect(Array.from(speeds.querySelectorAll('[role="radio"]')).map((radio) => radio.textContent)).toEqual(['1×', '1,5×', '2×'])
    expect(byTest(speeds, 'recording-speed-1').getAttribute('aria-checked')).toBe('true')
    await click(byTest(speeds, 'recording-speed-1.5'))
    expect(byTest(speeds, 'recording-speed-1.5').getAttribute('aria-checked')).toBe('true')
    expect(audioOf(box).playbackRate).toBe(1.5)
    expect(window.localStorage.getItem(RATE_KEY)).toBe('1.5')
    await click(byTest(box, 'recording-toggle'))
    expect(audioOf(box).playbackRate).toBe(1.5)
    // Another note, another day on the same device: still 1,5×.
    await act(async () => root!.unmount())
    root = null
    reloadRate()
    const again = await mount([recording()])
    expect(byTest(again.box, 'recording-speed-1.5').getAttribute('aria-checked')).toBe('true')
    expect(audioOf(again.box).playbackRate).toBe(1.5)
    // Something else in the storage is no speed.
    window.localStorage.setItem(RATE_KEY, '3')
    reloadRate()
    await settle()
    expect(byTest(again.box, 'recording-speed-1').getAttribute('aria-checked')).toBe('true')
  })

  it('NOTES-18 EC-1 words corrected by hand keep the reading in place, new words without a time are skipped', async () => {
    transcripts[WORDS] = { ...SPOKEN, text: 'Der erste Termin. Danach kommt der zweite, wohl Ende Januar.' }
    const { box } = await mount([recording()])
    await settle()
    const shown = words(box)
    expect(shown.map((word) => word.textContent?.trim())).toEqual(['Der', 'erste', 'Termin.', 'Danach', 'kommt', 'der', 'zweite,', 'wohl', 'Ende', 'Januar.'])
    expect(shown.map((word) => word.dataset.timed)).toEqual(['true', 'true', 'true', 'false', 'true', 'true', 'true', 'false', 'false', 'true'])
    await click(byTest(box, 'recording-toggle'))
    // "Dann" (1200 ms) became "Danach": nothing new is marked, the word before stays.
    await playedTo(audioOf(box), 1300)
    expect(shown.map(stateOf).indexOf('now')).toBe(2)
    await playedTo(audioOf(box), 2500)
    expect(shown.map(stateOf).indexOf('now')).toBe(6)
    await playedTo(audioOf(box), 2900)
    expect(shown.map(stateOf).indexOf('now')).toBe(9)
    for (let ms = 0; ms <= 3200; ms += 100) {
      await playedTo(audioOf(box), ms)
      const now = shown.findIndex((word) => stateOf(word) === 'now')
      if (now >= 0) expect(shown[now].dataset.timed).toBe('true')
    }
    // A new word jumps to the next word with a time.
    await click(shown[3])
    expect(audioOf(box).currentTime).toBe(1.6)
    await click(shown[8])
    expect(audioOf(box).currentTime).toBe(2.8)
  })

  it('NOTES-18 EC-1 the matching of words holds over a long text with corrections here and there', () => {
    const spoken = Array.from({ length: 3000 }, (_, index) => ({ text: `wort${index}`, start: index * 300, end: index * 300 + 250 }))
    const parts = spoken.map((word) => word.text)
    parts.splice(1000, 3, 'ganz', 'neu', 'geschrieben', 'und', 'länger')
    parts.splice(2000, 0, 'eingefügt')
    parts[parts.indexOf('wort2500')] = 'Wort2500,'
    const tokens = tokensOf({ text: parts.join(' '), words: spoken })
    const timed = tokens.filter((token) => token.start !== null)
    expect(timed.length).toBe(2997)
    expect(tokens.find((token) => token.text === 'Wort2500,')?.start).toBe(2500 * 300)
    expect(tokens.find((token) => token.text === 'eingefügt')?.start).toBeNull()
    expect(tokens.find((token) => token.text === 'wort2999')?.start).toBe(2999 * 300)
    const order = timedIndexes(tokens)
    expect(activeIndex(tokens, order, 1001 * 300)).toBe(tokens.findIndex((token) => token.text === 'wort999'))
    expect(jumpTarget(tokens, tokens.findIndex((token) => token.text === 'ganz'))).toBe(1003 * 300)
  })

  it('NOTES-18 EC-3 a format the browser cannot play is offered to download', async () => {
    playable = false
    known[2] = { ...known[2], mime: 'audio/x-caf', name: 'Memo.caf' }
    const { box } = await mount([recording()])
    expect(byTest(box, 'recording-unplayable').textContent).toBe('Dein Browser spielt dieses Format nicht ab.')
    expect((byTest(box, 'recording-toggle') as HTMLButtonElement).disabled).toBe(true)
    expect(byTest(box, 'recording-download').textContent).toBe('Herunterladen')
    // The text can still be read.
    await settle()
    expect(words(box)).toHaveLength(8)
  })

  it('NOTES-18 EC-3 a recording whose sound breaks off in the browser offers it to download', async () => {
    const { box } = await mount([recording()])
    expect(box.querySelector('[data-testid="recording-unplayable"]')).toBeNull()
    await act(async () => {
      audioOf(box).dispatchEvent(new Event('error'))
    })
    expect(byTest(box, 'recording-unplayable')).toBeTruthy()
  })

  it('NOTES-18 EC-2 a long recording asks only for what it needs and knows its length before it loads', async () => {
    const { box } = await mount([recording()])
    expect(audioOf(box).getAttribute('preload')).toBe('metadata')
    expect(audioOf(box).getAttribute('src')).toBe(`/api/attachments/${SOUND}/file`)
    expect(byTest(box, 'recording-total').textContent).toBe('52:10')
    await key(byTest(box, 'recording'), 'End')
    // To the end at once: one jump, no waiting for the whole file.
    await act(async () => {
      const position = byTest(box, 'recording-position') as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(position, String(3_130_000))
      position.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(audioOf(box).currentTime).toBe(3130)
  })

  it('NOTES-18 EC-4 when a second recording of the note starts, the first one stops', async () => {
    const { box } = await mount([recording(), recording({ id: SECOND, name: 'Nachtrag.m4a', transcript: null, duration: 60_000 })])
    const [first, second] = Array.from(box.querySelectorAll<HTMLElement>('[data-testid="recording"]'))
    await click(byTest(first, 'recording-toggle'))
    expect(first.getAttribute('data-playing')).toBe('true')
    await click(byTest(second, 'recording-toggle'))
    expect(paused).toEqual([audioOf(box, 0)])
    expect(first.getAttribute('data-playing')).toBe('false')
    expect(second.getAttribute('data-playing')).toBe('true')
    // And back.
    await click(byTest(first, 'recording-toggle'))
    expect(second.getAttribute('data-playing')).toBe('false')
  })

  it('NOTES-18 EC-4 a recording that leaves the page stops playing', async () => {
    const { editor, box } = await mount([recording()])
    await click(byTest(box, 'recording-toggle'))
    const media = audioOf(box)
    expect(media.paused).toBe(false)
    await act(async () => {
      editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] })
    })
    await settle()
    expect(media.paused).toBe(true)
  })

  it('NOTES-18 EC-6 with the keyboard alone space starts and stops and the arrow keys move', async () => {
    const { box } = await mount([recording()])
    const player = byTest(box, 'recording')
    expect(player.tabIndex).toBe(0)
    expect(player.getAttribute('aria-description')).toBe('Leertaste spielt und hält an, Pfeiltasten springen fünf Sekunden.')
    await key(player, ' ')
    expect(player.getAttribute('data-playing')).toBe('true')
    await playedTo(audioOf(box), 20_000)
    await key(player, 'ArrowRight')
    expect(audioOf(box).currentTime).toBe((20_000 + JUMP_MS) / 1000)
    await key(player, 'ArrowLeft')
    await key(player, 'ArrowLeft')
    expect(audioOf(box).currentTime).toBe((20_000 - JUMP_MS) / 1000)
    // On the position too the arrows jump five seconds, not a tenth.
    await key(byTest(player, 'recording-position'), 'ArrowRight')
    expect(audioOf(box).currentTime).toBe(20)
    await key(player, ' ')
    expect(player.getAttribute('data-playing')).toBe('false')
    // In the speeds the arrows choose the speed.
    await key(byTest(player, 'recording-speed-1'), 'ArrowRight')
    expect(byTest(player, 'recording-speed-1.5').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(byTest(player, 'recording-speed-1.5'))
    expect(audioOf(box).currentTime).toBe(20)
  })

  it('NOTES-18 EC-7 playing changes nothing in the note, so somebody else listens on their own', async () => {
    const { box } = await mount([recording()])
    await settle()
    const changes: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => changes.push(update))
    await click(byTest(box, 'recording-toggle'))
    await playedTo(audioOf(box), 1300)
    await click(words(box)[6])
    await click(byTest(box, 'recording-speed-2'))
    await click(byTest(box, 'recording-toggle'))
    expect(changes).toHaveLength(0)
  })

  it('NOTES-18 a recording without a transcript plays without text, one still uploading says so', async () => {
    transcripts = {}
    const { box } = await mount([recording(), recording({ id: SECOND, transcript: null })])
    await settle()
    const [first, second] = Array.from(box.querySelectorAll<HTMLElement>('[data-testid="recording"]'))
    expect(byTest(first, 'recording-transcript-state').textContent).toBe('Der Text fehlt noch.')
    expect(second.querySelector('[data-testid="recording-transcript-state"]')).toBeNull()
    expect(second.querySelector('[data-testid="recording-transcript"]')).toBeNull()
  })
})
