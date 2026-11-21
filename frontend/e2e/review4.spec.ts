/**
 * Fourth review: the outline's column stands right beside the sheet, not at the far edge of a wide window, and the two
 * are centred together in the note's side; the info below the outline goes with it.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review400' }

async function note(page: Page, title: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  return (await made.json()).id
}

/** Where the sheet, the outline and the side's room between its paddings stand, in CSS pixels. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null
    const pane = document.querySelector<HTMLElement>('[data-testid="note-pane"]')!
    const style = getComputedStyle(pane)
    const box = pane.getBoundingClientRect()
    const sheet = rect('note-page')!
    const outline = rect('outline')
    const info = rect('outline-info')
    return {
      room: { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) },
      sheet: { left: sheet.left, right: sheet.right, width: sheet.width, top: sheet.top },
      outline: outline && { left: outline.left, right: outline.right },
      info: info && { left: info.left, right: info.right },
    }
  })
}

for (const width of [1920, 1440]) {
  test(`NOTES-3 AC-15 at ${width} px the outline stands at most 40 px beside the sheet, the two centred together`, async ({ page }) => {
    const id = await note(page, `Outline beside ${width}`, '# Trip\n\ntext\n\n## Hotel\n\nmore\n\n## Train\n\nat 8')
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/notes/${id}`)
    await expect(page.getByTestId('note-title')).toHaveValue(`Outline beside ${width}`)
    // The sidebar (260) and the list (300) at their defaults: at 1440 px the side keeps about 880 px, inside its
    // padding about 830, enough for the sheet at 560, the gap and the column (824, fourth review).
    const outline = page.getByTestId('outline')
    const room = await page.getByTestId('note-pane').evaluate((pane) => {
      const style = getComputedStyle(pane)
      return pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    })
    test.info().annotations.push({ type: 'room', description: `${room} px inside the side's padding` })
    expect(room, 'the side inside its padding').toBeGreaterThanOrEqual(824)
    await expect(outline).toHaveAttribute('data-mode', 'column')
    await expect(page.getByTestId('outline-heading')).toHaveCount(3)
    const shown = await layout(page)
    const gap = shown.outline!.left - shown.sheet.right
    expect(gap, JSON.stringify(shown)).toBeGreaterThanOrEqual(0)
    expect(gap, JSON.stringify(shown)).toBeLessThanOrEqual(40)
    // Sheet and outline together in the middle of the side: as much room to the left as to the right.
    const before = shown.sheet.left - shown.room.left
    const after = shown.room.right - shown.outline!.right
    expect(before, JSON.stringify(shown)).toBeGreaterThanOrEqual(-1)
    expect(Math.abs(before - after), JSON.stringify(shown)).toBeLessThanOrEqual(2)
    // The info (folder, made, changed) stands in the column, beside the sheet as well.
    expect(shown.info!.left).toBeGreaterThanOrEqual(shown.outline!.left - 1)
    expect(shown.info!.left - shown.sheet.right).toBeLessThanOrEqual(40)

    // Outline off: the sheet stays as it is in width and height, only moves over to stand in the middle alone.
    await page.getByTestId('tool-outline').click()
    await expect(outline).toHaveCount(0)
    const alone = await layout(page)
    expect(Math.abs(alone.sheet.top - shown.sheet.top)).toBeLessThanOrEqual(1)
    if (width === 1920) expect(Math.abs(alone.sheet.width - shown.sheet.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(alone.sheet.left - alone.room.left - (alone.room.right - alone.sheet.right))).toBeLessThanOrEqual(2)
    await page.getByTestId('tool-outline').click()
    await expect(outline).toHaveAttribute('data-mode', 'column')
  })
}

test('NOTES-3 AC-14 AC-15 with the text width "wide" the outline still stands right beside the sheet, inside the side', async ({ page }) => {
  const id = await note(page, 'Outline wide', '# Trip\n\ntext\n\n## Hotel\n\nmore')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto(`/notes/${id}`)
  await page.getByTestId('tool-width').click()
  await page.getByTestId('width-wide').click()
  await expect(page.getByTestId('note-page')).toHaveAttribute('data-width', 'wide')
  await expect(page.getByTestId('outline')).toHaveAttribute('data-mode', 'column')
  const shown = await layout(page)
  const gap = shown.outline!.left - shown.sheet.right
  expect(gap, JSON.stringify(shown)).toBeGreaterThanOrEqual(0)
  expect(gap, JSON.stringify(shown)).toBeLessThanOrEqual(40)
  expect(shown.outline!.right).toBeLessThanOrEqual(shown.room.right + 1)
  expect(shown.sheet.left).toBeGreaterThanOrEqual(shown.room.left - 1)
})
