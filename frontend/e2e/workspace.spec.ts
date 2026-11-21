/**
 * NOTES-8 AC-9 in a real browser (second review): the sidebar changes only the list in the middle; the tabs, the text
 * typed in them and their live connections stay. A note of another folder opens in a new tab with the middle button;
 * reloading brings list and note back; the browser's back button changes the list back without closing a tab; an open
 * note without a title is not asked about when only the list changes.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-workspace' }

async function folder(page: Page, name: string): Promise<string> {
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

async function note(page: Page, title: string, folderId: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, folder_id: folderId, markdown }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

const tabTitles = (page: Page) => page.getByTestId('tab-title').allTextContents()

/** The address shows this list with this note beside it (any note when left out). */
const at = (path: string, note?: string) => (url: URL) => url.pathname === path && (note ? url.searchParams.get('note') === note : url.searchParams.has('note'))

test('NOTES-8 AC-9 another folder changes only the list: tabs and text stay, the address names both, reload and back work', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const a = await folder(page, `Police ${stamp}`)
  const b = await folder(page, `Garden ${stamp}`)
  const inA = await note(page, `Report ${stamp}`, a, 'first line')
  const inB = await note(page, `Roses ${stamp}`, b, 'water them')
  await page.setViewportSize({ width: 1600, height: 900 })

  // A note of folder A, opened from its list.
  await page.goto(`/folder/${a}`)
  await page.getByTestId('note-row').filter({ hasText: `Report ${stamp}` }).click()
  await expect(page).toHaveURL(at(`/folder/${a}`, inA))
  const editor = page.locator('[data-testid="tab-pane"] .ProseMirror').first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and more')
  await expect(editor).toContainText('first line and more')

  // Folder B from the sidebar: the list shows B, the tab and its text stay, nothing reloads.
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="tab-pane"] .ProseMirror')
    if (element) (element as HTMLElement).dataset.probe = 'kept'
  })
  await page.getByRole('treeitem', { name: new RegExp(`^Garden ${stamp}, `) }).click()
  await expect(page).toHaveURL(at(`/folder/${b}`, inA))
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', b)
  await expect(page.getByTestId('note-row').filter({ hasText: `Roses ${stamp}` })).toBeVisible()
  expect(await tabTitles(page)).toEqual([`Report ${stamp}`])
  await expect(page.locator('[data-testid="tab-pane"] .ProseMirror[data-probe="kept"]')).toContainText('first line and more')

  // A note of B with the middle button: a new tab, both there.
  await page.getByTestId('note-row').filter({ hasText: `Roses ${stamp}` }).click({ button: 'middle' })
  await expect.poll(() => tabTitles(page)).toEqual([`Report ${stamp}`, `Roses ${stamp}`])
  await expect(page).toHaveURL(at(`/folder/${b}`, inB))

  // Reloading brings back the list and the note.
  await expect(page.getByTestId('note-saved').first()).toHaveText('saved', { timeout: 15_000 })
  await page.reload()
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', b)
  await expect.poll(() => tabTitles(page)).toEqual([`Report ${stamp}`, `Roses ${stamp}`])
  await expect(page.locator('[data-testid="tab-pane"]')).toHaveAttribute('data-note', inB)

  // Back: first the tab used before, beside the same list; then the list of A again. No tab closes.
  await page.goBack()
  await expect(page).toHaveURL(at(`/folder/${b}`, inA))
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', b)
  await page.goBack()
  await expect(page).toHaveURL(at(`/folder/${a}`, inA))
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', a)
  expect(await tabTitles(page)).toEqual([`Report ${stamp}`, `Roses ${stamp}`])

  // "All notes", then the path over the note chooses its folder in the list; the tabs stay.
  await page.getByRole('link', { name: 'All notes' }).click()
  await expect(page).toHaveURL((url) => url.pathname === `/notes/${inA}`)
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', '')
  await page.locator('[data-testid="tab-pane"] [data-testid="note-path"]').click()
  await expect(page).toHaveURL(at(`/folder/${a}`, inA))
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', a)
  expect(await tabTitles(page)).toEqual([`Report ${stamp}`, `Roses ${stamp}`])

  // The search is a list in the middle too.
  await page.getByTestId('sidebar-search').click()
  await expect(page.getByTestId('search-page')).toBeVisible()
  expect(await tabTitles(page)).toEqual([`Report ${stamp}`, `Roses ${stamp}`])
  await page.getByTestId('search-field').fill(`Report ${stamp}`)
  await page.getByTestId('search-hit').first().click()
  await expect(page).toHaveURL(at('/search', inA))
  await expect(page.locator('[data-testid="tab-pane"]')).toHaveAttribute('data-note', inA)
  await expect(page.getByTestId('search-page')).toBeVisible()
})

test('NOTES-3 AC-9 NOTES-8 AC-9 a note without a title is not asked about when only the list changes', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const a = await folder(page, `Ask ${stamp}`)
  const b = await folder(page, `Calm ${stamp}`)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/folder/${a}`)
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('note-title')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.type('text without a title')
  await page.getByRole('treeitem', { name: new RegExp(`^Calm ${stamp}, `) }).click()
  await expect(page).toHaveURL(at(`/folder/${b}`))
  // The folder is empty: its invitation stands in the middle.
  await expect(page.getByTestId('folder-empty')).toBeVisible()
  // Links of the sidebar, the inbox and all notes, change the list too, and ask nothing.
  for (const name of ['Inbox', 'All notes']) {
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: new RegExp(`^${name}`) }).first().click()
    await expect(page.getByTestId('leave-dialog')).toHaveCount(0)
    await expect(page.locator('#nn-title-required')).toHaveCount(0)
  }
  await expect(page).toHaveURL((url) => url.pathname.startsWith('/notes/'))
  await expect(page.locator('[data-testid="tab-pane"] .ProseMirror')).toContainText('text without a title')
  // Closing its tab does ask (NOTES-3 AC-9).
  await page.getByTestId('tab-close').click()
  await expect(page.getByTestId('leave-dialog')).toBeVisible()
})
