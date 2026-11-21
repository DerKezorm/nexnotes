/**
 * NOTES-6 in real browsers against the real server: the view of a folder and a note changed on another device arrive
 * without reloading the page (AC-1, EC-6), and many notes open with the first row on screen in under a second (the
 * spec's loading time, measured in the page from the start of the navigation), scroll smoothly with only a window of rows in
 * the page, and keep the note at the top of the screen in its place when a new one arrives (EC-2, EC-6).
 *
 * The many notes belong to an account of their own (invited here), so that the other files' lists stay small. An
 * everyday run makes `MANY` of them (500: the window of rows, the loading time and the place on screen are all there,
 * in a minute); the spec's 10,000 come with `NEXNOTES_E2E_MANY=10000` (`npm run e2e:full`), at the end of a stage.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-list0000' }
/** How many notes the long list gets in an everyday run; `NEXNOTES_E2E_MANY` sets another number (10,000 in full). */
const MANY = 500

/** Notes in the page, from the start of the navigation, the moment the first row of a list is drawn (the frame after
 * it entered the page). */
async function watchFirstRow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="note-row"]')) return
      seen.disconnect()
      requestAnimationFrame(() => ((window as { firstRow?: number }).firstRow = performance.now()))
    })
    seen.observe(document, { childList: true, subtree: true })
  })
}

/** Opens `go` and gives the time from the start of the navigation to the first row on screen, in ms. */
async function firstRowAfter(page: Page, go: () => Promise<unknown>): Promise<number> {
  await go()
  await expect(page.getByTestId('note-row').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForFunction(() => (window as { firstRow?: number }).firstRow !== undefined)
  return page.evaluate(() => Math.round((window as { firstRow?: number }).firstRow!))
}

async function secondWindow(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: process.env.NEXNOTES_E2E_STATE })
  return context.newPage()
}

/** A member with a session of its own: invited by the operator, signed in by accepting. */
async function newMember(page: Page, browser: Browser, name: string): Promise<BrowserContext> {
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

test('NOTES-6 AC-1 EC-6 the view of a folder and a change on another device arrive without reloading', async ({ page, browser }) => {
  const made = await page.request.post('/api/folders', { data: { name: 'Haushalt E2E' }, headers: TAB })
  const folderId = (await made.json()).id as string
  const notes: string[] = []
  for (const title of ['Handwerker Bad', 'Sofa ausmessen', 'Urlaub Packliste']) {
    const note = await page.request.post('/api/notes', { data: { title, folder_id: folderId, markdown: '- [x] eins\n- [ ] zwei' }, headers: TAB })
    notes.push((await note.json()).id)
  }
  await page.goto(`/folder/${folderId}`)
  await expect(page.getByTestId('note-row')).toHaveCount(3)
  // Tiles for every list of the account (menu "Ansicht"); the end of the test puts the list back for the other files.
  await page.getByTestId('list-view').click()
  await page.getByTestId('list-style-tiles').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-tile')).toHaveCount(3)
  await expect(page.getByTestId('note-tile').first()).toContainText('1 of 2')

  // The phone opens the same folder: tiles too.
  const phone = await secondWindow(browser)
  await phone.goto(`/folder/${folderId}`)
  await expect(phone.getByTestId('note-tile')).toHaveCount(3)

  // The phone pins a note and renames another; the first window follows on its own.
  await page.evaluate(() => ((window as { stayed?: boolean }).stayed = true))
  await phone.request.put(`/api/notes/${notes[0]}/pin`, { data: { pinned: true }, headers: TAB })
  await phone.request.put(`/api/notes/${notes[1]}/title`, { data: { title: 'Sofa ausgemessen' }, headers: TAB })
  await expect(page.getByTestId('list-group-heading').first()).toHaveText('Pinned', { timeout: 10_000 })
  await expect(page.getByTestId('note-tile').first()).toContainText('Handwerker Bad')
  await expect(page.getByTestId('note-tile').filter({ hasText: 'Sofa ausgemessen' })).toHaveCount(1, { timeout: 10_000 })
  expect(await page.evaluate(() => (window as { stayed?: boolean }).stayed)).toBe(true)
  await phone.context().close()
  expect((await page.request.put('/api/me/list-look', { data: { style: 'list' }, headers: TAB })).ok()).toBe(true)
})

test('NOTES-6 EC-2 EC-6 many notes (10,000 in the full run) open quickly, scroll smoothly and keep their place', async ({ page, browser }) => {
  test.setTimeout(1_200_000)
  const context = await newMember(page, browser, 'Many')
  const many = await context.newPage()
  // MANY notes (10,000 in the full run), 40 at a time.
  const count = Number(process.env.NEXNOTES_E2E_MANY ?? MANY)
  const titles = Array.from({ length: count }, (_, index) => `Notiz ${String(index).padStart(5, '0')}`)
  for (let start = 0; start < titles.length; start += 40) {
    await Promise.all(
      titles.slice(start, start + 40).map((title, offset) =>
        many.request.post('/api/notes', { data: { title, markdown: `Zeile ${start + offset} mit etwas Text, damit die Vorschau etwas zeigt.` }, headers: TAB }),
      ),
    )
  }

  // Loading: the time until the first row is on screen, not only the server's answer. Once with an empty cache (the
  // program comes along), then opened again as on every day after. Measured on a server that has settled after the
  // many writes of the last minutes: one untimed read first (right after the import its answer took twice as long,
  // 0.7 s instead of 0.3 s, which is the import and not the opening of the app).
  expect((await many.request.get('/api/note-list')).ok()).toBe(true)
  await watchFirstRow(many)
  const listed = many.waitForResponse((response) => response.url().includes('/api/note-list?') || response.url().endsWith('/api/note-list'))
  const first = await firstRowAfter(many, () => many.goto('/'))
  const timing = (await listed).request().timing()
  const server = timing.responseEnd - timing.requestStart
  const again: number[] = []
  for (let round = 0; round < 3; round++) again.push(await firstRowAfter(many, () => many.reload()))
  const opened = [...again].sort((a, b) => a - b)[1]
  console.log(`${count} notes: list answer ${Math.round(server)} ms; first row ${first} ms after navigation, opened again ${again.join(' / ')} ms`)
  expect(server).toBeLessThan(1000)
  expect(first).toBeLessThan(1000)
  expect(opened).toBeLessThan(1000)
  await expect(many.getByTestId('list-counts')).toHaveText(`${count} notes`)

  // Scrolling through: every frame quick, never more than a window of rows in the page.
  const frames = await many.evaluate(async () => {
    const list = document.querySelector('[data-testid="note-window"]')!
    let scroller = list.parentElement!
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement!
    const gaps: number[] = []
    let most = 0
    let last = performance.now()
    for (let step = 0; step < 150; step++) {
      scroller.scrollTop += 900
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      gaps.push(now - last)
      last = now
      most = Math.max(most, document.querySelectorAll('[data-testid="note-row"]').length)
    }
    gaps.sort((a, b) => a - b)
    return { p95: gaps[Math.floor(gaps.length * 0.95)], most, top: scroller.scrollTop }
  })
  console.log(`scrolling: 95th percentile frame ${frames.p95.toFixed(1)} ms, at most ${frames.most} rows in the page`)
  expect(frames.top).toBeGreaterThan(Math.min(100_000, count * 62 - 2000))
  expect(frames.p95).toBeLessThan(50)
  expect(frames.most).toBeLessThan(120)

  // Sorted by title at once, from the menu "Ansicht".
  await many.getByTestId('list-view').click()
  await many.getByRole('menuitemradio', { name: 'Title A to Z' }).click()
  await many.keyboard.press('Escape')
  await many.evaluate(() => {
    const list = document.querySelector('[data-testid="note-window"]')!
    let scroller = list.parentElement!
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement!
    scroller.scrollTop = 0
  })
  await expect(many.getByTestId('note-row').first()).toContainText('Notiz 00000')

  // Down the list, a note made on another device lands on top: the rows on screen stay where they are.
  await many.getByTestId('list-view').click()
  await many.getByRole('menuitemradio', { name: 'Last changed' }).click()
  await many.keyboard.press('Escape')
  // Far down the list: 50,000 px with 10,000 notes, the middle of a shorter list.
  const down = await many.evaluate(() => {
    const list = document.querySelector('[data-testid="note-window"]')!
    let scroller = list.parentElement!
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement!
    const target = Math.min(50_000, Math.floor((scroller.scrollHeight - scroller.clientHeight) / 2))
    scroller.scrollTop = target
    return target
  })
  expect(down).toBeGreaterThan(5_000)
  await many.waitForTimeout(500)
  const before = await many.evaluate(() => {
    const list = document.querySelector('[data-testid="note-window"]')!
    let scroller = list.parentElement!
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement!
    const box = scroller.getBoundingClientRect()
    const row = [...document.querySelectorAll<HTMLElement>('[data-note]')].find((element) => element.getBoundingClientRect().top >= box.top + 40)
    return row ? { id: row.dataset.note!, top: row.getBoundingClientRect().top, scrolled: scroller.scrollTop } : null
  })
  expect(before).not.toBeNull()
  expect(before!.scrolled).toBe(down)
  const reloaded = many.waitForResponse((response) => response.url().includes('/api/note-list') && !response.url().includes('stamp'), { timeout: 20_000 })
  await context.request.post('/api/notes', { data: { title: 'Ganz neu' }, headers: TAB })
  await reloaded
  await many.waitForTimeout(300)
  const after = await many.evaluate((id) => document.querySelector<HTMLElement>(`[data-note="${id}"]`)?.getBoundingClientRect().top ?? null, before!.id)
  expect(after).not.toBeNull()
  expect(Math.abs(after! - before!.top)).toBeLessThan(3)
  await context.close()
})
