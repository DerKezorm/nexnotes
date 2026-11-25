/**
 * NOTES-25 in a real browser against the real server: an API key made under Settings, Connections (the card "API
 * keys" of the shared key module since the settings pass) with folders and a run-out, shown once; a program (played by `page.request`, no cookie counts and no `Origin` is sent) reads notes,
 * one note with Markdown and `etag`, searches, and ticks an item that the note open in the browser shows at once; the
 * description at /api/v1/docs loads without one request to another site; the operator's switch stops the API. The
 * page is the operator of global-setup.ts. A program makes a note, appends and replaces its text while it is open
 * in the browser; the inbox and the history name where it came from.
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
  await page.getByTestId('api-keys-new').click()
  await page.getByTestId('key-name').fill(`E2E program ${stamp}`)
  await page.getByTestId('key-right-write').click()
  await expect(page.getByTestId('key-expiry')).toHaveValue('90')
  await page.getByTestId('key-areas-some').click()
  await page.getByTestId(`key-area-${home}`).check()
  await page.getByTestId('key-submit').click()
  await expect(page.getByTestId('key-made')).toContainText('this once only')
  const token = (await page.getByTestId('key-secret').locator('input').inputValue()).trim()
  expect(token).toMatch(/^nn_api_/)
  const auth = { Authorization: `Bearer ${token}` }
  const row = page.locator('[data-card="api-keys"] tr[data-testid="key-row"]').filter({ hasText: `E2E program ${stamp}` })
  await expect(row).toContainText('Read and write')
  await expect(row).toContainText(`E2E home ${stamp}`)
  await expect(row).toContainText('Expires on')

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
  await row.getByTestId('key-revoke').click()
  await page.getByTestId('key-revoke-dialog').getByRole('button', { name: 'Revoke' }).click()
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
  await expect(page.getByTestId('api-keys-docs')).toHaveAttribute('href', '/api/v1/docs')
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
  // The switch is in the card "Interfaces" of Server › General (the shared key module since the settings pass).
  await page.goto('/settings/general')
  const toggle = page.locator('[data-card="interfaces"]').getByRole('checkbox', { name: 'Programming interface (API) for members' })
  await expect(toggle).toBeChecked()
  // The box follows the server's answer (it is held while the change is on its way).
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(async () => (await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(403)
  await page.goto('/settings/connections')
  await expect(page.getByTestId('api-keys-off')).toBeVisible()
  await expect(page.getByTestId('api-keys-new')).toBeDisabled()
  await page.goto('/settings/general')
  const again = page.locator('[data-card="interfaces"]').getByRole('checkbox', { name: 'Programming interface (API) for members' })
  await again.click()
  await expect(again).toBeChecked()
  await expect.poll(async () => (await page.request.get('/api/v1/me', { headers: auth })).status()).toBe(200)
})

test('NOTES-25 AC-27 the operator sees the token of an account and blocks it', async ({ page }) => {
  const name = `E2E blocked ${Date.now()}`
  const made = await page.request.post('/api/tokens', { data: { name, level: 'read' }, headers: TAB })
  const token = (await made.json()).token as string
  await page.goto('/settings/accounts')
  const row = page.locator('[data-card="all-api-keys"] tr[data-testid="all-keys-row"]').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(page.locator('body')).not.toContainText(token)
  await row.getByTestId('all-keys-block').click()
  await page.getByTestId('all-keys-block-dialog').getByRole('button', { name: 'Lock' }).click()
  await expect(row).toHaveAttribute('data-blocked', 'true')
  await expect(row.getByTestId('all-keys-unblock')).toBeVisible()
  expect((await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401)
  await page.goto('/settings/connections')
  await expect(page.locator('[data-card="api-keys"] tr[data-testid="key-row"]').filter({ hasText: name })).toContainText('Locked by the operator')
})

test('NOTES-25 AC-14 AC-16 AC-17 AC-22 a program makes a note, appends and replaces while it is open', async ({ page }) => {
  const stamp = Date.now()
  const made = await page.request.post('/api/tokens', { data: { name: `E2E weather ${stamp}`, level: 'write' }, headers: TAB })
  const auth = { Authorization: `Bearer ${(await made.json()).token as string}` }
  const ref = `weather-${stamp}`
  const created = await page.request.post('/api/v1/notes', { data: { markdown: `Weather ${stamp}

Sun in the morning`, external_ref: ref }, headers: auth })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  // The same request again: the same note, no second one.
  const again = await page.request.post('/api/v1/notes', { data: { markdown: 'ignored', external_ref: ref }, headers: auth })
  expect(again.status()).toBe(200)
  expect((await again.json()).id).toBe(id)

  await page.goto('/inbox')
  const card = page.locator('[data-testid="note-list"] [data-note]').filter({ hasText: `Weather ${stamp}` })
  await expect(card).toContainText(`Via the API from “E2E weather ${stamp}”`)
  await expect(card.getByTestId('inbox-origin-icon')).toHaveAttribute('data-origin', 'api')

  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toContainText('Sun in the morning')
  expect((await page.request.post(`/api/v1/notes/${id}/append`, { data: { markdown: 'Rain from noon' }, headers: auth })).status()).toBe(200)
  await expect(page.getByTestId('note-body')).toContainText('Rain from noon')
  const state = await (await page.request.get(`/api/v1/notes/${id}`, { headers: auth })).json()
  const replaced = await page.request.put(`/api/v1/notes/${id}/content`, {
    data: { markdown: state.markdown.replace('Rain from noon', 'Snow at night') },
    headers: { ...auth, 'If-Match': `"${state.etag}"` },
  })
  expect(replaced.status()).toBe(200)
  await expect(page.getByTestId('note-body')).toContainText('Snow at night')
  await expect(page.getByTestId('note-body')).not.toContainText('Rain from noon')
  // An older state is refused and changes nothing.
  const stale = await page.request.put(`/api/v1/notes/${id}/content`, { data: { markdown: 'All gone', base: state.etag }, headers: auth })
  expect(stale.status()).toBe(412)
  await expect(page.getByTestId('note-body')).toContainText('Snow at night')
})
