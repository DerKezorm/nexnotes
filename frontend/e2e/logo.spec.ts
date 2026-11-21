/** Shots of the sign-in page and the sidebar with the new mark and the wordmark, light and dark, for the eye. */
import { expect, test } from '@playwright/test'

for (const scheme of ['light', 'dark'] as const) {
  test(`the mark and the wordmark, ${scheme}`, async ({ page, browser }) => {
    await page.addInitScript((mode) => localStorage.setItem('nexnotes.theme', mode), scheme)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await expect(page.getByTestId('wordmark').first()).toHaveText('NEXNOTES')
    await expect(page.getByTestId('logo-mark').first()).toHaveAttribute('data-look', scheme)
    await page.locator('nav').first().screenshot({ path: `test-results/logo-sidebar-${scheme}.png` })
    const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const signIn = await guest.newPage()
    await signIn.addInitScript((mode) => localStorage.setItem('nexnotes.theme', mode), scheme)
    await signIn.goto('/login')
    await expect(signIn.getByTestId('wordmark')).toBeVisible()
    await signIn.screenshot({ path: `test-results/logo-login-${scheme}.png` })
    await guest.close()
  })
}
