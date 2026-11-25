/**
 * NOTES-2 AC-12 in real browsers: "Sign out" stands in Settings › Profile only, not in the sidebar nor in the settings'
 * navigation; it ends the session and leads to the sign-in page, on a wide screen and on a phone. Each case signs out
 * an account of its own (invited here), never the operator whose session the other files share. The question for
 * changes that still wait is covered by `signOut.test.tsx`. Runs with `npm run e2e`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-signout000' }

async function member(page: Page, browser: Browser, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport })
  const email = `sign-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: `Leaving Member ${email.split('@')[0]}`, email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return context
}

test('NOTES-2 AC-12 "Sign out" in the profile ends the session and shows the sign-in page', async ({ page, browser }) => {
  const context = await member(page, browser, { width: 1440, height: 900 })
  const mine = await context.newPage()
  await mine.goto('/settings/profile')
  // The module's card "Sign out" (konten 1.1.0).
  const card = mine.locator('[data-card="sign-out"]')
  await expect(card).toBeVisible()
  // Only here: the sidebar and the settings' navigation have no way of their own.
  await expect(mine.getByRole('navigation', { name: 'Main menu' }).getByText('Sign out', { exact: true })).toHaveCount(0)
  await expect(mine.getByTestId('settings-nav').getByText('Sign out', { exact: true })).toHaveCount(0)
  await mine.goto('/settings/security')
  await expect(mine.locator('[data-card="sign-out"]')).toHaveCount(0)
  await mine.goto('/settings/profile')
  await mine.getByTestId('sign-out').click()
  await expect(mine).toHaveURL(/\/login/)
  // The session is gone, not only the page: the app asks to sign in again.
  expect((await context.request.get('/api/auth/me')).status()).toBe(401)
  await mine.goto('/')
  await expect(mine).toHaveURL(/\/login/)
  await context.close()
})

test('NOTES-2 AC-12 on a phone the profile in the settings signs out the same way', async ({ page, browser }) => {
  const context = await member(page, browser, { width: 390, height: 844 })
  const mine = await context.newPage()
  await mine.goto('/folders')
  await mine.getByRole('button', { name: 'Open the menu' }).click()
  await mine.getByRole('navigation', { name: 'Main menu' }).last().getByRole('link', { name: /Settings/ }).click()
  await expect(mine).toHaveURL(/\/settings/)
  // The phone shows the list of the areas first (the ui kit's frame): no "Sign out" in it, it is in the profile.
  const list = mine.getByTestId('settings-nav')
  await expect(list).toBeVisible()
  await expect(list.getByText('Sign out', { exact: true })).toHaveCount(0)
  await list.getByRole('link', { name: 'Profile', exact: true }).click()
  await expect(mine).toHaveURL(/\/settings\/profile$/)
  const button = mine.getByTestId('sign-out')
  await button.scrollIntoViewIfNeeded()
  await expect(button).toBeVisible()
  await button.click()
  await expect(mine).toHaveURL(/\/login/)
  expect((await context.request.get('/api/auth/me')).status()).toBe(401)
  await context.close()
})
