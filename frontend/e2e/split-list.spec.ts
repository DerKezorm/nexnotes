/**
 * The list beside two notes (NOTES-8 AC-9, decision of 21.11.2026 "column, else drawer") and the side used last
 * standing out (NOTES-8 AC-1), in a real browser at 1920 and 1600 px.
 *
 * - With room (both sides keep 480 px, fifth review) the list is a column between the sidebar and the two notes; the button
 *   "List" hides and shows it, and the choice stays on this device.
 * - With less (here: the list dragged to its widest at 1600 px) a folder chosen in the sidebar opens the list as a
 *   drawer over the left note; a note chosen in it opens on the side used last and closes it; Escape closes it and
 *   gives the focus back.
 * - The side used last has a honey frame around its sheet, the other is dimmed; a click there makes it the one.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-split-list' }

async function folder(page: Page, name: string): Promise<string> {
  const made = await page.request.post('/api/folders', { data: { name }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

async function note(page: Page, title: string, folderId: string, markdown: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { title, folder_id: folderId, markdown }, headers: TAB })
  expect(made.ok()).toBe(true)
  return (await made.json()).id as string
}

const pane = (page: Page, side: 'left' | 'right') => page.locator(`[data-testid="tab-pane"][data-side="${side}"]`)
const row = (page: Page, title: string) => page.getByTestId('note-row').filter({ hasText: title })

/** Two notes of `folderId` side by side: `first` on the left, `second` on the right (the side used last). */
async function twoNotes(page: Page, folderId: string, first: string, second: string): Promise<void> {
  await page.goto(`/folder/${folderId}`)
  await row(page, first).click()
  await row(page, second).click({ button: 'right' })
  await page.getByTestId('menu-open-beside').click()
  await expect(pane(page, 'right')).toBeVisible()
  await expect(pane(page, 'left')).toBeVisible()
}

test('NOTES-8 AC-9 at 1920 px the list stands as a column beside two notes; "List" hides it, kept after a reload', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const a = await folder(page, `Desk ${stamp}`)
  const b = await folder(page, `Shed ${stamp}`)
  await note(page, `Letter ${stamp}`, a, 'dear')
  await note(page, `Invoice ${stamp}`, a, 'total')
  await note(page, `Hammer ${stamp}`, b, 'heavy')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await twoNotes(page, a, `Letter ${stamp}`, `Invoice ${stamp}`)

  const column = page.getByTestId('list-column')
  await expect(column).toBeVisible()
  // Between the sidebar and the notes, and both notes keep at least 480 px.
  const listBox = (await column.boundingBox())!
  const leftBox = (await pane(page, 'left').boundingBox())!
  const rightBox = (await pane(page, 'right').boundingBox())!
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(leftBox.x + 1)
  expect(leftBox.width).toBeGreaterThanOrEqual(480)
  expect(rightBox.width).toBeGreaterThanOrEqual(480)
  // Another folder from the sidebar: the column shows it, the notes stay.
  await page.getByRole('treeitem', { name: new RegExp(`^Shed ${stamp}, `) }).click()
  await expect(page.getByTestId('note-list')).toHaveAttribute('data-folder', b)
  await expect(row(page, `Hammer ${stamp}`)).toBeVisible()
  await expect(page.getByTestId('list-drawer')).toHaveCount(0)

  // "List" hides the column; the notes take the room; the choice stays after a reload.
  const toggle = page.getByTestId('tab-list-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(column).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect(pane(page, 'right')).toBeVisible()
  await expect(page.getByTestId('list-column')).toHaveCount(0)
  await page.getByTestId('tab-list-toggle').click()
  await expect(page.getByTestId('list-column')).toBeVisible()
})

test('NOTES-8 AC-9 at 1600 px with a wide list: a folder chosen opens the list as a drawer, a note chosen opens on the side used last', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const a = await folder(page, `Office ${stamp}`)
  const b = await folder(page, `Cellar ${stamp}`)
  await note(page, `Minutes ${stamp}`, a, 'agenda')
  await note(page, `Budget ${stamp}`, a, 'sum')
  await note(page, `Wine ${stamp}`, b, 'red')
  await page.setViewportSize({ width: 1600, height: 900 })

  // At the default width the column still fits beside two notes (1340 px of page: 300 + 2 × 514 + 12; each side keeps
  // 480 px beside the column since the fifth review, so 1280 px no longer hold it).
  await twoNotes(page, a, `Minutes ${stamp}`, `Budget ${stamp}`)
  await expect(page.getByTestId('list-column')).toBeVisible()
  // The list at its widest leaves the two notes too little: no column, the button opens a drawer.
  await page.getByTestId('column-handle-list').focus()
  await page.keyboard.press('End')
  await expect(page.getByTestId('list-column')).toHaveCount(0)
  const toggle = page.getByTestId('tab-list-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // A folder from the sidebar: the drawer slides in right beside the sidebar, over the left note, with its list.
  const cellar = page.getByRole('treeitem', { name: new RegExp(`^Cellar ${stamp}, `) })
  await cellar.click()
  const drawer = page.getByTestId('list-drawer')
  await expect(drawer).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(drawer.getByTestId('note-list')).toHaveAttribute('data-folder', b)
  const drawerBox = (await drawer.boundingBox())!
  const leftBox = (await pane(page, 'left').boundingBox())!
  expect(Math.round(drawerBox.width)).toBe(560)
  expect(Math.abs(drawerBox.x - leftBox.x)).toBeLessThanOrEqual(2)

  // Escape closes it, the focus goes back to the folder.
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(cellar).toBeFocused()

  // The same folder again opens it; a note chosen opens on the right (the side used last) and closes it.
  await cellar.click()
  await expect(drawer).toBeVisible()
  await drawer.getByTestId('note-row').filter({ hasText: `Wine ${stamp}` }).click()
  await expect(drawer).toHaveCount(0)
  await expect(pane(page, 'right')).toHaveAttribute('data-note', /.+/)
  await expect(pane(page, 'right').getByTestId('note-title')).toHaveValue(`Wine ${stamp}`)
  await expect(pane(page, 'left').getByTestId('note-title')).toHaveValue(`Minutes ${stamp}`)

  // "List" opens it with the focus inside; a click beside it closes it.
  await toggle.click()
  await expect(drawer).toBeFocused()
  await pane(page, 'right').click({ position: { x: 200, y: 300 } })
  await expect(drawer).toHaveCount(0)

  // Alt-click in the drawer opens a tab and keeps the drawer open.
  await toggle.click()
  await drawer.getByTestId('note-row').filter({ hasText: `Wine ${stamp}` }).waitFor()
  await page.getByRole('treeitem', { name: new RegExp(`^Office ${stamp}, `) }).click()
  await drawer.getByTestId('note-row').filter({ hasText: `Budget ${stamp}` }).click({ modifiers: ['Alt'] })
  // Budget's tab took Wine on the right before: Alt-click gives Budget a tab of its own.
  await expect(page.getByTestId('tab-title')).toHaveCount(3)
  await expect(page.getByTestId('tab-title').filter({ hasText: `Budget ${stamp}` })).toHaveCount(1)
  await expect(drawer).toBeVisible()
})

test('NOTES-8 AC-1 two notes side by side: the side used last has a honey frame, the other is dimmed, a click makes it the one', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const a = await folder(page, `Studio ${stamp}`)
  await note(page, `Sketch ${stamp}`, a, 'lines')
  await note(page, `Palette ${stamp}`, a, 'colors')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await twoNotes(page, a, `Sketch ${stamp}`, `Palette ${stamp}`)

  const sheet = (side: 'left' | 'right') => pane(page, side).getByTestId('note-page')
  const title = (side: 'left' | 'right') => pane(page, side).getByTestId('note-title')
  // The values of the colors in the look the page shows (light or dark): sheet and text, active and set back.
  const light = (await page.locator('html').getAttribute('data-theme')) === 'light'
  const look = light
    ? { sheet: 'rgb(255, 255, 255)', backSheet: 'rgb(236, 236, 242)', text: 'rgb(20, 20, 26)', backText: 'rgb(97, 97, 111)' }
    : { sheet: 'rgb(22, 22, 29)', backSheet: 'rgb(11, 11, 15)', text: 'rgb(242, 242, 245)', backText: 'rgb(138, 138, 151)' }
  await expect(pane(page, 'right')).toHaveAttribute('data-split', 'active')
  await expect(pane(page, 'left')).toHaveAttribute('data-split', 'passive')
  await expect(sheet('right')).toHaveCSS('outline-width', '2px')
  await expect(sheet('right')).toHaveCSS('outline-color', 'rgb(242, 193, 78)')
  await expect(sheet('left')).toHaveCSS('outline-style', 'none')
  // The other side clearly set back (fifth review): its sheet on the page's gray, its text one dimmed gray.
  await expect(sheet('left')).toHaveCSS('background-color', look.backSheet)
  await expect(sheet('right')).toHaveCSS('background-color', look.sheet)
  await expect(title('left')).toHaveCSS('color', look.backText)
  await expect(title('right')).toHaveCSS('color', look.text)

  // A click in the dimmed side makes it the one at once.
  await sheet('left').click({ position: { x: 80, y: 160 } })
  await expect(pane(page, 'left')).toHaveAttribute('data-split', 'active')
  await expect(pane(page, 'right')).toHaveAttribute('data-split', 'passive')
  await expect(sheet('left')).toHaveCSS('outline-width', '2px')
  await expect(title('right')).toHaveCSS('color', look.backText)
  await expect(title('left')).toHaveCSS('color', look.text)

  // One note again: no frame, nothing dimmed.
  await page.getByTestId('tab-end-split').click()
  await expect(pane(page, 'left')).not.toHaveAttribute('data-split', /.*/)
  await expect(page.getByTestId('note-page').first()).toHaveCSS('outline-style', 'none')
})
