/**
 * Third review: the outline button never does nothing (a column where it fits, a panel over the text where not), the
 * toolbar stays in sight in a long note, the bar at selected text, and Alt-click on a note opens a tab instead of the
 * browser's download.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review300' }

async function note(page: Page, title: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  return (await made.json()).id
}

const long = Array.from({ length: 120 }, (_, index) => (index % 20 === 0 ? `## Part ${index / 20 + 1}` : `Line ${index} of a long note.`)).join('\n\n')

test('NOTES-3 AC-15 the reviewed window: the outline stands beside the text; side by side it opens as a panel', async ({ page }) => {
  const id = await note(page, 'Outline window', '# Trip\n\ntext\n\n## Hotel\n\nmore')
  await note(page, 'Outline other', 'nothing')
  await page.setViewportSize({ width: 2000, height: 1000 })
  await page.goto(`/notes/${id}`)
  const button = page.getByTestId('tool-outline')
  await expect(page.getByTestId('outline')).toHaveAttribute('data-mode', 'column')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('outline-heading')).toHaveCount(2)
  // Side by side: no room for the column, the button opens a panel over the text's right edge.
  await page.getByTestId('note-row').filter({ hasText: 'Outline other' }).click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(page.locator('[data-testid="tab-pane"]')).toHaveCount(2)
  await expect(page.getByTestId('outline')).toHaveCount(0)
  const left = page.locator('[data-testid="tab-pane"][data-side="left"]')
  const toggle = left.getByTestId('tool-outline')
  if (await toggle.count()) await toggle.click()
  else {
    await left.getByTestId('tool-more').click()
    await page.getByTestId('more-outline').click()
  }
  const panel = left.getByTestId('outline')
  await expect(panel).toHaveAttribute('data-mode', 'panel')
  await expect(panel).toBeFocused()
  const sheet = (await left.getByTestId('note-page').boundingBox())!
  const box = (await panel.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width + 30)
  expect(box.x).toBeGreaterThan(sheet.x)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('NOTES-3 AC-3 in a long note the toolbar stays in sight while the text scrolls, the outline too', async ({ page }) => {
  const id = await note(page, 'Long note', long)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/notes/${id}`)
  const pane = page.getByTestId('tab-pane').first()
  const head = pane.getByTestId('editor-head')
  await expect(head.getByTestId('toolbar')).toBeVisible()
  const before = (await head.boundingBox())!
  await pane.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  await page.waitForTimeout(200)
  const after = (await head.boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThan(2)
  await expect(head.getByTestId('tool-bold')).toBeInViewport()
  // The title scrolled away; the outline stays below the toolbar.
  await expect(pane.getByTestId('note-meta')).not.toBeInViewport()
  const outline = (await pane.getByTestId('outline').boundingBox())!
  expect(outline.y).toBeGreaterThanOrEqual(after.y + after.height - 1)
  // One scroll area per note: nothing inside the side scrolls on its own.
  const inner = await pane.evaluate((side) => [...side.querySelectorAll('*')].filter((element) => {
    const style = getComputedStyle(element)
    return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1 && element.getAttribute('data-testid') !== 'outline'
  }).length)
  expect(inner).toBe(0)
})

test('NOTES-3 AC-20 the bar at selected text: bold keeps the selection, Escape sends it away', async ({ page }) => {
  const id = await note(page, 'Bubble', 'some words to format here')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/notes/${id}`)
  const body = page.getByTestId('note-body')
  await body.getByText('some words').dblclick()
  const bar = page.getByTestId('selection-bar')
  await expect(bar).toBeVisible()
  const selected = await page.evaluate(() => window.getSelection()?.toString())
  await bar.getByTestId('selection-tool-bold').click()
  await expect(body.locator('strong')).toHaveCount(1)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
})

test('NOTES-8 AC-3 Alt-click on a note opens a tab and starts no download', async ({ page }) => {
  const first = await note(page, 'Alt first', 'one')
  await note(page, 'Alt second', 'two')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/notes/${first}`)
  let downloads = 0
  page.on('download', () => (downloads += 1))
  await page.getByTestId('note-row').filter({ hasText: 'Alt second' }).click({ modifiers: ['Alt'] })
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await page.waitForTimeout(500)
  expect(downloads).toBe(0)
})
