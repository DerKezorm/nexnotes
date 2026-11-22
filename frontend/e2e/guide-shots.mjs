/**
 * The screenshots of the guide (NOTES-26), from the real interface: `backend/app/guide/<language>/shots/*.webp`.
 *
 *   npm run build
 *   node e2e/guide-shots.mjs            both languages
 *   node e2e/guide-shots.mjs de         one language; more names after it take only those pictures
 *
 * For each language a server of its own on a fresh temporary data folder (port 8573), made-up example notes of two
 * made-up people (Lena and Jonas, addresses at example.com), headless Chromium at 1280 × 800 in the light theme, one
 * worker. The pictures go through Pillow from the backend's environment (`guide-shots.py`) as WebP. The guide's own
 * notes show its pictures: run it twice after changing many of them, so the second run shows the first one's.
 */
import { chromium, request as httpRequest } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const BACKEND = path.resolve(FRONTEND, '..', 'backend')
const PYTHON = path.join(BACKEND, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const PORT = Number(process.env.NEXNOTES_SHOTS_PORT ?? 8573)
const BASE = `http://127.0.0.1:${PORT}`
const TAB = { 'X-Nexnotes-Client': 'tab-guideshot0' }
const PASSWORD = 'guide pictures only, made up'
const args = process.argv.slice(2)
const LANGUAGES = args[0] === 'de' || args[0] === 'en' ? [args[0]] : ['de', 'en']
const ONLY = new Set(args.slice(LANGUAGES.length === 1 ? 1 : 0))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The example notes, in both languages. Nobody real: names and addresses are made up. */
const WORDS = {
  de: {
    lena: 'Lena Vogel', jonas: 'Jonas Berg',
    folders: { home: 'Haushalt', recipes: 'Rezepte', work: 'Arbeit', projects: 'Projekte', travel: 'Urlaub' },
    shopping: ['Einkaufsliste', '- [x] Hafermilch\n- [x] Vollkornbrot\n- [ ] Äpfel\n- [ ] Kaffee\n- [ ] Blumen für den Balkon\n- [ ] Backpapier'],
    cleaning: ['Putzplan', 'Wer macht was in dieser Woche?\n\n| Tag | Aufgabe | Wer |\n|---|---|---|\n| Montag | Bad putzen | Lena |\n| Mittwoch | Staubsaugen | Jonas |\n| Freitag | Pflanzen gießen | Lena |\n| Samstag | Altglas wegbringen | Jonas |\n\nTauschen geht immer, Bescheid sagen reicht.'],
    pancakes: ['Pfannkuchen', 'Für vier Stück, schnell gemacht. #rezept\n\nPHOTO\n\n## Zutaten\n\n- [ ] 200 g Mehl\n- [ ] 2 Eier\n- [ ] 300 ml Milch\n- [ ] 1 Prise Salz\n- [ ] Beeren zum Belegen\n\n## Zubereitung\n\n1. Mehl, Eier, Milch und Salz glatt rühren.\n2. Den Teig zehn Minuten ruhen lassen.\n3. In wenig Butter von beiden Seiten goldbraun backen.\n\nDazu passt ==Ahornsirup== oder Apfelmus.'],
    soup: ['Tomatensuppe', 'Omas Tomatensuppe mit Basilikum. #rezept\n\n- 1 kg reife Tomaten\n- 1 Zwiebel, 2 Knoblauchzehen\n- 500 ml Gemüsebrühe\n- Basilikum, Salz, Pfeffer\n\nAlles 20 Minuten köcheln lassen, dann fein pürieren.'],
    meeting: ['Besprechung Montag', '#arbeit\n\n# Rückblick\n\nDie Umstellung auf das neue Lager lief gut. Zwei Lieferungen kamen zu spät, beide sind inzwischen da.\n\n# Themen\n\n## Herbstaktion\n\nPlakate bis Ende des Monats, Text schreibt Jonas. Budget wie im letzten Jahr.\n\n## Neue Kasse\n\nTermin für die Schulung steht noch aus. Lena fragt beim Anbieter nach.\n\n# Nächste Schritte\n\n- [ ] Plakate entwerfen\n- [ ] Schulung vereinbaren\n- [x] Protokoll verschicken'],
    ideas: ['Ideen für den Herbst', '#arbeit\n\n- Kürbiswoche mit Rezeptkarten\n- Stand auf dem Wochenmarkt\n- Gutscheine zum Erntedank'],
    packing: ['Packliste Italien', '- [x] Pässe\n- [x] Ladekabel\n- [ ] Sonnencreme\n- [ ] Wanderschuhe\n- [ ] Badesachen\n- [ ] Reiseführer'],
    plan: ['Reiseplan Gardasee', 'Vier Tage am See, die Unterkunft ist gebucht. #urlaub\n\nPHOTO\n\n| Tag | Ort | Was |\n|---|---|---|\n| 1 | Brenner | Anreise |\n| 2 | Malcesine | Seilbahn |\n| 3 | Limone | Bootsfahrt |\n\nPDF'],
    receipt: ['Kassenbon Bioladen', 'Ausgaben für die Haushaltskasse.\n\nRECEIPT'],
    old: ['Alte Einkaufsliste', '- Milch\n- Eier'],
    inbox: [['Buchtipp', 'Den Roman aus der Buchhandlung am Markt merken.', 'share:Safari'],
            ['Idee fürs Wochenende', 'Mit dem Rad an den See und dort picknicken.', 'dictation'],
            ['Zitat für die Karte', 'Kleine Schritte sind auch Schritte.', 'mcp:Laptop']],
    photo: 'Pfannkuchen mit Beeren', lake: 'Abends am See', pdfName: 'Reiseplan.pdf', receiptName: 'Kassenbon',
    receiptText: 'BIOLADEN AM MARKT\nHauptstraße 12\nÄpfel 1 kg 3,20\nVollkornbrot 4,10\nKaffee 7,90\nHafermilch 2,10\nBlumen 6,50\nSUMME 23,80',
    search: 'Tomaten', token: 'n8n Wetterbericht', smartName: 'Rezepte zum Ausprobieren', newNoteTitle: 'Geburtstag von Kim',
  },
  en: {
    lena: 'Lena Vogel', jonas: 'Jonas Berg',
    folders: { home: 'Home', recipes: 'Recipes', work: 'Work', projects: 'Projects', travel: 'Holidays' },
    shopping: ['Shopping list', '- [x] Oat milk\n- [x] Wholemeal bread\n- [ ] Apples\n- [ ] Coffee\n- [ ] Flowers for the balcony\n- [ ] Baking paper'],
    cleaning: ['Cleaning plan', 'Who does what this week?\n\n| Day | Task | Who |\n|---|---|---|\n| Monday | Clean the bathroom | Lena |\n| Wednesday | Vacuum | Jonas |\n| Friday | Water the plants | Lena |\n| Saturday | Take the bottles back | Jonas |\n\nSwapping is fine, just say so.'],
    pancakes: ['Pancakes', 'Makes four, quick to do. #recipe\n\nPHOTO\n\n## Ingredients\n\n- [ ] 200 g flour\n- [ ] 2 eggs\n- [ ] 300 ml milk\n- [ ] A pinch of salt\n- [ ] Berries on top\n\n## Method\n\n1. Whisk flour, eggs, milk and salt until smooth.\n2. Let the batter rest for ten minutes.\n3. Fry in a little butter until golden on both sides.\n\nServe with ==maple syrup== or apple sauce.'],
    soup: ['Tomato soup', "Grandma's tomato soup with basil. #recipe\n\n- 1 kg ripe tomatoes\n- 1 onion, 2 cloves of garlic\n- 500 ml vegetable stock\n- Basil, salt, pepper\n\nSimmer for 20 minutes, then blend until smooth."],
    meeting: ['Monday meeting', '#work\n\n# Looking back\n\nThe move to the new storeroom went well. Two deliveries came late; both have arrived since.\n\n# Topics\n\n## Autumn campaign\n\nPosters by the end of the month, Jonas writes the text. Same budget as last year.\n\n## New till\n\nThe training date is still open. Lena asks the supplier.\n\n# Next steps\n\n- [ ] Design the posters\n- [ ] Arrange the training\n- [x] Send the minutes'],
    ideas: ['Ideas for autumn', '#work\n\n- Pumpkin week with recipe cards\n- A stall at the farmers market\n- Vouchers for harvest festival'],
    packing: ['Packing list Italy', '- [x] Passports\n- [x] Chargers\n- [ ] Sun cream\n- [ ] Hiking boots\n- [ ] Swimwear\n- [ ] Guidebook'],
    plan: ['Lake Garda travel plan', 'Four days at the lake, the room is booked. #holiday\n\nPHOTO\n\n| Day | Place | What |\n|---|---|---|\n| 1 | Brenner | Getting there |\n| 2 | Malcesine | Cable car |\n| 3 | Limone | Boat trip |\n\nPDF'],
    receipt: ['Receipt organic grocer', 'Spending for the household budget.\n\nRECEIPT'],
    old: ['Old shopping list', '- Milk\n- Eggs'],
    inbox: [['Book tip', 'Remember the novel from the bookshop on the market.', 'share:Safari'],
            ['Idea for the weekend', 'Cycle to the lake and have a picnic there.', 'dictation'],
            ['Quote for the card', 'Small steps are steps too.', 'mcp:Laptop']],
    photo: 'Pancakes with berries', lake: 'Evening at the lake', pdfName: 'Travel plan.pdf', receiptName: 'Receipt',
    receiptText: 'ORGANIC GROCER\n12 Market Street\nApples 1 kg 3.20\nWholemeal bread 4.10\nCoffee 7.90\nOat milk 2.10\nFlowers 6.50\nTOTAL 23.80',
    search: 'tomatoes', token: 'n8n weather report', smartName: 'Recipes to try', newNoteTitle: "Kim's birthday",
  },
}

// --- The server ---------------------------------------------------------------------------------------------------

async function startServer(dataDir) {
  const server = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: BACKEND,
    env: {
      ...process.env,
      NEXNOTES_DATA_DIR: dataDir,
      NEXNOTES_FRONTEND_DIST: path.join(FRONTEND, 'dist'),
      NEXNOTES_DISABLE_BACKGROUND: '1',
      NEXNOTES_WORK_QUEUE: '1',
      NEXNOTES_GUIDE: '0',
      NEXNOTES_ARGON2_TIME: '1',
      NEXNOTES_ARGON2_MEMORY_KIB: '8192',
      NEXNOTES_ARGON2_PARALLELISM: '1',
      NEXNOTES_UPDATE_URL: 'http://127.0.0.1:9/releases/latest',
      NEXNOTES_SETUP_TOKEN: 'guide-shots-setup',
      NEXNOTES_LOG_LEVEL: 'quiet',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let said = ''
  server.stderr.on('data', (chunk) => (said = (said + chunk).slice(-4000)))
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return server
    } catch {
      // not yet
    }
    await sleep(500)
  }
  server.kill()
  throw new Error('the server did not start:\n' + said)
}

// --- The example notes --------------------------------------------------------------------------------------------

async function api(context, method, url, data, extra = {}) {
  const response = await context.fetch(url, { method, data, headers: TAB, ...extra })
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}

function attachmentId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[byte % 64]).join('') + 'xyzw12'
}

async function seed(language, samples) {
  const w = WORDS[language]
  const lena = await httpRequest.newContext({ baseURL: BASE, extraHTTPHeaders: TAB })
  await api(lena, 'POST', '/api/setup', {
    display_name: w.lena, email: 'lena@example.com', password: PASSWORD, password_confirm: PASSWORD, language,
    code: 'guide-shots-setup',
  })
  const folder = (name, icon, color, parent_id = null) => api(lena, 'POST', '/api/folders', { name, icon, color, parent_id })
  const home = await folder(w.folders.home, 'house', 'green')
  const recipes = await folder(w.folders.recipes, 'chef-hat', 'orange')
  const work = await folder(w.folders.work, 'briefcase', 'blue')
  const projects = await folder(w.folders.projects, 'kanban', 'violet', work.id)
  const travel = await folder(w.folders.travel, 'beach', 'sky')

  const notes = {}
  const files = []
  const note = async (key, folderId, [title, body], extra = {}) => {
    let markdown = body
    for (const [mark, name, file] of [['PHOTO', key === 'plan' ? w.lake : w.photo, key === 'plan' ? 'lake.jpg' : 'pancakes.jpg'],
      ['PDF', w.pdfName, `plan-${language}.pdf`], ['RECEIPT', w.receiptName, `receipt-${language}.jpg`]]) {
      if (!markdown.includes(mark)) continue
      const id = attachmentId()
      markdown = markdown.replace(mark, `${mark === 'PDF' ? '' : '!'}[${name}](attachment:${id})`)
      files.push({ key, id, name: mark === 'PDF' ? name : name + '.jpg', file, receipt: mark === 'RECEIPT' })
    }
    const made = await api(lena, 'POST', '/api/notes', { title, markdown, folder_id: folderId, origin: extra.origin ?? '' })
    notes[key] = made
    if (extra.pin) await api(lena, 'PUT', `/api/notes/${made.id}/pin`, { pinned: true })
    if (extra.color) await api(lena, 'PUT', `/api/notes/${made.id}/color`, { color: extra.color })
    if (extra.icon) await api(lena, 'PUT', `/api/notes/${made.id}/icon`, { icon: extra.icon })
    await sleep(40)
    return made
  }
  await note('old', home.id, w.old)
  await note('ideas', projects.id, w.ideas, { icon: 'lightbulb' })
  await note('soup', recipes.id, w.soup, { icon: 'food' })
  await note('receipt', home.id, w.receipt, { icon: 'receipt' })
  await note('cleaning', home.id, w.cleaning, { icon: 'cleaning' })
  await note('packing', travel.id, w.packing, { icon: 'suitcase', color: 'sky' })
  await note('plan', travel.id, w.plan, { icon: 'map' })
  await note('meeting', work.id, w.meeting, { icon: 'chat', color: 'blue' })
  await note('shopping', home.id, w.shopping, { pin: true, icon: 'shopping-cart', color: 'green' })
  await note('pancakes', recipes.id, w.pancakes, { pin: true, icon: 'chef-hat', color: 'honey' })
  for (const [index, [title, body, origin]] of w.inbox.entries()) await note(`inbox${index}`, null, [title, body], { origin })
  for (const upload of files) {
    const data = fs.readFileSync(path.join(samples, upload.file))
    const query = new URLSearchParams({ note_id: notes[upload.key].id, id: upload.id, name: upload.name })
    if (upload.receipt) query.set('text', 'device')
    await api(lena, 'POST', `/api/attachments?${query}`, undefined, { data, headers: { ...TAB, 'Content-Type': 'application/octet-stream' } })
    if (upload.receipt) {
      await api(lena, 'PUT', `/api/attachments/${upload.id}/text`, { pages: [{ text: w.receiptText, language }] })
    }
  }
  // In the trash, for its picture.
  await api(lena, 'DELETE', `/api/notes/${notes.old.id}`)
  // The guide itself, as every account has it.
  const guide = await api(lena, 'POST', '/api/guide', { language })
  // Somebody to share with, through an invitation.
  const invite = await api(lena, 'POST', '/api/invites', {})
  const jonas = await httpRequest.newContext({ baseURL: BASE, extraHTTPHeaders: TAB })
  await api(jonas, 'POST', `/api/invite/${invite.link.split('/').pop()}`, {
    display_name: w.jonas, email: 'jonas@example.com', password: PASSWORD, password_confirm: PASSWORD,
  })
  await api(jonas, 'PUT', '/api/me/language', { language })
  const people = await api(lena, 'GET', `/api/shares/people?q=${encodeURIComponent(w.jonas.split(' ')[0])}`)
  const person = people[0]
  await api(lena, 'PUT', `/api/shares/folder/${work.id}/people/${person.id}`, { level: 'write' })
  await api(lena, 'POST', '/api/tokens', { name: w.token, level: 'read', mcp: false, folders: null, expires: null }).catch(() => null)
  await lena.dispose()
  await jonas.dispose()
  return { folders: { home, recipes, work, projects, travel }, notes, guide, person }
}

// --- Pictures -----------------------------------------------------------------------------------------------------

async function signedIn(browser, language, options = {}) {
  const context = await browser.newContext({
    baseURL: BASE, locale: language === 'de' ? 'de-DE' : 'en-GB', viewport: { width: 1280, height: 800 },
    colorScheme: 'light', deviceScaleFactor: 1, timezoneId: 'Europe/Berlin', ...options,
  })
  const signed = await context.request.post('/api/auth/login', { data: { name: options.who ?? 'lena@example.com', password: PASSWORD }, headers: TAB })
  if (!signed.ok()) throw new Error('sign-in ' + signed.status())
  // A list wide enough for whole titles; every picture starts without the tabs of the one before.
  await context.addInitScript(() => {
    for (const account of [1, 2]) {
      localStorage.setItem(`nexnotes.column.list.${account}`, '340')
      if (!sessionStorage.getItem('guide-shots-kept-tabs')) localStorage.removeItem(`nexnotes.tabs.${account}`)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  return { context, page }
}

/** A region around some elements, with a margin, inside the page. */
async function around(page, locators, margin = 16) {
  const boxes = []
  for (const locator of locators) {
    const box = await locator.boundingBox()
    if (box) boxes.push(box)
  }
  if (!boxes.length) throw new Error('nothing to show')
  const size = page.viewportSize()
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin)
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin)
  const right = Math.min(size.width, Math.max(...boxes.map((box) => box.x + box.width)) + margin)
  const bottom = Math.min(size.height, Math.max(...boxes.map((box) => box.y + box.height)) + margin)
  return { x, y, width: right - x, height: bottom - y }
}

async function run(language, samples, out) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `nexnotes-guide-${language}-`))
  const server = await startServer(data)
  const done = []
  const failed = []
  try {
    const seeded = await seed(language, samples)
    const browser = await chromium.launch()
    try {
      const { page, context } = await signedIn(browser, language)
      const shoot = async (name, work) => {
        if (ONLY.size && !ONLY.has(name)) return
        try {
          const clip = await work()
          await page.waitForTimeout(250)
          await page.screenshot({ path: path.join(out, `${name}.png`), clip: clip ?? undefined, animations: 'disabled', caret: 'hide' })
          done.push(name)
        } catch (error) {
          failed.push(`${name}: ${String(error).split('\n')[0]}`)
          await page.screenshot({ path: path.join(out, `_failed-${name}.png`) }).catch(() => null)
        }
        await page.keyboard.press('Escape').catch(() => null)
        await page.keyboard.press('Escape').catch(() => null)
      }
      const s = seeded
      const openNote = async (folderId, noteId) => {
        await page.goto(`/folder/${folderId}?note=${noteId}`)
        await page.getByTestId('note-editor').first().waitFor()
        await page.waitForTimeout(900)
      }
      const L = (de, en) => (language === 'de' ? de : en)
      const w = WORDS[language]
      const pane = async () => {
        // The note beside the sidebar and the list: from the list's right edge to the page's.
        const list = await page.getByTestId('list-column').boundingBox().catch(() => null)
        const x = list ? Math.round(list.x + list.width) : 560
        return { x, y: 0, width: 1280 - x, height: 800 }
      }
      const row = (title) => page.getByTestId('note-list').getByText(title, { exact: true }).first()
      const menuAt = async (locator) => {
        await locator.click()
      }

      await shoot('overview', async () => {
        await openNote(s.folders.recipes.id, s.notes.pancakes.id)
      })
      await shoot('inbox', async () => {
        await page.goto('/inbox')
        await page.getByTestId('inbox-page').waitFor()
        await page.waitForTimeout(600)
      })
      await shoot('folder-style', async () => {
        await page.goto(`/folder/${s.folders.travel.id}`)
        await menuAt(page.getByTestId('folder-more'))
        await page.getByRole('menuitem', { name: L(/Symbol und Farbe/, /Symbol and color/) }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        return around(page, [dialog], 2)
      })
      await shoot('toolbar', async () => {
        await openNote(s.folders.work.id, s.notes.meeting.id)
        return { ...(await pane()), height: 330 }
      })
      await shoot('selection-bar', async () => {
        await openNote(s.folders.work.id, s.notes.meeting.id)
        await page.getByTestId('note-body').getByText(L('Umstellung', 'storeroom'), { exact: false }).first().dblclick()
        await page.getByTestId('selection-bar').waitFor()
        return { ...(await pane()), y: 120, height: 330 }
      })
      await shoot('checklist', async () => {
        await openNote(s.folders.home.id, s.notes.shopping.id)
        return pane()
      })
      await shoot('table', async () => {
        await openNote(s.folders.home.id, s.notes.cleaning.id)
        await page.getByTestId('note-body').locator('td').nth(4).click()
        await page.waitForTimeout(300)
        await page.getByRole('button', { name: L('Tabelle bearbeiten', 'Edit table'), exact: true }).first().click()
        await page.getByTestId('table-menu').waitFor()
        return pane()
      })
      await shoot('outline', async () => {
        await openNote(s.folders.work.id, s.notes.meeting.id)
        await page.setViewportSize({ width: 1600, height: 800 })
        await page.waitForTimeout(600)
        if (!(await page.getByTestId('outline').isVisible().catch(() => false))) {
          await page.getByRole('button', { name: L('Gliederung ein- oder ausblenden', 'Show or hide the outline') }).first().click()
        }
        await page.getByTestId('outline').waitFor()
        await page.getByTestId('fold').nth(1).click({ force: true })
        await page.mouse.move(5, 795)
      })
      await page.setViewportSize({ width: 1280, height: 800 })
      await shoot('paper', async () => {
        await openNote(s.folders.home.id, s.notes.cleaning.id)
        await page.getByTestId('note-menu').click()
        const menu = page.getByTestId('note-menu-panel')
        await menu.waitFor()
        return around(page, [menu, page.getByTestId('note-menu')], 14)
      })
      await shoot('note-icon', async () => {
        await openNote(s.folders.projects.id, s.notes.ideas.id)
        await page.getByRole('button', { name: L(/Symbol (ändern|wählen)/, /symbol/i) }).first().click()
        await page.getByTestId('note-icon-dialog').waitFor()
        return around(page, [page.getByRole('dialog')], 2)
      })
      await shoot('attachments', async () => {
        await openNote(s.folders.travel.id, s.notes.plan.id)
        await page.getByTestId('attachment-pdf').first().scrollIntoViewIfNeeded()
        await page.waitForTimeout(500)
        return pane()
      })
      await shoot('gallery', async () => {
        await page.goto('/')
        await page.getByRole('link', { name: L('Anhänge', 'Attachments'), exact: true }).first().click()
        await page.getByTestId('gallery-items').waitFor()
        await page.waitForTimeout(800)
      })
      await shoot('ocr', async () => {
        await openNote(s.folders.home.id, s.notes.receipt.id)
        await page.getByTestId('attachment-open-large').first().click()
        await page.getByTestId('ocr-show-text').first().click()
        await page.getByTestId('ocr-text').first().waitFor()
        await page.waitForTimeout(500)
      })
      await shoot('view-menu', async () => {
        await openNote(s.folders.home.id, s.notes.shopping.id)
        await page.getByTestId('list-view').click()
        const menu = page.getByTestId('list-view-menu')
        await menu.waitFor()
        return around(page, [menu, page.getByTestId('list-column')], 0)
      })
      await shoot('tiles', async () => {
        await page.goto('/')
        await page.getByTestId('list-view').click()
        await page.getByTestId('list-style-tiles').click()
        await page.keyboard.press('Escape')
        await page.waitForTimeout(800)
      })
      if (!ONLY.size || ONLY.has('tiles')) {
        await page.getByTestId('list-view').click()
        await page.getByTestId('list-style-list').click()
        await page.keyboard.press('Escape')
      }
      await shoot('pin-color', async () => {
        await openNote(s.folders.home.id, s.notes.shopping.id)
        await row(w.cleaning[0]).click({ button: 'right' })
        const menu = page.getByTestId('note-item-menu')
        await menu.waitFor()
        return around(page, [menu, page.getByTestId('list-column')], 0)
      })
      await shoot('tags', async () => {
        await page.goto('/')
        await page.getByRole('link', { name: L('#rezept', '#recipe'), exact: true }).first().click()
        await page.waitForTimeout(900)
      })
      await shoot('search', async () => {
        await page.goto('/')
        await page.waitForTimeout(500)
        await page.keyboard.press('Control+K')
        await page.getByTestId('search-field').locator('input').or(page.locator('input[data-testid="search-field"]')).first().fill(w.search)
        await page.getByTestId('search-hit').first().waitFor()
        await page.waitForTimeout(700)
      })
      await shoot('smart', async () => {
        await page.goto('/smart/new')
        await page.getByTestId('smart-name').fill(w.smartName)
        await page.getByTestId('smart-add').click()
        await page.getByTestId('smart-tag').first().fill(L('rezept', 'recipe'))
        await page.getByTestId('smart-add').click()
        await page.getByTestId('smart-kind').nth(1).selectOption('tasks')
        while ((await page.getByTestId('smart-condition-row').count()) > 2) await page.getByTestId('smart-remove').last().click()
        await page.waitForTimeout(1200)
      })
      await shoot('tabs', async () => {
        await openNote(s.folders.recipes.id, s.notes.pancakes.id)
        await page.evaluate(() => sessionStorage.setItem('guide-shots-kept-tabs', '1'))
        await row(w.soup[0]).click({ modifiers: ['Alt'] })
        await page.goto(`/folder/${s.folders.home.id}`)
        await page.getByTestId('note-list').waitFor()
        await row(w.shopping[0]).click({ modifiers: ['Alt'] })
        await row(w.cleaning[0]).click({ modifiers: ['Alt'] })
        await page.waitForTimeout(900)
      })
      await shoot('split', async () => {
        await row(w.packing ? w.shopping[0] : w.shopping[0]).click({ button: 'right' })
        await page.getByRole('menuitem', { name: L('Daneben öffnen', 'Open beside') }).click()
        await page.waitForTimeout(1200)
      })
      await page.evaluate(() => sessionStorage.removeItem('guide-shots-kept-tabs')).catch(() => null)
      await shoot('share', async () => {
        await openNote(s.folders.recipes.id, s.notes.pancakes.id)
        await page.getByTestId('note-menu').click()
        await page.getByTestId('note-share').click()
        const dialog = page.getByTestId('share-dialog')
        await dialog.waitFor()
        await dialog.locator('input').first().fill('Jonas')
        await page.getByTestId('share-found').getByText(w.jonas).first().click()
        await page.waitForTimeout(500)
        return around(page, [page.getByRole('dialog')], 2)
      })
      await shoot('share-link', async () => {
        await openNote(s.folders.recipes.id, s.notes.pancakes.id)
        await page.getByTestId('note-menu').click()
        await page.getByTestId('note-share').click()
        const dialog = page.getByTestId('share-dialog')
        await dialog.waitFor()
        await page.getByTestId('share-link-switch').click()
        await page.getByTestId('share-link-url').waitFor()
        await page.waitForTimeout(400)
        return around(page, [page.getByRole('dialog')], 2)
      })
      let other = null
      await shoot('presence', async () => {
        other = await signedIn(browser, language, { who: 'jonas@example.com' })
        await other.page.goto(`/notes/${s.notes.meeting.id}`)
        await other.page.getByTestId('note-body').first().waitFor()
        await other.page.waitForTimeout(800)
        await openNote(s.folders.work.id, s.notes.meeting.id)
        await other.page.getByTestId('note-body').getByText(L('Schulung vereinbaren', 'Arrange the training'), { exact: true }).first().click()
        await other.page.keyboard.press('End')
        await other.page.keyboard.press('Enter')
        await other.page.keyboard.type(L('Kasse testen', 'Try the new till'), { delay: 30 })
        await page.waitForTimeout(1500)
      })
      if (other) await other.context.close().catch(() => null)
      await shoot('notify', async () => {
        await page.goto(`/folder/${s.folders.work.id}`)
        await menuAt(page.getByTestId('folder-more'))
        await page.getByRole('menuitem', { name: L(/Mitteilungen/, /Notifications/) }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        await page.waitForTimeout(400)
        return around(page, [dialog], 2)
      })
      await shoot('vault', async () => {
        await openNote(s.folders.travel.id, s.notes.packing.id)
        await page.getByTestId('note-menu').click()
        await page.getByRole('menuitem', { name: L('Sperren', 'Lock') }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        await page.waitForTimeout(300)
        return around(page, [dialog], 2)
      })
      await shoot('history', async () => {
        const tree = await (await context.request.get('/api/folders')).json()
        const first = tree.folders.find((folder) => folder.parent_id === s.guide.id && folder.name === L('Erste Schritte', 'Getting started'))
        const list = await (await context.request.get(`/api/notes?folder_id=${first.id}`)).json()
        const welcome = list.find((item) => item.title === L('Willkommen bei nexnotes', 'Welcome to nexnotes'))
        await page.goto(`/folder/${first.id}?note=${welcome.id}`)
        await page.getByTestId('note-body').waitFor()
        await page.getByTestId('note-body').getByText(L('Schön, dass du da bist!', 'Good to have you here!'), { exact: false }).first().click()
        await page.keyboard.press('End')
        await page.keyboard.type(L(' Los geht es.', ' Here we go.'))
        await page.waitForTimeout(1500)
        await page.goto(`/notes/${welcome.id}/history`)
        await page.getByTestId('history-item').first().waitFor()
        await page.getByTestId('history-item').first().click()
        await page.waitForTimeout(900)
      })
      await shoot('trash', async () => {
        await page.goto('/trash')
        await page.waitForTimeout(900)
      })
      await shoot('export', async () => {
        await openNote(s.folders.travel.id, s.notes.plan.id)
        await page.getByTestId('note-menu').click()
        await page.getByTestId('note-export').click()
        const dialog = page.getByTestId('export-dialog')
        await dialog.waitFor()
        await page.waitForTimeout(800)
        return around(page, [dialog], 2)
      })
      await shoot('nextasks', async () => {
        await page.goto('/settings/connections')
        const card = page.locator('section').filter({ hasText: 'nextasks' }).first()
        await card.waitFor()
        await card.scrollIntoViewIfNeeded()
        return around(page, [card], 12)
      })
      await shoot('tokens', async () => {
        await page.goto('/settings/connections')
        const card = page.locator('section').filter({ hasText: L('API-Token', 'API token') }).first()
        await card.waitFor()
        await card.scrollIntoViewIfNeeded()
        return around(page, [card], 12)
      })
      await shoot('token-dialog', async () => {
        await page.goto('/settings/connections')
        await page.getByRole('button', { name: L('Neuer API-Token', 'New API token') }).first().click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        await page.waitForTimeout(400)
        return around(page, [dialog], 2)
      })
      await shoot('new-note', async () => {
        await page.goto(`/folder/${s.folders.home.id}`)
        await page.getByTestId('new-note').first().click()
        await page.getByTestId('note-title').first().waitFor()
        await page.waitForTimeout(500)
        await page.keyboard.type(w.newNoteTitle)
        await page.waitForTimeout(400)
      })
      if (!ONLY.size || ONLY.has('phone')) {
        const phone = await signedIn(browser, language, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
        try {
          await phone.page.goto('/folders')
          await phone.page.waitForTimeout(1200)
          await phone.page.screenshot({ path: path.join(out, 'phone.png'), animations: 'disabled' })
          done.push('phone')
        } catch (error) {
          failed.push(`phone: ${String(error).split('\n')[0]}`)
        } finally {
          await phone.context.close()
        }
      }
      await context.close()
    } finally {
      await browser.close()
    }
  } finally {
    server.kill()
    await sleep(800)
    fs.rmSync(data, { recursive: true, force: true })
  }
  return { done, failed }
}

const samples = fs.mkdtempSync(path.join(os.tmpdir(), 'nexnotes-guide-samples-'))
execFileSync(PYTHON, [path.join(HERE, 'guide-shots.py'), 'samples', samples], { stdio: 'inherit' })
for (const language of LANGUAGES) {
  const pngs = fs.mkdtempSync(path.join(os.tmpdir(), `nexnotes-guide-png-${language}-`))
  const { done, failed } = await run(language, samples, pngs)
  console.log(`${language}: ${done.length} pictures${failed.length ? `, failed: \n  ${failed.join('\n  ')}` : ''}`)
  const target = process.env.NEXNOTES_SHOTS_OUT ? path.join(process.env.NEXNOTES_SHOTS_OUT, language) : path.join(BACKEND, 'app', 'guide', language, 'shots')
  for (const name of fs.readdirSync(pngs).filter((file) => file.startsWith('_failed-'))) {
    fs.copyFileSync(path.join(pngs, name), path.join(os.tmpdir(), `nexnotes-guide-${language}${name}`))
    fs.rmSync(path.join(pngs, name))
  }
  console.log(execFileSync(PYTHON, [path.join(HERE, 'guide-shots.py'), 'webp', pngs, target]).toString().trim())
  fs.rmSync(pngs, { recursive: true, force: true })
}
fs.rmSync(samples, { recursive: true, force: true })
