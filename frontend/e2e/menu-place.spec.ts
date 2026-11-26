/**
 * Every menu of nexnotes stays whole inside the window (found 27.11.2026 on a screen with the task bar below): the menu
 * of a note low in the list opens upward or moves up, also when the note's own entries and the paper come a moment
 * later; the paper fits the menu's width, so the menu never scrolls sideways; a menu of the selection bar low in a note
 * opens above the bar. At 1080 px height and in a narrow window.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-menuplace' }

async function inside(page: Page, menu: Locator): Promise<void> {
  await expect(menu).toBeVisible()
  // Twice a frame apart: a menu that grows after it was placed must still stand inside.
  await page.waitForTimeout(300)
  const view = page.viewportSize()!
  const box = (await menu.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  const sideways = await menu.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(sideways).toBeLessThanOrEqual(0)
}

test.beforeAll(async ({ request }) => {
  for (let index = 0; index < 40; index += 1) {
    await request.post('/api/notes', { data: { title: `Place probe ${String(index).padStart(2, '0')}`, markdown: 'text' }, headers: TAB })
  }
})

for (const size of [
  { width: 1920, height: 1080 },
  { width: 900, height: 700 },
]) {
  test(`the menu of the lowest note in the list stays inside the window, paper without sideways scrolling, ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.goto('/inbox')
    const list = page.getByTestId('note-list')
    await expect(list).toBeVisible()
    const rows = page.getByTestId('note-row')
    await expect(rows.first()).toBeVisible()
    // The lowest row on screen: scroll the list to its end, take the last one that is shown whole.
    await list.evaluate((element) => {
      const scroller = (element.closest('[data-scroll]') as HTMLElement | null) ?? element
      scroller.scrollTop = scroller.scrollHeight
      for (let at: HTMLElement | null = element; at; at = at.parentElement) at.scrollTop = at.scrollHeight
    })
    const shown = await rows.evaluateAll((all) =>
      all
        .map((row, index) => {
          const box = row.getBoundingClientRect()
          const seen = document.elementFromPoint(box.left + 20, box.bottom - 4)
          return { index, whole: box.top >= 0 && box.bottom <= window.innerHeight && Boolean(seen && row.contains(seen)) }
        })
        .filter((row) => row.whole),
    )
    const lowest = rows.nth(shown[shown.length - 1].index)
    const box = (await lowest.boundingBox())!
    expect(box.y + box.height).toBeGreaterThan(size.height * 0.6)
    await lowest.click({ button: 'right', position: { x: 20, y: box.height - 4 } })
    const menu = page.getByTestId('note-item-menu')
    // The note's own entries and the paper come after the menu stood.
    await expect(menu.getByTestId('paper-picker')).toBeVisible()
    await inside(page, menu)
    const picker = (await menu.getByTestId('paper-picker').boundingBox())!
    const panel = (await menu.boundingBox())!
    expect(picker.x + picker.width).toBeLessThanOrEqual(panel.x + panel.width)
    await page.keyboard.press('Escape')
  })
}

test('a menu of the selection bar low in a note opens above the bar', async ({ page }) => {
  const lines = Array.from({ length: 80 }, (_, index) => `Line ${index} of the probe`).join('\n\n')
  const made = await page.request.post('/api/notes', { data: { title: 'Selection probe', markdown: `${lines}\n\nlast words here` }, headers: TAB })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/notes/${id}`)
  const last = page.getByTestId('note-body').getByText('last words here')
  await expect(last).toBeVisible()
  // The line low on screen: scroll so that it stands at the bottom edge.
  await last.evaluate((element) => element.scrollIntoView({ block: 'end' }))
  const line = (await last.boundingBox())!
  expect(line.y).toBeGreaterThan(1080 * 0.8)
  await last.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  const style = page.getByTestId('selection-tool-style')
  await expect(page.getByTestId('selection-bar')).toBeVisible()
  await expect(style).toBeVisible()
  await style.click()
  await inside(page, page.getByTestId('selection-menu-style'))
})
