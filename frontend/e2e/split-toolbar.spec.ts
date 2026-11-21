/**
 * The one toolbar over two notes side by side (NOTES-8, decision of 21.11.2026), in a real browser at 1920 px.
 *
 * - With both sides on show the text tools stand once, above both sides; each sheet keeps a small bar of its own at the
 *   top right (width, outline, pin, the others, the note's menu) and no text tools.
 * - The bar works on the side used last and shows that side's state; a click into the other side moves it there.
 * - A click in the bar keeps the selection in the text and the side used last.
 * - It stays in sight while the text below scrolls; one note alone keeps its own bar as before.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-split-toolbar' }

async function note(page: Page, title: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, markdown }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

const pane = (page: Page, side: 'left' | 'right') => page.locator(`[data-testid="tab-pane"][data-side="${side}"]`)
const bar = (page: Page) => page.getByTestId('shared-toolbar')

/** `first` on the left, `second` beside it on the right (the side used last), at 1920 px. */
async function twoNotes(page: Page, first: string, second: string, firstText: string, secondText: string): Promise<void> {
  const id = await note(page, first, firstText)
  await note(page, second, secondText)
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto(`/notes/${id}`)
  await page.getByTestId('note-row').filter({ hasText: second }).click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(pane(page, 'left')).toBeVisible()
  await expect(pane(page, 'right')).toBeVisible()
  await expect(bar(page).getByTestId('tool-bold')).toBeVisible()
}

/** Chooses `word` in the text of a side by a double click on the word itself (which also makes that side the one used
 * last). A double click on the paragraph would land in its middle, on whichever word stands there. */
async function choose(page: Page, side: 'left' | 'right', word: string): Promise<void> {
  const body = pane(page, side).getByTestId('note-body')
  await expect(body).toContainText(word)
  const at = await body.evaluate((element, word) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent!.indexOf(word)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + word.length)
      const box = range.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    return null
  }, word)
  expect(at, word).not.toBeNull()
  await page.mouse.dblclick(at!.x, at!.y)
}

test('NOTES-8 AC-1 at 1920 px one toolbar stands over both notes; each sheet keeps a small bar of its own', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await twoNotes(page, `Bread ${stamp}`, `Market ${stamp}`, 'flour water salt', 'apples pears plums')
  const shared = bar(page)
  const toolbar = shared.getByRole('toolbar')
  await expect(toolbar).toHaveAttribute('aria-label', `Tools for “Market ${stamp}” (right)`)
  // Above both sides, across both.
  const top = (await shared.boundingBox())!
  const left = (await pane(page, 'left').boundingBox())!
  const right = (await pane(page, 'right').boundingBox())!
  expect(top.y + top.height).toBeLessThanOrEqual(left.y + 1)
  expect(top.x).toBeLessThanOrEqual(left.x + 1)
  expect(top.x + top.width).toBeGreaterThanOrEqual(right.x + right.width - 1)
  // One or two rows, no scroll bar, the text tools only.
  const box = await toolbar.evaluate((element) => ({ height: element.getBoundingClientRect().height, scroll: element.scrollWidth - element.clientWidth }))
  expect(box.height).toBeLessThan(2 * 34 + 4 + 4)
  expect(box.scroll).toBeLessThanOrEqual(0)
  await expect(shared.getByTestId('tool-width')).toHaveCount(0)
  await expect(shared.getByTestId('tool-outline')).toHaveCount(0)
  // Each head: no text tools, its own at the top right of the side.
  for (const side of ['left', 'right'] as const) {
    const head = pane(page, side).getByTestId('editor-head')
    await expect(head.locator('[data-tool]')).toHaveCount(0)
    const own = head.getByTestId('note-tools')
    await expect(own).toHaveAttribute('role', 'group')
    for (const one of ['tool-width', 'tool-outline', 'note-menu']) await expect(own.getByTestId(one)).toBeVisible()
    const ownBox = (await own.boundingBox())!
    const sideBox = (await pane(page, side).boundingBox())!
    expect(ownBox.x).toBeGreaterThan(sideBox.x + sideBox.width / 2)
  }
})

test('NOTES-8 AC-1 the bar works on the side used last and shows its state; a click in the other side moves it there', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await twoNotes(page, `Left ${stamp}`, `Right ${stamp}`, 'lentils onions carrots', 'milk bread butter')
  await choose(page, 'right', 'bread')
  await bar(page).getByTestId('tool-bold').click()
  await expect(pane(page, 'right').locator('.ProseMirror strong')).toHaveText('bread')
  await expect(pane(page, 'left').locator('.ProseMirror strong')).toHaveCount(0)
  await expect(bar(page).getByTestId('tool-bold')).toHaveAttribute('aria-pressed', 'true')
  await expect(bar(page).getByTestId('tool-undo')).toBeEnabled()

  // Into the left text: the bar names it and shows its state at once.
  await choose(page, 'left', 'onions')
  await expect(pane(page, 'left')).toHaveAttribute('data-focused', 'true')
  await expect(bar(page).getByRole('toolbar')).toHaveAttribute('aria-label', `Tools for “Left ${stamp}” (left)`)
  await expect(bar(page).getByTestId('tool-bold')).toHaveAttribute('aria-pressed', 'false')
  await expect(bar(page).getByTestId('tool-undo')).toBeDisabled()
  await bar(page).getByTestId('tool-italic').click()
  await expect(pane(page, 'left').locator('.ProseMirror em')).toHaveText('onions')
  await expect(pane(page, 'right').locator('.ProseMirror em')).toHaveCount(0)
  // The text style: a heading on the left, the right still body text.
  await bar(page).locator('#nn-text-style').selectOption('h2')
  await expect(pane(page, 'left').locator('.ProseMirror h2')).toHaveCount(1)
  await choose(page, 'right', 'milk')
  await expect(bar(page).locator('#nn-text-style')).toHaveValue('p')
  // Ctrl+B stays the editor's own.
  await page.keyboard.press('Control+b')
  await expect(pane(page, 'right').locator('.ProseMirror strong').first()).toHaveText('milk')
})

test('NOTES-8 AC-1 a click in the bar keeps the selection in the text and the side used last', async ({ page }) => {
  const stamp = Date.now().toString(36)
  await twoNotes(page, `Keep ${stamp}`, `Mark ${stamp}`, 'first second third', 'alpha beta gamma')
  await choose(page, 'right', 'beta')
  await expect(pane(page, 'right')).toHaveAttribute('data-focused', 'true')
  for (const one of ['tool-underline', 'tool-strike']) {
    await bar(page).getByTestId(one).click()
    await expect(pane(page, 'right')).toHaveAttribute('data-focused', 'true')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('beta')
  }
  await expect(pane(page, 'right').locator('.ProseMirror u')).toHaveText('beta')
  await expect(pane(page, 'right').locator('.ProseMirror s')).toHaveText('beta')
  // The highlighter's colors: chosen from the menu, on the same selection.
  await bar(page).getByTestId('tool-highlight').click()
  await page.getByTestId('highlight-honey').click()
  await expect(pane(page, 'right').locator('.ProseMirror mark')).toHaveText('beta')
  await expect(pane(page, 'right')).toHaveAttribute('data-focused', 'true')
  // The arrows move inside the bar, Escape goes back to the text of the side used last.
  await bar(page).getByTestId('tool-bold').focus()
  await page.keyboard.press('ArrowRight')
  await expect(bar(page).getByTestId('tool-italic')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pane(page, 'right').getByTestId('note-body')).toBeFocused()
})

test("NOTES-8 AC-1 a sheet's own bar works on its own note, and the text tools stay in sight while it scrolls", async ({ page }) => {
  const stamp = Date.now().toString(36)
  const long = Array.from({ length: 120 }, (_, index) => `Line ${index} of a long note.`).join('\n\n')
  await twoNotes(page, `Long ${stamp}`, `Short ${stamp}`, long, 'short text')
  // The left sheet's menu chooses the paper of the left note, the right stays as it was.
  await pane(page, 'left').getByTestId('note-menu').click()
  await page.getByTestId('paper-lined').click()
  await expect(pane(page, 'left').getByTestId('note-paper')).toHaveAttribute('data-paper', 'lined')
  await expect(pane(page, 'right').getByTestId('note-paper')).toHaveAttribute('data-paper', 'blank')
  // The long left text scrolls; the bar over both does not move, the left head stays at the top of its side.
  const before = (await bar(page).boundingBox())!
  await pane(page, 'left').evaluate((element) => element.scrollTo(0, element.scrollHeight))
  await page.waitForTimeout(200)
  const after = (await bar(page).boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  await expect(bar(page).getByTestId('tool-bold')).toBeInViewport()
  await expect(pane(page, 'left').getByTestId('note-menu')).toBeInViewport()
})

test('NOTES-8 one note alone at 1920 px keeps its own toolbar as before', async ({ page }) => {
  const id = await note(page, `Alone ${Date.now().toString(36)}`, 'text')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto(`/notes/${id}`)
  const head = page.getByTestId('editor-head')
  await expect(head.getByTestId('tool-bold')).toBeVisible()
  await expect(head.getByTestId('tool-width')).toBeVisible()
  await expect(page.getByTestId('shared-toolbar')).toHaveCount(0)
})
