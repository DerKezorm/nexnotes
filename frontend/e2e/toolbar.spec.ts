/**
 * Two notes side by side at 1280 and 1024 px: each toolbar stays one row without a scroll bar (the rest is in "More"),
 * and "you, other window" at the right is never cut off.
 */
import { expect, test } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-toolbar00' }

for (const width of [1280, 1024]) {
  test(`NOTES-3 EC-11 side by side at ${width} px: one row of tools, the presence whole`, async ({ page, context }) => {
    const ids: string[] = []
    for (const title of [`Left ${width}`, `Right ${width}`]) {
      const made = await page.request.post('/api/notes', { data: { title, markdown: 'text' }, headers: TAB })
      ids.push((await made.json()).id)
    }
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/notes/${ids[0]}`)
    await page.getByTestId('note-row').filter({ hasText: `Right ${width}` }).click({ button: 'right' })
    await page.getByTestId('menu-open-beside').click()
    await expect(page.locator('[data-testid="tab-pane"]')).toHaveCount(2)
    // The same note in another window of the same account: "you, other window" in the left side.
    const other = await context.newPage()
    await other.goto(`/notes/${ids[0]}`)
    await expect(other.getByTestId('note-saved').first()).toHaveText('saved')
    const left = page.locator('[data-testid="tab-pane"][data-side="left"]')
    await expect(left.getByTestId('presence-own')).toBeVisible()
    for (const side of ['left', 'right']) {
      const pane = page.locator(`[data-testid="tab-pane"][data-side="${side}"]`)
      const bar = pane.getByTestId('toolbar').first()
      const box = await bar.evaluate((element) => ({ height: element.getBoundingClientRect().height, scroll: element.scrollWidth, client: element.clientWidth }))
      expect(box.height).toBeLessThan(44)
      expect(box.scroll).toBeLessThanOrEqual(box.client)
      const head = await pane.getByTestId('editor-head').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }))
      expect(head.scroll).toBeLessThanOrEqual(head.client)
    }
    const head = (await left.getByTestId('editor-head').boundingBox())!
    const own = (await left.getByTestId('presence-own').boundingBox())!
    expect(own.x).toBeGreaterThanOrEqual(head.x)
    expect(own.x + own.width).toBeLessThanOrEqual(head.x + head.width)
    await expect(left.getByTestId('tool-more')).toBeVisible()
    await other.close()
  })
}
