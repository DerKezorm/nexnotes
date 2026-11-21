/**
 * The menu of a row in Settings › Accounts stands over everything: the table's box gets no scroll bar of its own and
 * every entry is on screen, at 1280 and at 390 px.
 */
import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`the account menu is not cut off by the table, at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/settings/accounts')
    const button = page.getByTestId('account-menu-button').first()
    await expect(button).toBeVisible()
    const table = page.locator('.overflow-x-auto').filter({ has: button })
    const before = await table.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }))
    await button.scrollIntoViewIfNeeded()
    await button.click()
    const menu = page.getByTestId('account-menu')
    await expect(menu).toBeVisible()
    const after = await table.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }))
    expect(after.scroll).toBeLessThanOrEqual(after.client)
    expect(after).toEqual(before)
    expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true)
    for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })
}
