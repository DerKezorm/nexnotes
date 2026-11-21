/** NOTES-8 AC-3 in a real browser: the list menu of the front note says "already open", a tab behind is gone to. */
import { expect, test } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-tabmenu00' }

test('NOTES-8 AC-3 "Open in a new tab" never seems to do nothing', async ({ page }) => {
  const ids: string[] = []
  for (const title of ['Menu probe one', 'Menu probe two']) {
    const made = await page.request.post('/api/notes', { data: { title, markdown: 'text' }, headers: TAB })
    ids.push((await made.json()).id)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/notes/${ids[0]}`)
  const row = (title: string) => page.getByTestId('note-row').filter({ hasText: title })
  await row('Menu probe one').click({ button: 'right' })
  await expect(page.getByTestId('menu-open-tab')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('menu-open-tab')).toContainText('already open')
  await page.keyboard.press('Escape')
  await row('Menu probe two').click({ button: 'right' })
  await expect(page.getByTestId('menu-open-tab')).toHaveText('Open in a new tab')
  await page.getByTestId('menu-open-tab').click()
  await expect(page.locator('[data-testid="tab"][aria-current="true"]')).toHaveAttribute('data-note', ids[1])
  await row('Menu probe one').click({ button: 'right' })
  await expect(page.getByTestId('menu-open-tab')).toHaveText('Go to tab')
  await page.getByTestId('menu-open-tab').click()
  const back = page.locator(`[data-testid="tab"][data-note="${ids[0]}"]`)
  await expect(back).toHaveAttribute('aria-current', 'true')
  await expect(back).toHaveAttribute('data-pulse', 'true')
})
