/**
 * NOTES-3 AC-14 and AC-15 in a real browser: the width of the text and the outline beside it, at 2560 and 1280 px.
 */
import { expect, test } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-room00000' }

test('NOTES-3 AC-14 AC-15 width of the text and the outline at 2560 and 1280 px', async ({ page }) => {
  const made = await page.request.post('/api/notes', {
    data: { title: 'Room to write', markdown: '# Trip\n\nBring #passport\n\n## Train\n\nat 8\n\n## Hotel\n\ntwo nights' },
    headers: TAB,
  })
  const id = (await made.json()).id as string
  await page.setViewportSize({ width: 2560, height: 1200 })
  await page.goto(`/notes/${id}`)
  const outline = page.getByTestId('outline')
  await expect(outline).toBeVisible()
  await expect(outline.getByTestId('outline-heading')).toHaveText(['Trip', 'Train', 'Hotel'])
  await outline.getByRole('button', { name: 'Hotel' }).click()
  await expect(page.locator('.nn-editor h2', { hasText: 'Hotel' })).toBeInViewport()

  const article = page.getByTestId('note-page')
  expect(Math.round((await article.boundingBox())!.width)).toBe(760)
  await page.getByTestId('tool-width').first().click()
  await page.getByTestId('width-wide').click()
  expect(Math.round((await article.boundingBox())!.width)).toBe(1100)
  await page.getByTestId('tool-width').first().click()
  await page.getByTestId('width-full').click()
  const full = (await article.boundingBox())!.width
  expect(full).toBeGreaterThan(1500)

  // Narrower: the outline goes by itself, the text keeps the whole width of its side.
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(outline).toBeHidden()
  // Narrower, the width may stand under "More".
  if (await page.getByTestId('tool-width').first().isVisible()) await page.getByTestId('tool-width').first().click()
  else {
    await page.getByTestId('tool-more').first().click()
    await page.getByTestId('more-width').click()
  }
  await page.getByTestId('width-narrow').click()
  expect(Math.round((await article.boundingBox())!.width)).toBeLessThanOrEqual(760)
})
