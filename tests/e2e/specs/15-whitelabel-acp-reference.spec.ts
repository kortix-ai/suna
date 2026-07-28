import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createScopedKortix } from '@kortix/sdk/server';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  signIn,
} from '../helpers/session-auth';

const enabled = process.env.E2E_ENABLE_WHITELABEL_ACP === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:16708/v1';
const whiteLabelBase = process.env.E2E_WHITELABEL_URL || 'http://localhost:3010';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl =
  process.env.E2E_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'WhiteLabelAcpReference123!';
const authOptions = { supabaseUrl, password };

async function waitForReadySession(
  kortix: ReturnType<typeof createScopedKortix>,
  projectId: string,
  sessionId: string,
  expectedTransport: 'acp' | 'rest',
): Promise<void> {
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await kortix.session(projectId, sessionId).start(8_000);
    last = `${result?.stage ?? 'none'}:${result?.sandbox?.status ?? 'none'}:${result?.runtime_transport ?? 'none'}`;
    if (result?.stage === 'failed' || result?.sandbox?.status === 'failed') {
      throw new Error(`Session failed before readiness: ${last}`);
    }
    if (
      result?.stage === 'ready' &&
      result.sandbox?.status === 'active' &&
      result.sandbox.external_id &&
      result.runtime_transport === expectedTransport
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Session did not become ready: ${last}`);
}

test.describe
  .serial('15 — white-label ACP reference', () => {
    test.skip(!enabled, 'Set E2E_ENABLE_WHITELABEL_ACP=1 for the real sandbox flow.');
    test.setTimeout(15 * 60_000);

    let user: AuthUser;
    let auth: AuthSession;
    let kortix: ReturnType<typeof createScopedKortix>;
    let projectId = '';
    let sessionId = '';

    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(15 * 60_000);
      const email = `whitelabel-acp-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
      user = await createAuthUser(email, authOptions);
      auth = await signIn(email, authOptions);
      kortix = createScopedKortix({
        backendUrl: apiBase,
        getToken: async () => auth.access_token,
      });

      const accounts = await kortix.accounts.list();
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

      const project = await kortix.projects.provision({
        account_id: account.account_id,
        name: `White-label ACP ${Date.now()}`,
        seed_starter: true,
      });
      projectId = project.project_id;

      const projectHandle = kortix.project(projectId);
      await projectHandle.onboardingComplete(true);
      await projectHandle.modelDefaults.set({
        scope: 'project',
        model: 'claude-sonnet-4.6',
      });
      await projectHandle.updateExperimentalFeature('acp_runtime', true);

      const session = await projectHandle.sessions.create({
        name: 'White-label transport proof',
        agent_name: 'kortix',
        opencode_model: 'kortix/claude-sonnet-4.6',
      });
      sessionId = session.session_id;
      await waitForReadySession(kortix, projectId, sessionId, 'acp');
    });

    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(2 * 60_000);
      if (projectId && sessionId) {
        await kortix.session(projectId, sessionId).delete().catch(() => {});
      }
      if (projectId) {
        await kortix.project(projectId).archive().catch(() => {});
      }
      if (user?.id) {
        await deleteAuthUser(user.id, {
          supabaseUrl,
          envFiles: ['apps/api/.env', 'apps/web/.env'],
        });
      }
    });

    test('sends through ACP, toggles the server experiment, and rolls back through REST', async ({
      page,
    }) => {
      const acpRequests: Array<Record<string, unknown>> = [];
      const acpStreams: string[] = [];
      const restPromptRequests: string[] = [];

      page.on('request', (request) => {
        if (request.method() === 'GET' && request.url().includes('/kortix/acp/')) {
          acpStreams.push(request.url());
        }
        if (request.method() === 'POST' && request.url().includes('/kortix/acp/')) {
          const body = request.postDataJSON();
          if (body && typeof body === 'object') {
            acpRequests.push(body as Record<string, unknown>);
          }
        }
        if (request.url().includes('/prompt_async')) {
          restPromptRequests.push(request.url());
        }
      });

      await page.addInitScript((token) => {
        window.localStorage.setItem('kortix_api_key', token);
      }, auth.access_token);

      await page.goto(`${whiteLabelBase}/projects/${projectId}/sessions/${sessionId}`, {
        waitUntil: 'domcontentloaded',
      });

      const input = page.getByPlaceholder(/Message the agent/);
      await expect(input).toBeVisible({ timeout: 120_000 });
      await expect.poll(() => acpStreams.length, { timeout: 30_000 }).toBeGreaterThan(0);

      await input.fill('Reply with exactly: WHITE_LABEL_ACP_PONG');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('WHITE_LABEL_ACP_PONG', { exact: true }).last()).toBeVisible({
        timeout: 120_000,
      });

      expect(acpRequests.filter((request) => request.method === 'session/prompt')).toHaveLength(1);
      expect(restPromptRequests).toHaveLength(0);

      await page.goto(`${whiteLabelBase}/projects/${projectId}/settings`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible({
        timeout: 120_000,
      });
      const acpSwitch = page.getByRole('switch', {
        name: 'Enable ACP Runtime',
      });
      await expect(acpSwitch).toBeVisible({ timeout: 30_000 });
      await expect(acpSwitch).toBeChecked();
      await acpSwitch.click();
      await expect(acpSwitch).not.toBeChecked({ timeout: 30_000 });

      await waitForReadySession(kortix, projectId, sessionId, 'rest');

      await page.goto(`${whiteLabelBase}/projects/${projectId}/sessions/${sessionId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(input).toBeVisible({ timeout: 120_000 });

      const modelPicker = page
        .getByRole('button')
        .filter({ hasText: /Default model|Claude Sonnet 4\.6/ })
        .first();
      await expect(modelPicker).toBeVisible({ timeout: 120_000 });
      await modelPicker.click();
      const restModel = page.getByRole('button').filter({ hasText: 'Claude Sonnet 4.6' }).last();
      await expect(restModel).toBeVisible({ timeout: 120_000 });
      await restModel.click();

      await input.fill('Reply with exactly: WHITE_LABEL_REST_PONG');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('WHITE_LABEL_REST_PONG', { exact: true }).last()).toBeVisible({
        timeout: 120_000,
      });

      expect(restPromptRequests).toHaveLength(1);
    });
  });
