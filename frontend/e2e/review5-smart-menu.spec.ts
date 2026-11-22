/**
 * Fifth review: a smart folder in the sidebar has the menu a folder has ("…" on hover, a right click, Shift+F10) with
 * edit, up, down and delete, and on the phone's page "Folders" a "…" on every row. A smart folder carries a symbol
 * and a color chosen as a folder's. "About nexnotes" is an area of the settings (`settings-nav.spec.ts`). Runs
 * with `npm run e2e`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review5s0' }

async function smartFolder(page: Page, name: string, look: { icon?: string; color?: string } = {}): Promise<string> {
  const made = await page.request.post('/api/smart-folders', {
    data: { name, match: 'all', conditions: [{ kind: 'text', value: name }], ...look },
    headers: TAB,
  })
  expect(made.status()).toBe(201)
  return String((await made.json()).id)
}

async function removeSmart(page: Page, id: string): Promise<void> {
  await page.request.delete(`/api/smart-folders/${id}`, { headers: TAB })
}

/** An account of its own, signed in in a context of its own. */
async function member(page: Page, browser: Browser, name: string): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  expect(invite.status()).toBe(201)
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `${name.toLowerCase().replaceAll(' ', '-')}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: name, email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return context
}

test('fifth review: "…" on hover and a right click open the menu of a smart folder; edit opens the editor', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const id = await smartFolder(page, `Menu ${stamp}`)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  const section = page.getByTestId('sidebar-smart')
  const row = section.locator('li').filter({ hasText: `Menu ${stamp}` })
  const more = row.getByTestId('sidebar-smart-more')
  await expect(more).toBeHidden()
  await row.hover()
  await expect(more).toBeVisible()
  await more.click()
  const menu = page.getByTestId('smart-folder-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Move up', 'Move down', 'Delete'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await row.getByTestId('sidebar-smart-folder').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/smart/${id}/edit$`))
  await removeSmart(page, id)
})

test('fifth review: Shift+F10 opens the menu from the keyboard; up and down move a smart folder', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const first = await smartFolder(page, `Alpha ${stamp}`)
  const second = await smartFolder(page, `Beta ${stamp}`)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  const links = page.getByTestId('sidebar-smart-folder')
  const names = async () => (await links.allTextContents()).filter((text) => text.endsWith(stamp))
  await expect.poll(names).toEqual([`Alpha ${stamp}`, `Beta ${stamp}`])
  const beta = links.filter({ hasText: `Beta ${stamp}` })
  await beta.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('smart-folder-menu')
  await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeFocused()
  await menu.getByRole('menuitem', { name: 'Move up' }).click()
  await expect.poll(names).toEqual([`Beta ${stamp}`, `Alpha ${stamp}`])
  // The order is kept on the server.
  await page.reload()
  await expect.poll(names).toEqual([`Beta ${stamp}`, `Alpha ${stamp}`])
  await removeSmart(page, first)
  await removeSmart(page, second)
})

test('fifth review: deleting from the sidebar asks first and leaves the notes; the open one leaves its page', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const note = await (await page.request.post('/api/notes', { data: { title: `Kept ${stamp}`, markdown: `Gone ${stamp}` }, headers: TAB })).json()
  const id = await smartFolder(page, `Gone ${stamp}`)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/smart/${id}`)
  const row = page.getByTestId('sidebar-smart-folder').filter({ hasText: `Gone ${stamp}` })
  await row.click({ button: 'right' })
  await page.getByTestId('smart-folder-menu').getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByTestId('smart-delete')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('smart-delete-confirm').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(row).toHaveCount(0)
  expect((await page.request.get(`/api/notes/${note.id}`)).ok()).toBe(true)
})

test('NOTES-23 AC-1 fifth review: on a phone every smart folder of "Folders" has "…" with the same menu', async ({ page, browser }) => {
  const stamp = Date.now().toString(36)
  // An account of its own: what other files leave in the operator's (the notice of a finished export, fixed above the
  // bottom bar) stands over the "…" of the last rows on a phone.
  const context = await member(page, browser, `Phone member ${stamp}`)
  const own = await context.newPage()
  const id = await smartFolder(own, `Phone ${stamp}`)
  await own.setViewportSize({ width: 390, height: 844 })
  await own.goto('/folders')
  const rows = own.getByTestId('folders-smart-row')
  // Every smart folder has its "…", the ones every account gets as well as the own one.
  await expect(rows.filter({ hasText: `Phone ${stamp}` })).toHaveCount(1)
  await expect(rows.getByTestId('folders-smart-more')).toHaveCount(await rows.count())
  await rows.filter({ hasText: `Phone ${stamp}` }).getByTestId('folders-smart-more').click()
  await expect(own.getByTestId('smart-folder-menu').getByRole('menuitem')).toHaveText(['Edit', 'Move up', 'Move down', 'Delete'])
  await own.getByTestId('smart-folder-menu').getByRole('menuitem', { name: 'Edit' }).click()
  await expect(own).toHaveURL(new RegExp(`/smart/${id}/edit$`))
  await context.close()
})

test('fifth review: a smart folder takes a symbol and a color in the editor and shows them in the sidebar and its list', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/smart/new')
  await page.getByTestId('smart-name').fill(`Look ${stamp}`)
  await page.getByTestId('smart-kind').first().selectOption('pinned')
  await expect(page.getByTestId('smart-look-preview').locator('svg')).toHaveAttribute('data-symbol', 'filter')
  await page.getByTestId('smart-look').locator('summary').click()
  await page.getByTestId('smart-look').locator('[role="radio"][data-symbol="star"]').click()
  await page.getByTestId('smart-look').locator('button[data-color="#4ade80"]').click()
  await expect(page.getByTestId('smart-look-preview').locator('svg')).toHaveAttribute('data-symbol', 'star')
  await page.getByTestId('smart-save').click()
  await expect(page).toHaveURL(/\/smart\/[^/]+$/)
  const mark = page.getByTestId('sidebar-smart-folder').filter({ hasText: `Look ${stamp}` }).locator('svg')
  await expect(mark).toHaveAttribute('data-symbol', 'star')
  await expect(mark).toHaveCSS('color', 'rgb(74, 222, 128)')
  await expect(page.getByTestId('smart-page').locator('svg[data-symbol="star"]').first()).toBeVisible()
  const id = page.url().split('/smart/')[1]
  await removeSmart(page, id)
})
