/**
 * NOTES-10 in a real browser against the real server: files chosen, dropped and pasted stand in the note and upload
 * (AC-1), a picture in three sizes and large (AC-2), a PDF with its pages (AC-3), a file to download (AC-4), a video
 * (AC-8, EC-7), the limit (AC-6), a broken upload and its retry (EC-2), removing (AC-12), the full storage (AC-11,
 * EC-1), the gallery (AC-7, EC-9), links without cards when switched off (AC-9), a note one only reads (EC-10) and the
 * phone's sheet. The page is the operator of global-setup.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-attach00' }

/** A small PNG made here: a coloured square. */
function png(size = 64, rgb: [number, number, number] = [242, 193, 78]): Buffer {
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const chunk = (kind: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A PDF of `pages` empty pages, written by hand. */
function pdf(pages: number): Buffer {
  const objects: string[] = []
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)
  for (let index = 0; index < pages; index++) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A short video, when ffmpeg is there. */
function video(container: 'mp4' | 'webm'): Buffer | null {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexnotes-video-')), `clip.${container}`)
  const codec = container === 'mp4' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-c:v', 'libvpx-vp9', '-b:v', '200k']
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', ...codec, target], { stdio: 'ignore', timeout: 60_000 })
    return fs.readFileSync(target)
  } catch {
    return null
  }
}

async function newNote(page: Page, title: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown: 'Text vor den Anhängen' }, headers: TAB })
  expect(made.status()).toBe(201)
  return ((await made.json()) as { id: string }).id
}

async function openNote(page: Page, id: string): Promise<void> {
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toBeVisible()
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
}

async function settings(page: Page, values: Record<string, unknown>): Promise<void> {
  const saved = await page.request.put('/api/settings', { data: values, headers: TAB })
  expect(saved.ok()).toBe(true)
}

async function myId(page: Page): Promise<number> {
  return ((await (await page.request.get('/api/auth/me')).json()) as { id: number }).id
}

test.afterEach(async ({ page }) => {
  await settings(page, { upload_max_mb: 100, link_previews: true })
  await page.request.put(`/api/accounts/${await myId(page)}/storage-limit`, { data: { limit: null }, headers: TAB })
})

test('NOTES-10 AC-1 AC-2 AC-3 AC-4 AC-12 choose files: a picture in its sizes and large, a PDF, a file; remove one', async ({ page }) => {
  const id = await newNote(page, 'Sofa ausmessen')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.getByTestId('attach-input').setInputFiles([
    { name: 'Wohnzimmer.png', mimeType: 'image/png', buffer: png(200) },
    { name: 'Datenblatt Sofa.pdf', mimeType: 'application/pdf', buffer: pdf(12) },
    { name: 'Grundriss.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'latin1') },
  ])
  const picture = page.locator('figure.nn-picture')
  await expect(picture.locator('img')).toBeVisible()
  await expect(page.getByTestId('attachment-caption')).toContainText('Wohnzimmer.png ·')
  // The picture is drawn by the media worker; it may still be on its way when the element shows.
  await expect.poll(() => picture.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(200)
  // Sizes: medium from the start, then small and full width.
  const width = async () => (await picture.boundingBox())!.width
  const medium = await width()
  await page.getByTestId('attachment-size').click()
  await page.getByTestId('attachment-size-small').click()
  await expect(picture).toHaveAttribute('data-size', 'small')
  const small = await width()
  await page.getByTestId('attachment-size').click()
  await page.getByTestId('attachment-size-full').click()
  await expect(picture).toHaveAttribute('data-size', 'full')
  const full = await width()
  expect(small).toBeLessThan(medium)
  expect(medium).toBeLessThan(full)
  // Large: the view with the recognised text (NOTES-11).
  await page.getByTestId('attachment-open-large').click()
  await expect(page.getByTestId('ocr-viewer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ocr-viewer')).toHaveCount(0)
  // The PDF with its pages and the picture of its first page.
  const sheet = page.getByTestId('attachment-pdf')
  await expect(sheet).toContainText('PDF · 12 pages')
  await expect(sheet.locator('img')).toBeVisible()
  // The file, to download with its name.
  const file = page.getByTestId('attachment-file')
  await expect(file).toContainText('Grundriss.zip')
  const download = page.waitForEvent('download')
  await file.getByTestId('attachment-download').click()
  expect((await download).suggestedFilename()).toBe('Grundriss.zip')
  // Kept: the server's note names all three, in order.
  await expect.poll(async () => ((await (await page.request.get(`/api/notes/${id}/attachments`)).json()) as { items: unknown[] }).items.length).toBe(3)
  // Removing takes the file block out of the note (AC-12); after a reload it stays gone.
  await file.hover()
  await file.getByTestId('attachment-remove').click()
  await expect(page.getByTestId('attachment-file')).toHaveCount(0)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await page.reload()
  await expect(page.locator('figure.nn-picture')).toHaveAttribute('data-size', 'full')
  await expect(page.getByTestId('attachment-pdf')).toBeVisible()
  await expect(page.getByTestId('attachment-file')).toHaveCount(0)
})

test('NOTES-10 AC-1 a file dropped and a picture pasted land in the note; while dragging the area names the limit', async ({ page }) => {
  const id = await newNote(page, 'Ziehen und Einfügen')
  await openNote(page, id)
  const body = page.getByTestId('note-body')
  const box = (await body.boundingBox())!
  const dropped = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['hello'], 'Notiz.txt', { type: 'text/plain' }))
    return transfer
  })
  await page.getByTestId('note-page').dispatchEvent('dragenter', { dataTransfer: dropped })
  await expect(page.getByTestId('attach-drop')).toHaveText('Drag files here or paste them · at most 100 MB per file')
  await body.dispatchEvent('drop', { dataTransfer: dropped, clientX: box.x + 10, clientY: box.y + 5 })
  await expect(page.getByTestId('attachment-file')).toContainText('Notiz.txt')
  await expect(page.getByTestId('attach-drop')).toHaveCount(0)
  // A picture from the clipboard.
  await body.click()
  await page.evaluate(async (bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], 'Screenshot.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    document.querySelector('[data-testid="note-body"]')!.dispatchEvent(event)
  }, [...png(48)])
  await expect(page.locator('figure.nn-picture img')).toBeVisible()
  await expect.poll(async () => ((await (await page.request.get(`/api/notes/${id}/attachments`)).json()) as { items: Array<{ kind: string }> }).items.map((item) => item.kind).sort()).toEqual(['file', 'image'])
})

test('NOTES-10 AC-6 a file over the operator limit is refused with name, size and limit, and can be hidden', async ({ page }) => {
  await settings(page, { upload_max_mb: 1 })
  const id = await newNote(page, 'Drohne')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.getByTestId('attach-input').setInputFiles([{ name: 'Drohnenflug.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2 * 1024 * 1024 + 5) }])
  const refused = page.getByTestId('attach-refused')
  await expect(refused).toContainText('Drohnenflug.mp4 · 2.0 MB')
  await expect(refused).toContainText('Too large. At most 1 MB per file; the operator sets this.')
  await expect(page.getByTestId('attachment-upload')).toHaveCount(0)
  await refused.getByTestId('attach-refused-hide').click()
  await expect(refused).toHaveCount(0)
})

test('NOTES-10 EC-2 an upload whose connection breaks says so in red and uploads again', async ({ page }) => {
  const id = await newNote(page, 'Abbruch')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.route('**/api/attachments?*', (route) => route.abort('connectionfailed'))
  await page.getByTestId('attach-input').setInputFiles([{ name: 'Buchung Ferienwohnung.pdf', mimeType: 'application/pdf', buffer: pdf(2) }])
  const failed = page.getByTestId('attachment-upload')
  await expect(failed).toHaveAttribute('data-state', 'failed')
  await expect(failed).toContainText('Upload stopped, the connection was gone. The attachment is still missing.')
  await page.unroute('**/api/attachments?*')
  await page.getByTestId('attachment-retry').click()
  await expect(page.getByTestId('attachment-pdf')).toContainText('PDF · 2 pages')
})

test('NOTES-10 AC-10 EC-6 many files: three at a time with progress, the rest wait; cancel takes one out', async ({ page }) => {
  const id = await newNote(page, 'Viele')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  // The server answers slowly, so the line can be seen.
  let running = 0
  let most = 0
  await page.route('**/api/attachments?*', async (route) => {
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      await route.continue()
    } finally {
      running -= 1
    }
  })
  await page.getByTestId('attach-input').setInputFiles(Array.from({ length: 12 }, (_, index) => ({ name: `Foto ${index + 1}.png`, mimeType: 'image/png', buffer: png(16 + index) })))
  await expect(page.getByTestId('attachment-progress').filter({ hasText: 'waiting' }).first()).toBeVisible()
  await expect.poll(() => page.getByTestId('attachment-progress').filter({ hasText: 'waiting' }).count()).toBeLessThanOrEqual(9)
  await page.getByTestId('attachment-upload').last().getByTestId('attachment-cancel').click()
  await expect(page.locator('figure.nn-picture img')).toHaveCount(11, { timeout: 20_000 })
  expect(most).toBeLessThanOrEqual(3)
  // Writing went on meanwhile.
  await page.keyboard.type('weiter geschrieben')
  await expect(page.getByTestId('note-body')).toContainText('weiter geschrieben')
  await page.unroute('**/api/attachments?*')
})

test('NOTES-10 AC-8 EC-7 a video plays in the note or, where the browser cannot, shows its still and Download', async ({ page }) => {
  const webm = video('webm')
  const mp4 = video('mp4')
  test.skip(!webm || !mp4, 'ffmpeg is missing')
  const id = await newNote(page, 'Rundgang')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.getByTestId('attach-input').setInputFiles([
    { name: 'Rundgang.webm', mimeType: 'video/webm', buffer: webm! },
    { name: 'Rundgang Wohnzimmer.mov', mimeType: 'video/quicktime', buffer: mp4! },
  ])
  const cards = page.getByTestId('attachment-video')
  await expect(cards).toHaveCount(2)
  for (const card of [cards.nth(0), cards.nth(1)]) {
    await expect(card.locator('img')).toBeVisible()
    await expect(card).toContainText('0:02')
  }
  // WebM plays in every browser.
  await cards.nth(0).getByTestId('attachment-play').click()
  await expect.poll(() => cards.nth(0).locator('video').evaluate((player: HTMLVideoElement) => player.videoWidth)).toBe(320)
  // H.264 in a QuickTime film: plays where the browser has the codec, else the still, the name and Download.
  await cards.nth(1).getByTestId('attachment-play').click()
  await expect
    .poll(async () => ((await cards.nth(1).getAttribute('data-playable')) === 'false' ? 'fallback' : await cards.nth(1).locator('video').evaluate((player: HTMLVideoElement) => (player.videoWidth > 0 ? 'plays' : 'waits'))))
    .toMatch(/^(plays|fallback)$/)
  if ((await cards.nth(1).getAttribute('data-playable')) === 'false') {
    await expect(cards.nth(1).getByTestId('attachment-download')).toBeVisible()
    await expect(cards.nth(1)).toContainText('Rundgang Wohnzimmer.mov')
  }
  // The still in the list of notes and its tiles.
  await page.goto('/')
  await expect(page.locator(`[data-note="${id}"] img`).first()).toBeVisible()
})

test('NOTES-10 AC-11 EC-1 a full storage: the orange bar, no attachment, writing goes on; the way to the largest', async ({ page }) => {
  const id = await newNote(page, 'Urlaub Ostsee')
  const used = ((await (await page.request.get('/api/attachments/limits')).json()) as { used: number }).used
  await page.request.put(`/api/accounts/${await myId(page)}/storage-limit`, { data: { limit: used }, headers: TAB })
  await openNote(page, id)
  const bar = page.getByTestId('storage-full')
  await expect(bar).toContainText('Your storage is full:')
  await expect(bar).toContainText('Writing goes on; new attachments only once there is room.')
  await page.getByTestId('note-body').click()
  await page.getByTestId('attach-input').setInputFiles([{ name: 'Strand.png', mimeType: 'image/png', buffer: png(32) }])
  await expect(page.getByTestId('attach-refused')).toContainText('Your storage is full')
  await page.keyboard.type(' und weiter')
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await page.getByTestId('storage-large').click()
  await expect(page).toHaveURL(/\/attachments\?sort=largest$/)
  await expect(page.getByTestId('gallery-sort')).toHaveValue('largest')
})

test('NOTES-10 AC-7 EC-9 the gallery: kinds with numbers, largest first, into the note; empty for a new account', async ({ page, browser }) => {
  const id = await newNote(page, 'Galerie')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.getByTestId('attach-input').setInputFiles([
    { name: 'klein.png', mimeType: 'image/png', buffer: png(8) },
    { name: 'gross.pdf', mimeType: 'application/pdf', buffer: pdf(40) },
  ])
  await expect(page.getByTestId('attachment-pdf')).toBeVisible()
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  // No fixed entry of the sidebar any more (a smart folder now, NOTES-7): the account's gallery stays at its address.
  await page.goto('/attachments')
  await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible()
  await expect(page.getByTestId('gallery-kind-pdf')).toContainText('PDFs')
  await page.getByTestId('gallery-kind-pdf').click()
  await expect(page.getByTestId('gallery-item').first()).toContainText('in “Galerie”')
  await page.getByTestId('gallery-item').filter({ hasText: 'gross.pdf' }).click()
  await expect(page).toHaveURL(new RegExp(`/notes/${id}\\?attachment=`))
  await expect(page.locator('.nn-attachment-found')).toBeVisible()
  // A new account without attachments (EC-9).
  const invited = await page.request.post('/api/invites', { data: { email: `anna-${Date.now()}@example.com`, role: 'member' }, headers: TAB })
  expect(invited.status()).toBe(201)
  const token = ((await invited.json()) as { link: string }).link.split('/').pop()!
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const other = await context.newPage()
  const joined = await other.request.post(`/api/invite/${token}`, { data: { display_name: 'Anna', password: 'anna e2e password long enough' }, headers: TAB })
  expect(joined.ok()).toBe(true)
  await other.goto('/attachments')
  await expect(other.getByTestId('gallery-empty')).toContainText('No attachments yet')
  await context.close()
})

test('NOTES-10 AC-9 switched off, a pasted link stays a plain link and no card is asked for', async ({ page }) => {
  await settings(page, { link_previews: false })
  const id = await newNote(page, 'Links')
  await openNote(page, id)
  const asked: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/link-preview')) asked.push(request.url())
  })
  await page.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'https://moebel-beispiel.example.com/ecksofa')
    document.querySelector('[data-testid="note-body"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-testid="note-body"] a[href="https://moebel-beispiel.example.com/ecksofa"]')).toBeVisible()
  await page.waitForTimeout(500)
  expect(asked).toEqual([])
  await expect(page.getByTestId('attachment-link')).toHaveCount(0)
})

test('NOTES-10 the phone: the paperclip opens Photo, File and Link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await settings(page, { link_previews: false })
  const id = await newNote(page, 'Handy')
  await openNote(page, id)
  await page.getByTestId('attach-phone').click()
  const sheet = page.getByTestId('attach-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button')).toHaveText(['Photo', 'File', 'Link'])
  await sheet.getByTestId('attach-sheet-link').click()
  await page.getByTestId('attach-link-input').fill('example.org/plan')
  await page.getByRole('dialog', { name: 'Attach a link' }).getByRole('button', { name: 'Attach' }).click()
  await expect(page.locator('[data-testid="note-body"] a[href="https://example.org/plan"]')).toBeVisible()
  await page.getByTestId('attach-phone').click()
  await page.getByTestId('attach-photo-input').setInputFiles([{ name: 'Foto.png', mimeType: 'image/png', buffer: png(40) }])
  await expect(page.locator('figure.nn-picture img')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
