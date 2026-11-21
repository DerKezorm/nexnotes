/**
 * NOTES-15 in a real browser against the real server: on a phone the list of versions stands under the version and
 * takes the whole width. The page is the operator of global-setup.ts.
 */
import { expect, test } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-history0' }

test('NOTES-15 AC-1 on a phone (375 px) the list of versions takes the whole width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  const made = await page.request.post('/api/notes', { data: { title: 'Plan', markdown: 'first idea' }, headers: TAB })
  expect(made.status()).toBe(201)
  const { id } = (await made.json()) as { id: string }
  await page.goto(`/notes/${id}/history`)
  const list = page.getByRole('complementary', { name: 'History' })
  await expect(list).toBeVisible()
  const box = await list.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeLessThanOrEqual(1)
  expect(box!.width).toBeGreaterThanOrEqual(374)
  // Nothing sticks out sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})
