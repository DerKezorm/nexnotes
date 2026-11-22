/**
 * NOTES-23 in a real browser against the real server: the phone's way at 390 px with the sizes measured (AC-1, AC-7),
 * the manifest and the service worker that make nexnotes installable (AC-3), "No connection" without network (AC-4),
 * sharing from Android through the share target to a note in the inbox (AC-5), the form kept without network (EC-3),
 * a file over the limit (EC-4), and the share target's form without a service worker. The page is the operator of
 * global-setup.ts.
 *
 * Runs with `npm run e2e`, one worker at a time.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-handy000' }
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'

async function makeFolder(page: Page, name: string, parent_id: string | null = null): Promise<string> {
  const answer = await page.request.post('/api/folders', { data: { name, parent_id }, headers: TAB })
  expect(answer.status()).toBe(201)
  return ((await answer.json()) as { id: string }).id
}

/** The service worker took this page over (a reload after the first visit). */
async function controlled(page: Page): Promise<void> {
  await page.goto('/folders')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

/** Sends the share target's form as Android does: a POST of multipart data to /share-target, from the page itself. */
async function share(page: Page, fields: { title?: string; text?: string; url?: string }, files: { name: string; type: string; size?: number; body?: string }[] = []) {
  await page.evaluate(
    ({ fields, files }) => {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/share-target'
      form.enctype = 'multipart/form-data'
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = value ?? ''
        form.append(input)
      }
      const picker = document.createElement('input')
      picker.type = 'file'
      picker.name = 'files'
      picker.multiple = true
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(new File([file.size ? new Uint8Array(file.size) : (file.body ?? 'x')], file.name, { type: file.type }))
      picker.files = transfer.files
      form.append(picker)
      document.body.append(form)
      form.submit()
    },
    { fields, files },
  )
  await page.waitForURL(/\/share\?shared=/)
}

test.describe('NOTES-23 on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: ANDROID, hasTouch: true, isMobile: true })

  test('NOTES-23 AC-1 AC-7 folders, then notes, then the note, each with back; every button and field 44 px', async ({ page }) => {
    const stamp = Date.now().toString(36)
    const home = await makeFolder(page, `Haushalt ${stamp}`)
    await page.goto('/')
    await expect(page).toHaveURL(/\/folders$/)
    await expect(page.getByTestId('folders-page')).toBeVisible()

    const tooSmall = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('button, input:not([type=hidden]):not([type=checkbox]), select, textarea, [role=button], [data-testid=phone-back]')]
          .filter((element) => !element.closest('.ProseMirror') && element.offsetParent !== null)
          .map((element) => ({ element: element.outerHTML.slice(0, 80), box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.height < 44 || box.width < 44)
          .map(({ element, box }) => `${element} ${Math.round(box.width)}x${Math.round(box.height)}`),
      )
    expect(await tooSmall()).toEqual([])

    await page.locator(`a[href="/folder/${home}"]`).click()
    await expect(page.getByTestId('folder-page')).toBeVisible()
    const back = page.getByTestId('phone-back')
    await expect(back).toHaveAttribute('href', '/folders')
    const fab = page.getByTestId('phone-new-note')
    const box = (await fab.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(56)
    expect(390 - (box.x + box.width)).toBeLessThanOrEqual(20)
    expect(844 - (box.y + box.height)).toBeLessThanOrEqual(40)
    expect(await tooSmall()).toEqual([])

    await fab.click()
    await expect(page.getByTestId('note-body')).toBeVisible()
    const toList = page.getByTestId('phone-back')
    await expect(toList).toContainText(`Haushalt ${stamp}`)
    // AC-2: the bar above the keyboard, with "Close keyboard".
    await page.getByTestId('note-body').click()
    await expect(page.getByTestId('tool-keyboard')).toBeVisible()
    expect(await tooSmall()).toEqual([])
    await toList.click()
    await expect(page).toHaveURL(new RegExp(`/folder/${home}$`))
  })

  test('NOTES-23 AC-3 the manifest, its symbols and the service worker make nexnotes installable', async ({ page }) => {
    const manifest = await (await page.request.get('/manifest.webmanifest')).json()
    expect(manifest.display).toBe('standalone')
    for (const icon of manifest.icons) {
      const answer = await page.request.get(icon.src)
      expect(answer.status(), icon.src).toBe(200)
      expect(answer.headers()['content-type']).toBe('image/png')
    }
    await controlled(page)
    // The shell is kept, nothing of the API.
    const kept = await page.evaluate(async () => {
      const urls: string[] = []
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
      return urls
    })
    expect(kept).toContain('/index.html')
    expect(kept.some((path) => path.startsWith('/assets/'))).toBe(true)
    expect(kept.filter((path) => path.startsWith('/api') || path.startsWith('/l/'))).toEqual([])
  })

  test('NOTES-23 AC-4 without network "No connection", "Try again", and the app again when it is back', async ({ page, context }) => {
    await controlled(page)
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'No connection' })).toBeVisible()
    await expect(page.getByText('Writing without network works in the iPhone and iPad app.')).toBeVisible()
    // The page asks by itself as soon as the network is back. For "Try again" to be the one that brings the app back,
    // the server stays out of reach a moment longer (that first question fails), then answers again.
    let asked = 0
    await page.route('**/api/setup', (route) => {
      asked += 1
      return route.abort('internetdisconnected')
    })
    await context.setOffline(false)
    await expect.poll(() => asked).toBeGreaterThan(0)
    await expect(page.getByTestId('offline-retry')).toBeEnabled()
    await page.unroute('**/api/setup')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('offline')).toHaveCount(0)
  })

  test('NOTES-23 AC-5 a link and a picture shared from Android land in the inbox with origin and "Check title"', async ({ page }) => {
    await controlled(page)
    const stamp = Date.now().toString(36)
    await share(page, { title: `Kompost ${stamp}`, text: 'Lesen https://garden.example/kompost' }, [{ name: 'photo.png', type: 'image/png' }])
    await expect(page.getByRole('heading', { name: 'Save to nexnotes' })).toBeVisible()
    await expect(page.getByTestId('share-title')).toHaveValue(`Kompost ${stamp}`)
    await expect(page.getByTestId('share-folder')).toContainText('Inbox')
    await page.getByTestId('share-note').fill('Für das Hochbeet')
    await page.getByTestId('share-save').click()
    await expect(page.getByTestId('note-body')).toBeVisible()
    const inbox = await (await page.request.get('/api/folders/inbox')).json()
    const card = inbox.notes.find((note: { title: string }) => note.title === `Kompost ${stamp}`)
    expect(card).toMatchObject({ origin: 'share:Android', title_check: true })
    await page.goto('/inbox')
    await expect(page.getByText('Shared from Android').first()).toBeVisible()
  })

  test('NOTES-23 EC-3 without network the form stays, and "Save" again makes the note once', async ({ page, context }) => {
    await controlled(page)
    const stamp = Date.now().toString(36)
    await share(page, { title: `Offline ${stamp}`, text: 'Milch' })
    await context.setOffline(true)
    await page.getByTestId('share-save').click()
    await expect(page.getByTestId('share-offline')).toBeVisible()
    await expect(page.getByTestId('share-title')).toHaveValue(`Offline ${stamp}`)
    await context.setOffline(false)
    await page.getByTestId('share-save').click()
    await expect(page.getByTestId('note-body')).toBeVisible()
    const inbox = await (await page.request.get('/api/folders/inbox')).json()
    expect(inbox.notes.filter((note: { title: string }) => note.title === `Offline ${stamp}`)).toHaveLength(1)
  })

  test('NOTES-23 EC-4 a shared file over the limit is refused with a message', async ({ page }) => {
    const settings = await page.request.put('/api/settings', { data: { upload_max_mb: 1 }, headers: TAB })
    expect(settings.ok()).toBe(true)
    try {
      await controlled(page)
      await share(page, { title: 'Groß' }, [{ name: 'video.mp4', type: 'video/mp4', size: 2 * 1024 * 1024 }])
      await expect(page.getByTestId('share-too-large')).toContainText('video.mp4')
    } finally {
      await page.request.put('/api/settings', { data: { upload_max_mb: 100 }, headers: TAB })
    }
  })
})

test.describe('NOTES-23 without a service worker', () => {
  test.use({ serviceWorkers: 'block' })

  test('NOTES-23 AC-5 the share target form reaches the server and makes nothing there', async ({ page }) => {
    const before = (await (await page.request.get('/api/folders/inbox')).json()).notes.length
    await page.goto('/folders')
    await share(page, { title: 'Ohne Worker', text: 'x' })
    await expect(page).toHaveURL(/\/share\?shared=lost$/)
    await expect(page.getByTestId('share-gone')).toBeVisible()
    expect((await (await page.request.get('/api/folders/inbox')).json()).notes.length).toBe(before)
  })
})
