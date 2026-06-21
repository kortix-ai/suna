import { expect, test, type Page } from '@playwright/test';
import { json } from '../helpers/http';
import { installBrowserSession, signIn } from '../helpers/session-auth';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = process.env.E2E_ADMIN_PASSWORD || 'E2eAccountAccess123!';
const authOptions = { supabaseUrl, password, envFiles: ['apps/api/.env'] };

async function assertAdminRouteClean(page: Page, path: string, expectedTexts: string[]) {
  const badResponses: string[] = [];
  const consoleErrors: string[] = [];

  page.on('response', (response) => {
    if (response.status() >= 400) {
      const url = response.url();
      if (url.includes('/_vercel/insights/') || url.includes('/_vercel/speed-insights/')) {
        return;
      }
      badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (text.includes('Failed to load resource: the server responded with a status of 404')) {
        return;
      }
      consoleErrors.push(text);
    }
  });

  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL((url) => url.pathname === path);

  for (const text of expectedTexts) {
    await expect(page.getByText(text).first()).toBeVisible();
  }

  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('Not found');
  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

test.describe('09 - Admin operations console', () => {
  test.setTimeout(180_000);

  test('admin overview and operations dashboard use the supported ops API cleanly', async ({ page }) => {
    await json(await fetch(`${apiBase.replace(/\/v1$/, '')}/health`), 200);
    const configuredAdminEmail = process.env.E2E_ADMIN_EMAIL;
    test.skip(!configuredAdminEmail, 'E2E_ADMIN_EMAIL is required for admin ops UI E2E');
    const session = await signIn(configuredAdminEmail!, authOptions);
    // Let the assertions below own the admin navigations; otherwise the
    // immediate duplicate /admin load can abort Supabase's user fetch.
    await installBrowserSession(page, session, '/favicon.png', password);

    await assertAdminRouteClean(page, '/admin', [
      'Admin overview',
      'Operations',
      'Maintenance',
    ]);

    await assertAdminRouteClean(page, '/admin/ops', [
      'Operations',
      'LLM calls 24h',
      'Recent audit events',
      'Migration',
    ]);
  });
});
