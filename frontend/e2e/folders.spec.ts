/**
 * NOTES-4 in a real browser against the real server: folders made in the sidebar, a folder dragged onto another
 * (the browser's own drag and drop), the trash with "Undo", the path of a folder page, and the keyboard alone.
 * The page is the operator of global-setup.ts.
 */
import { expect, test, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-folders0' }

type Tree = { inbox: { id: string; count: number }; folders: { id: string; name: string; parent_id: string | null }[] }

async function tree(page: Page): Promise<Tree> {
  return (await (await page.request.get('/api/folders')).json()) as Tree
}

async function make(page: Page, name: string, parent_id: string | null = null): Promise<string> {
  const answer = await page.request.post('/api/folders', { data: { name, parent_id }, headers: TAB })
  expect(answer.status()).toBe(201)
  return ((await answer.json()) as { id: string }).id
}

function row(page: Page, name: string) {
  return page.getByRole('treeitem', { name: new RegExp(`^${name}, `) })
}

function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  return problems
}

test('NOTES-4 AC-1 AC-3 AC-5 folders made in the sidebar, one dragged onto another, trashed and brought back', async ({ page }) => {
  const problems = watchProblems(page)
  const stamp = Date.now().toString(36)
  await page.goto('/')
  await page.getByRole('button', { name: 'New folder at the top' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill(`Work ${stamp}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(row(page, `Work ${stamp}`)).toBeVisible()

  await row(page, `Work ${stamp}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New subfolder' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('Projects')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(row(page, 'Projects')).toBeVisible()

  const home = `Home ${stamp}`
  await make(page, home)
  await page.reload()
  await row(page, home).dragTo(row(page, `Work ${stamp}`))
  await expect.poll(async () => (await tree(page)).folders.find((f) => f.name === home)?.parent_id).toBe(
    (await tree(page)).folders.find((f) => f.name === `Work ${stamp}`)?.id,
  )

  await row(page, `Work ${stamp}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page.getByRole('dialog')).toContainText('With 2 subfolders and 0 notes.')
  await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click()
  await expect(page.getByRole('status')).toContainText(`“Work ${stamp}” with 0 notes moved to the trash.`)
  await expect(row(page, `Work ${stamp}`)).toHaveCount(0)
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(row(page, `Work ${stamp}`)).toBeVisible()
  expect((await tree(page)).folders.filter((f) => f.name === 'Projects' || f.name === home)).toHaveLength(2)
  expect(problems).toEqual([])
})

test('NOTES-4 AC-13 EC-3 EC-11 fifteen levels, the path of the deepest, and the way there by keyboard', async ({ page }, info) => {
  const problems = watchProblems(page)
  const stamp = Date.now().toString(36)
  let parent: string | null = null
  const ids: string[] = []
  for (let level = 1; level <= 15; level++) {
    parent = await make(page, level === 15 ? `A very long name of the fifteenth level ${stamp}` : `L${level} ${stamp}`, parent)
    ids.push(parent)
  }
  await page.goto(`/folder/${parent}`)
  const path = page.getByRole('navigation', { name: 'Path' })
  await expect(path.getByRole('link')).toHaveCount(14)
  const deepest = row(page, `A very long name of the fifteenth level ${stamp}`)
  await expect(deepest).toHaveAttribute('aria-level', '15')
  await expect(deepest).toBeInViewport()
  await expect(deepest.locator('span[title]')).toHaveAttribute('title', `A very long name of the fifteenth level ${stamp}`)
  await page.getByTestId('sidebar-places').screenshot({ path: info.outputPath('fifteen-levels.png') })

  await path.getByRole('link', { name: `L3 ${stamp}` }).click()
  await expect(page).toHaveURL(new RegExp(`/folder/${ids[2]}$`))

  // By keyboard: to the first level, close it, down to the next folder, open it with Enter.
  await row(page, `L3 ${stamp}`).focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, `L2 ${stamp}`)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, `L1 ${stamp}`)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, `L1 ${stamp}`)).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/folder/${ids[0]}$`))
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(row(page, `L1 ${stamp}`)).toBeFocused()
  expect(problems).toEqual([])
})
