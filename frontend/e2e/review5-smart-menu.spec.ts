/**
 * Fifth review: a smart folder in the sidebar has the menu a folder has ("…" on hover, a right click, Shift+F10) with
 * edit, up, down and delete, and on the phone's page "Folders" a "…" on every row. A smart folder carries a symbol
 * and a color chosen as a folder's. "About nexnotes" is an area of the settings (`settings-nav.spec.ts`). Run
 * centrally, never by an agent.
 */
import { expect, test, type Page } from '@playwright/test'

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

test('NOTES-23 AC-1 fifth review: on a phone every smart folder of "Folders" has "…" with the same menu', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const id = await smartFolder(page, `Phone ${stamp}`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/folders')
  const row = page.getByTestId('folders-smart-row').filter({ hasText: `Phone ${stamp}` })
  await row.getByTestId('folders-smart-more').click()
  await expect(page.getByTestId('smart-folder-menu').getByRole('menuitem')).toHaveText(['Edit', 'Move up', 'Move down', 'Delete'])
  await page.getByTestId('smart-folder-menu').getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/smart/${id}/edit$`))
  await removeSmart(page, id)
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
