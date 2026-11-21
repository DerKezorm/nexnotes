/** NOTES-3 AC-5 in a real browser: a table made from the toolbar, changed only through the controls one sees. */
import { expect, test } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-table0000' }

test('NOTES-3 AC-5 rows and columns through the visible controls; the other cells stay', async ({ page }) => {
  const made = await page.request.post('/api/notes', { data: { title: 'Table probe', markdown: 'Before' }, headers: TAB })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${id}`)
  await page.locator('.nn-editor .ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByTestId('tool-table').first().click()
  const table = page.locator('.nn-editor table')
  await expect(table).toBeVisible()
  // Fill the first two cells of the body.
  await page.locator('.nn-editor table tr').nth(1).locator('td').first().click()
  await page.keyboard.type('a1')
  await page.keyboard.press('Tab')
  await page.keyboard.type('b1')
  const rowsOf = () => table.locator('tr').count()
  const columnsOf = () => table.locator('tr').first().locator('th, td').count()
  expect(await rowsOf()).toBe(3)
  expect(await columnsOf()).toBe(3)
  // The "+" along the edges.
  await page.getByTestId('table-add-row').click()
  expect(await rowsOf()).toBe(4)
  await page.locator('.nn-editor table tr').nth(1).locator('td').first().click()
  await page.getByTestId('table-add-column').click()
  expect(await columnsOf()).toBe(4)
  // The menu at the table: move the row down, delete a column.
  await page.locator('.nn-editor table tr').nth(1).locator('td').first().click()
  await page.getByTestId('table-menu-button').click()
  await page.getByTestId('table-menu').getByTestId('table-rowDown').click()
  await expect(page.locator('.nn-editor table tr').nth(2).locator('td').first()).toHaveText('a1')
  // A right click in a cell: the same menu.
  await page.locator('.nn-editor table tr').nth(2).locator('td').last().click({ button: 'right' })
  await page.getByTestId('table-menu').getByTestId('table-deleteColumn').click()
  expect(await columnsOf()).toBe(3)
  await expect(page.locator('.nn-editor table tr').nth(2).locator('td').nth(0)).toHaveText('a1')
  await expect(page.locator('.nn-editor table tr').nth(2).locator('td').nth(1)).toHaveText('b1')
})
