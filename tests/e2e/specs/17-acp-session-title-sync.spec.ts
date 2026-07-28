import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';

const enabled = process.env.E2E_ENABLE_ACP_TITLE_SYNC === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl =
  process.env.E2E_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'AcpTitleSync123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

interface ReadySession {
  externalId: string;
  opencodeSessionId: string;
}

interface ProjectSession {
  session_id: string;
  name: string | null;
}

async function waitForReadySession(
  token: string,
  projectId: string,
  sessionId: string,
  expectedTransport: 'acp' | 'rest',
): Promise<ReadySession> {
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await api<{
      stage: string;
      runtime_transport?: 'acp' | 'rest';
      opencode_session_id?: string | null;
      sandbox?: { status?: string; external_id?: string | null } | null;
    }>(token, 'POST', `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`, {});
    last = [
      result.stage,
      result.sandbox?.status ?? 'none',
      result.runtime_transport ?? 'none',
      result.opencode_session_id ?? 'none',
    ].join(':');
    if (result.stage === 'failed' || result.sandbox?.status === 'failed') {
      throw new Error(`session failed before readiness: ${last}`);
    }
    if (
      result.stage === 'ready' &&
      result.sandbox?.status === 'active' &&
      result.sandbox.external_id &&
      result.runtime_transport === expectedTransport &&
      result.opencode_session_id
    ) {
      return {
        externalId: result.sandbox.external_id,
        opencodeSessionId: result.opencode_session_id,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`session did not become ready: ${last}`);
}

test.describe.serial('17 — ACP session title synchronization', () => {
  test.skip(!enabled, 'Set E2E_ENABLE_ACP_TITLE_SYNC=1 for the real sandbox flow.');
  test.setTimeout(20 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let projectId = '';
  const sessionIds: string[] = [];

  test.beforeAll(async ({ browser: _browser }, testInfo) => {
    testInfo.setTimeout(20 * 60_000);
    const email = `acp-title-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    user = await createAuthUser(email, authOptions);
    auth = await signIn(email, authOptions);

    const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
      auth.access_token,
      'GET',
      '/accounts',
    );
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

    const project = await api<{ project_id: string }>(
      auth.access_token,
      'POST',
      '/projects/provision',
      {
        account_id: account.account_id,
        name: `ACP title sync ${Date.now()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    await api(auth.access_token, 'PATCH', `/projects/${projectId}/onboarding`, {
      completed: true,
    });
    await api(auth.access_token, 'PUT', `/projects/${projectId}/model-defaults`, {
      scope: 'project',
      model: 'claude-sonnet-4.6',
    });
  });

  test.afterAll(async ({ browser: _browser }, testInfo) => {
    testInfo.setTimeout(2 * 60_000);
    if (projectId) {
      for (const sessionId of sessionIds) {
        await api(
          auth.access_token,
          'DELETE',
          `/projects/${projectId}/sessions/${sessionId}`,
        ).catch(() => {});
      }
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

  test('updates the sidebar from ACP and REST titles without a refresh', async ({ page }) => {
    const acpPrompts: string[] = [];
    const restPrompts: string[] = [];
    const sessionLists: ProjectSession[][] = [];
    let mainFrameNavigations = 0;

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/kortix/acp/')) {
        const body = request.postData() ?? '';
        if (body.includes('"method":"session/prompt"')) acpPrompts.push(body);
      }
      if (request.url().includes('/prompt_async')) restPrompts.push(request.url());
    });
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (
        response.request().method() !== 'GET' ||
        url.pathname !== `/v1/projects/${projectId}/sessions`
      ) {
        return;
      }
      const body = await response.json().catch(() => null);
      if (Array.isArray(body)) sessionLists.push(body as ProjectSession[]);
    });

    for (const transport of ['acp', 'rest'] as const) {
      await api(auth.access_token, 'PATCH', `/projects/${projectId}/experimental`, {
        feature: 'acp_runtime',
        enabled: transport === 'acp',
      });
      const session = await api<{ session_id: string }>(
        auth.access_token,
        'POST',
        `/projects/${projectId}/sessions`,
        { opencode_model: 'kortix/claude-sonnet-4.6' },
        201,
      );
      const sessionId = session.session_id;
      sessionIds.push(sessionId);
      await waitForReadySession(auth.access_token, projectId, sessionId, transport);

      const path = `/projects/${projectId}/sessions/${sessionId}${
        transport === 'acp' ? '?acp' : ''
      }`;
      await installBrowserSession(page, auth, path, password);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await expect(input).toBeVisible({ timeout: 120_000 });
      const sessionTitle = page.locator(
        `a[href="/projects/${projectId}/sessions/${sessionId}"] span[title]`,
      );
      await expect(sessionTitle).toHaveAttribute('title', 'New session', {
        timeout: 30_000,
      });

      const welcomeCard = page.getByRole('complementary', {
        name: /Welcome from Marko/i,
      });
      if (await welcomeCard.isVisible().catch(() => false)) {
        await welcomeCard.getByRole('button', { name: 'Dismiss' }).click();
      }

      acpPrompts.length = 0;
      restPrompts.length = 0;
      sessionLists.length = 0;
      const navigationsBeforePrompt = mainFrameNavigations;
      const marker = transport === 'acp' ? 'ACP_TITLE_SYNC_DONE' : 'REST_TITLE_SYNC_DONE';
      const sendButton = page.getByRole('button', { name: 'Send message' });
      await expect(page.getByText('Sandbox build running...', { exact: true })).toBeHidden({
        timeout: 12 * 60_000,
      });
      await input.fill(`Research the number 7 briefly. Then reply exactly ${marker}.`);
      await expect(sendButton).toBeEnabled({ timeout: 30_000 });
      await sendButton.click();
      await expect(page.getByText(marker, { exact: true }).last()).toBeVisible({
        timeout: 120_000,
      });
      await expect
        .poll(() => sessionTitle.getAttribute('title'), { timeout: 120_000 })
        .not.toBe('New session');

      const renderedTitle = await sessionTitle.getAttribute('title');
      expect(renderedTitle).toBeTruthy();
      if (!renderedTitle) throw new Error('sidebar did not render the generated session title');
      expect(mainFrameNavigations).toBe(navigationsBeforePrompt);
      expect(acpPrompts).toHaveLength(transport === 'acp' ? 1 : 0);
      expect(restPrompts).toHaveLength(transport === 'rest' ? 1 : 0);
      expect(sessionLists.length).toBeGreaterThan(0);

      const browserSnapshot = sessionLists
        .flat()
        .find((item) => item.session_id === sessionId && item.name === renderedTitle);
      expect(browserSnapshot?.name).toBe(renderedTitle);

      const persisted = await api<ProjectSession[]>(
        auth.access_token,
        'GET',
        `/projects/${projectId}/sessions`,
      );
      expect(persisted.find((item) => item.session_id === sessionId)?.name).toBe(renderedTitle);
    }
  });
});
