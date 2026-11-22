/**
 * The field "With people on this server" of the share dialog, note and folder alike: a name nobody on the server goes
 * by is said right below the field (the operator gets "Invite a person", which opens the invitation under Settings ›
 * Accounts), "Done" with a name typed and nobody chosen stays open once, and the field clears with an ✕ of the app's
 * own instead of the browser's. Runs with `npm run e2e`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-nobody000' }
const NOBODY = 'Nobody on this server goes by that. You can only share with accounts here.'

async function member(page: Page, browser: Browser, name: string): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `${name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: name, email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return context
}

async function shareNote(page: Page, title: string): Promise<void> {
  const note = await (await page.request.post('/api/notes', { data: { title, markdown: 'Text' }, headers: TAB })).json()
  await page.goto(`/notes/${note.id}`)
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-share').click()
  await expect(page.getByTestId('share-dialog')).toBeVisible()
}

test('NOTES-13 AC-1 a name nobody goes by is said under the field; the operator may invite; "Done" asks once', async ({ page }) => {
  await shareNote(page, `Nobody ${Date.now().toString(36)}`)
  const field = page.getByTestId('share-search')
  // A plain text field: no blue ✕ of the browser.
  await expect(field).toHaveAttribute('type', 'text')
  await field.fill(`zz-nobody-${Date.now().toString(36)}`)
  await expect(page.getByTestId('share-nobody')).toContainText(NOBODY)
  await expect(page.getByTestId('share-found')).toHaveCount(0)
  // "Done" with the name typed and nobody chosen: open, said once, aloud for a screen reader.
  await page.getByTestId('share-done').click()
  await expect(page.getByTestId('share-dialog')).toBeVisible()
  await expect(page.getByTestId('share-none-chosen')).toHaveText('Nobody chosen yet.')
  await expect(page.locator('[aria-live="polite"]').filter({ has: page.getByTestId('share-none-chosen') })).toHaveCount(1)
  await page.getByTestId('share-done').click()
  await expect(page.getByTestId('share-dialog')).toHaveCount(0)

  // The operator's way on: "Invite a person" opens the invitation in Settings › Accounts.
  await shareNote(page, `Invite ${Date.now().toString(36)}`)
  await page.getByTestId('share-search').fill(`zz-nobody-${Date.now().toString(36)}`)
  await page.getByTestId('share-invite').click()
  await expect(page).toHaveURL(/\/settings\/accounts/)
  await expect(page.getByRole('dialog', { name: 'Invite a person' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/settings\/accounts$/)
})

test('NOTES-13 AC-1 the ✕ of the field clears it; a folder\'s dialog says the same; a member gets no "Invite"', async ({ page, browser }) => {
  await shareNote(page, `Clear ${Date.now().toString(36)}`)
  const field = page.getByTestId('share-search')
  await field.fill('zz')
  // The ✕ inside the dialog, by its exact name: the tab and the row of a note called "Clear …" carry the word too.
  const clear = page.getByTestId('share-dialog').getByRole('button', { name: 'Clear', exact: true })
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(field).toHaveValue('')
  await expect(field).toBeFocused()
  await expect(page.getByTestId('share-search-clear')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // A folder: the same field, the same sentence.
  const folder = await (await page.request.post('/api/folders', { data: { name: `Share field ${Date.now().toString(36)}` }, headers: TAB })).json()
  await page.goto(`/folder/${folder.id}`)
  await page.getByTestId('folder-more').click()
  await page.getByRole('menuitem', { name: 'Share …' }).click()
  await page.getByTestId('share-search').fill(`zz-nobody-${Date.now().toString(36)}`)
  await expect(page.getByTestId('share-nobody')).toContainText(NOBODY)
  await page.keyboard.press('Escape')

  // A member is told the same, without the way to invite.
  const context = await member(page, browser, `Nobody member ${Date.now().toString(36)}`)
  const theirs = await context.newPage()
  await shareNote(theirs, 'Member note')
  await theirs.getByTestId('share-search').fill(`zz-nobody-${Date.now().toString(36)}`)
  await expect(theirs.getByTestId('share-nobody')).toContainText(NOBODY)
  await expect(theirs.getByTestId('share-invite')).toHaveCount(0)
  await context.close()
})
