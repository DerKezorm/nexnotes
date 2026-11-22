/**
 * NOTES-14 Mitteilungen in a real browser against the real server: the bell of a shared note with its panel (switch,
 * devices, preview), a browser that refuses notifications told where to allow them, a folder's switch from its menu,
 * and a tapped notification's address opening the note at the changed line. Real pushes (a push service, the relay)
 * are the run against the real thing, not this. Runs with `npm run e2e`.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-notify000' }

async function sharedNote(page: Page, title: string, markdown: string): Promise<string> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `nora-${Date.now()}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: 'Nora', email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  const member = await (await context.request.get('/api/auth/me')).json()
  await context.close()
  const note = await (await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })).json()
  const shared = await page.request.put(`/api/shares/note/${note.id}/people/${member.id}`, { data: { level: 'write' }, headers: TAB })
  expect(shared.ok()).toBe(true)
  return String(note.id)
}

test('NOTES-14 AC-1 AC-8 the bell of a shared note: off from the start, on with a tap, devices and preview', async ({ page }) => {
  const id = await sharedNote(page, 'Saturday shopping', '- [ ] Milk\n- [ ] Tomatoes')
  await page.goto(`/notes/${id}`)
  const bell = page.getByTestId('notify-bell')
  await expect(bell).toHaveAttribute('aria-pressed', 'false')
  await bell.click()
  const toggle = page.getByTestId('notify-switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(bell).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('notify-preview')).toContainText('Anna in “Saturday shopping”')
  await expect(page.getByTestId('notify-this-browser')).toContainText('This browser')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('notify-popover')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('notify-bell')).toHaveAttribute('aria-pressed', 'true')
})

test('NOTES-14 EC-3 a browser that refuses notifications is told where to allow them again', async ({ page }) => {
  const id = await sharedNote(page, 'Refused', 'text')
  await page.context().clearPermissions()
  await page.goto(`/notes/${id}`)
  await page.getByTestId('notify-bell').click()
  // Asked only once the panel knows this browser's state: before, "Allow" is not there yet whatever the browser says.
  const here = page.getByTestId('notify-this-browser')
  await expect(here).toHaveAttribute('data-state', /^(off|denied|unsupported)$/)
  if ((await here.getAttribute('data-state')) === 'off') await page.getByTestId('notify-allow').click()
  // Headless Chromium answers the question with no: the panel says so and where to allow them again.
  await expect(here).toHaveAttribute('data-state', 'denied')
  await expect(here).toContainText('not allowed')
  await expect(page.getByTestId('notify-denied-help')).toContainText('Allow them in the site settings')
})

test('NOTES-14 AC-5 the address of a tapped notification opens the note at the changed line', async ({ page }) => {
  const id = await sharedNote(page, 'Jump', '- [ ] Milk\n- [ ] Eggs\n- [ ] Butter')
  await page.goto(`/notes/${id}?change=1`)
  await expect(page.locator('.nn-change-found')).toContainText('Eggs')
})

test('NOTES-14 AC-1 a folder is switched from its menu', async ({ page }) => {
  const name = `Household ${Date.now()}`
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.ok()).toBe(true)
  await page.goto('/')
  await page.getByRole('treeitem', { name: new RegExp(`^${name}, `) }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Notifications …' }).click()
  await expect(page.getByTestId('notify-not-shared')).toBeVisible()
})
