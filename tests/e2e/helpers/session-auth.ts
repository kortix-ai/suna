import { expect, type Page } from '@playwright/test';

import { optionalEnvValue, requireEnvValue } from './env';
import { json } from './http';

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

interface AuthOptions {
  supabaseUrl: string;
  password: string;
  envFiles?: string[];
}

function envFiles(options: AuthOptions): string[] {
  return options.envFiles ?? ['apps/web/.env', 'apps/api/.env'];
}

function trustedAuthHeader(value: string, name: string): string {
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) {
    throw new Error(`${name} contains characters that are not valid in an auth header`);
  }
  return value;
}

export async function createAuthUser(email: string, options: AuthOptions): Promise<AuthUser> {
  const serviceRoleKey = trustedAuthHeader(
    requireEnvValue('SUPABASE_SERVICE_ROLE_KEY', ...envFiles(options)),
    'SUPABASE_SERVICE_ROLE_KEY',
  );
  const response = await fetch(`${options.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: options.password,
      email_confirm: true,
    }),
  });
  const body = await json<{ user?: AuthUser } & AuthUser>(response, 200);
  return body.user ?? body;
}

export async function deleteAuthUser(userId: string, options: Omit<AuthOptions, 'password'>): Promise<void> {
  const serviceRoleKey = optionalEnvValue(
    'SUPABASE_SERVICE_ROLE_KEY',
    ...(options.envFiles ?? ['apps/web/.env', 'apps/api/.env']),
  );
  if (!serviceRoleKey) return;
  const trustedServiceRoleKey = trustedAuthHeader(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY');
  await fetch(`${options.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: trustedServiceRoleKey,
      Authorization: `Bearer ${trustedServiceRoleKey}`,
    },
  }).catch(() => {});
}

export async function signIn(email: string, options: AuthOptions): Promise<AuthSession> {
  const files = envFiles(options);
  const anonKey = trustedAuthHeader(
    optionalEnvValue('SUPABASE_ANON_KEY', ...files) ||
      requireEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', ...files),
    'SUPABASE_ANON_KEY',
  );
  return json<AuthSession>(
    await fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: options.password }),
    }),
    200,
  );
}

export async function installBrowserSession(
  page: Page,
  session: AuthSession,
  returnUrl: string,
  password: string,
): Promise<void> {
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
