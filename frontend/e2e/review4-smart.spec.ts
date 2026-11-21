/**
 * Fourth review, NOTES-7 with NOTES-10 and NOTES-13: "Shared with me" and "Attachments" are no fixed entries of the
 * sidebar any more but smart folders every account gets. "Shared with me" shows the notes others shared and leads to
 * the page of shares; "Attachments" opens as the gallery of its notes' attachments, beside list and tiles. Deleted,
 * they are gone; the old addresses stay. Run centrally, never by an agent.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review4s0' }

/** A PDF of one empty page, written by hand. */
function pdf(): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>']
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

async function member(page: Page, browser: Browser, name: string): Promise<{ context: BrowserContext; id: number }> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `${name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: name, email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  const me = await (await context.request.get('/api/auth/me')).json()
  return { context, id: Number(me.id) }
}

test('NOTES-7 AC-7 "Shared with me" and "Attachments" are smart folders: the shared notes, the gallery, deleted for good', async ({ page, browser }) => {
  const stamp = Date.now().toString(36)
  const reader = await member(page, browser, `Review ${stamp}`)
  const shared = await (await page.request.post('/api/notes', { data: { title: `Shared soup ${stamp}`, markdown: 'lentils' }, headers: TAB })).json()
  const given = await page.request.put(`/api/shares/note/${shared.id}/people/${reader.id}`, { data: { level: 'read' }, headers: TAB })
  expect(given.ok()).toBe(true)

  const theirs = await reader.context.newPage()
  await theirs.setViewportSize({ width: 1400, height: 900 })
  await theirs.goto('/')
  const section = theirs.getByTestId('sidebar-smart')
  await expect(section.getByTestId('sidebar-smart-folder')).toHaveText(['Open checklists', 'Recently edited', 'Shared with me', 'Attachments'])
  // No fixed entries any more above the folders.
  await expect(theirs.getByTestId('shared-entry')).toHaveCount(0)
  await expect(theirs.getByTestId('sidebar-attachments')).toHaveCount(0)

  // "Shared with me": the note of the operator, and the way to the page of shares.
  await section.getByTestId('sidebar-smart-folder').filter({ hasText: 'Shared with me' }).click()
  await expect(theirs.getByTestId('note-row').filter({ hasText: `Shared soup ${stamp}` })).toBeVisible()
  await theirs.getByTestId('smart-shared-page').click()
  await expect(theirs).toHaveURL(/\/shared$/)
  await expect(theirs.getByTestId('shared-item').filter({ hasText: `Shared soup ${stamp}` })).toBeVisible()

  // "Attachments": a note of its own with a PDF, shown as the gallery.
  const own = await (await theirs.request.post('/api/notes', { data: { title: `Contract ${stamp}`, markdown: 'Text' }, headers: TAB })).json()
  await theirs.goto(`/notes/${own.id}`)
  await theirs.getByTestId('note-body').click()
  await theirs.getByTestId('attach-input').setInputFiles([{ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf() }])
  await expect(theirs.getByTestId('attachment-pdf')).toBeVisible()
  await expect(theirs.getByTestId('note-saved')).toHaveText('saved')
  await section.getByTestId('sidebar-smart-folder').filter({ hasText: 'Attachments' }).click()
  await expect(theirs.getByTestId('note-list')).toHaveAttribute('data-mode', 'gallery')
  await theirs.getByTestId('list-view').click()
  await expect(theirs.getByTestId('list-mode-gallery')).toHaveAttribute('aria-checked', 'true')
  await theirs.keyboard.press('Escape')
  const tile = theirs.getByTestId('gallery-item').filter({ hasText: 'contract.pdf' })
  await expect(tile).toContainText(`in “Contract ${stamp}”`)
  await tile.click()
  await expect(theirs).toHaveURL(new RegExp(`/smart/[^?]+\\?.*attachment=.*note=${own.id}`))
  await expect(theirs.getByTestId('note-body')).toBeVisible()
  // The notes stay at hand in the menu "Ansicht", kept over a reload.
  await theirs.getByTestId('list-view').click()
  await theirs.getByTestId('list-mode-list').click()
  await theirs.keyboard.press('Escape')
  await expect(theirs.getByTestId('note-row').filter({ hasText: `Contract ${stamp}` })).toBeVisible()
  await theirs.reload()
  await expect(theirs.getByTestId('note-list')).toHaveAttribute('data-mode', 'list')

  // Deleted, "Shared with me" is gone and does not come back; the page stays at its address.
  await section.getByTestId('sidebar-smart-folder').filter({ hasText: 'Shared with me' }).click()
  await theirs.getByTestId('smart-more').click()
  await theirs.getByTestId('smart-delete-open').click()
  await theirs.getByTestId('smart-delete-confirm').click()
  await expect(section.getByTestId('sidebar-smart-folder').filter({ hasText: 'Shared with me' })).toHaveCount(0)
  await theirs.reload()
  await expect(section.getByTestId('sidebar-smart-folder')).toHaveText(['Open checklists', 'Recently edited', 'Attachments'])
  await theirs.goto('/shared')
  await expect(theirs.getByTestId('shared-item').filter({ hasText: `Shared soup ${stamp}` })).toBeVisible()
  // The account's own gallery stays at its address too ("Large attachments" of a full storage leads there).
  await theirs.goto('/attachments?sort=largest')
  await expect(theirs.getByTestId('gallery-sort')).toHaveValue('largest')
  await reader.context.close()
})

test('NOTES-23 AC-1 NOTES-7 on a phone the page "Folders" has the section "Smart" of the sidebar, without a fixed "Shared with me"', async ({ page, browser }) => {
  const stamp = Date.now().toString(36)
  const reader = await member(page, browser, `Phone ${stamp}`)
  const shared = await (await page.request.post('/api/notes', { data: { title: `Phone soup ${stamp}`, markdown: 'lentils' }, headers: TAB })).json()
  expect((await page.request.put(`/api/shares/note/${shared.id}/people/${reader.id}`, { data: { level: 'read' }, headers: TAB })).ok()).toBe(true)
  const phone = await reader.context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto('/folders')
  await expect(phone.getByTestId('folders-page')).toBeVisible()
  await expect(phone.getByTestId('folders-shared')).toHaveCount(0)
  const section = phone.getByTestId('folders-smart')
  await expect(section.getByRole('heading', { name: 'Smart' })).toBeVisible()
  await expect(section.getByTestId('folders-smart-folder')).toHaveText(['Open checklists›', 'Recently edited›', 'Shared with me›', 'Attachments›'])
  await expect(section.getByTestId('smart-icon-shared_with_me')).toHaveCount(1)
  await expect(section.getByTestId('smart-icon-attachments')).toHaveCount(1)
  await expect(section.getByTestId('folders-smart-new')).toHaveAttribute('href', '/smart/new')
  await section.getByTestId('folders-smart-folder').filter({ hasText: 'Shared with me' }).click()
  await expect(phone).toHaveURL(/\/smart\/[^/?]+$/)
  await expect(phone.getByTestId('note-row').filter({ hasText: `Phone soup ${stamp}` })).toBeVisible()
  await reader.context.close()
})
