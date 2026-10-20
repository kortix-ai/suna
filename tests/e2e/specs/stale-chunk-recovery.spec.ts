import { expect, test } from '@playwright/test';

test('an entry chunk 404 recovers before hydration without a manual reload', async ({ page }) => {
  let failed = false;
  let documents = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
  });
  await page.route('**/_next/static/chunks/**/*.js*', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 404, body: 'stale chunk' });
    } else {
      await route.continue();
    }
  });
  await page.goto('/auth?chunkRecovery=1', { waitUntil: 'commit' });
  await expect(page.getByLabel('Email')).toBeEditable({ timeout: 60_000 });
  await expect.poll(() => documents).toBe(2);
  await expect(page).toHaveURL(/\/auth\?chunkRecovery=1$/);
  await page.waitForFunction(() => Boolean(Reflect.get(window, '__ENV_LOGGED__')));
  await page.getByLabel('Email').fill('chunk-recovery@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Check your email', { exact: true })).toBeVisible();
  expect(failed).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('kortix:chunk-reload-at'))).not.toBeNull();
});
