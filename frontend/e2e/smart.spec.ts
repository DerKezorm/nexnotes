/**
 * NOTES-7 Intelligente Ordner in a real browser: the two every new account gets in the section "Smart" (AC-7, AC-8),
 * making one with conditions and the preview beside them (AC-1 to AC-3), opening it as a list or tiles kept over a
 * reload (AC-4), saving one from the search and from a tag's page (AC-5, NOTES-9 AC-6, NOTES-5 AC-6), deleting with a
 * question while the notes stay (AC-6), the order by dragging (AC-8), a folder of a condition deleted (EC-1), nothing
 * that fits (EC-2), and "New note" from a smart folder going into the inbox (NOTES-4 AC-9).
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-smart0000' }

async function folder(page: Page, name: string): Promise<string> {
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

async function note(page: Page, title: string, markdown: string, folderId?: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown, ...(folderId ? { folder_id: folderId } : {}) }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

async function smartFolder(page: Page, name: string, conditions: unknown[], match = 'all'): Promise<string> {
  const made = await page.request.post('/api/smart-folders', { data: { name, match, conditions }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

test('NOTES-7 AC-7 AC-8 a new account has "Open checklists", "Recently edited", "Shared with me" and "Attachments" in the section Smart, after the folders', async ({ page, browser }) => {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const accepted = await context.request.post(`/api/invite/${token}`, {
    data: { display_name: 'Smart Member', email: `smart-${Date.now()}@example.com`, password: 'a long e2e member password' },
    headers: TAB,
  })
  expect(accepted.ok()).toBe(true)
  const member = await context.newPage()
  await member.setViewportSize({ width: 1400, height: 900 })
  await member.goto('/')
  const section = member.getByTestId('sidebar-smart')
  await expect(section.getByRole('heading', { name: 'Smart' })).toBeVisible()
  await expect(section.getByTestId('sidebar-smart-folder')).toHaveText(['Open checklists', 'Recently edited', 'Shared with me', 'Attachments'])
  // The last two took the place of the sidebar's fixed entries and keep their symbols.
  await expect(section.getByTestId('smart-filter-icon')).toHaveCount(2)
  await expect(section.getByTestId('smart-icon-shared_with_me')).toHaveCount(1)
  await expect(section.getByTestId('smart-icon-attachments')).toHaveCount(1)
  // In the sidebar's order: after the folders, before the tags.
  const order = await member.getByTestId('sidebar-places').evaluate((places) =>
    Array.from(places.querySelectorAll('[data-testid="sidebar-smart"], [data-testid="sidebar-tags"], [role="tree"]')).map(
      (element) => element.getAttribute('data-testid') ?? 'folders',
    ),
  )
  expect(order.indexOf('sidebar-smart')).toBeGreaterThan(order.indexOf('folders'))
  // Open checklists finds a note with an open item.
  await member.request.post('/api/notes', { data: { title: 'Shopping', markdown: '- [ ] milk' }, headers: TAB })
  await section.getByText('Open checklists').click()
  await expect(member.getByTestId('note-row').filter({ hasText: 'Shopping' })).toBeVisible()
  await context.close()
})

test('NOTES-7 AC-1 AC-2 AC-3 AC-4 made with conditions and a preview, its sort kept over a reload', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const recipes = await folder(page, `Recipes ${stamp}`)
  await note(page, `Lentil soup ${stamp}`, `#try${stamp}\n\n- [ ] lentils\n- [x] stock`, recipes)
  await note(page, `Shakshuka ${stamp}`, `#try${stamp}`, recipes)
  await note(page, `Shopping ${stamp}`, '- [ ] milk')
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto('/')
  await page.getByTestId('sidebar-smart-new').click()
  await expect(page).toHaveURL(/\/smart\/new$/)
  await page.getByTestId('smart-name').fill(`To try ${stamp}`)
  await page.getByTestId('smart-tag').fill(`#try${stamp}`)
  await expect(page.getByTestId('smart-preview-count')).toHaveText('Fits right now: 2 notes')
  await page.getByTestId('smart-add').click()
  await page.getByTestId('smart-kind').last().selectOption('tasks')
  await expect(page.getByTestId('smart-preview-count')).toHaveText('Fits right now: 1 note')
  await expect(page.getByTestId('smart-preview-item')).toHaveCount(1)
  await page.getByTestId('smart-match-any').click()
  await expect(page.getByTestId('smart-preview-count')).not.toHaveText('Fits right now: 1 note')
  await page.getByTestId('smart-match-all').click()
  await page.getByTestId('smart-save').click()
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('note-row')).toHaveCount(1)
  await expect(page.getByTestId('note-row').first()).toContainText(`Lentil soup ${stamp}`)
  // Sorted by title, kept on the server: still so after a reload.
  await page.getByTestId('list-view').click()
  await page.getByTestId('list-sort-title').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('list-state')).toHaveText('Title A to Z')
  await page.reload()
  await expect(page.getByTestId('list-state')).toHaveText('Title A to Z')
  // Always the state of now: a second recipe with an open item shows up without touching the folder.
  await note(page, `Pancakes ${stamp}`, `#try${stamp}\n\n- [ ] eggs`)
  await expect(page.getByTestId('note-row')).toHaveCount(2, { timeout: 15_000 })
  // A note opens beside the list (NOTES-8 AC-9).
  await page.getByTestId('note-row').first().click()
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}\?note=/)
})

test('NOTES-7 AC-5 NOTES-9 AC-6 "Save as smart folder" on the search makes one with exactly its conditions', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await note(page, `Invoice tiles ${stamp}`, `bathroom #bath${stamp}`)
  await note(page, `Invoice kitchen ${stamp}`, 'kitchen')
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(`/search?q=${encodeURIComponent(`invoice ${stamp}`)}&tag=bath${stamp}&period=week`)
  await expect(page.getByTestId('search-count')).toHaveText('1 result')
  await page.getByTestId('search-save-smart').click()
  await expect(page).toHaveURL(/\/smart\/new$/)
  await expect(page.getByTestId('smart-kind')).toHaveCount(3)
  await expect(page.getByTestId('smart-preview-count')).toHaveText('Fits right now: 1 note')
  await page.getByTestId('smart-save').click()
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('note-row')).toHaveCount(1)
  await expect(page.getByTestId('sidebar-smart-folder').filter({ hasText: `invoice ${stamp}` })).toBeVisible()
})

test('NOTES-7 AC-5 NOTES-5 AC-6 EC-6 "Save as smart folder" on a tag page opens "#tag"; a second time the name is taken', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await note(page, `Garden ${stamp}`, `#plant${stamp}`)
  await note(page, `Balcony ${stamp}`, `#Plant${stamp}`)
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(`/tags/plant${stamp}`)
  await page.getByTestId('tag-smart').click()
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('note-row')).toHaveCount(2)
  await page.goto(`/tags/plant${stamp}`)
  await page.getByTestId('tag-smart').click()
  await expect(page.getByText(`There is already a smart folder named “#plant${stamp}”`, { exact: false })).toBeVisible()
})

test('NOTES-7 AC-6 deleting asks once and leaves every note; EC-1 a deleted folder is named; EC-2 nothing fits', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const kitchen = await folder(page, `Kitchen ${stamp}`)
  await note(page, `Soup ${stamp}`, 'hot', kitchen)
  const id = await smartFolder(page, `Kitchen notes ${stamp}`, [{ kind: 'folder', op: 'tree', id: kitchen, name: `Kitchen ${stamp}` }])
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(`/smart/${id}`)
  await expect(page.getByTestId('note-row')).toHaveCount(1)
  // The folder goes into the trash: the smart folder says which condition points nowhere and offers to edit.
  expect((await page.request.delete(`/api/folders/${kitchen}`, { headers: TAB })).ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('smart-broken')).toContainText(`The folder “Kitchen ${stamp}” of a condition was deleted.`)
  await expect(page.getByTestId('smart-empty')).toContainText('No note fits right now')
  await expect(page.getByTestId('smart-condition')).toHaveText([`in “Kitchen ${stamp}” with subfolders`])
  await page.getByTestId('smart-broken-edit').click()
  await expect(page).toHaveURL(new RegExp(`/smart/${id}/edit$`))
  await page.goBack()
  // Deleting asks once (from the "…" in the head), goes without the trash, the notes stay.
  await page.getByTestId('smart-more').click()
  await page.getByTestId('smart-delete-open').click()
  await expect(page.getByTestId('smart-delete')).toContainText('The notes in it stay where they are.')
  await page.getByTestId('smart-delete-confirm').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('sidebar-smart-folder').filter({ hasText: `Kitchen notes ${stamp}` })).toHaveCount(0)
  expect((await page.request.get(`/api/smart-folders/${id}`, { headers: TAB })).status()).toBe(404)
})

test('NOTES-7 AC-8 the order of the smart folders follows dragging and stays after a reload', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await smartFolder(page, `First ${stamp}`, [{ kind: 'pinned' }])
  await smartFolder(page, `Second ${stamp}`, [{ kind: 'pinned' }])
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto('/')
  const links = page.getByTestId('sidebar-smart-folder')
  await links.filter({ hasText: `Second ${stamp}` }).dragTo(links.filter({ hasText: `First ${stamp}` }))
  const names = async () => (await links.allTextContents()).filter((name) => name.endsWith(stamp))
  await expect.poll(names).toEqual([`Second ${stamp}`, `First ${stamp}`])
  await page.reload()
  await expect.poll(names).toEqual([`Second ${stamp}`, `First ${stamp}`])
  // The keyboard does the same: Alt + arrow up.
  await links.filter({ hasText: `First ${stamp}` }).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(names).toEqual([`First ${stamp}`, `Second ${stamp}`])
})

test('NOTES-4 AC-9 NOTES-7 "New note" in a smart folder goes into the inbox', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const id = await smartFolder(page, `Recent ${stamp}`, [{ kind: 'date', field: 'updated', period: 'today' }])
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(`/smart/${id}`)
  await page.getByTestId('new-note').click()
  await expect(page).toHaveURL(new RegExp(`/smart/${id}\\?note=`))
  const noteId = new URL(page.url()).searchParams.get('note')!
  const made = await page.request.get(`/api/notes/${noteId}`, { headers: TAB })
  const inbox = (await (await page.request.get('/api/folders', { headers: TAB })).json()).inbox.id
  expect((await made.json()).folder_id).toBe(inbox)
})
