/**
 * NOTES-18 in a real browser against the real server. Sketches and recordings come from the iOS app, so they are made
 * here the way the app makes them (NOTES-24): a note naming the blocks, then the files uploaded with their role. A
 * sketch is seen sharp and large, zoomed and saved (AC-1, EC-5, AC-6) and changes from another device without
 * reloading (AC-2); a recording plays with its text read along (AC-3), jumps to a word (AC-4), keeps its speed (AC-5),
 * shows its parts (AC-7), answers the keyboard (EC-6), and stops when another starts (EC-4). Its words are found by the
 * search and its transcript lies in the export.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-sketch000' }

const newId = () => crypto.randomBytes(16).toString('base64url')

/** A PNG made here: a white sheet with a dark diagonal stroke, as PencilKit would draw it. */
function png(width = 400, height = 240, ink: [number, number, number] = [20, 20, 26]): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4)
    for (let x = 0; x < width; x++) {
      const onLine = Math.abs(x * (height / width) - y) < 3
      row.set(onLine ? [...ink, 255] : [0, 0, 0, 0], 1 + x * 4)
    }
    rows.push(row)
  }
  const chunk = (kind: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

/** A spoken-like tone of `seconds`, made with ffmpeg: Opus in Ogg (every browser here plays it) or AAC in M4A. */
function sound(seconds: number, form: 'ogg' | 'm4a'): Buffer {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexnotes-sound-')), `rec.${form}`)
  const codec = form === 'ogg' ? ['-c:a', 'libopus', '-b:a', '32k'] : ['-c:a', 'aac', '-b:a', '48k']
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, ...codec, target], { stdio: 'ignore', timeout: 60_000 })
  return fs.readFileSync(target)
}

const SPOKEN = 'Der erste Termin wäre die Woche nach dem Jahreswechsel. Der zweite Ende Januar. Bis dahin klären wir die Lagerfläche.'

/** The transcript as the app writes it: the recognised words with their times over `seconds`. */
function transcript(seconds: number, text = SPOKEN): Buffer {
  const words = text.split(' ')
  const each = (seconds * 1000) / words.length
  return Buffer.from(
    JSON.stringify({ format: 1, language: 'de-DE', text, words: words.map((word, index) => ({ text: word.replace(/[.,]$/, ''), start: Math.round(index * each), end: Math.round(index * each + each * 0.8) })) }),
  )
}

async function upload(page: Page, noteId: string, id: string, data: Buffer, name: string, role: string): Promise<Record<string, unknown>> {
  const answer = await page.request.post(`/api/attachments?note_id=${noteId}&id=${id}&name=${encodeURIComponent(name)}&as=${role}`, { data, headers: { ...TAB, 'Content-Type': 'application/octet-stream' } })
  expect(answer.status(), await answer.text()).toBe(201)
  return answer.json()
}

type Made = { note: string; picture: string; data: string; sound: string; words: string; second: string }

/** A note as the iPad makes it: a sketch, a kept recording with its words, a second recording from the iPhone. */
async function fromTheIpad(page: Page, title: string): Promise<Made> {
  const made = { picture: newId(), data: newId(), sound: newId(), words: newId(), second: newId() }
  const markdown = [
    'Nach dem Termin',
    `![Skizze.png](attachment:${made.picture} "drawing data=${made.data}")`,
    `[Besprechung.ogg](attachment:${made.sound} "recording duration=6000 transcript=${made.words}")`,
    `[Nachtrag.m4a](attachment:${made.second} "recording duration=3000")`,
  ].join('\n\n')
  const note = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  expect(note.status()).toBe(201)
  const noteId = ((await note.json()) as { id: string }).id
  expect((await upload(page, noteId, made.picture, png(), 'Skizze.png', 'drawing')).kind).toBe('drawing')
  expect((await upload(page, noteId, made.data, Buffer.from('PKDrawing binary data'), 'Skizze.drawing', 'drawing-data')).kind).toBe('drawingdata')
  expect((await upload(page, noteId, made.sound, sound(6, 'ogg'), 'Besprechung.ogg', 'recording')).kind).toBe('recording')
  expect((await upload(page, noteId, made.words, transcript(6), 'Besprechung.json', 'transcript')).kind).toBe('transcript')
  expect((await upload(page, noteId, made.second, sound(3, 'm4a'), 'Nachtrag.m4a', 'recording')).kind).toBe('recording')
  return { note: noteId, ...made }
}

async function openNote(page: Page, id: string): Promise<void> {
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toBeVisible()
}

test('NOTES-18 AC-1 EC-5 AC-6 a sketch from the iPad stands sharp in the note, opens large to zoom and saves as a picture', async ({ page }) => {
  const made = await fromTheIpad(page, 'Skizze vom iPad')
  await openNote(page, made.note)
  const sketch = page.getByTestId('sketch')
  await expect(sketch).toBeVisible()
  const image = sketch.getByTestId('sketch-image')
  await expect(image).toHaveAttribute('src', `/api/attachments/${made.picture}/file`)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(400)
  await expect(sketch.getByTestId('sketch-caption')).toHaveText('Sketch · view only in the browser, draw on iPhone and iPad')
  // Light paper in the dark theme as well.
  expect(await sketch.getByTestId('sketch-open').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 245, 248)')
  // Saving: the picture as a file.
  const download = page.waitForEvent('download')
  await sketch.getByTestId('sketch-download').click()
  expect((await download).suggestedFilename()).toBe('Skizze.png')
  // Large: zoom and move.
  await sketch.getByTestId('sketch-open').click()
  const viewer = page.getByTestId('sketch-viewer')
  await expect(viewer).toBeVisible()
  await viewer.getByTestId('sketch-zoom-in').click()
  await viewer.getByTestId('sketch-zoom-in').click()
  await expect(viewer.getByTestId('sketch-zoom')).toHaveText('156 %')
  const stage = viewer.getByTestId('sketch-stage')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 4 })
  await page.mouse.up()
  await expect(viewer.getByTestId('sketch-viewer-image')).toHaveAttribute('style', /translate\(80px, 40px\) scale\(1\.5625\)/)
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  // Removed like any attachment.
  await sketch.hover()
  await sketch.getByTestId('attachment-remove').click()
  await expect(page.getByTestId('sketch')).toHaveCount(0)
})

test('NOTES-18 AC-2 a sketch changed on another device shows its new version without reloading', async ({ page, browser }) => {
  const made = await fromTheIpad(page, 'Skizze ändert sich')
  await openNote(page, made.note)
  await expect(page.getByTestId('sketch-image')).toHaveAttribute('src', `/api/attachments/${made.picture}/file`)
  // The other device: uploads the new picture first, then names it in the note (here through a second editor).
  const fresh = newId()
  await upload(page, made.note, fresh, png(400, 240, [36, 72, 176]), 'Skizze.png', 'drawing')
  const other = await browser.newPage({ storageState: process.env.NEXNOTES_E2E_STATE })
  await openNote(other, made.note)
  await expect(other.getByTestId('note-saved')).toHaveText('saved')
  await other.evaluate((id) => {
    const editor = (document.querySelector('.ProseMirror') as unknown as { editor: { commands: { command: (fn: (props: { tr: { setNodeMarkup: (pos: number, type: undefined, attrs: object) => void }; state: { doc: { descendants: (fn: (node: { type: { name: string }; attrs: object }, pos: number) => void) => void } } }) => boolean) => void } } }).editor
    editor.commands.command(({ tr, state }) => {
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'drawing') tr.setNodeMarkup(pos, undefined, { ...node.attrs, id })
      })
      return true
    })
  }, fresh)
  await expect(page.getByTestId('sketch-image')).toHaveAttribute('src', `/api/attachments/${fresh}/file`, { timeout: 8000 })
  await expect.poll(() => page.getByTestId('sketch-image').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(400)
  await other.close()
})

test('NOTES-18 AC-3 AC-4 AC-5 AC-7 EC-4 EC-6 a recording plays with its text read along, jumps to a word and keeps its speed', async ({ page }) => {
  const made = await fromTheIpad(page, 'Aufnahme vom iPad')
  await openNote(page, made.note)
  const [player, second] = [page.getByTestId('recording').first(), page.getByTestId('recording').nth(1)]
  await expect(player.getByTestId('recording-total')).toHaveText('0:06')
  await expect(player.getByTestId('recording-transcript')).toHaveText(SPOKEN)
  await expect(player.getByText('Tap a word to jump to that point of the recording.')).toBeVisible()
  const audio = player.getByTestId('recording-audio')
  // AC-7: playing shows pause, the time goes on.
  await player.getByTestId('recording-toggle').click()
  await expect(player.getByTestId('recording-toggle')).toHaveAttribute('aria-label', 'Pause')
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(0.6)
  // AC-3: the spoken word is marked, what was heard dimmer.
  await expect(player.locator('.nn-w-now')).toHaveCount(1)
  await expect.poll(() => player.locator('.nn-w-now').getAttribute('data-i').then(Number)).toBeGreaterThan(0)
  // AC-4: a word tapped moves the recording there.
  const word = player.locator('[data-i="11"]')
  await expect(word).toHaveText('Ende ')
  await word.click()
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(3.2)
  await expect.poll(() => player.locator('.nn-w-now').getAttribute('data-i').then(Number)).toBeGreaterThanOrEqual(11)
  expect(await player.locator('[data-i="2"]').getAttribute('class')).toContain('nn-w-heard')
  // AC-5: 2× for this device, also after reloading.
  await player.getByTestId('recording-speed-2').click()
  expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(2)
  // EC-4: the second recording starts, the first stops (an M4A plays or offers itself to download, EC-3).
  if ((await second.getByTestId('recording-unplayable').count()) === 0) {
    await second.getByTestId('recording-toggle').click()
    await expect(player).toHaveAttribute('data-playing', 'false')
    await expect(second).toHaveAttribute('data-playing', 'true')
    await second.getByTestId('recording-toggle').click()
  } else {
    await expect(second.getByTestId('recording-download')).toBeVisible()
    await player.getByTestId('recording-toggle').click()
  }
  await expect(player).toHaveAttribute('data-playing', 'false')
  // EC-6: the keyboard alone.
  await player.focus()
  await page.keyboard.press('Space')
  await expect(player).toHaveAttribute('data-playing', 'true')
  await page.keyboard.press('Space')
  await expect(player).toHaveAttribute('data-playing', 'false')
  // ArrowLeft goes 5 s back, at most to the start: the recording may stand before its fifth second here.
  const before = await audio.evaluate((element: HTMLAudioElement) => element.currentTime)
  const back = Math.max(0, before - 5)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThan(back + 0.3)
  expect(await audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(Math.max(0, back - 0.3))
  await page.reload()
  await expect(page.getByTestId('recording').first().getByTestId('recording-speed-2')).toHaveAttribute('aria-checked', 'true')
})

test('NOTES-18 the words of a recording are found, and the export carries the transcript beside the sound', async ({ page }) => {
  const made = await fromTheIpad(page, 'Gesucht und exportiert')
  const hits = await (await page.request.get('/api/search?q=Lagerfl%C3%A4che', { headers: TAB })).json()
  expect(hits.items.map((hit: { id: string }) => hit.id)).toContain(made.note)
  const found = hits.items.find((hit: { id: string }) => hit.id === made.note)
  expect(found.attachment).toMatchObject({ kind: 'recording', name: 'Besprechung.ogg', ref: made.sound })
  const markdown = await page.request.get(`/api/export/notes/${made.note}/markdown`, { headers: TAB })
  expect(markdown.status()).toBe(200)
  const body = await markdown.body()
  // A ZIP: the sketch as a picture, the sound, its transcript as text; the PencilKit data stays out.
  const names = body.toString('latin1')
  for (const name of ['Skizze.png', 'Besprechung.ogg', 'Besprechung.txt', 'Nachtrag.m4a']) expect(names).toContain(name)
  expect(names).not.toContain('Skizze.drawing')
})
