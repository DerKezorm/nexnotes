/**
 * NOTES-3 and NOTES-12 in real browsers against the real server: a new note, typing and "saved", two sessions on one
 * note (time to arrive), a broken connection (bar, waiting changes, the browser's question when the tab closes), a
 * note of 30,000 words, deleting with "Undo", leaving without a title. The page is the operator of global-setup.ts.
 */
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test'
import { OPERATOR } from './global-setup'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-notes000' }
const LIVE = /\/api\/notes\/[^/]+\/live$/

type Head = { id: string; title: string; title_check: boolean; preview: string; folder_id: string }

async function makeNote(page: Page, data: Record<string, unknown> = {}): Promise<Head> {
  const answer = await page.request.post('/api/notes', { data, headers: TAB })
  expect(answer.status()).toBe(201)
  return (await answer.json()) as Head
}

async function head(page: Page, id: string): Promise<Head> {
  return (await (await page.request.get(`/api/notes/${id}`)).json()) as Head
}

function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function secondWindow(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: process.env.NEXNOTES_E2E_STATE })
  return context.newPage()
}

const body = (page: Page) => page.getByTestId('note-body')

test('NOTES-3 AC-1 AC-2 AC-8 a new note opens with the cursor in the title, Enter goes into the text, typing is saved', async ({ page }) => {
  const problems = watchProblems(page)
  await page.goto('/')
  await page.getByTestId('new-note').click()
  await expect(page).toHaveURL(/\/notes\//)
  const title = page.getByTestId('note-title')
  await expect(title).toBeFocused()
  await title.fill('Shopping Saturday')
  await page.keyboard.press('Enter')
  await expect(body(page)).toBeFocused()
  await page.keyboard.type('Milk, tomatoes, bread')
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  const id = page.url().split('/notes/')[1].split('?')[0]
  await expect.poll(async () => (await head(page, id)).preview, { timeout: 5000 }).toBe('Milk, tomatoes, bread')
  await expect(page.getByTestId('note-meta')).toContainText('Inbox')
  await expect(page.getByTestId('note-meta')).toContainText('created')
  await expect(page.getByTestId('note-row').filter({ hasText: 'Shopping Saturday' })).toBeVisible()
  expect(problems).toEqual([])
})

test('NOTES-12 AC-1 what one session types shows in the other within a second', async ({ page, browser }) => {
  const note = await makeNote(page, { title: 'Together' })
  const other = await secondWindow(browser)
  await page.goto(`/notes/${note.id}`)
  await other.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await expect(other.getByTestId('note-saved')).toHaveText('saved')
  // The same account in two windows: the other window is "you, other window" (EC-8).
  await expect(page.getByTestId('presence-own')).toHaveText('you, other window')
  await body(page).click()
  const started = Date.now()
  await page.keyboard.type('hello there')
  await expect(body(other)).toContainText('hello there', { timeout: 1000 })
  expect(Date.now() - started).toBeLessThan(1000)
  await other.context().close()
})

test('NOTES-12 AC-8 EC-4 a broken connection shows the bar and the waiting changes, the tab asks before closing, nothing is lost', async ({ page }) => {
  const note = await makeNote(page, { title: 'Train' })
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
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  offline = true
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'tunnel' })
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await body(page).click()
  await page.keyboard.type('written in the tunnel')
  await expect(page.getByTestId('note-saved')).toHaveText(/changes? waiting/)
  await expect(page.getByTestId('note-saved')).toHaveClass(/text-warn-500/)

  // Closing the tab now: the browser asks first.
  let asked = false
  page.once('dialog', async (dialog) => {
    asked = dialog.type() === 'beforeunload'
    await dialog.dismiss()
  })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toBe(true)
  expect(page.isClosed()).toBe(false)

  offline = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByTestId('offline-bar')).toBeHidden({ timeout: 10_000 })
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await expect.poll(async () => (await head(page, note.id)).preview, { timeout: 5000 }).toBe('written in the tunnel')
})

test('NOTES-3 EC-2 a note of 30,000 words opens and typing stays quick', async ({ page }) => {
  const words = Array.from({ length: 30_000 }, (_, i) => `word${i % 997}`)
  const paragraphs: string[] = []
  for (let i = 0; i < words.length; i += 15) paragraphs.push(words.slice(i, i + 15).join(' '))
  const note = await makeNote(page, { title: 'Dictation of two hours', markdown: paragraphs.join('\n\n') })
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved', { timeout: 20_000 })
  await expect(body(page).locator('p').nth(1999)).toBeAttached()
  await body(page).locator('p').nth(1000).click()
  await page.keyboard.press('End')
  // Time per keystroke inside the page: from the key event to the text in the document.
  const times = await page.evaluate(async () => {
    const editor = document.querySelector('[data-testid="note-body"]') as HTMLElement
    const measured: number[] = []
    for (let i = 0; i < 30; i++) {
      const started = performance.now()
      document.execCommand('insertText', false, 'x')
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      measured.push(performance.now() - started)
      void editor
    }
    return measured
  })
  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(`30,000 words: median ${median.toFixed(1)} ms, slowest ${sorted[sorted.length - 1].toFixed(1)} ms per keystroke`)
  expect(median).toBeLessThan(50)
  await expect(page.getByTestId('note-saved')).toHaveText('saved', { timeout: 10_000 })
})

test('NOTES-3 AC-6 deleting moves the note to the trash, "Undo" within ten seconds brings it back', async ({ page }) => {
  const note = await makeNote(page, { title: `Throw away ${Date.now()}`, markdown: 'not for long' })
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await page.getByTestId('note-menu').click()
  await page.getByTestId('note-delete').click()
  await expect(page).not.toHaveURL(/\/notes\//)
  await expect(page.getByTestId('note-row').filter({ hasText: note.title })).toHaveCount(0)
  const notice = page.getByTestId('folder-notice')
  await expect(notice).toContainText('Note moved to the trash.')
  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}`))
  await expect(page.getByTestId('note-title')).toHaveValue(note.title)
  await expect(page.getByTestId('note-row').filter({ hasText: note.title })).toBeVisible()
})

test('NOTES-3 AC-9 AC-10 leaving without a title asks with a suggestion; taken on purpose it is ok, made without typing it is marked', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('note-title')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dentist Tuesday 15:30 confirm, bring the booklet')
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  // Typed at once after Enter: every key in the text, none in the title.
  await expect(page.getByTestId('note-title')).toHaveValue('')
  await expect(body(page)).toHaveText('Dentist Tuesday 15:30 confirm, bring the booklet')
  const id = page.url().split('/notes/')[1].split('?')[0]
  await page.getByRole('link', { name: 'All notes' }).click()
  const dialog = page.getByTestId('leave-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('leave-suggestion')).toHaveText('Dentist Tuesday 15:30 confirm')
  await page.getByTestId('leave-take').click()
  await expect(page).not.toHaveURL(/\/notes\//)
  // Seen and taken: a title like a typed one, no mark (AC-9).
  await expect.poll(async () => (await head(page, id)).title).toBe('Dentist Tuesday 15:30 confirm')
  expect((await head(page, id)).title_check).toBe(false)
  // This very note's row (a repeated run leaves notes of the same words behind).
  const seen = page.locator(`[data-testid="note-row"][href="/notes/${id}"]`)
  await expect(seen).toContainText('Dentist Tuesday 15:30 confirm')
  await expect(seen).not.toContainText('Check title')
  // Made without typing (AC-10): the suggestion carries the mark until "Title OK".
  const made = await page.request.post('/api/notes', { data: { markdown: 'Pick up the parcel at the post office' }, headers: { 'X-Nexnotes-Client': 'tab-e2e-notes0000' } })
  const other = (await made.json()).id as string
  expect((await head(page, other)).title_check).toBe(true)
  await page.reload()
  const row = page.locator(`[data-testid="note-row"][href="/notes/${other}"]`)
  await expect(row).toContainText('Check title')
  await row.click()
  await page.getByTestId('title-ok').click()
  await expect(page.getByTestId('title-check')).toHaveCount(0)
  expect((await head(page, other)).title_check).toBe(false)
})

test("NOTES-3 AC-9 the browser's back button asks too and goes back only with the suggestion", async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('note-title')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Pick up the parcel at the post office')
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  const here = page.url()
  const id = here.split('/notes/')[1].split('?')[0]
  const dialog = page.getByTestId('leave-dialog')
  await page.goBack()
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(here)
  // "Enter a title": the note stays, the cursor in the title.
  await page.getByTestId('leave-type').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(here)
  await expect(page.getByTestId('note-title')).toBeFocused()
  // Back once more: the suggestion, and the step back is made.
  await page.goBack()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('leave-suggestion')).toHaveText('Pick up the parcel at the post office')
  await page.getByTestId('leave-take').click()
  await expect(page).not.toHaveURL(/\/notes\//)
  await expect.poll(async () => (await head(page, id)).title).toBe('Pick up the parcel at the post office')
  // Forward again: the note has its title now, nothing asks.
  await page.goForward()
  await expect(page).toHaveURL(here)
  await expect(page.getByTestId('note-title')).toHaveValue('Pick up the parcel at the post office')
  await page.goBack()
  await expect(page).not.toHaveURL(/\/notes\//)
  await expect(dialog).toHaveCount(0)
})

test('NOTES-3 EC-4 a new note left without title and text leaves nothing behind', async ({ page }) => {
  await page.goto('/')
  const before = ((await (await page.request.get('/api/notes')).json()) as Head[]).length
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await page.getByRole('link', { name: 'All notes' }).click()
  await expect(page.getByTestId('leave-dialog')).toHaveCount(0)
  await expect.poll(async () => ((await (await page.request.get('/api/notes')).json()) as Head[]).length).toBe(before)
})

/** Connections the page opened to a note's live room. */
function countLive(page: Page): () => number {
  let opened = 0
  page.on('websocket', (ws) => {
    if (LIVE.test(new URL(ws.url()).pathname)) opened++
  })
  return () => opened
}

test('NOTES-12 EC-2 a note in the trash opened by its address says so, offers it back and does not reconnect', async ({ page }) => {
  const note = await makeNote(page, { title: `Binned ${Date.now()}`, markdown: 'in the trash already' })
  expect((await page.request.delete(`/api/notes/${note.id}`, { headers: TAB })).status()).toBe(204)
  const opened = countLive(page)
  await page.goto(`/notes/${note.id}`)
  const stopped = page.getByTestId('stopped-bar')
  await expect(stopped).toContainText('This note was deleted and is in the trash.')
  await expect(page.getByTestId('note-editor')).toHaveAttribute('data-status', 'gone')
  await expect(page.getByTestId('note-title')).toHaveAttribute('readonly', '')
  await expect(page.getByTestId('note-saved')).toHaveCount(0)
  // The room said 4404 once; nothing knocks again.
  await page.waitForTimeout(2500)
  expect(opened()).toBe(1)
  await stopped.getByRole('button', { name: 'Restore from the trash' }).click()
  await expect(stopped).toHaveCount(0)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  await expect(page.getByTestId('note-title')).toHaveValue(note.title)
  await expect(body(page)).toContainText('in the trash already')
})

test('NOTES-12 EC-2 a note deleted while the connection was away says so on the way back, nothing claims to wait', async ({ page }) => {
  const note = await makeNote(page, { title: 'Deleted behind my back', markdown: 'start' })
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
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  offline = true
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'tunnel' })
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await body(page).click()
  await page.keyboard.type(' written away')
  await expect(page.getByTestId('note-saved')).toHaveText(/changes? waiting/)
  // Meanwhile the note goes to the trash (another window, another device).
  expect((await page.request.delete(`/api/notes/${note.id}`, { headers: TAB })).status()).toBe(204)
  offline = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByTestId('stopped-bar')).toContainText('This note was deleted and is in the trash.')
  await expect(page.getByTestId('offline-bar')).toHaveCount(0)
  await expect(page.getByTestId('note-saved')).toHaveCount(0)
  await expect(page.getByTestId('note-editor')).toHaveAttribute('data-status', 'gone')
  const opened = sockets.length
  await page.waitForTimeout(2500)
  expect(sockets.length).toBe(opened)
})

test('NOTES-12 EC-5 a session ended while the connection was away ends the note with a hint, not with waiting for ever', async ({ browser }) => {
  // A browser of its own with a session of its own, so that signing it out leaves the other tests' session alone.
  const context = await browser.newContext({ storageState: undefined })
  const page = await context.newPage()
  const signed = await page.request.post('/api/auth/login', { data: OPERATOR, headers: TAB })
  expect(signed.ok()).toBe(true)
  const note = await makeNote(page, { title: 'Session goes', markdown: 'start' })
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
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByTestId('note-saved')).toHaveText('saved')
  offline = true
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'tunnel' })
  await body(page).click()
  await page.keyboard.type(' never arrives')
  await expect(page.getByTestId('note-saved')).toHaveText(/changes? waiting/)
  expect((await page.request.post('/api/auth/logout', { headers: TAB })).status()).toBe(204)
  offline = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByTestId('note-editor')).toHaveAttribute('data-status', 'forbidden')
  await expect(page.getByTestId('stopped-bar')).toContainText('You no longer have access to this note. What has not arrived is not saved.')
  await expect(page.getByTestId('offline-bar')).toHaveCount(0)
  await expect(page.getByTestId('note-saved')).toHaveCount(0)
  const opened = sockets.length
  await page.waitForTimeout(2500)
  expect(sockets.length).toBe(opened)
  await context.close()
})
