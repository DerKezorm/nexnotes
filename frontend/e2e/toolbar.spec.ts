/**
 * Two notes side by side at 1280, 1024 and 900 px (second review): each toolbar stands in one row or two, never more,
 * broken only between groups, without a scroll bar; the note's own buttons and "you, other window" at the right are
 * never cut off. "More" comes only where not even two rows hold the tools. With both sides on show the text tools
 * stand once over both (21.11.2026, `split-toolbar.spec.ts`): that one bar keeps the same rules, each side's head
 * keeps only the note's own buttons.
 */
import { expect, test, type Locator } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-toolbar00' }

async function inside(outer: Locator, inner: Locator) {
  const a = (await outer.boundingBox())!
  const b = (await inner.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(a.x - 0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(a.x + a.width + 0.5)
}

for (const width of [1280, 1024, 900]) {
  test(`NOTES-3 EC-11 side by side at ${width} px: at most two rows of tools, the buttons at the right whole`, async ({ page, context }) => {
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
    const report: string[] = []
    for (const pane of await page.locator('[data-testid="tab-pane"]').all()) {
      if (!(await pane.isVisible())) continue
      const head = pane.getByTestId('editor-head')
      const shared = page.getByTestId('shared-toolbar')
      const both = (await shared.count()) > 0
      // Both sides on show: the one bar over both, measured in its own row; the head holds no text tools.
      if (both) await expect(head.locator('[data-tool]')).toHaveCount(0)
      const frame = both ? shared : head
      const bar = (both ? shared : pane).getByTestId('toolbar').first()
      const box = await bar.evaluate((element) => ({ height: element.getBoundingClientRect().height, scroll: element.scrollWidth, client: element.clientWidth, rows: element.getAttribute('data-rows') }))
      // Two rows at most (34 px each and the gap), no scroll bar anywhere in the head.
      expect(box.height).toBeLessThan(2 * 34 + 4 + 4)
      expect(box.scroll).toBeLessThanOrEqual(box.client)
      for (const one of [head, frame]) {
        const scroll = await one.evaluate((element) => element.scrollWidth - element.clientWidth)
        expect(scroll).toBeLessThanOrEqual(0)
      }
      // Every tool on show is whole inside its bar; the note's buttons inside the head.
      for (const tool of await bar.locator('[data-tool]').all()) await inside(frame, tool)
      await inside(head, pane.getByTestId('note-menu'))
      const more = await bar.getByTestId('tool-more').count()
      report.push(`${await pane.getAttribute('data-side')}: rows ${box.rows}, more ${more}`)
      // "More" only where not even two rows hold the tools: two rows in use, or a side too narrow for the text style.
      if (more) expect(box.rows === '2' || (await bar.locator('#nn-text-style').count()) === 0).toBe(true)
    }
    const left = page.locator('[data-testid="tab-pane"][data-side="left"]')
    if (await left.isVisible()) {
      await expect(left.getByTestId('presence-own')).toBeVisible()
      await inside(left.getByTestId('editor-head'), left.getByTestId('presence-own'))
    }
    test.info().annotations.push({ type: 'toolbar', description: report.join('; ') })
    console.log(`toolbar ${width}: ${report.join('; ')}`)
    await other.close()
  })
}

for (const width of [1440, 1280]) {
  test(`NOTES-3 EC-11 one note at ${width} px: every tool on show in one or two rows, no "More"`, async ({ page }) => {
    const made = await page.request.post('/api/notes', { data: { title: `Alone ${width}`, markdown: 'text' }, headers: TAB })
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/notes/${(await made.json()).id}`)
    const head = page.getByTestId('editor-head')
    const bar = head.getByTestId('toolbar')
    await expect(bar.locator('[data-tool]').first()).toBeVisible()
    await expect(bar.getByTestId('tool-more')).toHaveCount(0)
    await expect(bar.locator('button[data-tool]')).toHaveCount(19)
    const box = await bar.evaluate((element) => ({ height: element.getBoundingClientRect().height, scroll: element.scrollWidth - element.clientWidth }))
    expect(box.height).toBeLessThan(2 * 34 + 4 + 4)
    expect(box.scroll).toBeLessThanOrEqual(0)
    for (const tool of await bar.locator('[data-tool]').all()) await inside(head, tool)
    await inside(head, head.getByTestId('note-menu'))
    // Typing does not change the bar: the text below does not move.
    const before = await bar.boundingBox()
    await page.getByTestId('note-body').click()
    await page.keyboard.type(' and more words')
    expect(await bar.boundingBox()).toEqual(before)
  })
}

test('NOTES-3 EC-11 on a phone the tools stand in one row above the keyboard that scrolls sideways, never cut off', async ({ page }) => {
  const made = await page.request.post('/api/notes', { data: { title: 'Phone tools', markdown: 'text' }, headers: TAB })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/notes/${(await made.json()).id}`)
  await expect(page.getByTestId('note-title')).toHaveValue('Phone tools')
  await expect(page.getByTestId('editor-head').getByTestId('toolbar')).toBeHidden()
})
