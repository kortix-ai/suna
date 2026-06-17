import { test, expect } from '@playwright/test';

test.describe('Visual regression — landing page', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    });
  });

  test('full page snapshot', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page).toHaveScreenshot('landing-full.png', {
      fullPage: true,
    });
  });

  test('above-the-fold snapshot', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page).toHaveScreenshot('landing-viewport.png', {
      fullPage: false,
    });
  });
});
