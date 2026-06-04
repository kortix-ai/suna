import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  firstExistingExplicitEnvFile,
  optionalEnvValue,
  requireEnvValue,
} from '../helpers/env';
import { json } from '../helpers/http';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = process.env.E2E_ADMIN_PASSWORD || 'E2eAccountAccess123!';

interface AuthUser {
  id: string;
  email?: string;
}

interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function createAuthUser(email: string): Promise<AuthUser> {
  const serviceRoleKey = requireEnvValue('SUPABASE_SERVICE_ROLE_KEY', 'apps/api/.env');
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });
  const body = await json<{ user?: AuthUser } & AuthUser>(response, 200);
  return body.user ?? body;
}

async function signIn(email: string): Promise<AuthSession> {
  const anonKey =
    optionalEnvValue('SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env') ||
    requireEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env');
  return json<AuthSession>(
    await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    }),
    200,
  );
}

async function installBrowserSession(page: Page, session: AuthSession, returnUrl: string) {
  await page.context().clearCookies();
  await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const lockScreen = page.getByText('Click or press Enter to sign in');
  if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const emailInput = page.locator('input[name="email"]');
    for (let attempt = 0; attempt < 3 && !(await emailInput.isVisible().catch(() => false)); attempt++) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(750);
    }
  }

  await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: /^Sign in$/i }).click();
  const usePassword = page.getByRole('button', { name: /Use password instead/i });
  if (await usePassword.isVisible().catch(() => false)) {
    await usePassword.click();
  }
  await page.locator('input[name="email"]').fill(session.user.email || '');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form').getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
}

async function grantPlatformAdmin(userId: string) {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const sql = `
      INSERT INTO kortix.platform_user_roles (account_id, role, granted_by)
      VALUES ('${userId}', 'super_admin', '${userId}')
      ON CONFLICT (account_id) DO UPDATE SET role = excluded.role;
    `;
  const envFile = firstExistingExplicitEnvFile();
  if (envFile) {
    const fs = require('fs') as typeof import('node:fs');
    const path = require('path') as typeof import('node:path');
    const composeFile = path.join(path.dirname(envFile), 'docker-compose.yml');
    if (fs.existsSync(composeFile)) {
      execFileSync(
        'docker',
        [
          'compose',
          '--project-name',
          process.env.E2E_COMPOSE_PROJECT_NAME || 'kortix-default',
          '--env-file',
          envFile,
          '-f',
          composeFile,
          'exec',
          '-T',
          'supabase-db',
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
          '-d',
          'postgres',
        ],
        { input: sql, encoding: 'utf8' },
      );
      return;
    }
  }

  const databaseUrl = requireEnvValue('DATABASE_URL', 'apps/api/.env');
  execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

async function ensureAdminSession(): Promise<AuthSession> {
  const configuredAdminEmail = process.env.E2E_ADMIN_EMAIL;
  if (configuredAdminEmail) {
    return signIn(configuredAdminEmail);
  }

  const email = `e2e-admin-ops-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  const user = await createAuthUser(email);
  await grantPlatformAdmin(user.id);
  return signIn(email);
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
    await installBrowserSession(page, session, '/favicon.png');

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
