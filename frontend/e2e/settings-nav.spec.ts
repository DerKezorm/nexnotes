/**
 * NOTES-2 AC-9 in real browsers: the settings in areas. The operator sees both groups of the navigation, a member only
 * "My account" (and lands on the profile from a server address), the addresses of the tabs before lead to their area,
 * and a narrow page has a choice instead of the navigation. Run centrally, never by an agent.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-settnav00' }

async function member(page: Page, browser: Browser): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `settings-nav-${Date.now()}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: 'Nav Member', email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return context
}

test('NOTES-2 AC-9 the operator sees both groups, each area at its own address', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav')
  await expect(nav).toBeVisible()
  await expect(nav.getByText('My account', { exact: true })).toBeVisible()
  await expect(nav.getByText('Server', { exact: true })).toBeVisible()
  await expect(page.getByTestId('settings-jump')).toBeHidden()
  for (const name of ['Profile', 'Security', 'Appearance', 'Connections', 'General', 'Sign-in', 'Mail', 'Storage and backups', 'Text recognition', 'Accounts', 'Log']) {
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible()
  }
  await expect(nav.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page')
  await nav.getByRole('link', { name: 'Storage and backups', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/storage$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Storage and backups')
  await expect(page.locator('#backups')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Storage and backups', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Profile', exact: true })).not.toHaveAttribute('aria-current', 'page')
  // "About nexnotes" is an area of the settings: the navigation stays, its entry is marked.
  await nav.getByRole('link', { name: 'About nexnotes' }).click()
  await expect(page).toHaveURL(/\/settings\/about$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('About nexnotes')
  await expect(nav).toBeVisible()
  await expect(nav.getByRole('link', { name: 'About nexnotes' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('about-version')).toBeVisible()
})

test('NOTES-2 AC-9 the old address /about leads to the area in the settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/about')
  await expect(page).toHaveURL(/\/settings\/about$/)
  await expect(page.getByTestId('settings-nav').getByRole('link', { name: 'About nexnotes' })).toHaveAttribute('aria-current', 'page')
})

test('NOTES-2 AC-9 the navigation is reached with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings/security')
  const nav = page.getByTestId('settings-nav')
  await nav.getByRole('link', { name: 'Security', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(nav.getByRole('link', { name: 'Appearance', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings\/appearance$/)
})

test('NOTES-2 AC-9 the addresses of the tabs before lead to their area', async ({ page }) => {
  await page.goto('/settings/server')
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(page.locator('#limits')).toBeVisible()
  for (const kept of ['connections', 'accounts', 'log']) {
    await page.goto(`/settings/${kept}`)
    await expect(page).toHaveURL(new RegExp(`/settings/${kept}$`))
    await expect(page.getByTestId('settings-nav').locator('[aria-current="page"]')).toHaveAttribute('href', `/settings/${kept}`)
  }
})

test('NOTES-2 AC-9 a member sees only My account and lands on the profile from a server address', async ({ page, browser }) => {
  const context = await member(page, browser)
  const own = await context.newPage()
  await own.setViewportSize({ width: 1440, height: 900 })
  await own.goto('/settings')
  const nav = own.getByTestId('settings-nav')
  await expect(nav.getByText('My account', { exact: true })).toBeVisible()
  await expect(nav.getByText('Server', { exact: true })).toHaveCount(0)
  await expect(nav.getByRole('link')).toHaveText(['Profile', 'Security', 'Appearance', 'Connections', 'About nexnotes'])
  for (const asked of ['/settings/server', '/settings/accounts', '/settings/log', '/settings/general']) {
    await own.goto(asked)
    await expect(own).toHaveURL(/\/settings$/)
    await expect(own.getByRole('heading', { level: 1 })).toHaveText('Profile')
  }
  await context.close()
})

test('NOTES-2 AC-9 a narrow page chooses the area above the content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav')).toBeHidden()
  const choice = page.getByTestId('settings-jump')
  await expect(choice).toBeVisible()
  await choice.selectOption('ocr')
  await expect(page).toHaveURL(/\/settings\/ocr$/)
  await expect(page.locator('#ocr')).toBeVisible()
  // Nothing wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
