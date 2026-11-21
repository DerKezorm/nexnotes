/**
 * NOTES-8 in real browsers against the real server: seven tabs opened from a folder's list (Ctrl with a click and the
 * middle button), the oldest one going with a notice, the keys, and all of them back after a reload (AC-3, AC-5,
 * AC-7, EC-7); six tabs with long titles at several widths down to an iPad held upright: narrower tabs first, then two
 * rows, never a scroll bar (AC-8, EC-4), also with two of them side by side; the same note on both sides (EC-1), as
 * an account with an umlaut in its name (NOTES-12: the presence carries it whole); and two accounts in two browser
 * tabs of one browser (the cookie is shared): the second never sees anything of the first.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-tabs0000' }
const LIVE = /\/api\/notes\/[^/]+\/live$/

async function folderWith(page: Page, name: string, titles: string[]): Promise<{ folder: string; notes: string[] }> {
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.status()).toBe(201)
  const folder = (await made.json()).id as string
  const notes: string[] = []
  for (const title of titles) {
    const note = await page.request.post('/api/notes', { data: { title, folder_id: folder, markdown: `About ${title}` }, headers: TAB })
    expect(note.status()).toBe(201)
    notes.push((await note.json()).id)
  }
  return { folder, notes }
}

const row = (page: Page, title: string) => page.getByTestId('note-row').filter({ hasText: title })

const PASSWORD = 'a long e2e member password'

/** A member invited by the operator (`page`), with a browser of its own signed in by accepting. */
async function member(page: Page, browser: Browser, name: string, email: string): Promise<BrowserContext> {
  const invite = await page.request.post('/api/invites', { data: {}, headers: TAB })
  expect(invite.status()).toBe(201)
  const token = String((await invite.json()).link).split('/invite/')[1]
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const accepted = await context.request.post(`/api/invite/${token}`, { data: { display_name: name, email, password: PASSWORD }, headers: TAB })
  expect(accepted.ok(), await accepted.text()).toBe(true)
  return context
}

/** Errors the page itself reports (a message of the live room it could not read, say). */
function pageErrors(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(message.text())
  })
  page.on('pageerror', (error) => seen.push(String(error)))
  return seen
}

test('NOTES-8 AC-3 AC-5 AC-7 EC-7 seven tabs: the oldest goes with a notice, the keys switch, a reload brings them back', async ({ page }) => {
  const titles = ['Tab one', 'Tab two', 'Tab three', 'Tab four', 'Tab five', 'Tab six', 'Tab seven']
  const { folder, notes } = await folderWith(page, `Tabs E2E ${Date.now()}`, titles)
  await page.goto(`/notes/${notes[0]}?folder=${folder}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await expect(page.getByTestId('tab')).toHaveCount(1)
  // Ctrl (⌘) with a click, and the middle button: tabs of nexnotes, not of the browser.
  for (const [index, title] of titles.slice(1, 6).entries()) {
    if (index % 2) await row(page, title).click({ button: 'middle' })
    else await row(page, title).click({ modifiers: ['ControlOrMeta'] })
    await expect(page.getByTestId('tab')).toHaveCount(index + 2)
  }
  expect(page.context().pages()).toHaveLength(1)
  await expect(page.getByTestId('tab-title')).toHaveText(titles.slice(0, 6))
  await expect(page.getByTestId('tab-count')).toHaveText('6 of 6')
  // Keys: the first tab, then the next.
  await page.keyboard.press('Alt+Shift+Digit1')
  await expect(page).toHaveURL(new RegExp(`/notes/${notes[0]}`))
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect(page).toHaveURL(new RegExp(`/notes/${notes[1]}`))
  // The seventh: "Tab three" was not used for the longest ("one" and "two" were just now).
  await row(page, 'Tab seven').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('folder-notice')).toContainText('“Tab three” was closed because 6 tabs were open already.')
  const kept = ['Tab one', 'Tab two', 'Tab seven', 'Tab four', 'Tab five', 'Tab six']
  await expect(page.getByTestId('tab-title')).toHaveText(kept)
  // Beside: "Tab four" on the right.
  await row(page, 'Tab four').click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(page.locator('[data-testid="tab-pane"][data-side="right"]')).toHaveAttribute('data-note', notes[3])
  await expect(page.getByTestId('tab-side')).toHaveText(['left', 'right'])
  await expect(page.getByTestId('note-saved')).toHaveText(['saved', 'saved'])

  // Later, on the same device.
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/notes/${notes[3]}`))
  await expect(page.getByTestId('tab-title')).toHaveText(kept)
  await expect(page.locator('[data-testid="tab-pane"][data-side="left"]')).toHaveAttribute('data-note', notes[6])
  await expect(page.locator('[data-testid="tab-pane"][data-side="right"]')).toHaveAttribute('data-note', notes[3])
})

test('NOTES-8 AC-8 EC-4 six tabs with long titles grow narrower, then stand in two rows, never with a scroll bar', async ({ page }) => {
  const titles = Array.from({ length: 6 }, (_, index) => `A rather long title of a note number ${index + 1} that never fits`)
  const { folder, notes } = await folderWith(page, `Widths E2E ${Date.now()}`, titles)
  const me = (await (await page.request.get('/api/auth/me')).json()) as { id: number }
  await page.goto(`/notes/${notes[0]}?folder=${folder}`)
  await page.evaluate(
    ([account, ids, folderId]) => {
      const tabs = (ids as string[]).map((note, index) => ({ key: `k${index}`, note, folder: folderId, used: index + 1 }))
      localStorage.setItem(`nexnotes.tabs.${account}`, JSON.stringify({ v: 1, tabs, left: 'k0', right: null, focus: 'left', ratio: 0.5, seq: 6 }))
    },
    [me.id, notes, folder] as const,
  )
  await page.goto(`/notes/${notes[0]}?folder=${folder}`)
  await expect(page.getByTestId('tab')).toHaveCount(6)
  await expect(page.getByTestId('tab-title').last()).toHaveText(titles[5])

  const measure = () =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-testid="tab-bar"]') as HTMLElement
      const tabs = [...document.querySelectorAll<HTMLElement>('[data-testid="tab"]')]
      const titles = [...document.querySelectorAll<HTMLElement>('[data-testid="tab-title"]')]
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
        widths: tabs.map((tab) => Math.round(tab.getBoundingClientRect().width)),
        cut: titles.every((title) => title.scrollWidth > title.clientWidth),
        tooltips: tabs.map((tab) => tab.getAttribute('title') ?? ''),
        scrollbars: [bar, ...bar.querySelectorAll<HTMLElement>('*')].filter((element) => {
          const style = getComputedStyle(element)
          return ['auto', 'scroll'].includes(style.overflowX) && element.scrollWidth > element.clientWidth
        }).length,
      }
    })

  const seen: Record<number, Awaited<ReturnType<typeof measure>>> = {}
  for (const [width, height] of [
    [1600, 900],
    [1280, 800],
    [1024, 768],
    [900, 900],
    // An iPad held upright.
    [768, 1024],
  ]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(150)
    const now = await measure()
    seen[width] = now
    expect(now.overflow, `${width}px`).toBeLessThanOrEqual(0)
    expect(now.pageOverflow, `${width}px`).toBeLessThanOrEqual(0)
    expect(now.scrollbars, `${width}px`).toBe(0)
    expect(now.rows, `${width}px`).toBeLessThanOrEqual(2)
    // A readable start of every title, the whole of it in the tooltip.
    for (const tabWidth of now.widths) expect(tabWidth, `${width}px`).toBeGreaterThanOrEqual(100)
    expect(now.cut, `${width}px`).toBe(true)
    now.tooltips.forEach((tooltip, index) => expect(tooltip).toContain(titles[index]))
  }
  // Narrower first, in one row; then two rows.
  expect(seen[1280].rows).toBe(1)
  expect(Math.max(...seen[1280].widths)).toBeLessThan(200)
  expect(seen[768].rows).toBe(2)

  // Two of them side by side, the last two of the row: their tabs say "left" and "right" and still keep a readable
  // start of the title (TITLE_MIN in layout.ts: 56 px).
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.evaluate(
    ([account, ids, folderId]) => {
      const tabs = (ids as string[]).map((note, index) => ({ key: `k${index}`, note, folder: folderId, used: index + 1 }))
      localStorage.setItem(`nexnotes.tabs.${account}`, JSON.stringify({ v: 1, tabs, left: 'k4', right: 'k5', focus: 'right', ratio: 0.5, seq: 6 }))
    },
    [me.id, notes, folder] as const,
  )
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/notes/${notes[5]}`))
  await expect(page.getByTestId('tab-side')).toHaveCount(2)
  for (const [width, height] of [
    [1280, 800],
    [1024, 768],
    [900, 900],
    [820, 1180],
    [768, 1024],
  ]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(150)
    const now = await measure()
    expect(now.overflow, `${width}px split`).toBeLessThanOrEqual(0)
    expect(now.pageOverflow, `${width}px split`).toBeLessThanOrEqual(0)
    expect(now.scrollbars, `${width}px split`).toBe(0)
    expect(now.rows, `${width}px split`).toBeLessThanOrEqual(2)
    const titles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="tab"]')].map((tab) => ({
        side: tab.dataset.side,
        title: Math.round((tab.querySelector('[data-testid="tab-title"]') as HTMLElement).getBoundingClientRect().width),
      })),
    )
    for (const one of titles) expect(one.title, `${width}px split, ${one.side || 'tab'}: ${JSON.stringify(titles)}`).toBeGreaterThanOrEqual(56)
    expect(titles.filter((one) => one.side).map((one) => one.side)).toEqual(['left', 'right'])
  }
  expect((await measure()).rows).toBe(2)
})

test('NOTES-8 EC-1 NOTES-12 the same note on both sides, as "Jürgen": typed on one side shows on the other at once, offline too; closing a side keeps the title', async ({ page: operator, browser }) => {
  // An umlaut in the name: every presence message carries it, and must arrive whole (NOTES-12).
  const context = await member(operator, browser, 'Jürgen', `juergen-${Date.now()}@example.com`)
  const page = await context.newPage()
  const errors = pageErrors(page)
  const { folder, notes } = await folderWith(page, `Twice E2E ${Date.now()}`, ['Twice open'])
  let offline = false
  const sockets: WebSocketRoute[] = []
  await page.routeWebSocket(LIVE, (ws) => {
    if (offline) {
      ws.close({ code: 4000, reason: 'tunnel' })
      return
    }
    sockets.push(ws)
    ws.connectToServer()
  })
  await page.goto(`/notes/${notes[0]}?folder=${folder}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await row(page, 'Twice open').click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  const left = page.locator('[data-testid="tab-pane"][data-side="left"]')
  const right = page.locator('[data-testid="tab-pane"][data-side="right"]')
  await expect(right).toHaveAttribute('data-note', notes[0])
  await expect(right.getByTestId('note-saved')).toHaveText('saved')
  await left.getByTestId('note-body').click()
  await page.keyboard.press('End')
  const started = Date.now()
  await page.keyboard.type(' typed on the left')
  await expect(right.getByTestId('note-body')).toContainText('typed on the left', { timeout: 1000 })
  expect(Date.now() - started).toBeLessThan(1000)
  // Each side sees the other as "you, other window" (NOTES-12 EC-8).
  await expect(right.getByTestId('presence-own')).toHaveText('you, other window')
  await expect(left.getByTestId('note-saved')).toHaveText('saved')

  // The network goes: what is typed on the right still shows on the left at once, and waits on both sides.
  offline = true
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'tunnel' })
  await expect(page.getByTestId('offline-bar')).toHaveCount(2)
  await right.getByTestId('note-body').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and on the right offline')
  await expect(left.getByTestId('note-body')).toContainText('and on the right offline', { timeout: 1000 })
  await expect(left.getByTestId('note-saved')).toHaveText(/changes? waiting/)
  // Back online: stored, nothing lost.
  offline = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByTestId('note-saved')).toHaveText(['saved', 'saved'])
  await expect.poll(async () => ((await (await page.request.get(`/api/notes/${notes[0]}`)).json()) as { preview: string }).preview, { timeout: 5000 }).toContain('and on the right offline')
  // Both tabs named from the start.
  await expect(page.getByTestId('tab-title')).toHaveText(['Twice open', 'Twice open'])

  // Ending the split, and closing the right side: no question for a title, and the title stays as it is.
  await page.getByTestId('tab-end-split').click()
  await expect(right).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.getByTestId('leave-dialog')).toHaveCount(0)
  await row(page, 'Twice open').click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(right).toHaveAttribute('data-note', notes[0])
  await expect(right.getByTestId('note-saved')).toHaveText('saved')
  await page.locator('[data-testid="tab"][data-side="right"]').getByTestId('tab-close').click()
  await expect(right).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.getByTestId('leave-dialog')).toHaveCount(0)
  await expect(page.getByTestId('tab-title')).toHaveText(['Twice open'])
  const head = (await (await page.request.get(`/api/notes/${notes[0]}`)).json()) as { title: string; title_check: boolean }
  expect(head.title).toBe('Twice open')
  expect(head.title_check).toBe(false)
  // The presence of "Jürgen" never broke in the browser.
  expect(errors.filter((error) => /JSON|SyntaxError/.test(error))).toEqual([])
  await context.close()
})

test('NOTES-8 NOTES-2 two accounts in two browser tabs: the second never sees a title or text of the first, not even what waited offline', async ({ page: operator, browser }) => {
  const stamp = Date.now()
  const context = await member(operator, browser, 'Jürgen', `juergen-a-${stamp}@example.com`)
  const bea = await member(operator, browser, 'Bea', `bea-${stamp}@example.com`)
  await bea.close()
  const first = await context.newPage()
  const { folder, notes } = await folderWith(first, `Personal E2E ${stamp}`, ['GEHEIM Personalakte', 'GEHEIM Gehälter'])
  let offline = false
  const sockets: WebSocketRoute[] = []
  await first.routeWebSocket(LIVE, (ws) => {
    if (offline) {
      ws.close({ code: 4000, reason: 'tunnel' })
      return
    }
    sockets.push(ws)
    ws.connectToServer()
  })
  await first.goto(`/notes/${notes[0]}?folder=${folder}`)
  await expect(first.getByTestId('note-saved')).toHaveText('saved')
  await row(first, 'GEHEIM Gehälter').click({ button: 'right' })
  await first.getByTestId('menu-open-beside').click()
  await expect(first.getByTestId('note-saved')).toHaveText(['saved', 'saved'])
  // Offline, Jürgen types on: the change waits.
  offline = true
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'tunnel' })
  await expect(first.getByTestId('offline-bar')).toHaveCount(2)
  await first.locator('[data-testid="tab-pane"][data-side="left"]').getByTestId('note-body').click()
  await first.keyboard.press('End')
  await first.keyboard.type(' GEHEIM Nachtrag')
  await expect(first.getByTestId('note-saved').first()).toHaveText(/changes? waiting/)

  // From now on, whenever the first tab shows Bea's name, nothing of Jürgen's notes may be on it.
  await first.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { leaked: string[] }).leaked = seen
    const look = () => {
      const text = document.body.innerText
      if (text.includes('Bea') && /GEHEIM|Personalakte|Gehälter|Nachtrag/.test(text)) seen.push(text.slice(0, 400))
    }
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })

  // A second browser tab signs in as Bea (the cookie is shared).
  const second = await context.newPage()
  const signed = await second.request.post('/api/auth/login', { data: { name: `bea-${stamp}@example.com`, password: PASSWORD }, headers: TAB })
  expect(signed.ok(), await signed.text()).toBe(true)
  const beaId = ((await (await second.request.get('/api/auth/me')).json()) as { id: number }).id
  await second.goto('/')
  await expect(second.getByTestId('sidebar-places')).toBeVisible()
  // The first tab follows when it is looked at again.
  await first.bringToFront()
  await first.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(first).toHaveURL(/\/$/, { timeout: 15_000 })
  await expect(first.getByRole('link', { name: /^Bea · / })).toBeVisible()
  await expect(first.getByTestId('folder-notice')).toContainText(/changes? of the account before (was|were) not saved yet and (is|are) lost\./)
  // The line comes back: still nothing of Jürgen's arrives.
  offline = false
  await first.evaluate(() => window.dispatchEvent(new Event('online')))
  await first.waitForTimeout(1500)
  await expect(first.getByTestId('tab-bar')).toHaveCount(0)
  for (const one of [first, second]) await expect(one.locator('body')).not.toContainText(/GEHEIM|Personalakte|Gehälter|Nachtrag/)
  expect(await first.evaluate(() => (window as unknown as { leaked: string[] }).leaked)).toEqual([])
  const kept = await first.evaluate((id) => localStorage.getItem(`nexnotes.tabs.${id}`) ?? '', beaId)
  for (const id of notes) expect(kept).not.toContain(id)
  await context.close()
})
