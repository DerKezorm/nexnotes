/**
 * B7: the page never grows below the window. The frame of the app has a fixed height and scrolls inside; hidden texts
 * (`sr-only`, absolute) used to hang on the page instead and made it taller, with an empty strip and a second scroll bar
 * in the settings (the copy rows of the addresses for AI tools and API keys sit far down there).
 */
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1280, height: 600 } })

for (const path of ['/settings/connections', '/settings/account', '/']) {
  test(`B7 ${path}: the page is no taller than the window`, async ({ page }) => {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    if (path === '/settings/connections') await expect(page.getByTestId('api-keys-address')).toBeAttached()
    const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, window: innerHeight }))
    expect(sizes.page).toBeLessThanOrEqual(sizes.window)
  })
}
