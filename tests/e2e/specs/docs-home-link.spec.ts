import { expect, test } from '@playwright/test';

test('docs home link announces the brand once in either theme', async ({ page }) => {
  await page.goto('/docs');
  // The link holds the full logo file; its alt text names it (#10931).
  const home = page.locator('header a[href="/docs"]').first();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(home).toBeVisible();
    await expect(home).toHaveAccessibleName('Kortix');
    await expect(home).toHaveAttribute('href', '/docs');
  }
  await home.click();
  // /docs redirects to the guide (#10931).
  await expect(page).toHaveURL(/\/docs(\/guide)?\/?$/);
  await expect(page.locator('main')).toBeVisible();
});
