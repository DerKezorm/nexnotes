/**
 * NOTES-4 AC-15 and NOTES-6 AC-10 in a real browser: the sidebar and the list beside an open note are dragged wider
 * and narrower at their edge, the width stays after a reload, a double click resets it; a phone has no handle.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

const TAB = { 'X-Nexnotes-Client': 'tab-e2e-columns0' }

async function drag(page: Page, handle: Locator, by: number): Promise<void> {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + by / 2, y, { steps: 4 })
  await page.mouse.move(x + by, y, { steps: 4 })
  await page.mouse.up()
}

const widthOf = (locator: Locator) => locator.evaluate((element) => Math.round(element.getBoundingClientRect().width))

test('NOTES-4 AC-15 NOTES-6 AC-10 the sidebar and the list are dragged to a width the device keeps', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const made = await page.request.post('/api/notes', {
    data: { title: 'A note with a rather long title that does not fit into the narrow list column', markdown: 'text' },
    headers: TAB,
  })
  expect(made.ok()).toBe(true)
  const id = (await made.json()).id as string
  await page.goto(`/notes/${id}`)
  const sidebar = page.getByRole('navigation', { name: 'Main menu' })
  const sidebarHandle = page.getByTestId('column-handle-sidebar')
  const listHandle = page.getByTestId('column-handle-list')
  await expect(listHandle).toBeVisible()
  expect(await widthOf(sidebar)).toBe(260)
  const list = listHandle.locator('..')
  expect(await widthOf(list)).toBe(300)

  await drag(page, sidebarHandle, 80)
  expect(await widthOf(sidebar)).toBe(340)
  await drag(page, listHandle, 120)
  expect(await widthOf(list)).toBe(420)
  // Too far: no further than the greatest width.
  await drag(page, listHandle, 600)
  expect(await widthOf(list)).toBe(560)

  await page.reload()
  await expect(listHandle).toBeVisible()
  expect(await widthOf(sidebar)).toBe(340)
  expect(await widthOf(list)).toBe(560)

  // By keyboard, and back to the default with a double click.
  await sidebarHandle.focus()
  await page.keyboard.press('ArrowLeft')
  expect(await widthOf(sidebar)).toBe(324)
  await sidebarHandle.dblclick()
  expect(await widthOf(sidebar)).toBe(260)
  await listHandle.dblclick()
  expect(await widthOf(list)).toBe(300)
})

test('NOTES-4 AC-15 a phone has no handle', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open the menu' })).toBeVisible()
  await expect(page.getByTestId('column-handle-sidebar')).toBeHidden()
  await page.getByRole('button', { name: 'Open the menu' }).click()
  await expect(page.getByRole('navigation', { name: 'Main menu' }).last()).toBeVisible()
  await expect(page.getByTestId('column-handle-sidebar')).toBeHidden()
})
