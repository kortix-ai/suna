import { type Page, expect } from '@playwright/test';

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

function authCookieName(options: AuthOptions): string {
  const files = envFiles(options);
  const appUrl =
    optionalEnvValue('KORTIX_PUBLIC_APP_URL', ...files)
    || optionalEnvValue('NEXT_PUBLIC_APP_URL', ...files)
    || optionalEnvValue('NEXT_PUBLIC_URL', ...files)
    || optionalEnvValue('PUBLIC_URL', ...files);
  if (!appUrl) return 'sb-kortix-auth-token';
  try {
    const url = new URL(appUrl);
    if (['localhost', '127.0.0.1'].includes(url.hostname) && url.port) {
      return `sb-kortix-auth-token-${url.port}`;
    }
  } catch {
    // Match the application fallback for invalid or missing app URLs.
  }
  return 'sb-kortix-auth-token';
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
  for (let attempt = 1; attempt <= 6; attempt += 1) {
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
    if (response.status === 504 && attempt < 6) {
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const body = await json<{ user?: AuthUser } & AuthUser>(response, 200);
    return body.user ?? body;
  }
  throw new Error('unreachable');
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
  const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypass) {
    await page.context().setExtraHTTPHeaders({
      'x-vercel-protection-bypass': vercelBypass,
      'x-vercel-set-bypass-cookie': 'true',
    });
  }
  await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
  if (vercelBypass) {
    // The first request creates the web-origin _vercel_jwt cookie. Remove the
    // Vercel-only headers before cross-origin requests reach the Kortix API.
    await page.context().setExtraHTTPHeaders({});
  }
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

  await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      if (!form) return false;
      const reactPropsKey = Object.keys(form).find((key) => key.startsWith('__reactProps$'));
      if (!reactPropsKey) return false;
      const reactProps = (form as unknown as Record<string, { onSubmit?: unknown }>)[reactPropsKey];
      return typeof reactProps?.onSubmit === 'function';
    },
    null,
    { timeout: 30_000 },
  );
  const signInTab = page.getByRole('tab', { name: /^Sign in$/i });
  if (await signInTab.isVisible().catch(() => false)) {
    await signInTab.click();
  }
  await page.locator('input[name="email"]').fill(session.user.email || '');
  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  const usePassword = page.getByRole('button', { name: /Use password instead/i });
  const passwordInput = page.locator('input[name="password"]');
  if (await continueButton.isVisible().catch(() => false)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(continueButton).toBeEnabled({ timeout: 60_000 });
      await continueButton.click({ timeout: 60_000 });
      if (
        await usePassword
          .or(passwordInput)
          .isVisible({ timeout: 20_000 })
          .catch(() => false)
      ) {
        break;
      }
    }
  }
  await expect(usePassword.or(passwordInput)).toBeVisible({ timeout: 45_000 });
  if (await usePassword.isVisible().catch(() => false)) {
    await usePassword.click();
  }
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);
  await page
    .locator('form')
    .getByRole('button', { name: /^(Sign in|Continue)$/i })
    .click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 180_000 });
}

/**
 * Install an already-minted Supabase password-grant session into the browser.
 *
 * Use this when the test target is an authenticated product flow rather than
 * the magic-link/password auth UI. The cookie format matches @supabase/ssr.
 */
export async function installBrowserSessionDirect(
  page: Page,
  session: AuthSession,
  returnUrl: string,
  options: AuthOptions,
): Promise<void> {
  await page.context().clearCookies();
  const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypass) {
    await page.context().setExtraHTTPHeaders({
      'x-vercel-protection-bypass': vercelBypass,
      'x-vercel-set-bypass-cookie': 'true',
    });
  }
  await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
  if (vercelBypass) {
    await page.context().setExtraHTTPHeaders({});
  }

  const origin = new URL(page.url()).origin;
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const originUrl = new URL(origin);
  const key =
    ['localhost', '127.0.0.1'].includes(originUrl.hostname) && originUrl.port
      ? `sb-kortix-auth-token-${originUrl.port}`
      : authCookieName(options);
  const chunks = encoded.match(/.{1,3180}/g) ?? [];
  await page.context().addCookies(
    chunks.map((value, index) => ({
      name: chunks.length === 1 ? key : `${key}.${index}`,
      value,
      url: origin,
      sameSite: 'Lax' as const,
    })),
  );
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 180_000 });
}
