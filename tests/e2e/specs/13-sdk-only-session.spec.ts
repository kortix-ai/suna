import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';

const enabled = process.env.E2E_ENABLE_SDK_ONLY_SESSION === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'SdkOnlySession123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };
const databaseUrl = process.env.E2E_DATABASE_URL
  || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

test.use({
  launchOptions: {
    args: ['--disable-gpu', '--disable-webgl', '--disable-webgl2'],
  },
});

function executeSql(sql: string): string {
  return execFileSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function readAccountTier(accountId: string): string {
  return executeSql(
    `SELECT tier FROM kortix.credit_accounts WHERE account_id = '${accountId}'`,
  );
}

function fundAccount(accountId: string): void {
  executeSql(
    `INSERT INTO kortix.credit_accounts (
       account_id,
       balance,
       balance_precise,
       non_expiring_credits,
       non_expiring_credits_precise,
       tier
     )
     VALUES ('${accountId}', 1000, 1000, 1000, 1000, 'tier_2_20')
     ON CONFLICT (account_id)
     DO UPDATE SET
       balance = 1000,
       balance_precise = 1000,
       non_expiring_credits = 1000,
       non_expiring_credits_precise = 1000,
       tier = 'tier_2_20'`,
  );
}

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

interface ProjectSummary {
  project_id: string;
}

interface ProjectSession {
  session_id: string;
}

interface BillingState {
  subscription: {
    tier_key: string;
  };
}

interface ModelDefaults {
  freeTier: boolean;
  resolvedForCaller: string | null;
}

interface ModelPicker {
  models: Record<string, unknown>;
}

interface SessionStart {
  stage: string;
  sandbox?: {
    status?: string;
    external_id?: string | null;
  } | null;
}

async function waitForReadySession(
  token: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await api<SessionStart>(
      token,
      'POST',
      `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`,
      {},
    );
    last = `${result.stage}:${result.sandbox?.status ?? 'none'}`;
    if (
      result.stage === 'ready'
      && result.sandbox?.status === 'active'
      && result.sandbox.external_id
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`session did not become ready: ${last}`);
}

test.describe.serial('13 — SDK-only web session', () => {
  test.skip(!enabled, 'Set E2E_ENABLE_SDK_ONLY_SESSION=1 for the real sandbox flow.');
  test.setTimeout(12 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let accountId = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    const email = `sdk-only-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    user = await createAuthUser(email, authOptions);
    auth = await signIn(email, authOptions);
    accountId = user.id;

    const accounts = await api<AccountSummary[]>(auth.access_token, 'GET', '/accounts');
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    expect(account?.account_id).toBe(accountId);
    fundAccount(accountId);
    expect(readAccountTier(accountId)).toBe('tier_2_20');

    const project = await api<ProjectSummary>(
      auth.access_token,
      'POST',
      '/projects/provision',
      {
        account_id: accountId,
        name: `SDK-only E2E ${Date.now()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    expect(readAccountTier(accountId)).toBe('tier_2_20');
    await api(
      auth.access_token,
      'PATCH',
      `/projects/${projectId}/onboarding`,
      { completed: true },
    );
    expect(readAccountTier(accountId)).toBe('tier_2_20');
    const billing = await api<BillingState>(
      auth.access_token,
      'GET',
      `/billing/account-state?account_id=${accountId}`,
    );
    expect(billing.subscription.tier_key).toBe('tier_2_20');
    const defaults = await api<ModelDefaults>(
      auth.access_token,
      'GET',
      `/projects/${projectId}/model-defaults`,
    );
    expect(defaults.freeTier).toBe(false);
    expect(defaults.resolvedForCaller).toBeTruthy();
    const picker = await api<ModelPicker>(
      auth.access_token,
      'GET',
      `/projects/${projectId}/model-picker`,
    );
    expect(Object.keys(picker.models).length).toBeGreaterThan(0);

    const session = await api<ProjectSession>(
      auth.access_token,
      'POST',
      `/projects/${projectId}/sessions`,
      {
        name: 'SDK-only browser session',
      },
      201,
    );
    sessionId = session.session_id;
    await waitForReadySession(auth.access_token, projectId, sessionId);
  });

  test.afterAll(async () => {
    if (projectId && sessionId) {
      await api(auth.access_token, 'DELETE', `/projects/${projectId}/sessions/${sessionId}`)
        .catch(() => {});
    }
    if (projectId) {
      await api(auth.access_token, 'DELETE', `/projects/${projectId}`).catch(() => {});
    }
    if (accountId) {
      execFileSync(
        'psql',
        [
          databaseUrl,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `DELETE FROM kortix.accounts WHERE account_id = '${accountId}'`,
        ],
        { stdio: 'ignore' },
      );
    }
    if (user?.id) {
      await deleteAuthUser(user.id, {
        supabaseUrl,
        envFiles: ['apps/api/.env', 'apps/web/.env'],
      });
    }
  });

  test('streams a real prompt through the SDK and keeps the project UI functional', async ({
    page,
  }) => {
    const runtimeRequests: string[] = [];
    const globalEventRequests: string[] = [];
    const acpRequests: string[] = [];
    const failedKortixResponses: string[] = [];

    page.on('request', (request) => {
      if (request.url().includes('/global/event')) {
        globalEventRequests.push(request.url());
      }
      if (request.url().includes('/kortix/acp/')) {
        acpRequests.push(request.url());
      }
      if (
        request.method() === 'POST'
        && request.url().includes('/v1/p/')
        && request.url().includes('/prompt_async')
      ) {
        runtimeRequests.push(request.url());
      }
    });
    page.on('response', (response) => {
      if (
        response.status() >= 400
        && (response.url().includes('/v1/projects/') || response.url().includes('/v1/p/'))
      ) {
        failedKortixResponses.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });

    await installBrowserSessionDirect(
      page,
      auth,
      `/projects/${projectId}/sessions/${sessionId}`,
      authOptions,
    );

    await expect(page).toHaveURL(`/projects/${projectId}/sessions/${sessionId}`);
    await expect(page.getByTestId('session-layout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('session-chat')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: 'Agent picker' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Model picker' })).toBeVisible();
    const welcomeCard = page.getByRole('complementary', { name: /Welcome from Marko/i });
    if (await welcomeCard.isVisible().catch(() => false)) {
      await welcomeCard.getByRole('button', { name: 'Dismiss' }).click({ force: true });
    }

    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    await input.fill('Reply with exactly one word: PONG');
    await page.getByRole('button', { name: 'Send message' }).click({ force: true });

    await expect(page.getByText('PONG', { exact: true }).last()).toBeVisible({
      timeout: 120_000,
    });
    expect(runtimeRequests).toHaveLength(1);
    expect(globalEventRequests.length).toBeGreaterThan(0);
    expect(acpRequests).toEqual([]);
    expect(failedKortixResponses).toEqual([]);

    await page.getByRole('button', { name: /^Files$/ }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/sessions/${sessionId}`);
    await expect(page.getByText('kortix.yaml', { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  test('falls back from a warm-session agent mismatch without reporting a global error', async ({
    page,
  }) => {
    const mismatchConsoleErrors: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (
        message.type() === 'error'
        && (
          text.includes('WARM_SESSION_CONFIGURATION_MISMATCH')
          || text.includes('The warm session does not match the selected agent or sandbox')
        )
      ) {
        mismatchConsoleErrors.push(text);
      }
    });

    const warmReady = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().endsWith(`/projects/${projectId}/sessions/warm`)
      && response.status() === 200
    ));
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await warmReady;

    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: 120_000 });
    const agentPicker = page.getByRole('button', { name: 'Agent picker' });
    await agentPicker.click();
    await page.getByText('memory-reflector', { exact: true }).click();
    await expect(agentPicker).toContainText('memory-reflector');
    await input.fill('Reply with exactly one word: PONG');

    const mismatchResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().endsWith(`/projects/${projectId}/sessions/warm/claim`)
      && response.status() === 409
    ));
    const fallbackCreate = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().endsWith(`/projects/${projectId}/sessions`)
      && response.status() === 201
    ));
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Send message' }).click({ force: true });
    await mismatchResponse;
    await fallbackCreate;
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions/[0-9a-f-]+$`),
      { timeout: 60_000 },
    );
    await expect(page.getByText('PONG', { exact: true }).last()).toBeVisible({
      timeout: 180_000,
    });
    expect(Date.now() - startedAt).toBeLessThan(180_000);
    expect(mismatchConsoleErrors).toEqual([]);
  });
});
