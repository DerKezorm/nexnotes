/**
 * Findings of the review of NOTES-7 and NOTES-23 (fourteenth round), in a real browser against the real server:
 * at 390 px every list that is no folder (smart folders, also "Mit mir geteilt" and "Anhänge", the page "Mit mir
 * geteilt", a tag, the search) has "‹ Ordner" and "New note", which goes into the inbox (NOTES-23 AC-1); links are 44 px
 * too, in a smart folder and in the drawer's section "Intelligent" (AC-7); the title of the share form takes 120
 * characters, as the server keeps them. And NOTES-7: "Hat Anhänge" and the gallery give the same notes.
 *
 * Run by the orchestrator only (`npm run e2e`), never by an agent: the machine has 16 GB.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-review5p14' }
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'

type Smart = { id: string; preset: string; name: string }

async function smartFolders(page: Page): Promise<Smart[]> {
  return ((await (await page.request.get('/api/smart-folders')).json()) as { items: Smart[] }).items
}

async function makeSmart(page: Page, name: string, conditions: unknown[]): Promise<string> {
  const answer = await page.request.post('/api/smart-folders', { data: { name, match: 'all', conditions }, headers: TAB })
  expect(answer.status()).toBe(201)
  return ((await answer.json()) as { id: string }).id
}

async function inboxId(page: Page): Promise<string> {
  return ((await (await page.request.get('/api/folders')).json()) as { inbox: { id: string } }).inbox.id
}

/** Every link, button and field on show that is smaller than a finger. */
async function tooSmall(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]):not([type=checkbox]), select, textarea, [role=button]')]
      .filter((element) => !element.closest('.ProseMirror') && element.offsetParent !== null)
      .filter((element) => getComputedStyle(element).display !== 'inline')
      .map((element) => ({ element: element.outerHTML.slice(0, 90), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 44 || box.width < 44)
      .map(({ element, box }) => `${element} ${Math.round(box.width)}x${Math.round(box.height)}`),
  )
}

test.describe('fourteenth review on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: ANDROID, hasTouch: true, isMobile: true })

  test('NOTES-23 AC-1 smart folders, "Mit mir geteilt", a tag and the search have "‹ Ordner" and "New note" into the inbox', async ({ page }) => {
    const stamp = Date.now().toString(36)
    await page.request.post('/api/notes', { data: { title: `Tagged ${stamp}`, markdown: `#p14${stamp}` }, headers: TAB })
    const folders = await smartFolders(page)
    const own = await makeSmart(page, `Pinned ${stamp}`, [{ kind: 'pinned' }])
    const inbox = await inboxId(page)
    const lists = [
      ...folders.filter((folder) => folder.preset === 'shared_with_me' || folder.preset === 'attachments').map((folder) => `/smart/${folder.id}`),
      `/smart/${own}`,
      '/shared',
      `/tags/p14${stamp}`,
      `/search?q=${encodeURIComponent(`Tagged ${stamp}`)}`,
    ]
    expect(lists.length).toBe(6)
    for (const at of lists) {
      await page.goto(at)
      const back = page.getByTestId('phone-back')
      await expect(back, at).toBeVisible()
      await expect(back, at).toHaveAttribute('href', '/folders')
      const fab = page.getByTestId('phone-new-note')
      await expect(fab, at).toBeVisible()
      const box = (await fab.boundingBox())!
      expect(box.width, at).toBeGreaterThanOrEqual(52)
      expect(box.x + box.width, at).toBeGreaterThan(390 - 40)
      expect(box.y + box.height, at).toBeGreaterThan(844 - 60)
      await fab.click()
      await expect(page, at).toHaveURL(/[?&]note=/)
      const noteId = new URL(page.url()).searchParams.get('note')!
      const note = (await (await page.request.get(`/api/notes/${noteId}`)).json()) as { folder_id: string }
      expect(note.folder_id, at).toBe(inbox)
      await page.request.delete(`/api/notes/${noteId}`, { headers: TAB })
    }
    await page.goto(`/smart/${own}`)
    await page.getByTestId('phone-back').click()
    await expect(page).toHaveURL(/\/folders$/)
  })

  test('NOTES-23 AC-7 links in a smart folder and the drawer\'s "+" beside "Intelligent" are 44 px', async ({ page }) => {
    const stamp = Date.now().toString(36)
    const folder = ((await (await page.request.post('/api/folders', { data: { name: `Gone ${stamp}`, parent_id: null }, headers: TAB })).json()) as { id: string }).id
    // One pointing nowhere ("Bearbeiten" in the note), one with nothing in it ("Bearbeiten" in the empty state).
    const broken = await makeSmart(page, `Broken ${stamp}`, [{ kind: 'folder', op: 'in', id: folder, name: `Gone ${stamp}` }])
    await page.request.delete(`/api/folders/${folder}`, { headers: TAB })
    const shared = (await smartFolders(page)).find((item) => item.preset === 'shared_with_me')
    for (const at of [`/smart/${broken}`, ...(shared ? [`/smart/${shared.id}`] : []), '/smart/new', '/folders']) {
      await page.goto(at)
      await expect(page.locator('main')).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(await tooSmall(page), at).toEqual([])
    }
    await page.goto(`/smart/${broken}`)
    await expect(page.getByTestId('smart-broken-edit')).toBeVisible()
    expect((await page.getByTestId('smart-broken-edit').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    if (shared) {
      await page.goto(`/smart/${shared.id}`)
      expect((await page.getByTestId('smart-shared-page').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    // The sidebar as the drawer of a phone.
    await page.locator('header button').first().click()
    // The desktop sidebar stays in the page (hidden below md): only the drawer's "+" is meant.
    const plus = page.locator('[role="presentation"]').getByTestId('sidebar-smart-new')
    await expect(plus).toBeVisible()
    const box = (await plus.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  })

  test('NOTES-23 AC-5 the title of the share form takes 120 characters and says so', async ({ page }) => {
    await page.goto('/folders')
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await page.evaluate(() => {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/share-target'
      form.enctype = 'multipart/form-data'
      for (const [name, value] of Object.entries({ title: 'x'.repeat(300), text: 'long title', url: '' })) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = value
        form.append(input)
      }
      document.body.append(form)
      form.submit()
    })
    await page.waitForURL(/\/share\?shared=/)
    const field = page.getByTestId('share-title')
    await expect(field).toHaveAttribute('maxlength', '120')
    await expect(field).toHaveValue('x'.repeat(120))
    await expect(page.getByTestId('share-title-count')).toBeVisible()
    await field.fill('')
    await field.pressSequentially('y'.repeat(130))
    await expect(field).toHaveValue('y'.repeat(120))
  })
})

test('NOTES-7 "Hat Anhänge" and the gallery of a smart folder give the same notes', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const note = ((await (await page.request.post('/api/notes', { data: { title: `Plain ${stamp}`, markdown: 'no files' }, headers: TAB })).json()) as { id: string }).id
  const pictures = await makeSmart(page, `Pictures ${stamp}`, [{ kind: 'attachment', type: 'any' }, { kind: 'text', value: `Plain ${stamp}` }])
  const listed = (await (await page.request.get(`/api/smart-folders/${pictures}/notes`)).json()) as { items: { id: string }[] }
  const gallery = (await (await page.request.get(`/api/smart-folders/${pictures}/attachments`)).json()) as { items: { note: { id: string } }[] }
  const inList = new Set(listed.items.map((item) => item.id))
  const inGallery = new Set(gallery.items.map((item) => item.note.id))
  expect([...inGallery].every((id) => inList.has(id))).toBe(true)
  expect(inList.has(note)).toBe(false)
})
