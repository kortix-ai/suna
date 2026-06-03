/**
 * UI e2e for the workspace-less sandbox-templates refactor.
 *
 * Mirrors the auth pattern from `08-accounts-project-access.spec.ts`:
 * provisions a fresh Supabase user via the admin API, signs them in to get a
 * session, then drives the Next dashboard. We verify the Customize → Sandbox
 * panel:
 *
 *   1. Provision a Freestyle-backed project for the test user.
 *   2. GET /sandboxes — platform default present (API-level smoke).
 *   3. Open the project's Sandbox tab in the browser; assert it renders
 *      WITHOUT a runtime error (catches the regression where the card crashed
 *      with "Cannot read properties of undefined (reading 'find')").
 *   4. Click Rebuild on the platform default; expect POST /snapshots/rebuild
 *      → 202 and no client console error.
 *
 * Designed for the local-dev stack (Next on :3000, API on :8008, Supabase on
 * :54321).
 */

import { expect, test, type Page } from '@playwright/test';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'E2eSandboxTpl123!';

interface AuthUser { id: string; email?: string }
interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

function repoRoot(): string {
  const path = require('path') as typeof import('node:path');
  return path.resolve(__dirname, '../../..');
}

function parseEnvFile(rel: string): Record<string, string> {
  const fs = require('fs') as typeof import('node:fs');
  const path = require('path') as typeof import('node:path');
  const file = path.isAbsolute(rel) ? rel : path.join(repoRoot(), rel);
  if (!fs.existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return env;
}

function envValue(name: string, ...files: string[]): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const f of files) {
    const v = parseEnvFile(f)[name];
    if (v) return v;
  }
  return undefined;
}

function envRequired(name: string, ...files: string[]): string {
  const v = envValue(name, ...files);
  if (!v) throw new Error(`${name} not found in env or ${files.join(', ')}`);
  return v;
}

async function createAuthUser(email: string): Promise<AuthUser> {
  const serviceRoleKey = envRequired('SUPABASE_SERVICE_ROLE_KEY', 'apps/api/.env', 'apps/web/.env');
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`createAuthUser failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { user?: AuthUser } & AuthUser;
  return body.user ?? body;
}

async function deleteAuthUser(userId: string): Promise<void> {
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY', 'apps/api/.env', 'apps/web/.env');
  if (!serviceRoleKey) return;
  await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  }).catch(() => {});
}

async function signIn(email: string): Promise<AuthSession> {
  const anonKey =
    envValue('SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env') ||
    envRequired('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env');
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`signIn failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<AuthSession>;
}

async function api<T>(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: T | null = null;
  try { json = text ? (JSON.parse(text) as T) : null; } catch { json = null; }
  return { status: res.status, json };
}

/**
 * Skip the dashboard's auth UI by writing the Supabase session straight into
 * the cookie + localStorage keys the @supabase/ssr browser client reads on
 * boot. Cookie name in local-dev is derived from the frontend port
 * (`sb-kortix-auth-token-3000` on :3000) — see apps/web/src/lib/supabase/constants.ts.
 */
async function installBrowserSession(page: Page, session: AuthSession, returnUrl: string) {
  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
  const port = new URL(baseURL).port;
  const cookieName = port ? `sb-kortix-auth-token-${port}` : 'sb-kortix-auth-token';
  const sessionPayload = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  });

  await page.context().clearCookies();
  // Seed the cookie at the parent URL so the SSR client reads it on first nav.
  const host = new URL(baseURL).hostname;
  await page.context().addCookies([
    {
      name: cookieName,
      value: encodeURIComponent(sessionPayload),
      domain: host,
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
  // Also drop it in localStorage so the browser client picks it up if it
  // prefers that storage backend.
  await page.addInitScript(({ key, value }) => {
    try { localStorage.setItem(key, value); } catch { /* best effort */ }
  }, { key: cookieName, value: sessionPayload });

  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
}

test.describe('12 — Sandbox templates UI', () => {
  test.setTimeout(180_000);

  let user: AuthUser;
  let session: AuthSession;
  let projectId: string;

  test.beforeAll(async () => {
    const email = `e2e-sbx-${Date.now()}@kortix.test`;
    user = await createAuthUser(email);
    session = await signIn(email);
    const projectName = `e2e-ui-tpl-${Math.floor(Date.now() / 1000)}`;
    const { status, json } = await api<{ project_id: string; seeded: boolean }>(
      session.access_token,
      'POST',
      '/projects/provision',
      { name: projectName, seed_starter: true },
    );
    expect(status).toBe(201);
    expect(json?.project_id).toBeTruthy();
    projectId = json!.project_id;
  });

  test.afterAll(async () => {
    if (projectId && session) {
      await api(session.access_token, 'DELETE', `/projects/${projectId}`).catch(() => {});
    }
    if (user?.id) await deleteAuthUser(user.id);
  });

  test('sandboxes API returns platform default before opening the panel', async () => {
    const { status, json } = await api<{
      items: Array<{ slug: string; is_default: boolean; source: string }>;
      default_slug: string | null;
    }>(session.access_token, 'GET', `/projects/${projectId}/sandboxes`);
    expect(status).toBe(200);
    expect(json?.default_slug).toBe('default');
    const platformDefault = json?.items.find((t) => t.is_default && t.slug === 'default');
    expect(platformDefault, 'platform default must be present').toBeTruthy();
    expect(platformDefault?.source).toBe('platform');
  });

  test('Sandbox panel renders the platform default row without runtime errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await installBrowserSession(page, session, `/projects/${projectId}/sandbox`);

    // Card heading
    await expect(page.getByRole('heading', { name: /Sandbox templates/i }))
      .toBeVisible({ timeout: 30_000 });

    // Platform default row: "Default" name + "default" slug code chip.
    await expect(page.getByText('Default', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('code', { hasText: 'default' }).first()).toBeVisible();

    // At least one state badge rendered (Ready / Building / Pulling / Not built yet / Error).
    const stateBadge = page.locator(
      ':is(span:has-text("Ready"), span:has-text("Not built yet"), span:has-text("Building"), span:has-text("Pulling"), span:has-text("Error"))',
    );
    await expect(stateBadge.first()).toBeVisible({ timeout: 15_000 });

    expect(pageErrors, `client errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });

  test('clicking Rebuild on the platform default calls the API and does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Capture rebuild POSTs as they happen — armed BEFORE navigation so we
    // never miss the response between fixture setup and the actual click.
    const seenRebuildStatuses: number[] = [];
    page.on('response', (res) => {
      if (
        res.url().includes(`/projects/${projectId}/snapshots/rebuild`) &&
        res.request().method() === 'POST'
      ) {
        seenRebuildStatuses.push(res.status());
      }
    });

    await installBrowserSession(page, session, `/projects/${projectId}/sandbox`);
    await expect(page.getByRole('heading', { name: /Sandbox templates/i }))
      .toBeVisible({ timeout: 30_000 });

    const rebuildButton = page.getByRole('button', { name: /^Rebuild$/i }).first();
    await expect(rebuildButton).toBeVisible({ timeout: 15_000 });
    await expect(rebuildButton).toBeEnabled({ timeout: 15_000 });
    await rebuildButton.click();

    // Wait up to 30s for the rebuild POST to land — toast feedback gives the
    // user the cue too, but for the assertion we watch the network.
    await expect.poll(() => seenRebuildStatuses.length, { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(0);
    expect(seenRebuildStatuses[0]).toBe(202);

    expect(pageErrors, `client errors after Rebuild: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
