import { expect, test, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = process.env.E2E_GOLDEN_PASSWORD || 'E2eGoldenPaths123!';
const runGoldenPaths = process.env.E2E_ENABLE_GOLDEN_PATHS === '1';
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
  metadata?: Record<string, unknown>;
  project_role: string | null;
  effective_project_role: string | null;
}

interface ProjectSession {
  session_id: string;
  project_id: string;
  branch_name: string;
  sandbox_provider: 'daytona' | 'local_docker';
  sandbox_id: string | null;
  status: string;
}

interface SessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  provider: 'daytona' | 'local_docker';
  external_id: string | null;
  status: string;
}

interface InviteResult {
  status: 'added' | 'pending';
  invite_id?: string;
  user_id?: string;
  email: string;
}

interface ProjectTrigger {
  trigger_id: string;
  project_id: string;
  type: 'webhook' | 'cron';
  config: Record<string, unknown>;
}

interface WebhookFireResponse {
  status: 'fired' | 'queued';
  event: {
    event_id: string;
    status: string;
    session_id: string | null;
    rendered_prompt: string | null;
  };
  session?: ProjectSession;
  backpressure?: Record<string, unknown>;
}

interface OpenCodeFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

function repoRoot(): string {
  const path = require('path') as typeof import('node:path');
  return path.resolve(__dirname, '../../..');
}

function parseEnvFile(relativePath: string): Record<string, string> {
  const fs = require('fs') as typeof import('node:fs');
  const path = require('path') as typeof import('node:path');
  const filePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(repoRoot(), relativePath);
  if (!fs.existsSync(filePath)) return {};

  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return env;
}

function candidateEnvFiles(files: string[]): string[] {
  const path = require('path') as typeof import('node:path');
  const explicit = (process.env.E2E_ENV_FILE || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...explicit, ...files];
}

function requireEnvValue(name: string, ...files: string[]): string {
  if (process.env[name]) return process.env[name]!;

  for (const file of candidateEnvFiles(files)) {
    const value = parseEnvFile(file)[name];
    if (value) return value;
  }
  throw new Error(`${name} was not found in ${candidateEnvFiles(files).join(', ')}`);
}

function optionalEnvValue(name: string, ...files: string[]): string | undefined {
  if (process.env[name]) return process.env[name];

  for (const file of candidateEnvFiles(files)) {
    const value = parseEnvFile(file)[name];
    if (value) return value;
  }
  return undefined;
}

function databaseUrl(): string {
  return process.env.E2E_DATABASE_URL || requireEnvValue('DATABASE_URL', 'apps/api/.env');
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
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const lockScreen = page.getByText('Click or press Enter to sign in');
  if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
    await page.waitForTimeout(1_500);
    if (!(await page.locator('input[name="email"]').isVisible().catch(() => false))) {
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      });
    }
  }

  await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Sign in$/i }).first().click();
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

async function poll<T>(
  label: string,
  fn: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      lastValue = value;
      if (ready(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${label} timed out. Last value: ${JSON.stringify(lastValue)}. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForSandbox(token: string, projectId: string, sessionId: string) {
  return poll<SessionSandbox>(
    `sandbox ${sessionId}`,
    () => api<SessionSandbox>(token, 'GET', `/projects/${projectId}/sessions/${sessionId}/sandbox`),
    (sandbox) => sandbox.status === 'active' && Boolean(sandbox.external_id),
    180_000,
  );
}

async function waitForDaemonHealth(token: string, externalId: string) {
  return poll<Record<string, unknown>>(
    `daemon health ${externalId}`,
    async () => json<Record<string, unknown>>(
      await fetch(`${apiBase}/p/${externalId}/8000/kortix/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      200,
    ),
    (health) => health.daemon === 'ok',
    180_000,
  );
}

async function waitForOpenCodeHealth(token: string, externalId: string) {
  return poll<Record<string, unknown>>(
    `OpenCode health ${externalId}`,
    async () => json<Record<string, unknown>>(
      await fetch(`${apiBase}/p/${externalId}/8000/global/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      200,
    ),
    (health) => health.healthy === true,
    180_000,
  );
}

async function waitForProxiedFileList(token: string, externalId: string, path: string) {
  return poll<OpenCodeFileNode[]>(
    `proxied file list ${externalId}:${path}`,
    async () => json<OpenCodeFileNode[]>(
      await fetch(`${apiBase}/p/${externalId}/8000/file?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      200,
    ),
    (files) => Array.isArray(files) && files.length > 0,
    180_000,
  );
}

async function stopActiveProjectSessions(token: string, projectId: string) {
  const sessions = await api<ProjectSession[]>(token, 'GET', `/projects/${projectId}/sessions`);
  await Promise.all(sessions
    .filter((session) => !['stopped', 'completed', 'failed', 'archived'].includes(session.status))
    .map((session) => api(token, 'DELETE', `/projects/${projectId}/sessions/${session.session_id}`)));
}

function queryScalar(sql: string): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('psql', [
    databaseUrl(),
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ], { encoding: 'utf8' }).trim();
}

function webhookSignature(rawBody: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
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

test.describe.serial('10 - SPEC production golden paths', () => {
  test.skip(!runGoldenPaths, 'Set E2E_ENABLE_GOLDEN_PATHS=1 to run destructive production-like golden paths.');
  test.setTimeout(900_000);

  let runId: string;
  let owner: AuthUser;
  let ownerSession: AuthSession;
  let account: AccountSummary;
  let project: ProjectSummary;
  let primarySession: ProjectSession;
  let primarySandbox: SessionSandbox;

  test.beforeAll(async () => {
    runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerEmail = `golden-owner-${runId}@example.test`;
    owner = await createAuthUser(ownerEmail);
    ownerSession = await signIn(ownerEmail);

    const accounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    expect(accounts.some((item) => item.personal_account)).toBe(true);

    account = await api<AccountSummary>(
      ownerSession.access_token,
      'POST',
      '/accounts',
      { name: `Golden Org ${runId}` },
      201,
    );
  });

  test('E2E-2 and E2E-3: account filtering plus pending invite auto-claim', async ({ page }) => {
    const bobEmail = `golden-bob-${runId}@example.test`;
    const personalProjectName = `golden-personal-${runId}`;
    const accountProjectName = `golden-account-${runId}`;

    const ownerAccounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    const personalAccount = ownerAccounts.find((item) => item.personal_account);
    expect(personalAccount).toBeTruthy();
    expect(ownerAccounts.map((item) => item.account_id)).toContain(account.account_id);

    const personalProject = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects',
      {
        account_id: personalAccount!.account_id,
        name: personalProjectName,
        repo_url: `https://github.com/kortix-ai/${personalProjectName}.git`,
        default_branch: 'main',
      },
      201,
    );

    const accountProject = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects',
      {
        account_id: account.account_id,
        name: accountProjectName,
        repo_url: `https://github.com/kortix-ai/${accountProjectName}.git`,
        default_branch: 'main',
      },
      201,
    );

    const personalProjects = await api<ProjectSummary[]>(
      ownerSession.access_token,
      'GET',
      `/projects?account_id=${personalAccount!.account_id}`,
    );
    expect(personalProjects.map((item) => item.project_id)).toContain(personalProject.project_id);
    expect(personalProjects.map((item) => item.project_id)).not.toContain(accountProject.project_id);

    const accountProjects = await api<ProjectSummary[]>(
      ownerSession.access_token,
      'GET',
      `/projects?account_id=${account.account_id}`,
    );
    expect(accountProjects.map((item) => item.project_id)).toContain(accountProject.project_id);
    expect(accountProjects.map((item) => item.project_id)).not.toContain(personalProject.project_id);

    const invite = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: bobEmail, role: 'member' },
      201,
    );
    expect(invite.status).toBe('pending');
    expect(invite.invite_id).toBeTruthy();

    await createAuthUser(bobEmail);
    const bobSession = await signIn(bobEmail);
    const bobAccounts = await api<AccountSummary[]>(bobSession.access_token, 'GET', '/accounts');
    expect(bobAccounts.map((item) => item.account_id)).toContain(account.account_id);

    await installBrowserSession(page, ownerSession, '/projects');
    await selectAccountForUi(page, personalAccount!.account_id);
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h3', { hasText: personalProjectName })).toBeVisible();
    await expect(page.getByText(accountProjectName)).toHaveCount(0);

    await selectAccountForUi(page, account.account_id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('h3', { hasText: accountProjectName })).toBeVisible();
  });

  test('E2E-1 and E2E-4: GitHub repo project starts a session and reaches daemon health', async () => {
    const repoName = `kortix-golden-${runId}`.replace(/[^a-zA-Z0-9._-]/g, '-');
    project = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects/create-repo',
      {
        account_id: account.account_id,
        name: repoName,
        private: true,
      },
      201,
    );
    expect(project.repo_url).toContain('github.com');
    expect(project.effective_project_role).toBe('manager');
    if (process.env.E2E_REQUIRE_GITHUB_APP === '1') {
      const github = (project.metadata?.github ?? {}) as Record<string, unknown>;
      expect(github.auth_source).toBe('app_installation');
    }

    const opencodeFiles = await api<Array<{ path?: string; name?: string }>>(
      ownerSession.access_token,
      'GET',
      `/projects/${project.project_id}/files?path=.opencode`,
    );
    expect(opencodeFiles.length).toBeGreaterThan(0);

    const opencodeConfig = await api<{ content: string }>(
      ownerSession.access_token,
      'GET',
      `/projects/${project.project_id}/files/content?path=.opencode/opencode.jsonc`,
    );
    expect(opencodeConfig.content).toContain('provider');

    const sessionCreate = await measure(() => api<ProjectSession>(
      ownerSession.access_token,
      'POST',
      `/projects/${project.project_id}/sessions`,
      {
        provider: process.env.E2E_GOLDEN_PROVIDER || undefined,
      },
      201,
    ));
    primarySession = sessionCreate.value;
    assertSlo('POST /v1/projects/:id/sessions -> 201', sessionCreate.durationMs, threshold('E2E_SLO_SESSION_CREATE_MS', 800));
    expect(primarySession.session_id).toBeTruthy();
    if (process.env.E2E_GOLDEN_PROVIDER) {
      expect(primarySession.sandbox_provider).toBe(process.env.E2E_GOLDEN_PROVIDER);
    }
    expect(primarySession.branch_name).toBe(primarySession.session_id);
    expect(primarySession.sandbox_id).toBe(primarySession.session_id);

    const sandboxActivation = await measure(() => waitForSandbox(ownerSession.access_token, project.project_id, primarySession.session_id));
    primarySandbox = sandboxActivation.value;
    const sandboxLimit = primarySession.sandbox_provider === 'local_docker'
      ? threshold('E2E_SLO_LOCAL_DOCKER_ACTIVE_MS', 15_000)
      : threshold('E2E_SLO_DAYTONA_ACTIVE_MS', 45_000);
    assertSlo(`${primarySession.sandbox_provider} provisioning -> active`, sandboxActivation.durationMs, sandboxLimit);
    expect(primarySandbox.session_id).toBe(primarySession.session_id);
    expect(primarySandbox.sandbox_id).toBe(primarySession.session_id);
    expect(primarySandbox.external_id).toBeTruthy();

    const legacyCount = Number(queryScalar(`
      SELECT count(*)::int
      FROM kortix.sandboxes
      WHERE sandbox_id = '${primarySession.session_id}'::uuid
         OR external_id = '${primarySandbox.external_id}'
    `));
    expect(legacyCount).toBe(0);

    const health = await waitForDaemonHealth(ownerSession.access_token, primarySandbox.external_id!);
    expect(health.daemon).toBe('ok');
    expect(['ok', 'starting']).toContain(health.opencode);

    const proxiedOpencodeFiles = await waitForProxiedFileList(
      ownerSession.access_token,
      primarySandbox.external_id!,
      '.opencode',
    );
    expect(proxiedOpencodeFiles.some((file) => (
      file.type === 'directory'
      && (file.path === '.opencode/agents' || file.path.endsWith('/agents') || file.name === 'agents')
    ))).toBe(true);

    const proxiedAgentFiles = await waitForProxiedFileList(
      ownerSession.access_token,
      primarySandbox.external_id!,
      '.opencode/agents',
    );
    expect(proxiedAgentFiles.some((file) => file.type === 'file' && (file.path.endsWith('/default.md') || file.name === 'default.md'))).toBe(true);
    expect(proxiedAgentFiles.some((file) => file.type === 'file' && (file.path.endsWith('/reviewer.md') || file.name === 'reviewer.md'))).toBe(true);
  });

  test('E2E-5: local_docker provider starts the same sandbox image and reaches health', async () => {
    test.skip(process.env.E2E_GOLDEN_LOCAL_DOCKER !== '1', 'Set E2E_GOLDEN_LOCAL_DOCKER=1 to run the local_docker golden path.');
    expect(project).toBeTruthy();

    if (primarySession?.sandbox_provider === 'local_docker' && primarySandbox?.external_id) {
      expect(primarySandbox.provider).toBe('local_docker');
      expect(primarySandbox.external_id).not.toBe(primarySession.session_id);
      const health = await waitForDaemonHealth(ownerSession.access_token, primarySandbox.external_id);
      expect(health.daemon).toBe('ok');
      return;
    }

    const localSession = await api<ProjectSession>(
      ownerSession.access_token,
      'POST',
      `/projects/${project.project_id}/sessions`,
      { provider: 'local_docker' },
      201,
    );
    expect(localSession.sandbox_provider).toBe('local_docker');
    expect(localSession.branch_name).toBe(localSession.session_id);

    const sandbox = await waitForSandbox(ownerSession.access_token, project.project_id, localSession.session_id);
    expect(sandbox.provider).toBe('local_docker');
    expect(sandbox.external_id).toBeTruthy();
    expect(sandbox.external_id).not.toBe(localSession.session_id);

    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const dockerPs = execFileSync('docker', [
      'ps',
      '--format',
      '{{.Names}} {{.ID}} {{.Ports}}',
      '--filter',
      `name=kortix-session-${localSession.session_id.slice(0, 8)}`,
    ], { encoding: 'utf8' });
    expect(dockerPs).toContain('kortix-session-');
    expect(dockerPs).toContain('8000');

    const health = await waitForDaemonHealth(ownerSession.access_token, sandbox.external_id!);
    expect(health.daemon).toBe('ok');
  });

  test('E2E-6: new session opens the project chat route without legacy redirects', async ({ page }) => {
    expect(project).toBeTruthy();
    await stopActiveProjectSessions(ownerSession.access_token, project.project_id);
    await installBrowserSession(page, ownerSession, `/projects/${project.project_id}/sessions`);
    await selectAccountForUi(page, account.account_id);
    await page.goto(`/projects/${project.project_id}/sessions`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /New session/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/sessions/[0-9a-f-]+$`), { timeout: 90_000 });
    const createdSessionId = page.url().split('/').pop() || '';
    expect(page.url()).not.toContain('/instances');
    expect(page.url()).not.toContain('/dashboard');
    expect(new URL(page.url()).pathname).not.toMatch(/^\/sessions\/[0-9a-f-]+$/);
    await expect(page.getByText('Provisioning session')).toBeVisible({ timeout: 30_000 });

    const sandbox = await waitForSandbox(ownerSession.access_token, project.project_id, createdSessionId);
    await waitForDaemonHealth(ownerSession.access_token, sandbox.external_id!);
    await waitForOpenCodeHealth(ownerSession.access_token, sandbox.external_id!);

    await expect(page.getByTestId('session-layout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('session-chat')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: 'Agent picker' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Model picker' })).toBeVisible({ timeout: 30_000 });
    const sidebarSessionLink = page.locator(`a[href="/projects/${project.project_id}/sessions/${createdSessionId}"]`).first();
    await expect(sidebarSessionLink).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Reaching workspace/i)).toHaveCount(0);
    await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Secrets', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Triggers', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /^Files$/ }).click();
    await expect(page).toHaveURL(`/projects/${project.project_id}/files`);
    expect(page.url()).not.toContain('/instances');
    expect(page.url()).not.toContain('/dashboard');
    await sidebarSessionLink.click();
    await expect(page).toHaveURL(`/projects/${project.project_id}/sessions/${createdSessionId}`);

    const badResponses: string[] = [];
    page.on('response', (response) => {
      const url = response.url();
      if (response.status() >= 400 && (url.includes('/v1/projects') || url.includes('/v1/p/'))) {
        badResponses.push(`${response.status()} ${response.request().method()} ${url}`);
      }
    });

    const urlBeforeRefresh = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(urlBeforeRefresh);
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 120_000 });
    expect(badResponses).toEqual([]);
    if (createdSessionId) {
      await api(ownerSession.access_token, 'DELETE', `/projects/${project.project_id}/sessions/${createdSessionId}`);
    }
  });

  test('E2E-7: signed webhook trigger fires a session and rejects bad signatures', async () => {
    expect(project).toBeTruthy();
    await stopActiveProjectSessions(ownerSession.access_token, project.project_id);
    const secret = `golden-secret-${runId}`;
    const trigger = await api<ProjectTrigger>(
      ownerSession.access_token,
      'POST',
      `/projects/${project.project_id}/triggers`,
      {
        type: 'webhook',
        agent_name: 'default',
        prompt_template: 'Process: {{ body.foo }}',
        config: {
          secret,
          provider: process.env.E2E_GOLDEN_PROVIDER || undefined,
        },
      },
      201,
    );
    expect(trigger.trigger_id).toBeTruthy();
    expect(trigger.config.has_secret).toBe(true);

    const rawBody = JSON.stringify({ foo: 'bar' });
    await json(
      await fetch(`${apiBase}/webhooks/${trigger.trigger_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      }),
      401,
    );
    await json(
      await fetch(`${apiBase}/webhooks/${trigger.trigger_id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kortix-Signature': 'sha256=bad',
        },
        body: rawBody,
      }),
      401,
    );

    const fired = await json<WebhookFireResponse>(
      await fetch(`${apiBase}/webhooks/${trigger.trigger_id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kortix-Signature': webhookSignature(rawBody, secret),
        },
        body: rawBody,
      }),
      202,
    );
    expect(fired.status).toBe('fired');
    expect(fired.event.status).toBe('fired');
    expect(fired.event.session_id).toBeTruthy();
    expect(fired.event.rendered_prompt).toContain('bar');
    expect(fired.session?.session_id).toBe(fired.event.session_id);
    if (process.env.E2E_GOLDEN_PROVIDER && fired.session) {
      expect(fired.session.sandbox_provider).toBe(process.env.E2E_GOLDEN_PROVIDER);
    }

    const storedEvent = queryScalar(`
      SELECT status || E'\\t' || COALESCE(session_id::text, '')
      FROM kortix.project_trigger_events
      WHERE event_id = '${fired.event.event_id}'::uuid
    `);
    expect(storedEvent).toBe(`fired\t${fired.event.session_id}`);

    if (process.env.E2E_GOLDEN_BACKPRESSURE === '1') {
      const queued = await json<WebhookFireResponse>(
        await fetch(`${apiBase}/webhooks/${trigger.trigger_id}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Kortix-Signature': webhookSignature(rawBody, secret),
          },
          body: rawBody,
        }),
        [202],
      );
      expect(['fired', 'queued']).toContain(queued.status);
      if (queued.status === 'queued') {
        expect(queued.event.status).toBe('queued');
        expect(queued.backpressure).toBeTruthy();
      }
    }
  });
});
