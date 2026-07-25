import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
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
  const deadline = Date.now() + 5 * 60_000;
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
  test.setTimeout(8 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    const email = `sdk-only-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    user = await createAuthUser(email, authOptions);
    auth = await signIn(email, authOptions);

    const accounts = await api<AccountSummary[]>(auth.access_token, 'GET', '/accounts');
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    expect(account?.account_id).toBeTruthy();
    execFileSync(
      'psql',
      [
        databaseUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO kortix.credit_accounts (account_id, balance, tier)
         VALUES ('${account.account_id}', 1000, 'tier_2_20')
         ON CONFLICT (account_id)
         DO UPDATE SET balance = 1000, tier = 'tier_2_20'`,
      ],
      { stdio: 'ignore' },
    );

    const project = await api<ProjectSummary>(
      auth.access_token,
      'POST',
      '/projects/provision',
      {
        account_id: account.account_id,
        name: `SDK-only E2E ${Date.now()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    await api(
      auth.access_token,
      'PATCH',
      `/projects/${projectId}/onboarding`,
      { completed: true },
    );

    const session = await api<ProjectSession>(
      auth.access_token,
      'POST',
      `/projects/${projectId}/sessions`,
      {
        name: 'SDK-only browser session',
        opencode_model: 'kortix/claude-sonnet-4.6',
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
    const failedKortixResponses: string[] = [];

    page.on('request', (request) => {
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

    await installBrowserSession(
      page,
      auth,
      `/projects/${projectId}/sessions/${sessionId}`,
      password,
    );

    await expect(page).toHaveURL(`/projects/${projectId}/sessions/${sessionId}`);
    await expect(page.getByTestId('session-layout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('session-chat')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: 'Agent picker' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Model picker' })).toBeVisible();
    const welcomeCard = page.getByRole('complementary', { name: /Welcome from Marko/i });
    if (await welcomeCard.isVisible().catch(() => false)) {
      await welcomeCard.getByRole('button', { name: 'Dismiss' }).click();
    }

    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    await input.fill('Reply with exactly one word: PONG');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page.getByText('PONG', { exact: true }).last()).toBeVisible({
      timeout: 120_000,
    });
    expect(runtimeRequests).toHaveLength(1);
    expect(failedKortixResponses).toEqual([]);

    await page.getByRole('button', { name: /^Files$/ }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/files`);
    await expect(page.getByText('kortix.yaml', { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
  });
});
