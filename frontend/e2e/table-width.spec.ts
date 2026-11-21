/**
 * NOTES-3 AC-19 in a real browser (second review): a new table's columns share the text's width; typing changes no
 * column, the text wraps in its cell; dragging an edge sets the width and it stays after reloading; a double click on
 * the edge fits the column; the table menu makes a column wider and narrower; never narrower than 60 px; a table wider
 * than the text scrolls in its box.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-colwidth0' }

/** The widths of the cells of the header row, as the page shows them. */
async function widths(page: Page): Promise<number[]> {
  return page.locator('.nn-editor table tr').first().locator('th, td').evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width))
}

function near(actual: number[], expected: number[], tolerance = 1.5) {
  expect(actual.length).toBe(expected.length)
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]), `column ${index + 1}: ${value} against ${expected[index]}`).toBeLessThanOrEqual(tolerance))
}

/** Puts the pointer on the right edge of a header cell, where the grip shows. */
async function onEdge(page: Page, column: number) {
  const box = (await page.locator('.nn-editor table tr').first().locator('th, td').nth(column).boundingBox())!
  const x = box.x + box.width - 2
  const y = box.y + box.height / 2
  await page.mouse.move(x - 30, y)
  await page.mouse.move(x, y)
  await expect(page.locator('.nn-editor .column-resize-handle').first()).toBeVisible()
  return { x, y }
}

test('NOTES-3 AC-19 columns keep their width while typing, are dragged, fitted and set from the menu, and stay', async ({ page }) => {
  const made = await page.request.post('/api/notes', { data: { title: 'Column widths', markdown: 'Before' }, headers: TAB })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${id}`)
  await page.locator('.nn-editor .ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByTestId('tool-table').first().click()
  const table = page.locator('.nn-editor table')
  await expect(table).toBeVisible()

  // A new table: three equal columns over the whole width of the text.
  const fresh = await widths(page)
  near(fresh, [fresh[0], fresh[0], fresh[0]])
  const text = await page.locator('.nn-editor .ProseMirror').evaluate((element) => element.getBoundingClientRect().width)
  const wrapper = page.locator('.nn-editor .tableWrapper')
  expect(Math.abs((await wrapper.boundingBox())!.width - text)).toBeLessThanOrEqual(2)

  // Typing a long text and a long word: no column changes, the cell grows in height only.
  const cell = page.locator('.nn-editor table tr').nth(1).locator('td').first()
  const lowBefore = (await cell.boundingBox())!.height
  await cell.click()
  await page.keyboard.type('A rather long sentence that has to wrap inside its cell instead of pushing the others aside ')
  await page.keyboard.type('Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen')
  near(await widths(page), fresh, 0.5)
  expect((await cell.boundingBox())!.height).toBeGreaterThan(lowBefore * 2)
  const scroll = await wrapper.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(scroll).toBeLessThanOrEqual(1)

  // Dragging the first column's edge 80 px to the right: that column grows, the others stay.
  const edge = await onEdge(page, 0)
  await page.mouse.down()
  await page.mouse.move(edge.x + 40, edge.y, { steps: 4 })
  await page.mouse.move(edge.x + 80, edge.y, { steps: 4 })
  await page.mouse.up()
  const dragged = await widths(page)
  near(dragged, [fresh[0] + 80, fresh[1], fresh[2]], 3)
  // Together now wider than the text: the table scrolls in its box.
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(40)

  // Saved, and after reloading the same.
  await expect(page.getByTestId('note-saved').first()).toHaveText('saved', { timeout: 15_000 })
  await page.reload()
  await expect(table).toBeVisible()
  near(await widths(page), dragged, 1)

  // A double click on the second column's edge fits it to its content ("Qty" alone is narrow: down to 60 px or so).
  const header = page.locator('.nn-editor table tr').first().locator('th').nth(1)
  await header.click()
  await page.keyboard.type('Qty')
  const second = await onEdge(page, 1)
  await page.mouse.dblclick(second.x, second.y)
  await expect.poll(async () => (await widths(page))[1]).toBeLessThan(dragged[1] - 40)
  const fitted = await widths(page)
  expect(fitted[1]).toBeGreaterThanOrEqual(60)
  // "Qty" stands on one line in the fitted column.
  const line = await header.evaluate((element) => {
    const words = element.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.selectNodeContents(words)
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
  })
  expect(line).toBe(1)
  near([fitted[0], fitted[2]], [dragged[0], dragged[2]], 1)

  // From the table menu, without a mouse on the edge: wider, then narrower, never under 60 px.
  await page.locator('.nn-editor table tr').nth(1).locator('td').nth(2).locator('p').click()
  await page.getByTestId('table-menu-button').click()
  await page.getByTestId('table-menu').getByTestId('table-columnWider').click()
  await expect.poll(async () => (await widths(page))[2]).toBeGreaterThan(fitted[2] + 35)
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('table-menu-button').click()
    await page.getByTestId('table-menu').getByTestId('table-columnNarrower').click()
  }
  await expect.poll(async () => Math.round((await widths(page))[2])).toBe(60)
  // The keyboard reaches the menu too: the items are buttons in the shared menu.
  await page.getByTestId('table-menu-button').click()
  await expect(page.getByTestId('table-menu').getByTestId('table-columnFit')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('NOTES-3 AC-19 a width set in one window shows in the other', async ({ page, context }) => {
  const made = await page.request.post('/api/notes', { data: { title: 'Column widths live', markdown: 'Before' }, headers: TAB })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${id}`)
  await page.locator('.nn-editor .ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByTestId('tool-table').first().click()
  await expect(page.locator('.nn-editor table')).toBeVisible()
  const other = await context.newPage()
  await other.setViewportSize({ width: 1440, height: 900 })
  await other.goto(`/notes/${id}`)
  await expect(other.locator('.nn-editor table')).toBeVisible()
  const before = await widths(other)
  const edge = await onEdge(page, 0)
  await page.mouse.down()
  await page.mouse.move(edge.x - 60, edge.y, { steps: 6 })
  await page.mouse.up()
  const mine = await widths(page)
  expect(mine[0]).toBeLessThan(before[0] - 50)
  await expect.poll(async () => Math.round((await widths(other))[0])).toBe(Math.round(mine[0]))
  await other.close()
})
