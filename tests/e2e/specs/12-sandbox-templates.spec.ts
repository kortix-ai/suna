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
 *   4. Create a project template and click Rebuild; expect the build API call
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
interface AccountSummary { account_id: string; personal_account: boolean }
interface TemplateCreateResult { template_id: string; slug: string }
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
  const path = require('path') as typeof import('node:path');
  const explicit = (process.env.E2E_ENV_FILE || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const f of [...explicit, ...files]) {
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

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function seedSelfHostedProject(accountId: string, userId: string, name: string): string {
  const childProcess = require('child_process') as typeof import('node:child_process');
  const crypto = require('crypto') as typeof import('node:crypto');
  const fs = require('fs') as typeof import('node:fs');
  const path = require('path') as typeof import('node:path');
  const envFile = (process.env.E2E_ENV_FILE || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .find((candidate) => fs.existsSync(candidate));
  if (!envFile) throw new Error('E2E_ENV_FILE is required for self-host project seeding');

  const composeFile = path.join(path.dirname(envFile), 'docker-compose.yml');
  const projectId = crypto.randomUUID();
  const repoUrl = `https://github.com/kortix-ai/sandbox-template-${projectId}.git`;
  const sql = `
insert into kortix.projects (
  project_id,
  account_id,
  name,
  repo_url,
  default_branch,
  manifest_path,
  status,
  metadata
) values (
  '${projectId}'::uuid,
  '${escapeSql(accountId)}'::uuid,
  '${escapeSql(name)}',
  '${escapeSql(repoUrl)}',
  'main',
  'kortix.toml',
  'active',
  '{"self_host_e2e":true}'::jsonb
);

insert into kortix.project_members (
  account_id,
  project_id,
  user_id,
  project_role,
  granted_by
) values (
  '${escapeSql(accountId)}'::uuid,
  '${projectId}'::uuid,
  '${escapeSql(userId)}'::uuid,
  'manager',
  '${escapeSql(userId)}'::uuid
);
`;
  childProcess.execFileSync(
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
  return projectId;
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
  let res: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (!res) throw lastError;
  const text = await res.text();
  let json: T | null = null;
  try { json = text ? (JSON.parse(text) as T) : null; } catch { json = null; }
  return { status: res.status, json };
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

async function openSandboxSection(page: Page, projectId: string) {
  await expect(page.getByRole('dialog', { name: /Customize/i })).toBeVisible({ timeout: 30_000 });
  const sandboxHeading = page.getByRole('heading', { name: /Sandbox templates/i });
  if (!(await sandboxHeading.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await page.getByRole('button', { name: /^Sandbox$/i }).click();
  }
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 30_000 });
  await expect(sandboxHeading).toBeVisible({ timeout: 30_000 });
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
    const accounts = await api<AccountSummary[]>(
      session.access_token,
      'GET',
      '/accounts',
    );
    const personalAccount = accounts.json?.find((account) => account.personal_account);
    expect(personalAccount?.account_id).toBeTruthy();
    projectId = seedSelfHostedProject(personalAccount!.account_id, user.id, projectName);
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
    }>(session.access_token, 'GET', `/projects/${projectId}/sandbox-templates`);
    expect(status).toBe(200);
    expect(json?.default_slug).toBe('default');
    const platformDefault = json?.items.find((t) => t.is_default && t.slug === 'default');
    expect(platformDefault, 'platform default must be present').toBeTruthy();
    expect(platformDefault?.source).toBe('platform');
  });

  test('Sandbox panel renders the platform default row without runtime errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await installBrowserSession(page, session, `/projects/${projectId}/customize/sandbox`);
    await openSandboxSection(page, projectId);
    pageErrors.length = 0;

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

  test('clicking Rebuild on a project template calls the API and does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const customSlug = `e2e-image-${Date.now()}`;
    const created = await api<TemplateCreateResult>(
      session.access_token,
      'POST',
      `/projects/${projectId}/sandbox-templates`,
      {
        slug: customSlug,
        name: 'E2E image template',
        image: 'kortix/kortix-sandbox:selfhost-local',
      },
    );
    expect(created.status).toBe(201);
    expect(created.json?.template_id).toBeTruthy();
    const templateId = created.json!.template_id;

    // Capture rebuild POSTs as they happen — armed before navigation so we
    // never miss the response between fixture setup and the actual click.
    const seenRebuildStatuses: number[] = [];
    page.on('response', (res) => {
      if (
        res.url().includes(`/projects/${projectId}/sandbox-templates/${templateId}/build`) &&
        res.request().method() === 'POST'
      ) {
        seenRebuildStatuses.push(res.status());
      }
    });

    await installBrowserSession(page, session, `/projects/${projectId}/customize/sandbox`);
    await openSandboxSection(page, projectId);
    pageErrors.length = 0;

    const templateRow = page.locator('li', { hasText: customSlug });
    await expect(templateRow).toBeVisible({ timeout: 15_000 });
    const rebuildButton = templateRow.getByRole('button', { name: /^Rebuild$/i });
    await expect(rebuildButton).toBeEnabled({ timeout: 15_000 });
    await rebuildButton.click();

    // Wait up to 30s for the template build POST to land — toast feedback gives the
    // user the cue too, but for the assertion we watch the network.
    await expect.poll(() => seenRebuildStatuses.length, { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(0);
    expect(seenRebuildStatuses[0]).toBe(202);

    expect(pageErrors, `client errors after Rebuild: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
