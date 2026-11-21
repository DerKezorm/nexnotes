/**
 * NOTES-3 AC-1, EC-4, EC-9: "New note" while a new, empty note is open in the same place takes that one (the list
 * stays as it is, the cursor goes into the title); once something is written, a second note comes and stays.
 */
import { expect, test } from '@playwright/test'

test('NOTES-3 AC-1 EC-4 "New note" beside an empty new note: nothing flickers, the title has the cursor', async ({ page, browser }) => {
  const TAB = { 'X-Nexnotes-Client': 'tab-e2e-newnote00' }
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const ok = await context.request.post(`/api/invite/${token}`, { data: { display_name: 'Newnote', email: 'newnote@example.com', password: 'a long e2e member password' }, headers: TAB })
  expect(ok.ok()).toBe(true)
  const member = await context.newPage()
  await member.setViewportSize({ width: 1440, height: 900 })
  await member.goto('/inbox')
  const newNote = member.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'New note' })
  await newNote.click()
  await expect(member.getByTestId('note-title')).toBeFocused()
  const rows = member.getByTestId('note-row')
  await expect(rows).toHaveCount(1)
  const first = member.url()
  // The list is watched for 2 s after the second click: always one row.
  await member.evaluate(() => {
    const seen: number[] = []
    ;(window as { seenRows?: number[] }).seenRows = seen
    const watch = new MutationObserver(() => seen.push(document.querySelectorAll('[data-testid="note-row"]').length))
    watch.observe(document.body, { childList: true, subtree: true })
  })
  await member.getByTestId('note-title').blur()
  await newNote.click()
  await member.waitForTimeout(2000)
  expect(await member.evaluate(() => [...new Set((window as { seenRows?: number[] }).seenRows)].filter((count) => count > 1))).toEqual([])
  await expect(rows).toHaveCount(1)
  expect(member.url()).toBe(first)
  await expect(member.getByTestId('note-title')).toBeFocused()
  // Written into: "New note" makes a second one, and both stay.
  await member.getByTestId('note-title').fill('Shopping')
  await newNote.click()
  await expect(rows).toHaveCount(2)
  await member.waitForTimeout(1500)
  await expect(rows).toHaveCount(2)
  await context.close()
})
