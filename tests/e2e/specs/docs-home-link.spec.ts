import { expect, test } from '@playwright/test';

test('docs home link announces the brand once in either theme', async ({ page }) => {
  await page.goto('/docs');
  const home = page.locator('header a').filter({ hasText: 'Kortix' }).first();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(home).toBeVisible();
    await expect(home).toHaveAccessibleName('Kortix');
    await expect(home).toHaveAttribute('href', '/docs');
  }
  await home.click();
  await expect(page).toHaveURL(/\/docs\/?$/);
  await expect(page.locator('main')).toBeVisible();
});
