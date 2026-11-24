/**
 * The screenshots of the README, from the real interface: `docs/screenshots/*.png`.
 *
 *   npm run build
 *   node e2e/readme-shots.mjs           every picture
 *   node e2e/readme-shots.mjs note-dark  only the ones named
 *
 * The server, the made-up example notes (Lena and Jonas, addresses at example.com) and the sign-in come from
 * `guide-shots.mjs`, in English. Headless Chromium at 1080 × 675 with twice the pixels, one worker; the phone at
 * 390 × 844. Light or dark as the name of the picture says.
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HERE, PYTHON, WORDS, seed, signedIn, sleep, startServer } from './guide-shots.mjs'

const OUT = path.resolve(HERE, '..', '..', 'docs', 'screenshots')
const ONLY = new Set(process.argv.slice(2))
const DESK = { viewport: { width: 1080, height: 675 }, deviceScaleFactor: 2 }
const w = WORDS.en

const samples = fs.mkdtempSync(path.join(os.tmpdir(), 'nexnotes-readme-samples-'))
execFileSync(PYTHON, [path.join(HERE, 'guide-shots.py'), 'samples', samples], { stdio: 'inherit' })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nexnotes-readme-'))
const server = await startServer(data)
const done = []
const failed = []
try {
  const s = await seed('en', samples)
  const browser = await chromium.launch()
  try {
    /** One picture in a context of its own, so that nothing of the one before shows. */
    const shoot = async (name, options, work) => {
      if (ONLY.size && !ONLY.has(name)) return
      const scheme = name.endsWith('-dark') ? 'dark' : 'light'
      const { context, page } = await signedIn(browser, 'en', { ...DESK, colorScheme: scheme, ...options })
      try {
        // What the work hands back is cleared away after the picture (another person's window, say).
        const after = await work(page, context)
        await page.mouse.move(2, 2)
        await page.waitForTimeout(400)
        await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' })
        if (after) await after()
        done.push(name)
      } catch (error) {
        failed.push(`${name}: ${String(error).split('\n')[0]}`)
        await page.screenshot({ path: path.join(os.tmpdir(), `nexnotes-readme-failed-${name}.png`) }).catch(() => null)
      } finally {
        await context.close()
      }
    }
    const openNote = async (page, folderId, noteId) => {
      await page.goto(`/folder/${folderId}?note=${noteId}`)
      await page.getByTestId('note-editor').first().waitFor()
      await page.waitForTimeout(900)
    }
    const row = (page, title) => page.getByTestId('note-list').getByText(title, { exact: true }).first()

    await shoot('note-dark', {}, async (page) => {
      await openNote(page, s.folders.recipes.id, s.notes.pancakes.id)
    })
    await shoot('live-light', {}, async (page) => {
      const other = await signedIn(browser, 'en', { ...DESK, who: 'jonas@example.com' })
      {
        await other.page.goto(`/notes/${s.notes.meeting.id}`)
        await other.page.getByTestId('note-body').first().waitFor()
        await other.page.waitForTimeout(800)
        await openNote(page, s.folders.work.id, s.notes.meeting.id)
        await other.page.getByTestId('note-body').getByText('Arrange the training', { exact: true }).first().click()
        await other.page.keyboard.press('End')
        await other.page.keyboard.press('Enter')
        await other.page.keyboard.type('Try the new till', { delay: 30 })
        await page.waitForTimeout(1500)
        // The line being written, with the other person's cursor, in the middle of the picture.
        await page.getByTestId('note-body').getByText('Try the new till').first().evaluate((line) => line.scrollIntoView({ block: 'center' }))
        await page.waitForTimeout(400)
      }
      return () => other.context.close()
    })
    await shoot('split-dark', {}, async (page) => {
      await openNote(page, s.folders.recipes.id, s.notes.pancakes.id)
      await page.evaluate(() => sessionStorage.setItem('guide-shots-kept-tabs', '1'))
      await row(page, w.soup[0]).click({ modifiers: ['Alt'] })
      await page.goto(`/folder/${s.folders.home.id}`)
      await page.getByTestId('note-list').waitFor()
      await row(page, w.shopping[0]).click({ modifiers: ['Alt'] })
      await row(page, w.cleaning[0]).click({ modifiers: ['Alt'] })
      await page.waitForTimeout(900)
      await row(page, w.shopping[0]).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Open beside' }).click()
      await page.waitForTimeout(800)
      // The sidebar folded too, so that both notes have room for their tables.
      await page.getByTestId('list-strip-sidebar').click()
      await page.waitForTimeout(1200)
    })
    await shoot('focus-light', {}, async (page) => {
      await openNote(page, s.folders.work.id, s.notes.meeting.id)
      await page.getByTestId('sidebar-collapse').click()
      await page.waitForTimeout(400)
      await page.getByTestId('list-collapse').click()
      await page.waitForTimeout(900)
    })
    await shoot('ocr-light', {}, async (page) => {
      await openNote(page, s.folders.home.id, s.notes.receipt.id)
      await page.getByTestId('attachment-open-large').first().click()
      await page.getByTestId('ocr-show-text').first().click()
      await page.getByTestId('ocr-text').first().waitFor()
      await page.waitForTimeout(500)
    })
    await shoot('phone-dark', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
      await page.goto('/folders')
      await page.waitForTimeout(1200)
    })
  } finally {
    await browser.close()
  }
} finally {
  server.kill()
  await sleep(800)
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(samples, { recursive: true, force: true })
}
console.log(`${done.length} pictures in ${OUT}${failed.length ? `, failed:\n  ${failed.join('\n  ')}` : ''}`)
if (failed.length) process.exitCode = 1
