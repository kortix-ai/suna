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

export async function deleteAuthUser(
  userId: string,
  options: Omit<AuthOptions, 'password'>,
): Promise<void> {
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
    for (
      let attempt = 0;
      attempt < 3 && !(await emailInput.isVisible().catch(() => false));
      attempt++
    ) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(750);
    }
  }

  const emailInput = page.locator('input[name="email"]');
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  const signInTab = page.getByRole('tab', { name: /^Sign in$/i });
  if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
  await emailInput.fill(session.user.email || '');

  // Current auth is a two-step email → password flow. Older deployments expose
  // the password mode directly behind a tab/button, so keep both paths usable.
  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click();
  const usePassword = page.getByText(/Use password instead/i, { exact: true });
  if (
    await usePassword
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await usePassword.click();
  }
  const passwordInput = page.locator('input[name="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);
  const submit = page.locator('form').getByRole('button', { name: /^(Sign in|Continue)$/i });
  await submit.click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), {
    timeout: 30_000,
  });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
}
