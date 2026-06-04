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
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';
import { seedSelfHostedProject } from '../helpers/self-host';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'E2eSandboxTpl123!';
const authOptions = { supabaseUrl, password };

interface AccountSummary { account_id: string; personal_account: boolean }
interface TemplateCreateResult { template_id: string; slug: string }

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
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);
    const projectName = `e2e-ui-tpl-${Math.floor(Date.now() / 1000)}`;
    const accounts = await api<AccountSummary[]>(
      session.access_token,
      'GET',
      '/accounts',
    );
    const personalAccount = accounts.json?.find((account) => account.personal_account);
    expect(personalAccount?.account_id).toBeTruthy();
    projectId = seedSelfHostedProject({
      accountId: personalAccount!.account_id,
      userId: user.id,
      name: projectName,
    });
  });

  test.afterAll(async () => {
    if (projectId && session) {
      await api(session.access_token, 'DELETE', `/projects/${projectId}`).catch(() => {});
    }
    if (user?.id) await deleteAuthUser(user.id, authOptions);
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

    await installBrowserSession(page, session, `/projects/${projectId}/customize/sandbox`, password);
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

    await installBrowserSession(page, session, `/projects/${projectId}/customize/sandbox`, password);
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
