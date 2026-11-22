/**
 * NOTES-26 in a real browser against the real server: a member of its own (so that the operator's lists stay as the
 * other tests expect them) makes the guide under Settings › Appearance, finds the folder "Guide" with its subjects in
 * the sidebar, opens a note of it and sees its picture, a real checklist and where it came from in the history. The
 * test server runs with the guide switched off for new accounts (`NEXNOTES_GUIDE=0`); the button works all the same.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-guide0000' }

async function member(page: Page, browser: Browser): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'en-US' })
  const email = `guide-${Date.now().toString(36)}@example.com`
  const made = await context.request.post(`/api/invite/${token}`, { data: { display_name: 'Guide Reader', email, password: 'a long e2e member password' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return context
}

test('NOTES-26 AC-3 AC-4 AC-8 make the guide again: a folder with subjects, notes with pictures, from nexnotes', async ({ page, browser }) => {
  const context = await member(page, browser)
  const reader = await context.newPage()
  await reader.goto('/settings/appearance')
  await reader.getByTestId('guide-make').click()
  await expect(reader.getByTestId('guide-made')).toContainText('“Guide” is ready.')
  await reader.getByTestId('guide-made').getByRole('link').click()
  await expect(reader).toHaveURL(/\/folder\//)
  await expect(reader.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible()

  // Its subjects as subfolders, in the guide's order.
  const tree = await (await context.request.get('/api/folders')).json()
  const root = tree.folders.find((folder: { name: string; parent_id: string | null }) => folder.name === 'Guide' && !folder.parent_id)
  const subjects = tree.folders.filter((folder: { parent_id: string | null }) => folder.parent_id === root.id)
  expect(subjects.map((folder: { name: string }) => folder.name).slice(0, 2)).toEqual(['Getting started', 'Writing'])

  // The welcome note: a picture that loads, a checklist to tick off.
  await reader.goto(`/folder/${subjects[0].id}`)
  await reader.getByTestId('note-list').getByText('Welcome to nexnotes', { exact: true }).first().click()
  const picture = reader.getByTestId('note-body').locator('img').first()
  await expect(picture).toBeVisible()
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(100)
  const box = reader.getByTestId('note-body').getByRole('checkbox').first()
  await expect(box).not.toBeChecked()
  await box.check()
  await expect(box).toBeChecked()

  // The history names nexnotes, not the member.
  const notes = await (await context.request.get(`/api/notes?folder_id=${subjects[0].id}`)).json()
  const welcome = notes.find((note: { title: string }) => note.title === 'Welcome to nexnotes')
  await reader.goto(`/notes/${welcome.id}/history`)
  await expect(reader.getByTestId('history-item').first()).toContainText('nexnotes · Guide')

  // A second time: next to the first, under a name of its own.
  await reader.goto('/settings/appearance')
  await reader.getByTestId('guide-make').click()
  await expect(reader.getByTestId('guide-made')).toContainText('“Guide (2)” is ready.')
  await context.close()
})
