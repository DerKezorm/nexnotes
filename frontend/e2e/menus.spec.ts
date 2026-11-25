/**
 * Settings › Accounts as the shared account module lays it out (konten 0.3.9): one row per account with "Manage", no
 * table and no menu. "Manage" opens a dialog that stands over everything and has every act on screen in words, at 1280
 * and at 390 px; on the own account it offers nothing that belongs in the profile (role, block, delete, sign out
 * everywhere).
 */
import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`the dialog "Manage" fits the screen and has no menu, at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/settings/accounts')
    const rows = page.getByTestId('account-rows')
    await expect(rows).toBeVisible()
    await expect(page.getByTestId('account-table')).toHaveCount(0)
    const manage = rows.getByTestId('account-manage').first()
    await expect(manage).toHaveText('Manage')
    await manage.click()
    const dialog = page.getByTestId('manage-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('menu')).toHaveCount(0)
    // No sideways scrolling: the dialog is as wide as the screen at most.
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1)
    for (const button of await dialog.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeInViewport({ ratio: 1 })
    }
    // The operator's own account (the first row): nothing of the profile's here.
    for (const word of ['Make member', 'Block', 'Delete account', 'Sign out everywhere']) {
      await expect(dialog.getByRole('button', { name: word, exact: true })).toHaveCount(0)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}
