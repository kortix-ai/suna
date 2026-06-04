import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { type AuthSession, createAuthUser, installBrowserSession, signIn } from '../helpers/session-auth';
import { runSqlWithSelfHostFallback } from '../helpers/self-host';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = process.env.E2E_ADMIN_PASSWORD || 'E2eAccountAccess123!';
const authOptions = { supabaseUrl, password, envFiles: ['apps/api/.env'] };

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function grantPlatformAdmin(userId: string) {
  const sql = `
      INSERT INTO kortix.platform_user_roles (account_id, role, granted_by)
      VALUES ('${userId}', 'super_admin', '${userId}')
      ON CONFLICT (account_id) DO UPDATE SET role = excluded.role;
    `;
  runSqlWithSelfHostFallback(sql);
}

async function ensureAdminSession(): Promise<AuthSession> {
  const configuredAdminEmail = process.env.E2E_ADMIN_EMAIL;
  if (configuredAdminEmail) {
    return signIn(configuredAdminEmail, authOptions);
  }

  const email = `e2e-admin-ops-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  const user = await createAuthUser(email, authOptions);
  await grantPlatformAdmin(user.id);
  return signIn(email, authOptions);
}

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
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}$`));

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
    const session = await ensureAdminSession();
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
