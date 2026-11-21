/**
 * NOTES-25 in a real browser against the real server: an API token made under Settings, Connections with folders and
 * a run-out, shown once; a program (played by `page.request`, no cookie counts and no `Origin` is sent) reads notes,
 * one note with Markdown and `etag`, searches, and ticks an item that the note open in the browser shows at once; the
 * description at /api/v1/docs loads without one request to another site; the operator's switch stops the API. The
 * page is the operator of global-setup.ts. Writing over the API (new notes, append) comes with round 2.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-api0000000' }

async function folder(page: Page, name: string): Promise<string> {
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).id as string
}

test('NOTES-25 AC-1 AC-2 AC-7 AC-8 AC-9 AC-10 a token for one folder reads, searches and ticks into the open note', async ({ page }) => {
  const stamp = Date.now()
  const home = await folder(page, `E2E home ${stamp}`)
  const made = await page.request.post('/api/notes', { data: { title: `Shopping ${stamp}`, markdown: '- [ ] Milk\n- [ ] Basil\n\nfor saturday', folder_id: home }, headers: TAB })
  const id = (await made.json()).id as string
  const outside = await page.request.post('/api/notes', { data: { title: `Elsewhere ${stamp}`, markdown: 'Milk too' }, headers: TAB })
  const elsewhere = (await outside.json()).id as string

  await page.goto('/settings/connections')
  await page.getByTestId('tokens-new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill(`E2E program ${stamp}`)
  await page.getByTestId('token-level-write').check()
  await expect(page.getByTestId('token-days')).toHaveValue('90')
  await page.getByTestId('token-scope-some').check()
  await page.locator(`[data-testid="token-folder"][data-folder="${home}"]`).check()
  await page.getByTestId('token-make').click()
  await expect(page.getByTestId('tokens-made')).toContainText('only this once')
  const token = (await page.getByTestId('tokens-secret').textContent())!.trim()
  expect(token).toMatch(/^nn_api_/)
  const auth = { Authorization: `Bearer ${token}` }
  const row = page.getByTestId('token-row').filter({ hasText: `E2E program ${stamp}` })
  await expect(row.getByTestId('token-meta')).toContainText('read and write · API · 1 folder')
  await expect(row.getByTestId('token-expiry')).toContainText('Expires on')

  const listed = await (await page.request.get('/api/v1/notes', { headers: auth })).json()
  expect(listed.notes.map((note: { id: string }) => note.id)).toEqual([id])
  expect((await page.request.get(`/api/v1/notes/${elsewhere}`, { headers: auth })).status()).toBe(404)
  const one = await page.request.get(`/api/v1/notes/${id}`, { headers: auth })
  const body = await one.json()
  expect(body.markdown).toContain('- [ ] Basil')
  expect(one.headers()['etag']).toBe(`"${body.etag}"`)
  const found = await (await page.request.get('/api/v1/search', { params: { q: 'saturday' }, headers: auth })).json()
  expect(found.notes.map((note: { id: string }) => note.id)).toEqual([id])

  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toContainText('Basil')
  const ticked = await page.request.post(`/api/v1/notes/${id}/items/1`, { data: { checked: true, text: 'Basil' }, headers: auth })
  expect(ticked.status()).toBe(200)
  expect((await ticked.json()).etag).not.toBe(body.etag)
  await expect(page.locator('li[data-checked="true"]')).toHaveCount(1)

  // From a web page: refused, whatever the token.
  const fromPage = await page.request.get('/api/v1/me', { headers: { ...auth, Origin: 'https://evil.example' } })
  expect(fromPage.status()).toBe(403)

  await page.goto('/settings/connections')
  await row.getByTestId('token-revoke').click()
  await page.getByTestId('tokens-revoke-confirm').click()
  await expect(row).toHaveCount(0)
  expect((await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(401)
})

test('NOTES-25 AC-25 the description loads from this server only and offers no Try it out', async ({ page }) => {
  const foreign: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && !url.protocol.startsWith('data')) foreign.push(request.url())
  })
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  await page.goto('/settings/connections')
  await expect(page.getByTestId('tokens-docs')).toHaveAttribute('href', '/api/v1/docs')
  await page.goto('/api/v1/docs')
  await expect(page.locator('.swagger-ui')).toBeVisible()
  await expect(page.locator('.opblock').first()).toBeVisible()
  await page.locator('.opblock').first().click()
  await expect(page.getByRole('button', { name: 'Try it out' })).toHaveCount(0)
  expect(foreign).toEqual([])
  expect(problems.filter((text) => /Content Security Policy|Refused/i.test(text))).toEqual([])
})

test('NOTES-25 AC-5 the operator switches the API off and on again', async ({ page }) => {
  const made = await page.request.post('/api/tokens', { data: { name: `E2E switch ${Date.now()}`, level: 'read' }, headers: TAB })
  const token = (await made.json()).token as string
  const auth = { Authorization: `Bearer ${token}` }
  await page.goto('/settings/general')
  const toggle = page.getByRole('switch', { name: 'API for members' })
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect.poll(async () => (await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(403)
  await page.goto('/settings/connections')
  await expect(page.getByTestId('tokens-off')).toBeVisible()
  await expect(page.getByTestId('tokens-new')).toBeDisabled()
  await page.goto('/settings/general')
  await page.getByRole('switch', { name: 'API for members' }).check()
  await expect.poll(async () => (await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(200)
})

test('NOTES-25 AC-27 the operator sees the token of an account and blocks it', async ({ page }) => {
  const name = `E2E blocked ${Date.now()}`
  const made = await page.request.post('/api/tokens', { data: { name, level: 'read' }, headers: TAB })
  const token = (await made.json()).token as string
  await page.goto('/settings/accounts')
  const row = page.getByTestId('all-token-row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(page.locator('body')).not.toContainText(token)
  await row.getByTestId('all-token-block').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
  await expect(row.getByTestId('all-token-blocked')).toBeVisible()
  expect((await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401)
  await page.goto('/settings/connections')
  await expect(page.getByTestId('token-row').filter({ hasText: name })).toContainText('Blocked by the operator')
})
