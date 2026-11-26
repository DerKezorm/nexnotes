/**
 * NOTES-20 in a real browser against the real server: a key (since the module mcp again an MCP key made by hand in the
 * card "AI tools (MCP)"; API tokens no longer offer "Also for AI tools") made under Settings, Connections, shown once
 * with
 * "Copy", listed with its right and last use and revoked (AC-1, AC-5, AC-9); a note an AI tool makes over MCP lands
 * in the inbox with where it came from and "check title" (AC-4, AC-6); a program connects through the consent page
 * (AC-7). The page is the operator of global-setup.ts. The tool is played by `page.request`, which sends no `Origin`,
 * as MCP clients do not.
 */
import { createHash, randomBytes } from 'node:crypto'

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-mcp000000' }

async function rpc(request: APIRequestContext, token: string, method: string, params?: Record<string, unknown>) {
  return request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function tool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const answer = await rpc(request, token, 'tools/call', { name, arguments: args })
  expect(answer.status()).toBe(200)
  const result = (await answer.json()).result
  expect(result.isError, result.content[0].text).toBe(false)
  return result.structuredContent as Record<string, unknown>
}

async function makeKey(page: Page, name: string, level: 'read' | 'write'): Promise<string> {
  const made = await page.request.post('/api/tokens', { data: { name, level, mcp: true }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).token as string
}

test('NOTES-20 AC-1 AC-5 AC-9 a key is made with a name and a right, shown once, listed and revoked', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const name = `E2E key ${Date.now()}`
  // The card "AI tools (MCP)" of the shared key module: an MCP key by hand (module mcp, decision 6). A new API key no
  // longer offers "Also for AI tools (MCP)".
  await page.goto('/settings/connections')
  await page.getByTestId('api-keys-new').click()
  await expect(page.getByTestId('key-option-mcp')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('tools-new').click()
  await page.getByTestId('key-name').fill(name)
  await page.getByTestId('key-right-write').click()
  await page.getByTestId('key-submit').click()
  await expect(page.getByTestId('key-made')).toContainText(name)
  const token = (await page.getByTestId('key-secret').locator('input').inputValue()).trim()
  expect(token).toMatch(/^nn_mcp_/)
  const copy = page.getByTestId('key-secret').getByRole('button', { name: 'Copy' })
  await copy.click()
  await expect(page.getByTestId('key-secret').getByRole('button', { name: 'Copied' })).toBeVisible()
  // The key works, and its use shows in the list.
  expect((await rpc(page.request, token, 'ping')).status()).toBe(200)
  await page.reload()
  await expect(page.getByTestId('key-made')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(token)
  const keys = page.locator('[data-card="ai-tools"] [data-testid="tools-keys"] tr[data-testid="key-row"]')
  const row = keys.filter({ hasText: name })
  await expect(row).toContainText('Read and write')
  await expect(row).not.toContainText('never')
  await row.getByTestId('key-revoke').click()
  await page.getByTestId('key-revoke-dialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(keys.filter({ hasText: name })).toHaveCount(0)
  expect((await rpc(page.request, token, 'ping')).status()).toBe(401)
})

test('NOTES-20 AC-4 AC-6 a note an AI tool makes lands in the inbox, says where it came from and asks to check its title', async ({ page }) => {
  const name = `E2E tool ${Date.now()}`
  const token = await makeKey(page, name, 'write')
  const made = await tool(page.request, token, 'create_note', { text: 'Shopping list from the chat\n\n- [ ] pasta\n- [ ] basil' })
  await page.goto('/inbox')
  // The inbox is a list like every other: each note a box with its id.
  const card = page.locator('[data-testid="note-list"] [data-note]').filter({ hasText: 'Shopping list from the chat' })
  await expect(card).toBeVisible()
  await expect(card).toContainText(name)
  await expect(card.getByTestId('inbox-origin-icon')).toHaveAttribute('data-origin', 'mcp')
  await expect(card).toContainText('Check title')
  // Ticked over MCP: the note open in the browser follows.
  await page.goto(`/notes/${made.id as string}`)
  await expect(page.getByTestId('note-body')).toContainText('pasta')
  await tool(page.request, token, 'check_item', { note_id: made.id, index: 0, text: 'pasta' })
  await expect(page.locator('[data-checked="true"]').first()).toBeVisible()
})

test('NOTES-20 AC-7 a program connects through the consent page with read only or read and write', async ({ page }) => {
  const redirect = 'http://127.0.0.1:9/callback'
  const registered = await page.request.post('/api/oauth/register', { data: { client_name: 'E2E program', redirect_uris: [redirect] } })
  expect(registered.status()).toBe(201)
  const clientId = (await registered.json()).client_id as string
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  // The program's own address is not there in the test: it answers here.
  await page.route('http://127.0.0.1:9/**', (route) => route.fulfill({ status: 200, body: 'connected' }))
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e' })
  await page.goto(`/oauth/authorize?${query}`)
  await expect(page.getByTestId('mcp-consent')).toContainText('E2E program')
  await page.getByTestId('consent-level-write').click()
  await page.getByTestId('consent-allow').click()
  await page.waitForURL(/127\.0\.0\.1:9\/callback/)
  const back = new URL(page.url())
  expect(back.searchParams.get('state')).toBe('e2e')
  const traded = await page.request.post('/api/oauth/token', {
    form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: clientId, redirect_uri: redirect, code_verifier: verifier },
  })
  expect(traded.status()).toBe(200)
  const access = (await traded.json()).access_token as string
  const listed = await rpc(page.request, access, 'tools/list')
  const names = ((await listed.json()).result.tools as { name: string }[]).map((each) => each.name)
  expect(names).toContain('create_note')
  await page.goto('/settings/connections')
  // Under "Connected programs" of the card "AI tools (MCP)", apart from the API keys (NOTES-25 AC-4).
  const programs = page.locator('[data-card="ai-tools"] [data-testid="tools-programs"] tr[data-testid="key-row"]')
  const row = programs.filter({ hasText: 'E2E program' })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-program', 'true')
  await row.getByTestId('key-revoke').click()
  await page.getByTestId('key-revoke-dialog').getByRole('button', { name: 'Revoke' }).click()
  // Revoked once the server said so (the row is gone), not while the request is still on its way.
  await expect(programs.filter({ hasText: 'E2E program' })).toHaveCount(0)
  expect((await rpc(page.request, access, 'ping')).status()).toBe(401)
})
