import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { requireEnvValue } from '../helpers/env';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = process.env.E2E_BOUNDARY_PASSWORD || 'E2eBoundary123!';
const runBoundaryTests = process.env.E2E_ENABLE_GOLDEN_PATHS === '1';
const enforceSlos = process.env.E2E_ENFORCE_SLOS === '1';

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

interface AccountSummary {
  account_id: string;
  name: string;
  personal_account: boolean;
  account_role: 'owner' | 'admin' | 'member';
}

interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  project_role: string | null;
  effective_project_role: string | null;
}

interface InviteResult {
  status: 'added' | 'pending';
  user_id?: string;
  invite_id?: string;
  email: string;
  account_role: 'owner' | 'admin' | 'member';
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function json<T>(
  response: Response,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const body = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected ${expected.join('/')} from ${response.url}, got ${response.status}: ${body}`,
    );
  }
  return body ? JSON.parse(body) as T : ({} as T);
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  return json<T>(
    await fetch(`${apiBase}${path}`, {
      method,
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    expectedStatus,
  );
}

async function apiStatus(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.text();
  return response.status;
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
  const anonKey = requireEnvValue('SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env');
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

async function selectAccountForUi(page: Page, accountId: string) {
  await page.evaluate((id) => {
    localStorage.setItem(
      'kortix.currentAccount',
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function threshold(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertSlo(label: string, durationMs: number, limitMs: number) {
  test.info().annotations.push({
    type: enforceSlos ? 'slo' : 'slo-observed',
    description: `${label}: ${Math.round(durationMs)}ms <= ${limitMs}ms`,
  });
  if (enforceSlos) expect(durationMs, label).toBeLessThanOrEqual(limitMs);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const started = performance.now();
  const value = await fn();
  return {
    value,
    durationMs: performance.now() - started,
  };
}

test.describe.serial('11 - SPEC auth boundaries, concurrency, and SLOs', () => {
  test.skip(!runBoundaryTests, 'Set E2E_ENABLE_GOLDEN_PATHS=1 to run destructive production boundary checks.');
  test.setTimeout(420_000);

  test('§10.6/§10.7 API boundaries and invite concurrency hold', async () => {
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerEmail = `boundary-owner-${runId}@example.test`;
    const memberEmail = `boundary-member-${runId}@example.test`;
    const inviteeEmail = `boundary-invitee-${runId}@example.test`;
    const outsiderEmail = `boundary-outsider-${runId}@example.test`;

    const owner = await createAuthUser(ownerEmail);
    const member = await createAuthUser(memberEmail);
    const outsider = await createAuthUser(outsiderEmail);
    const ownerSession = await signIn(ownerEmail);
    const memberSession = await signIn(memberEmail);
    const outsiderSession = await signIn(outsiderEmail);

    expect(owner.id).toBeTruthy();
    expect(member.id).toBeTruthy();
    expect(outsider.id).toBeTruthy();

    await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    await api<AccountSummary[]>(memberSession.access_token, 'GET', '/accounts');
    await api<AccountSummary[]>(outsiderSession.access_token, 'GET', '/accounts');

    const account = await api<AccountSummary>(
      ownerSession.access_token,
      'POST',
      '/accounts',
      { name: `Boundary Org ${runId}` },
      201,
    );
    const project = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects',
      {
        account_id: account.account_id,
        name: `Boundary Project ${runId}`,
        repo_url: `https://github.com/kortix-ai/boundary-${runId}.git`,
        default_branch: 'main',
      },
      201,
    );

    const randomSessionId = '00000000-0000-4000-a000-00000000b011';
    expect(await apiStatus(outsiderSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);
    expect(await apiStatus(outsiderSession.access_token, 'GET', `/projects/${project.project_id}/files`)).toBe(403);
    expect(await apiStatus(outsiderSession.access_token, 'GET', `/projects/${project.project_id}/files/content?path=README.md`)).toBe(403);
    expect(await apiStatus(outsiderSession.access_token, 'GET', `/projects/${project.project_id}/sessions`)).toBe(403);
    expect(await apiStatus(outsiderSession.access_token, 'POST', `/projects/${project.project_id}/sessions`, {})).toBe(403);
    expect(await apiStatus(outsiderSession.access_token, 'GET', `/projects/${project.project_id}/sessions/${randomSessionId}/sandbox`)).toBe(403);

    const addedMember = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: memberEmail, role: 'member' },
      201,
    );
    expect(addedMember.status).toBe('added');
    expect(addedMember.user_id).toBe(member.id);
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);

    const viewerGrant = await api<{ project_role: string; effective_project_role: string }>(
      ownerSession.access_token,
      'PUT',
      `/projects/${project.project_id}/access/${member.id}`,
      { role: 'viewer' },
    );
    expect(viewerGrant.effective_project_role).toBe('viewer');
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(200);
    expect(await apiStatus(memberSession.access_token, 'POST', `/projects/${project.project_id}/sessions`, {})).toBe(403);

    await api<{ ok: true }>(
      ownerSession.access_token,
      'DELETE',
      `/projects/${project.project_id}/access/${member.id}`,
    );
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);

    expect(await apiStatus(
      ownerSession.access_token,
      'POST',
      `/projects/${project.project_id}/sessions`,
      { provider: 'justavps' },
    )).toBe(400);

    const pendingInvite = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: inviteeEmail, role: 'member' },
      201,
    );
    expect(pendingInvite.status).toBe('pending');
    expect(pendingInvite.invite_id).toBeTruthy();

    const redactedInvite = await api<Record<string, unknown>>(
      outsiderSession.access_token,
      'GET',
      `/account-invites/${pendingInvite.invite_id}`,
    );
    expect(redactedInvite.email_matches_caller).toBe(false);
    expect(redactedInvite.account_name).toBeNull();
    expect(redactedInvite.inviter_email).toBeNull();
    expect(redactedInvite.email).toBeNull();

    await createAuthUser(inviteeEmail);
    const inviteeSession = await signIn(inviteeEmail);
    const accepts = await Promise.all([
      fetch(`${apiBase}/account-invites/${pendingInvite.invite_id}/accept`, {
        method: 'POST',
        headers: authHeaders(inviteeSession.access_token),
      }),
      fetch(`${apiBase}/account-invites/${pendingInvite.invite_id}/accept`, {
        method: 'POST',
        headers: authHeaders(inviteeSession.access_token),
      }),
    ]);
    expect(accepts.map((response) => response.status)).toEqual([200, 200]);
    const acceptBodies = await Promise.all(accepts.map((response) => response.json() as Promise<Record<string, unknown>>));
    expect(acceptBodies.filter((body) => body.already_accepted === true)).toHaveLength(1);
    expect(acceptBodies.every((body) => body.account_id === account.account_id)).toBe(true);

    await api<{ ok: true }>(ownerSession.access_token, 'DELETE', `/projects/${project.project_id}`);
  });

  test('§10.6.C SLO probes meet the configured production budgets', async ({ page }) => {
    const healthLimit = threshold('E2E_SLO_HEALTH_MS', 250);
    const projectsFirstPaintLimit = threshold('E2E_SLO_PROJECTS_FIRST_PAINT_MS', 1500);
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerEmail = `slo-owner-${runId}@example.test`;

    await createAuthUser(ownerEmail);
    const ownerSession = await signIn(ownerEmail);
    const accounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    const personalAccount = accounts.find((account) => account.personal_account);
    expect(personalAccount).toBeTruthy();
    const project = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects',
      {
        account_id: personalAccount!.account_id,
        name: `SLO Project ${runId}`,
        repo_url: `https://github.com/kortix-ai/slo-${runId}.git`,
        default_branch: 'main',
      },
      201,
    );

    const healthDurations: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const { durationMs } = await measure(async () => {
        const response = await fetch(`${apiBase}/health`);
        expect(response.status).toBe(200);
        await response.text();
      });
      healthDurations.push(durationMs);
    }
    assertSlo('GET /v1/health p95', percentile(healthDurations, 95), healthLimit);

    await installBrowserSession(page, ownerSession, '/projects');
    await selectAccountForUi(page, personalAccount!.account_id);
    const { durationMs: projectsFirstPaintMs } = await measure(async () => {
      await page.goto('/projects', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('h3', { hasText: project.name })).toBeVisible();
    });
    assertSlo('web /projects first paint', projectsFirstPaintMs, projectsFirstPaintLimit);

    await api<{ ok: true }>(ownerSession.access_token, 'DELETE', `/projects/${project.project_id}`);
  });
});
