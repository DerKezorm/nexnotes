/**
 * NOTES-6 EC-1 in a real browser: "All notes" of an account without notes shows the empty state with its words and
 * "New note", light and dark, wide, narrow and on a phone, and again after the only note (left empty) went away.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-empty0000' }

async function expectEmptyState(page: Page): Promise<void> {
  const empty = page.getByTestId('list-empty')
  await expect(empty).toBeVisible()
  await expect(empty.getByText('No notes yet', { exact: true })).toBeVisible()
  await expect(empty.getByText('What you write shows up here', { exact: false })).toBeVisible()
  await expect(empty.getByTestId('list-empty-new')).toBeVisible()
  await expect(empty.getByTestId('list-empty-new')).toHaveText('New note')
  // The words stand out from the box: not the color of its background.
  const [text, back] = await empty.getByText('No notes yet', { exact: true }).evaluate((element) => {
    const color = getComputedStyle(element).color
    let node: Element | null = element
    let background = 'rgba(0, 0, 0, 0)'
    while (node && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(node).backgroundColor
      node = node.parentElement
    }
    return [color, background]
  })
  expect(text).not.toBe(back)
}

test('NOTES-6 EC-1 all notes of an account without notes show the empty state, light and dark, at every width', async ({ page, browser }) => {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const accepted = await context.request.post(`/api/invite/${token}`, {
    data: { display_name: 'Nobody Yet', email: 'nobody-yet@example.com', password: 'a long e2e member password' },
    headers: TAB,
  })
  expect(accepted.ok()).toBe(true)
  const member = await context.newPage()
  for (const [width, scheme] of [[1600, 'light'], [1600, 'dark'], [900, 'light'], [390, 'dark']] as const) {
    await member.setViewportSize({ width, height: 900 })
    await member.emulateMedia({ colorScheme: scheme })
    await member.goto('/')
    await expectEmptyState(member)
  }
  // A new note left empty goes away again (NOTES-3 EC-4): the empty state is back.
  await member.setViewportSize({ width: 1600, height: 900 })
  await member.getByTestId('list-empty-new').click()
  await expect(member.getByTestId('note-editor')).toBeVisible()
  await member.getByRole('link', { name: 'All notes' }).click()
  await expectEmptyState(member)
  await context.close()
})
