/**
 * NOTES-17 in a real browser against the real server: the note's menu opens "Export", a note comes as Markdown and as
 * PDF at once, everything runs in the background and the notice offers the ZIP when it is ready. Pictures for the eye
 * under test-results/export-*.png.
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-export00' }

async function openExport(page: import('@playwright/test').Page, id: string) {
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-title')).toHaveValue('Einkauf')
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-export').click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('NOTES-17 AC-1 AC-2 AC-3 AC-7 a note as Markdown and PDF, everything as ZIP with a notice when ready', async ({ page }) => {
  const made = await page.request.post('/api/notes', {
    data: { title: 'Einkauf', markdown: '## Markt\n\n- [x] Milch\n- [ ] Brot\n\n| Was | Wie viel |\n| --- | --- |\n| Äpfel | 6 |\n\n#wochenende' },
    headers: TAB,
  })
  expect(made.status()).toBe(201)
  const { id } = (await made.json()) as { id: string }

  // As Markdown: the file the server names, everything in it.
  let dialog = await openExport(page, id)
  await expect(dialog.getByRole('radio')).toHaveCount(4)
  await page.screenshot({ path: 'test-results/export-dialog.png' })
  let waiting = page.waitForEvent('download')
  await dialog.getByTestId('export-start').click()
  let download = await waiting
  expect(download.suggestedFilename()).toBe('Einkauf.md')
  const markdown = fs.readFileSync(await download.path(), 'utf-8')
  expect(markdown).toContain('# Einkauf\n\n## Markt\n\n- [x] Milch\n- [ ] Brot')
  expect(markdown).toContain('| Äpfel | 6 |')
  expect(markdown).toContain('\n#wochenende\n')
  expect(markdown).toMatch(/^---\ntitle: "Einkauf"\ncreated: /)

  // As PDF.
  dialog = await openExport(page, id)
  await dialog.getByText('This note as PDF').click()
  waiting = page.waitForEvent('download')
  await dialog.getByTestId('export-start').click()
  download = await waiting
  expect(download.suggestedFilename()).toBe('Einkauf.pdf')
  expect(fs.readFileSync(await download.path()).subarray(0, 5).toString()).toBe('%PDF-')

  // Everything: the size before, the export in the background, the notice when the ZIP is ready.
  dialog = await openExport(page, id)
  await dialog.getByText('Export everything').click()
  await expect(dialog.getByTestId('export-estimate')).toContainText('About')
  await dialog.getByTestId('export-start').click()
  await expect(dialog).toBeHidden()
  const notice = page.getByTestId('export-ready')
  await expect(notice).toContainText('is ready', { timeout: 20_000 })
  await page.screenshot({ path: 'test-results/export-ready.png' })
  waiting = page.waitForEvent('download')
  await notice.getByRole('link', { name: 'Download' }).click()
  download = await waiting
  expect(download.suggestedFilename()).toMatch(/^nexnotes \d{4}-\d{2}-\d{2}\.zip$/)
  const zip = fs.readFileSync(await download.path())
  expect(zip.subarray(0, 2).toString()).toBe('PK')
  expect(zip.includes(Buffer.from('Inbox/Einkauf.md'))).toBe(true)
  // Fetched is seen: the notice goes, and stays gone after a reload.
  await expect(notice).toBeHidden()
  await page.reload()
  await expect(page.getByTestId('note-title')).toHaveValue('Einkauf')
  await expect(page.getByTestId('export-ready')).toHaveCount(0)
})

test('NOTES-17 AC-4 the menu of a folder exports it', async ({ page }) => {
  const folder = await page.request.post('/api/folders', { data: { name: 'Haushalt Export' }, headers: TAB })
  expect(folder.status()).toBe(201)
  const { id } = (await folder.json()) as { id: string }
  await page.request.post('/api/notes', { data: { title: 'Sofa', markdown: 'Breite 2,10 m', folder_id: id }, headers: TAB })
  await page.goto(`/folder/${id}`)
  await page.getByRole('button', { name: 'Menu of Haushalt Export' }).first().click()
  await page.getByRole('menuitem', { name: 'Export' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByRole('radio', { name: /Folder “Haushalt Export” as ZIP/ })).toBeChecked()
  await expect(dialog.getByTestId('export-estimate')).toContainText('1 note')
  await dialog.getByTestId('export-start').click()
  await expect(page.getByTestId('export-ready')).toContainText('Haushalt Export', { timeout: 20_000 })
})
