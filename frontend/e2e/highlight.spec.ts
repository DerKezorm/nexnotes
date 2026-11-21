/**
 * NOTES-3 AC-11 and AC-13 in a real browser, as found in the second review: the highlighter sits in the line without
 * moving a letter, one undo takes exactly the marker back (redo sets it again), and the selection never looks like a
 * marker nor changes a marker's colour.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-highlight' }
const TEXT = 'fafasdfasdfaf'
/** "asdfasd" in TEXT. */
const FROM = 3
const TO = 10

/** The box of the characters FROM..TO of the first paragraph, however the marks split its text. */
async function charBox(page: Page, from: number, to: number) {
  return page.evaluate(
    ([start, end]) => {
      const paragraph = document.querySelector('.nn-editor .ProseMirror p')!
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let seen = 0
      let started = false
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        const length = node.data.length
        if (!started && start <= seen + length) {
          range.setStart(node, start - seen)
          started = true
        }
        if (started && end <= seen + length) {
          range.setEnd(node, end - seen)
          break
        }
        seen += length
      }
      const rect = range.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    },
    [from, to],
  )
}

/** The colour most of the word's pixels have: the ground behind the letters (marker, selection or page). */
async function groundOf(page: Page): Promise<[number, number, number]> {
  const box = await charBox(page, FROM, TO)
  const shot = await page.screenshot({ clip: { x: box.left + 1, y: box.top + 1, width: box.right - box.left - 2, height: box.bottom - box.top - 2 } })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    const counts = new Map<string, number>()
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    return top.split(',').map(Number) as [number, number, number]
  }, shot.toString('base64'))
}

/** Hue in degrees and saturation 0..1 (HSL). */
function hueOf([r, g, b]: [number, number, number]): { hue: number; saturation: number } {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const light = (max + min) / 2
  if (max === min) return { hue: 0, saturation: 0 }
  const delta = max - min
  const saturation = delta / (1 - Math.abs(2 * light - 1))
  let hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return { hue, saturation }
}

/** "asdfasd" selected with the keyboard, as one does; again if the editor was not ready for the first keys. */
async function selectWord(page: Page) {
  await expect(async () => {
    await page.locator('.nn-editor .ProseMirror p').first().click()
    await page.keyboard.press('Home')
    for (let i = 0; i < FROM; i++) await page.keyboard.press('ArrowRight')
    for (let i = FROM; i < TO; i++) await page.keyboard.press('Shift+ArrowRight')
    expect(await page.evaluate(() => String(window.getSelection()))).toBe('asdfasd')
  }).toPass({ timeout: 10_000 })
}

for (const theme of ['dark', 'light'] as const) {
  test(`NOTES-3 AC-11 AC-13 the highlighter moves no letter, one undo takes it back, the selection keeps its colour (${theme})`, async ({ page }) => {
    const made = await page.request.post('/api/notes', { data: { title: `Highlighter ${theme}`, markdown: TEXT }, headers: TAB })
    const id = (await made.json()).id as string
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/notes/${id}`)
    await page.evaluate((chosen) => {
      if (chosen === 'light') document.documentElement.setAttribute('data-theme', 'light')
      else document.documentElement.removeAttribute('data-theme')
    }, theme)
    const marks = page.locator('.nn-editor .ProseMirror mark')
    await expect(page.locator('.nn-editor .ProseMirror p').first()).toHaveText(TEXT)

    const before = { word: await charBox(page, FROM, TO), after: await charBox(page, TO, TEXT.length), all: await charBox(page, 0, TEXT.length) }
    await selectWord(page)
    await page.getByTestId('tool-highlight').first().click()
    await page.getByTestId('highlight-honey').click()
    await expect(marks).toHaveCount(1)
    await expect(marks).toHaveText('asdfasd')

    // (a) No gap: every letter stays where it was, the paragraph as wide as before.
    const after = { word: await charBox(page, FROM, TO), after: await charBox(page, TO, TEXT.length), all: await charBox(page, 0, TEXT.length) }
    for (const part of ['word', 'after', 'all'] as const) {
      expect(Math.abs(after[part].left - before[part].left), `${part} left`).toBeLessThan(0.5)
      expect(Math.abs(after[part].right - before[part].right), `${part} right`).toBeLessThan(0.5)
    }

    // (c) The marker selected and not selected: the same honey. Plain selected text never looks like a marker.
    const markedSelected = hueOf(await groundOf(page))
    await page.keyboard.press('End')
    await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toBe('')
    const marked = hueOf(await groundOf(page))
    expect(marked.saturation).toBeGreaterThan(0.25)
    expect(Math.abs(marked.hue - 42)).toBeLessThan(12)
    expect(Math.abs(markedSelected.hue - marked.hue)).toBeLessThan(8)
    expect(markedSelected.saturation).toBeGreaterThan(0.25)

    // (b) One undo from the toolbar takes exactly the marker back; redo sets it again.
    await selectWord(page)
    await page.getByTestId('tool-undo').first().click()
    await expect(marks).toHaveCount(0)
    await expect(page.locator('.nn-editor .ProseMirror p').first()).toHaveText(TEXT)
    await expect(page.getByTestId('tool-undo').first()).toBeDisabled()
    const plainSelected = hueOf(await groundOf(page))
    expect(plainSelected.saturation, 'the selection is not honey').toBeLessThan(0.15)
    await page.getByTestId('tool-redo').first().click()
    await expect(marks).toHaveCount(1)
    await expect(marks).toHaveText('asdfasd')
    await expect(marks).toHaveAttribute('data-color', 'honey')
  })
}
