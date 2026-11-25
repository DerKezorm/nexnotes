/**
 * The sheet of a note: its own surface, another color than the page around it, light and dark; the title a field
 * without a box. Shots for the eye under test-results/sheet-*.png.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-sheet0000' }

/** Light or dark is the account's since konten 1.1.0 (every device); the browser's value only paints the first frame. */
async function theme(page: Page, scheme: string): Promise<void> {
  expect((await page.request.put('/api/me/theme', { data: { theme: scheme }, headers: TAB })).ok()).toBe(true)
  await page.addInitScript((mode) => localStorage.setItem('nexnotes.theme', mode), scheme)
}

// The operator's account is shared by every file: back to "as the system" afterwards.
test.afterEach(async ({ page }) => {
  await page.request.put('/api/me/theme', { data: { theme: 'system' }, headers: TAB })
})

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
    await theme(page, scheme)
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

test('NOTES-3 AC-17 each paper is the background of the text, light and dark apart', async ({ page }) => {
  const made = await page.request.post('/api/notes', { data: { title: 'Paper', markdown: 'one\n\ntwo' }, headers: TAB })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 1440, height: 900 })
  const seen: Record<string, string> = {}
  for (const scheme of ['light', 'dark'] as const) {
    await theme(page, scheme)
    for (const paper of ['blank', 'lined', 'grid', 'dots']) {
      expect((await page.request.put(`/api/notes/${id}/paper`, { data: { paper }, headers: TAB })).ok()).toBe(true)
      await page.goto(`/notes/${id}`)
      const sheet = page.getByTestId('note-paper')
      await expect(sheet).toHaveAttribute('data-paper', paper)
      const style = await sheet.evaluate((element) => {
        const css = getComputedStyle(element)
        return { image: css.backgroundImage, size: css.backgroundSize, attachment: css.backgroundAttachment }
      })
      seen[`${scheme} ${paper}`] = style.image
      if (paper === 'blank') expect(style.image).toBe('none')
      else expect(style.attachment).toMatch(/^local(, local)*$/)
      if (paper === 'lined') expect(style.image).toContain('linear-gradient')
      if (paper === 'grid') expect(style.size).toMatch(/^24px 24px(, 24px 24px)*$/)
      if (paper === 'dots') expect(style.image).toContain('radial-gradient')
    }
  }
  expect(seen['light lined']).not.toBe(seen['dark lined'])
})
