/**
 * NOTES-13 Teilen in real browsers against the real server: the operator shares a note with a member (who reads it
 * without a toolbar, finds it under "Shared with me", sees the right taken away while it is open), and a read link
 * opened by somebody without an account (light page, no script, gone once revoked). Runs with `npm run e2e`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-shares000' }

async function member(page: Page, browser: Browser, name: string): Promise<{ context: BrowserContext; id: number }> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const email = `${name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: name, email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  const me = await (await context.request.get('/api/auth/me')).json()
  return { context, id: Number(me.id) }
}

test('NOTES-13 AC-1 AC-3 AC-4 AC-5 shared to read: no toolbar, under "Shared with me", taken back while open', async ({ page, browser }) => {
  // A name of this run only: a Rita of an earlier run (--repeat-each, a server kept) would be found first.
  const name = `Rita ${Date.now().toString(36)}`
  const reader = await member(page, browser, name)
  const note = await (await page.request.post('/api/notes', { data: { title: 'Lentil soup', markdown: '250 g red lentils' }, headers: TAB })).json()
  await page.goto(`/notes/${note.id}`)
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-share').click()
  await expect(page.getByTestId('share-hint')).toHaveText('Only you decide who sees the note. Others cannot share it further.')
  await page.getByTestId('share-search').fill(name)
  await page.getByTestId('share-found').filter({ hasText: name }).click()
  await expect(page.getByTestId('share-person')).toContainText(name)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-shared-mark')).toHaveText(`shared with ${name}`)

  const theirs = await reader.context.newPage()
  await theirs.goto('/shared')
  await expect(theirs.getByTestId('shared-item')).toContainText('Lentil soup')
  await expect(theirs.getByTestId('shared-level')).toHaveText('read')
  await theirs.getByTestId('shared-item').getByRole('link').click()
  await expect(theirs.getByTestId('note-body')).toContainText('250 g red lentils')
  await expect(theirs.locator('[data-testid^="tool-"]')).toHaveCount(0)
  await expect(theirs.getByTestId('note-shared-mark')).toHaveText('from Tester · read only')

  const taken = await page.request.delete(`/api/shares/note/${note.id}/people/${reader.id}`, { headers: TAB })
  expect(taken.ok()).toBe(true)
  // The room refuses at once, the side then says the note is not available any more (NOTES-8 EC-6) and keeps the
  // sentence that names who ended it (AC-5). The editor's own bar stood only until the tab heard the note was gone.
  await expect(theirs.getByTestId('tab-gone')).toContainText('This note is no longer available.', { timeout: 10_000 })
  await expect(theirs.getByTestId('tab-gone-said')).toHaveText('“Lentil soup” is not here any more: Tester stopped sharing it.')
  await reader.context.close()
})

test('NOTES-13 AC-9 AC-12 EC-5 a read link opens light for somebody without an account, with no script, until revoked', async ({ page, browser }) => {
  const note = await (await page.request.post('/api/notes', { data: { title: 'Recipe', markdown: 'Pinch of **cinnamon**' }, headers: TAB })).json()
  await page.goto(`/notes/${note.id}`)
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-share').click()
  await page.getByTestId('share-link-switch').click()
  const url = await page.getByTestId('share-link-url').inputValue()
  expect(url).toMatch(/\/l\/[A-Za-z0-9_-]{43}$/)

  const stranger = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'de-DE', colorScheme: 'dark' })
  const visitor = await stranger.newPage()
  const scripts: string[] = []
  visitor.on('request', (request) => request.resourceType() === 'script' && scripts.push(request.url()))
  await visitor.goto(url)
  await expect(visitor.locator('h1')).toHaveText('Recipe')
  await expect(visitor.locator('header')).toContainText('Geteilt von Tester · nur lesen · gültig bis')
  await expect(visitor.getByText('Als PDF laden')).toBeVisible()
  await expect(visitor.locator('footer')).toHaveText('Erstellt mit nexnotes · selbst gehostet')
  // Light even in a dark browser.
  expect(await visitor.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 245, 248)')
  expect(scripts).toEqual([])

  await page.getByTestId('share-link-revoke').click()
  // Revoked once the server said so: the dialog takes the link away only then. A reload before could still show it.
  await expect(page.getByTestId('share-link-url')).toHaveCount(0)
  await expect(page.getByTestId('share-link-switch')).toHaveAttribute('aria-checked', 'false')
  await visitor.reload()
  await expect(visitor.locator('h1')).toHaveText('Dieser Link gilt nicht mehr')
  await expect(visitor.getByText('Recipe')).toHaveCount(0)
  await stranger.close()
})
