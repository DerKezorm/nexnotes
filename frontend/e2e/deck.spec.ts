/**
 * NOTES-21 in a real browser against the real server: a key for nexdeck (since NOTES-25 an API token) made under
 * Settings, Connections, the card's
 * reads and a tick from the card arriving in the note open in the browser. nexdeck's server is played by
 * `page.request` with nothing but the key (no cookie of the page counts there, no `Origin` is sent). The card itself
 * is nexdeck's; this checks what nexnotes gives it. The page is the operator of global-setup.ts.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-deck000000' }

async function makeKey(page: Page, name: string, level: 'read' | 'write'): Promise<string> {
  // The card "API keys" of the shared key module (since the settings pass).
  await page.goto('/settings/connections')
  await page.getByTestId('api-keys-new').click()
  await page.getByTestId('key-name').fill(name)
  await page.getByTestId(`key-right-${level}`).click()
  await page.getByTestId('key-submit').click()
  await expect(page.getByTestId('key-made')).toContainText(name)
  const token = (await page.getByTestId('key-secret').locator('input').inputValue()).trim()
  expect(token).toMatch(/^nn_api_/)
  return token
}

test('NOTES-21 AC-1 AC-2 AC-5 a card reads the pinned notes, one checklist, and ticks an item into the open note', async ({ page }) => {
  const name = `E2E kitchen ${Date.now()}`
  const token = await makeKey(page, name, 'write')
  const auth = { Authorization: `Bearer ${token}` }
  const made = await page.request.post('/api/notes', { data: { title: `Shopping ${Date.now()}`, markdown: '- [ ] Milk\n- [ ] Tomatoes\n- [x] Bread' }, headers: TAB })
  const id = (await made.json()).id as string
  expect((await page.request.put(`/api/notes/${id}/pin`, { data: { pinned: true }, headers: TAB })).status()).toBe(200)

  const me = await page.request.get('/api/v1/me', { headers: auth })
  expect((await me.json()).app).toBe('nexnotes')
  const pinned = await (await page.request.get('/api/v1/dashboard', { headers: auth })).json()
  expect(pinned.pinned.map((item: { id: string }) => item.id)).toContain(id)

  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toContainText('Tomatoes')
  const card = await (await page.request.get(`/api/v1/notes/${id}`, { headers: auth })).json()
  expect(card.tasks).toEqual({ done: 1, total: 3 })
  const ticked = await page.request.post(`/api/v1/notes/${id}/items/1`, { data: { checked: true, text: 'Tomatoes' }, headers: auth })
  expect(ticked.status()).toBe(200)
  expect((await ticked.json()).tasks).toEqual({ done: 2, total: 3 })
  // AC-3 from the other side: the open note follows without reloading.
  await expect(page.locator('li[data-checked="true"]')).toHaveCount(2)

  // The last use shows in the list; revoked, the card is turned away at once (EC-3).
  await page.goto('/settings/connections')
  const row = page.locator('[data-card="api-keys"] tr[data-testid="key-row"]').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(row).not.toContainText('never')
  await row.getByTestId('key-revoke').click()
  await page.getByTestId('key-revoke-dialog').getByRole('button', { name: 'Revoke' }).click()
  // Asked once the server confirmed the revoke (the row is gone), not while the request is still on its way.
  await expect(row).toHaveCount(0)
  expect((await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(401)
})

test('NOTES-21 EC-3 a key that only shows cannot tick', async ({ page }) => {
  const token = await makeKey(page, `E2E hall ${Date.now()}`, 'read')
  const made = await page.request.post('/api/notes', { data: { markdown: '- [ ] Milk' }, headers: TAB })
  const id = (await made.json()).id as string
  const refused = await page.request.post(`/api/v1/notes/${id}/items/0`, { data: { checked: true, text: 'Milk' }, headers: { Authorization: `Bearer ${token}` } })
  expect(refused.status()).toBe(403)
  expect((await refused.json()).detail.code).toBe('token_reads_only')
})
