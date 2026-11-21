/**
 * The sheet of a note: its own surface, another color than the page around it, light and dark; the title a field
 * without a box. Shots for the eye under test-results/sheet-*.png.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-sheet0000' }

async function colors(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="note-page"]')!
    let around: Element | null = sheet.parentElement
    let background = 'rgba(0, 0, 0, 0)'
    while (around && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(around).backgroundColor
      around = around.parentElement
    }
    if (background === 'rgba(0, 0, 0, 0)') background = getComputedStyle(document.body).backgroundColor
    const title = getComputedStyle(document.querySelector('[data-testid="note-title"]')!)
    return { sheet: getComputedStyle(sheet).backgroundColor, page: background, titleBox: [title.borderTopWidth, title.borderLeftWidth, title.borderRightWidth] }
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the sheet stands out from the page, ${scheme}`, async ({ page }) => {
    const made = await page.request.post('/api/notes', { data: { title: `Sheet ${scheme}`, markdown: 'Some text on the sheet.' }, headers: TAB })
    const id = (await made.json()).id as string
    await page.emulateMedia({ colorScheme: scheme })
    await page.addInitScript((mode) => localStorage.setItem('nexnotes.theme', mode), scheme)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/notes/${id}`)
      await expect(page.getByTestId('note-title')).toHaveValue(`Sheet ${scheme}`)
      const seen = await colors(page)
      expect(seen.sheet, JSON.stringify(seen)).not.toBe(seen.page)
      expect(seen.titleBox).toEqual(['0px', '0px', '0px'])
      if (width > 768) expect(seen.sheet).toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(22, 22, 29)')
      await page.screenshot({ path: `test-results/sheet-${scheme}-${width}.png` })
    }
  })
}
