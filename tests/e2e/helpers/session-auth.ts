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
  _password: string,
): Promise<void> {
  const context = page.context();
  await context.clearCookies();

  // These tests already obtained a real Supabase password-grant session above.
  // Install that session directly instead of sending a magic-link email and
  // immediately racing a password sign-in against GoTrue's OTP mutation. This
  // is the same base64url cookie representation @supabase/ssr writes.
  await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
  const origin = new URL(page.url()).origin;
  const url = new URL(origin);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const cookieName = local && url.port ? `sb-kortix-auth-token-${url.port}` : 'sb-kortix-auth-token';
  const cookieValue = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const chunks =
    cookieValue.length <= 3180
      ? [{ name: cookieName, value: cookieValue }]
      : Array.from({ length: Math.ceil(cookieValue.length / 3180) }, (_, index) => ({
          name: `${cookieName}.${index}`,
          value: cookieValue.slice(index * 3180, (index + 1) * 3180),
        }));

  await context.addCookies(
    chunks.map((chunk) => ({
      ...chunk,
      url: origin,
      sameSite: 'Lax' as const,
      expires: session.expires_at,
    })),
  );
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/auth(?:[/?#]|$)/, { timeout: 30_000 });
}
