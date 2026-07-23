import { expect, test } from '@playwright/test';

type LandingDiagnostics = {
  consoleErrors: string[];
  pageErrors: string[];
};

const diagnosticsByPage = new WeakMap<object, LandingDiagnostics>();

test.describe('Visual regression — landing page', () => {
  test.beforeEach(async ({ page }) => {
    const diagnostics: LandingDiagnostics = {
      consoleErrors: [],
      pageErrors: [],
    };
    diagnosticsByPage.set(page, diagnostics);
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      diagnostics.pageErrors.push(error.message);
    });

    await page.context().clearCookies();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    });
    const issueCount = page.locator('nextjs-portal').locator('[data-issues-count]');
    if ((await issueCount.count()) > 0) {
      await expect(issueCount).toHaveText('0');
    }
  });

  test.afterEach(async ({ page }) => {
    const diagnostics = diagnosticsByPage.get(page);
    if (!diagnostics) throw new Error('Landing diagnostics were not initialized');
    expect(diagnostics.consoleErrors, 'landing page console errors').toEqual([]);
    expect(diagnostics.pageErrors, 'landing page uncaught errors').toEqual([]);
  });

  test('full page snapshot', async ({ page }) => {
    await expect(page).toHaveScreenshot('landing-full.png', {
      fullPage: true,
    });
  });

  test('above-the-fold snapshot', async ({ page }) => {
    await expect(page).toHaveScreenshot('landing-viewport.png', {
      fullPage: false,
    });
  });
});
