/**
 * The looks of the lists (decision of 21.11.2026): list, cards, compact and tiles, chosen in the menu "Ansicht", one
 * choice of the account for every list, kept over a reload and on another device; at 1440 px and on a phone (390 px).
 * The hints switch off and stay off. A member of its own (invited here), so that the other files keep the list look.
 * Each look leaves a screenshot in the test's output for looking at it by eye. The inbox and the page of a tag are lists
 * like the folders: the same head, the same menu, the same looks, with "File" and where a note lies.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-styles00' }
const STYLES = ['list', 'cards', 'compact', 'tiles'] as const
/** The note's link in each look. */
const LINK = { list: 'note-row', cards: 'note-card', compact: 'note-compact', tiles: 'note-tile' } as const

async function member(page: Page, browser: Browser, name: string): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  expect(invite.status()).toBe(201)
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const accepted = await context.request.post(`/api/invite/${token}`, {
    data: { display_name: name, email: `${name.toLowerCase()}@example.com`, password: 'a long e2e member password' },
    headers: TAB,
  })
  expect(accepted.ok()).toBe(true)
  return context
}

async function fill(page: Page): Promise<string> {
  const folder = (await (await page.request.post('/api/folders', { data: { name: 'Haushalt' }, headers: TAB })).json()).id as string
  const notes: [string, string][] = [
    ['Wocheneinkauf', 'Milch · Brot · Eier\n\n- [x] Milch\n- [ ] Brot\n- [ ] Eier\n\n#einkauf'],
    ['Lasagne', 'Zutaten: 500 g Hackfleisch, 1 Dose Tomaten, Lasagneplatten, Béchamel #essen'],
    ['Putzplan', 'Mo Bad, Mi Küche, Fr Staubsaugen, Sa Fenster'],
    ['Umzugskartons', '- [x] Küche\n- [x] Bad\n- [x] Keller'],
    ['Ein sehr langer Titel einer Notiz, der in keiner Darstellung in eine Zeile passt und abgeschnitten wird', 'Text'],
  ]
  for (const [title, markdown] of notes) {
    const made = await page.request.post('/api/notes', { data: { title, folder_id: folder, markdown }, headers: TAB })
    expect(made.ok()).toBe(true)
  }
  return folder
}

async function choose(page: Page, style: (typeof STYLES)[number]): Promise<void> {
  await page.getByTestId('list-view').click()
  await expect(page.getByTestId('list-view-menu')).toBeVisible()
  await page.getByTestId(`list-style-${style}`).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('list-view-menu')).toHaveCount(0)
  await expect(page.getByTestId('list-view')).toBeFocused()
}

for (const [label, size] of [
  ['1440 px', { width: 1440, height: 900 }],
  ['phone 390 px', { width: 390, height: 844 }],
] as const) {
  test(`every look of the lists at ${label}, kept over a reload and in every list`, async ({ page, browser }, info) => {
    const context = await member(page, browser, label.startsWith('phone') ? 'StylesPhone' : 'StylesWide')
    const own = await context.newPage()
    await own.setViewportSize(size)
    const folder = await fill(own)
    await own.goto(`/folder/${folder}`)
    await expect(own.getByTestId('list-head')).toContainText('Haushalt')
    await expect(own.getByTestId('list-state')).toHaveText('Last changed · grouped by date')
    await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', 'list')
    for (const style of STYLES) {
      await choose(own, style)
      await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', style)
      await expect(own.getByTestId(LINK[style])).toHaveCount(5)
      await expect(own.getByTestId(LINK[style]).filter({ hasText: 'Wocheneinkauf' })).toContainText(style === 'compact' ? '1/3' : '1 of 3')
      // Nothing sticks out sideways, also with the long title.
      const wider = await own.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(wider, style).toBeLessThanOrEqual(0)
      await own.screenshot({ path: info.outputPath(`${style}.png`) })
      // Kept for the account: after a reload, and in "All notes".
      await own.reload()
      await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', style)
      await own.goto('/')
      await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', style)
      await own.goto(`/folder/${folder}`)
    }
    // Tiles stand two side by side on a phone.
    if (label.startsWith('phone')) {
      const [first, second] = await own.getByTestId('note-tile').evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top))
      expect(first).toBe(second)
    }
    // The hints off: no chips, kept over a reload.
    await choose(own, 'list')
    await own.getByTestId('list-view').click()
    await own.getByTestId('list-hints').click()
    await own.keyboard.press('Escape')
    await expect(own.getByTestId('note-hints')).toHaveCount(0)
    await own.reload()
    await expect(own.getByTestId('note-row')).toHaveCount(5)
    await expect(own.getByTestId('note-hints')).toHaveCount(0)
    // Another device of the account sees the same.
    const other = await context.newPage()
    await other.goto(`/folder/${folder}`)
    await expect(other.getByTestId('note-list')).toHaveAttribute('data-style', 'list')
    await expect(other.getByTestId('note-hints')).toHaveCount(0)
    // A group folds shut and stays so on this device.
    await own.getByTestId('list-group-toggle').first().click()
    await expect(own.getByTestId('note-row')).toHaveCount(0)
    await own.reload()
    await expect(own.getByTestId('list-group-toggle').first()).toHaveAttribute('aria-expanded', 'false')
    await context.close()
  })
}

test('the inbox and the page of a tag have the head, the menu "View" and the looks of every list', async ({ page, browser }) => {
  const context = await member(page, browser, 'StylesPlaces')
  const own = await context.newPage()
  await own.setViewportSize({ width: 1440, height: 900 })
  const folder = await fill(own)
  // Two notes caught quickly: in the inbox, one with a tag.
  for (const [title, markdown] of [
    ['Idee Balkon', 'Kräuter im Kasten #einkauf'],
    ['Anruf Werkstatt', 'Reifen wechseln'],
  ]) {
    expect((await own.request.post('/api/notes', { data: { title, markdown }, headers: TAB })).ok()).toBe(true)
  }

  // The inbox: the head every list has, where a note came from, "File" in every look.
  await own.goto('/inbox')
  await expect(own.getByTestId('list-head')).toContainText('Inbox')
  await expect(own.getByTestId('list-head').getByTestId('list-counts')).toHaveText('2 notes')
  for (const style of STYLES) {
    await choose(own, style)
    await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', style)
    await expect(own.getByTestId(LINK[style])).toHaveCount(2)
    await expect(own.locator('[data-note] [data-testid="inbox-origin-icon"]').first()).toHaveAttribute('data-origin', 'here')
    await expect(own.getByTestId('inbox-sort-in')).toHaveCount(2)
    const wider = await own.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(wider, style).toBeLessThanOrEqual(0)
  }
  // The look is the account's: the folder shows tiles too.
  await own.goto(`/folder/${folder}`)
  await expect(own.getByTestId('note-list')).toHaveAttribute('data-style', 'tiles')
  // "File" still files a note, from the tiles.
  await own.goto('/inbox')
  await own.locator('[data-note]').filter({ hasText: 'Anruf Werkstatt' }).getByTestId('inbox-sort-in').click()
  const dialog = own.getByRole('dialog')
  await dialog.getByRole('option').filter({ hasText: 'Haushalt' }).click()
  await dialog.getByRole('button', { name: 'Move to “Haushalt”' }).click()
  await expect(own.getByTestId('note-tile')).toHaveCount(1)
  await expect(own.getByTestId('list-head').getByTestId('list-counts')).toHaveText('1 note')

  // The page of a tag: the same head with "…", the folder of each note, its own sorting.
  await choose(own, 'list')
  await own.goto('/tags/einkauf')
  const head = own.getByTestId('list-head')
  await expect(head.locator('h1')).toHaveText('#einkauf')
  await expect(head.getByTestId('list-counts')).toHaveText('2 notes')
  await expect(own.getByTestId('note-row')).toHaveCount(2)
  await expect(own.getByTestId('note-folder')).toHaveText(['Inbox', 'Haushalt'])
  await own.getByTestId('list-view').click()
  await own.getByTestId('list-sort-title').click()
  await own.getByTestId('list-direction-desc').click()
  await own.keyboard.press('Escape')
  await expect(own.getByTestId('note-row').first()).toContainText('Wocheneinkauf')
  // Kept for this tag on the server.
  await own.reload()
  await expect(own.getByTestId('list-state')).toHaveText('Title Z to A')
  await expect(own.getByTestId('note-row').first()).toContainText('Wocheneinkauf')
  for (const style of STYLES) {
    await choose(own, style)
    await expect(own.getByTestId(LINK[style])).toHaveCount(2)
  }
  await own.getByTestId('tag-more').click()
  await expect(own.getByTestId('tag-menu').getByRole('menuitem')).toHaveText(['Rename', 'Delete', 'Save as smart folder'])
  await own.keyboard.press('Escape')
  await choose(own, 'list')
  await context.close()
})
