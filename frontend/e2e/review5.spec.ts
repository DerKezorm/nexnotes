/**
 * Fifth review (21.11.2026), in a real browser:
 *
 * 1. "+" in the row of tabs takes a quite empty new note that is open instead of making another; a quite empty note
 *    thrown away closes its tab by itself.
 * 2. Long titles break into further lines in the sheet, never cut off; the list stands as a column beside two notes
 *    only while each keeps 480 px.
 * 3. Beside a second note the sheet's own small bar stands at the top right inside the sheet: above the sheets only the
 *    bar over both needs a row. A narrow sheet says less under its title.
 * 6. The same note on both sides of one window shows no "you, other window"; a second browser tab does.
 * 7. The button that ends side by side says "Show one note only"; the list folds away with "«" in its head to a strip at
 *    the left edge (sixth review), no button "List" in the row of tabs.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review500' }

async function note(page: Page, title: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

const pane = (page: Page, side: 'left' | 'right') => page.locator(`[data-testid="tab-pane"][data-side="${side}"]`)

async function beside(page: Page, title: string): Promise<void> {
  await page.getByTestId('note-row').filter({ hasText: title }).first().click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(pane(page, 'right')).toBeVisible()
}

test('NOTES-8 NOTES-3 AC-1 EC-4 "+" takes the empty new note that is open; an empty note thrown away closes its tab', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const id = await note(page, `Plus ${stamp}`, 'text')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-title')).toHaveValue(`Plus ${stamp}`)
  const tabs = page.getByTestId('tab')
  await expect(tabs).toHaveCount(1)
  const made: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes') made.push(request.url())
  })
  await page.getByTestId('tab-new').click()
  await expect(tabs).toHaveCount(2)
  await expect(page.getByTestId('note-title')).toBeFocused()
  // Again and again: the same empty note, the cursor in its title, no third tab.
  await page.getByTestId('note-body').click()
  await page.getByTestId('tab-new').click()
  await page.getByTestId('tab-new').click()
  await expect(page.getByTestId('note-title')).toBeFocused()
  await expect(tabs).toHaveCount(2)
  expect(made).toHaveLength(1)
  // The first tab again: the empty note goes out of view, is thrown away, and its tab closes by itself.
  await tabs.first().click()
  await expect(tabs).toHaveCount(1)
  await expect(page.locator('[data-testid="tab"][data-state="gone"]')).toHaveCount(0)
  await expect(page.getByTestId('leave-dialog')).toHaveCount(0)
  await expect(page.getByTestId('note-title')).toHaveValue(`Plus ${stamp}`)
})

test('NOTES-3 long titles break into lines in the sheet, never cut off: one note, side by side with the list, and in the drawer\'s width', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const long = `Pfannkuchen mit Apfelmus und Zimt für den Sonntag ${stamp}`
  const first = await note(page, long, 'Eier, Mehl, Milch')
  await note(page, `Pfannkuchen ${stamp}`, 'kurz')
  const whole = async (side: 'left' | 'right' | null) => {
    const title = side ? pane(page, side).getByTestId('note-title') : page.getByTestId('note-title')
    const sheet = side ? pane(page, side).getByTestId('note-page') : page.getByTestId('note-page')
    await expect(title).toBeVisible()
    const box = await title.evaluate((element) => ({ scroll: element.scrollWidth - element.clientWidth, scrollY: element.scrollHeight - element.clientHeight, height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) }))
    expect(box.scroll, 'no title runs out sideways').toBeLessThanOrEqual(0)
    expect(box.scrollY, 'every line of the title in sight').toBeLessThanOrEqual(1)
    const titleBox = (await title.boundingBox())!
    const sheetBox = (await sheet.boundingBox())!
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 0.5)
    return box
  }
  // One note at 1440: one line or more, never cut.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${first}`)
  await whole(null)
  // A narrow window with one note: the long title breaks into further lines.
  await page.setViewportSize({ width: 820, height: 900 })
  const narrow = await whole(null)
  expect(narrow.height).toBeGreaterThan(narrow.line * 1.5)
  // Side by side at 1920 with the list as a column: each side keeps at least 480 px, the titles whole.
  await page.setViewportSize({ width: 1920, height: 1000 })
  await beside(page, `Pfannkuchen ${stamp}`)
  await expect(page.getByTestId('list-column')).toBeVisible()
  for (const side of ['left', 'right'] as const) expect((await pane(page, side).boundingBox())!.width).toBeGreaterThanOrEqual(480)
  await whole('left')
  await whole('right')
  await expect(pane(page, 'right').getByTestId('note-title')).toHaveValue(`Pfannkuchen ${stamp}`)
  // At 1280 the two sides would get less than 480 px beside the list: the list gives way (a drawer), the titles whole.
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByTestId('list-column')).toHaveCount(0)
  await whole('left')
  await whole('right')
})

test('NOTES-8 beside a second note the sheet\'s own bar stands at the top right inside the sheet; a narrow sheet says less', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const first = await note(page, `Sheet bar ${stamp}`, 'one')
  await note(page, `Other sheet ${stamp}`, 'two')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/notes/${first}`)
  await beside(page, `Other sheet ${stamp}`)
  const bar = page.getByTestId('shared-toolbar')
  await expect(bar).toBeVisible()
  const barBox = (await bar.boundingBox())!
  for (const side of ['left', 'right'] as const) {
    await expect(pane(page, side).getByTestId('editor-head')).toHaveCount(0)
    const sheet = pane(page, side).getByTestId('note-page')
    const tools = sheet.getByTestId('sheet-tools')
    await expect(tools.getByTestId('note-menu')).toBeVisible()
    const sheetBox = (await sheet.boundingBox())!
    const toolsBox = (await tools.boundingBox())!
    const titleBox = (await pane(page, side).getByTestId('note-title').boundingBox())!
    // Right after the bar over both comes the sheet itself: no row of its own for the note's tools.
    expect(sheetBox.y - (barBox.y + barBox.height)).toBeLessThanOrEqual(24)
    // At the right inside the sheet, beside the title or just above it.
    expect(toolsBox.y).toBeGreaterThanOrEqual(sheetBox.y)
    expect(toolsBox.x + toolsBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 0.5)
    expect(toolsBox.x + toolsBox.width / 2).toBeGreaterThan(sheetBox.x + sheetBox.width / 2)
    expect(toolsBox.y).toBeLessThanOrEqual(titleBox.y + titleBox.height)
    // Symbols only: the clip without its word.
    await expect(tools.getByTestId('attach')).toHaveText('')
    // Narrower than 560 px: folder, "changed" and saving; the day it was made in the tooltip of "changed".
    expect(sheetBox.width).toBeLessThan(560)
    await expect(sheet.getByTestId('note-created')).toHaveCount(0)
    await expect(sheet.getByTestId('note-changed')).toHaveAttribute('title', /^created /)
    const meta = await sheet.getByTestId('note-meta').evaluate((element) => ({ height: element.getBoundingClientRect().height }))
    expect(meta.height, 'the line under the title in at most two lines').toBeLessThan(2 * 20 + 6)
  }
  // One note alone in a wide window: the line as before, with "created".
  await page.getByTestId('tab-end-split').click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByTestId('note-created')).toBeVisible()
  await expect(page.getByTestId('editor-head')).toBeVisible()
})

test('NOTES-12 EC-8 NOTES-8 EC-1 the same note on both sides of one window is no "other window"; a second tab is', async ({ page, context }) => {
  const stamp = Date.now().toString(36)
  const id = await note(page, `Twice ${stamp}`, 'same')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto(`/notes/${id}`)
  await beside(page, `Twice ${stamp}`)
  await expect(pane(page, 'left').getByTestId('note-saved')).toHaveText('saved')
  await expect(pane(page, 'right').getByTestId('note-saved')).toHaveText('saved')
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('presence-own')).toHaveCount(0)
  // A second browser tab with the same note: both sides see it.
  const other = await context.newPage()
  await other.goto(`/notes/${id}`)
  await expect(other.getByTestId('note-saved').first()).toHaveText('saved')
  await expect(pane(page, 'left').getByTestId('presence-own')).toBeVisible()
  await expect(pane(page, 'right').getByTestId('presence-own')).toBeVisible()
  await expect(other.getByTestId('presence-own').first()).toBeVisible()
  await other.close()
})

test('NOTES-8 the button that ends side by side says "Show one note only"; the list folds with "«" in its head, not from the row of tabs, also beside one note', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const id = await note(page, `Ends ${stamp}`, 'a')
  await note(page, `Ends beside ${stamp}`, 'b')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto(`/notes/${id}`)
  // One note folds the list too (24.11.2026): "«" in its head, "»" in the strip brings it back.
  await expect(page.getByTestId('list-head')).toBeVisible()
  await page.getByTestId('list-collapse').click()
  await expect(page.getByTestId('list-column')).toHaveCount(0)
  await expect(page.getByTestId('list-expand')).toBeVisible()
  await page.getByTestId('list-expand').click()
  await expect(page.getByTestId('list-column')).toBeVisible()
  await beside(page, `Ends beside ${stamp}`)
  const end = page.getByTestId('tab-end-split')
  await expect(end).toHaveAttribute('aria-label', 'Show one note only')
  await expect(end).toHaveAttribute('title', 'Show one note only')
  await expect(page.getByTestId('tab-list-toggle')).toHaveCount(0)
  // "«" folds the list away, "»" in the strip at the left edge brings it back; both by keyboard.
  await page.getByTestId('list-collapse').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('list-column')).toHaveCount(0)
  await expect(page.getByTestId('list-expand')).toBeFocused()
  await expect(page.getByTestId('list-expand')).toHaveAttribute('title', 'Expand list')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('list-column')).toBeVisible()
  await expect(page.getByTestId('list-collapse')).toBeFocused()
  // Folded, a folder chosen in the sidebar opens the drawer, as before.
  await page.getByTestId('list-collapse').click()
  await page.getByRole('link', { name: /^Inbox/ }).first().click()
  await expect(page.getByTestId('list-drawer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('list-drawer')).toHaveCount(0)
})
