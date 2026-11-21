/**
 * NOTES-11 in a real browser against the real server and its work queue: a PDF with text of its own is read without
 * Tesseract (AC-2), its text shows page by page beside the page and goes into the note (AC-3), the search finds it and
 * opens the view at the page with the place marked (AC-1, AC-8). A picture shows its text, or says that this server
 * cannot recognise, where Tesseract is missing. The page is the operator of global-setup.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import zlib from 'node:zlib'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-ocr00000' }

/** A PDF whose pages carry the given lines as text of their own (Helvetica), written by hand. */
function textPdf(pages: string[][]): Buffer {
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 4 + index * 2)
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((lines, index) => {
    const stream = lines.map((line, row) => `BT /F1 16 Tf 60 ${770 - row * 24} Td (${line}) Tj ET`).join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
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

/** A white PNG with a black bar: something to look at, nothing to read. */
function png(width = 300, height = 200): Buffer {
  const row = Buffer.alloc(1 + width * 3, 255)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => (y > 90 && y < 110 ? Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0)]) : row)))
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
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function newNote(page: Page, title: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown: 'Post vom Wasserwerk' }, headers: TAB })
  expect(made.status()).toBe(201)
  return ((await made.json()) as { id: string }).id
}

async function openNote(page: Page, id: string): Promise<void> {
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toBeVisible()
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
}

async function attachmentOf(page: Page, noteId: string): Promise<string> {
  let id = ''
  await expect
    .poll(async () => {
      const items = ((await (await page.request.get(`/api/notes/${noteId}/attachments`)).json()) as { items: { id: string }[] }).items
      id = items[0]?.id ?? ''
      return id
    })
    .not.toBe('')
  return id
}

async function textState(page: Page, id: string): Promise<string> {
  return ((await (await page.request.get(`/api/attachments/${id}/text`)).json()) as { state: string }).state
}

test('NOTES-11 AC-1 AC-2 AC-3 AC-8 a PDF with text: read in the background, shown page by page, found and opened at the place', async ({ page }) => {
  const id = await newNote(page, 'Wasserrechnung')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.getByTestId('attach-input').setInputFiles([
    {
      name: 'Wasser.pdf',
      mimeType: 'application/pdf',
      buffer: textPdf([
        ['Stadtwerke Beispiel', 'Jahresrechnung Wasser 2026', 'Kundennummer 4711'],
        ['Verbrauch laut Zaehler 112 Kubikmeter', 'Nachzahlung faellig zum 15.12.2026'],
      ]),
    },
  ])
  const attachment = await attachmentOf(page, id)
  await expect.poll(() => textState(page, attachment), { timeout: 30_000 }).toBe('done')

  // AC-3: large, the page beside its text, page by page; into the note.
  await page.getByTestId('attachment-pdf-large').click()
  const viewer = page.getByTestId('ocr-viewer')
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId('ocr-where')).toHaveText('PDF · Page 1 of 2')
  // The server draws the page in a process of its own: a moment.
  await expect.poll(() => page.getByTestId('ocr-picture').evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(500)
  await page.getByTestId('ocr-show-text').click()
  await expect(page.getByTestId('ocr-text')).toContainText('Jahresrechnung Wasser 2026')
  await page.getByTestId('ocr-next').click()
  await expect(page.getByTestId('ocr-where')).toHaveText('PDF · Page 2 of 2')
  await expect(page.getByTestId('ocr-text')).toContainText('Nachzahlung faellig')
  await page.getByTestId('ocr-insert').click()
  await expect(page.getByTestId('ocr-insert')).toHaveText('Inserted into the note')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page.getByTestId('note-body')).toContainText('Verbrauch laut Zaehler 112 Kubikmeter')

  // AC-1, AC-8: the search finds the text of page 1 (no longer in the note) and opens the view there, marked.
  await page.goto('/search?q=kundennummer')
  const hit = page.locator(`[data-hit="${id}"]`)
  await expect(hit).toContainText('Wasserrechnung')
  await expect(hit.getByTestId('search-hit-attachment')).toContainText('Wasser.pdf')
  await hit.click()
  await expect(page).toHaveURL(new RegExp(`/notes/${id}`))
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId('ocr-where')).toHaveText('PDF · Page 1 of 2')
  await expect(page.getByTestId('ocr-mark')).toHaveText('Kundennummer')
  await page.getByTestId('ocr-close').click()
  await expect(viewer).toHaveCount(0)
})

test('NOTES-11 a picture opens large with its text, or says that this server cannot recognise', async ({ page }) => {
  const engine = (await (await page.request.get('/api/ocr')).json()) as { available: boolean }
  const id = await newNote(page, 'Foto')
  await openNote(page, id)
  await page.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.getByTestId('attach-input').setInputFiles([{ name: 'Balken.png', mimeType: 'image/png', buffer: png() }])
  const attachment = await attachmentOf(page, id)
  await expect.poll(() => textState(page, attachment), { timeout: 30_000 }).toBe(engine.available ? 'done' : 'unavailable')
  await page.locator('figure.nn-picture').getByTestId('attachment-open-large').click()
  await page.getByTestId('ocr-show-text').click()
  if (engine.available) await expect(page.getByTestId('ocr-none')).toHaveText('No text recognized')
  else await expect(page.getByTestId('ocr-unavailable')).toHaveText('Text recognition is not set up on this server.')
})
