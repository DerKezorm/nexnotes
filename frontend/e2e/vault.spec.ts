/**
 * NOTES-16 in a real browser against the real server: set up the vault at the first lock, the note encrypted before
 * it leaves, opened again with the password, written and saved encrypted, a wrong password with its wait, the lock
 * taken off. The page is the operator of global-setup.ts. Each test locks its own note; the vault is the account's,
 * so the first test that runs sets it up and the others use it.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-vault0000' }
const PASSWORD = 'e2e Tresor-Passwort'

async function newNote(page: Page, title: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  expect(made.status()).toBe(201)
  return ((await made.json()) as { id: string }).id
}

async function lock(page: Page, id: string): Promise<void> {
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('note-body')).toBeVisible()
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-lock').click()
  const setup = page.getByTestId('vault-setup')
  if (await setup.isVisible().catch(() => false)) {
    await expect(page.getByTestId('vault-warning')).toContainText('A forgotten password means the content is gone')
    await expect(page.getByTestId('vault-title-hint')).toBeVisible()
    await page.getByTestId('vault-password').fill(PASSWORD)
    await page.getByTestId('vault-repeat').fill(PASSWORD)
    await expect(page.getByTestId('vault-submit')).toBeDisabled()
    await page.getByTestId('vault-understood').check()
  } else {
    await page.getByTestId('vault-password').fill(PASSWORD)
  }
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-lock-dialog')).toBeHidden({ timeout: 20_000 })
}

test('NOTES-16 AC-1 AC-2 AC-3 AC-7 lock, open with the password, write, and the server keeps only ciphertext', async ({ page }) => {
  const secret = `geheim${Date.now()}`
  const id = await newNote(page, 'Tresor e2e', `Kontonummer ${secret}`)
  await lock(page, id)
  const head = await (await page.request.get(`/api/notes/${id}`)).json()
  expect(head.locked).toBe(true)
  const sealed = await page.request.get(`/api/vault/notes/${id}`)
  expect(await sealed.text()).not.toContain(secret)
  // A new page load: the key is gone with the page, the password is asked.
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('locked-note')).toBeVisible()
  await expect(page.getByTestId('locked-title')).toHaveText('Tresor e2e')
  await page.getByTestId('vault-password').fill(PASSWORD)
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('note-body')).toContainText(secret, { timeout: 20_000 })
  await page.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' und mehr')
  await expect(page.getByTestId('note-saved')).toHaveText('Saved', { timeout: 10_000 })
  const after = await page.request.get(`/api/vault/notes/${id}`)
  expect(await after.text()).not.toContain('und mehr')
  // Nothing of the password in the browser's storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(stored).not.toContain(PASSWORD)
})

test('NOTES-16 EC-1 three wrong passwords wait with a countdown', async ({ page }) => {
  const id = await newNote(page, 'Tresor falsch', 'x')
  await lock(page, id)
  await page.goto(`/notes/${id}`)
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByTestId('vault-password').fill(`falsch ${attempt}`)
    await page.getByTestId('vault-submit').click()
    await expect(page.getByTestId('vault-message')).toBeVisible()
  }
  await expect(page.getByTestId('vault-submit')).toHaveText(/Unlock in 0:\d\d/)
  await expect(page.getByTestId('vault-submit')).toBeDisabled()
})

test('NOTES-16 AC-4 the lock comes off and the note is a normal note again', async ({ page }) => {
  const secret = `offen${Date.now()}`
  const id = await newNote(page, 'Tresor auf', secret)
  await lock(page, id)
  await page.goto(`/notes/${id}`)
  await page.getByTestId('vault-password').fill(PASSWORD)
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('note-body')).toContainText(secret, { timeout: 20_000 })
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-unlock').click()
  await page.getByTestId('vault-remove-dialog').getByTestId('vault-password').fill(PASSWORD)
  await page.getByTestId('vault-remove-dialog').getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-remove-dialog')).toBeHidden({ timeout: 20_000 })
  const head = await (await page.request.get(`/api/notes/${id}`)).json()
  expect(head.locked).toBe(false)
  const found = await (await page.request.get('/api/search', { params: { q: secret } })).json()
  expect(found.total).toBe(1)
})

test('NOTES-8 EC-5 a locked note shows the lock in its tab and the password in the note', async ({ page }) => {
  const id = await newNote(page, 'Tresor Tab', 'x')
  await lock(page, id)
  await page.goto(`/notes/${id}`)
  await expect(page.getByTestId('tab-lock')).toBeVisible()
  await expect(page.getByTestId('vault-password')).toBeVisible()
})
