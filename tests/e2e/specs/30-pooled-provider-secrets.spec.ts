import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { createManifestProject, isDeployedTarget, type ManifestProject } from '../helpers/manifest-project';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const authOptions = { supabaseUrl, password: 'E2ePooledSecrets123!' };
const api = createApiJsonClient(apiBase);

test.describe('30 — pooled provider secrets', () => {
  test('a partially failed access change reloads grants before retrying', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(120_000);
    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-pool-owner-${runId}@example.test`;
    const firstEmail = `e2e-pool-first-${runId}@example.test`;
    const secondEmail = `e2e-pool-second-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const first = await createAuthUser(firstEmail, authOptions);
    const second = await createAuthUser(secondEmail, authOptions);
    const session = await signIn(ownerEmail, authOptions);
    let project: ManifestProject | null = null;
    let resourcePath: string | null = null;
    try {
      const accounts = await api<Array<{ account_id: string }>>(session.access_token, 'GET', '/accounts');
      const accountId = accounts[0]!.account_id;
      for (const email of [firstEmail, secondEmail]) {
        await api(session.access_token, 'POST', `/accounts/${accountId}/members`, { email, role: 'member' }, 201);
      }
      project = await createManifestProject({ api, accessToken: session.access_token, accountId, userId: owner.id,
        name: `Provider access ${runId}`, databaseUrl: databaseUrl! });
      await api(session.access_token, 'PATCH', `/projects/${project.id}/features`, { feature: 'pooled_provider_secrets', enabled: true });
      const key = await api<{ secret_id: string }>(session.access_token, 'POST', `/accounts/${accountId}/secret-resources`, {
        label: 'Shared team key', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY', value: 'fake-shared-team-key',
        consumer: 'llm_gateway', strategy: 'broker',
      }, 201);
      resourcePath = `/accounts/${accountId}/secret-resources/${key.secret_id}`;
      await installBrowserSessionDirect(page, session, `/projects/${project.id}/customize/models`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${project.id}/customize/models`, { waitUntil: 'domcontentloaded' });
      const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
      if (await welcome.isVisible().catch(() => false)) await welcome.getByRole('button', { name: 'Dismiss' }).click();
      const panel = page.getByRole('region', { name: 'Anthropic API keys' });
      await panel.getByRole('button', { name: 'Actions for Shared team key' }).click();
      await page.getByRole('menuitem', { name: 'Manage access' }).click();
      const dialog = page.getByRole('dialog', { name: 'Access to Shared team key' });
      await dialog.getByRole('button', { name: firstEmail }).click();
      await dialog.getByRole('button', { name: secondEmail }).click();
      let rejectSecond = true;
      await page.route(`**/v1${resourcePath}/grants/${second.id}`, async (route) => {
        if (rejectSecond) await route.fulfill({ status: 403, json: { error: 'Access change denied' } });
        else await route.continue();
      });
      const denied = page.waitForResponse((response) => response.url().endsWith(`/grants/${second.id}`) && response.status() === 403);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await denied;
      await expect(dialog.getByRole('alert')).toHaveText('Access could not be changed');
      await expect(page.getByText('Access change denied', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
      rejectSecond = false;
      await dialog.getByRole('button', { name: firstEmail }).click();
      const revoked = page.waitForResponse((response) => response.request().method() === 'DELETE'
        && response.url().endsWith(`/grants/${first.id}`));
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      const list = await api<{ secrets: Array<{ secret_id: string; granted_user_ids: string[] }> }>(session.access_token, 'GET', `/accounts/${accountId}/secret-resources`);
      expect(list.secrets.find((item) => item.secret_id === key.secret_id)?.granted_user_ids.sort()).toEqual([owner.id, second.id].sort());
      await page.setViewportSize({ width: 720, height: 480 });
      await panel.getByRole('button', { name: 'Actions for Shared team key' }).click();
      await page.getByRole('menuitem', { name: 'Manage access' }).click();
      await dialog.getByRole('button', { name: ownerEmail }).click();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const afterOwnerRevocation = await api<{ secrets: Array<{ secret_id: string; granted_user_ids: string[] }> }>(session.access_token, 'GET', `/accounts/${accountId}/secret-resources`);
      expect(afterOwnerRevocation.secrets.find((item) => item.secret_id === key.secret_id)?.granted_user_ids).toEqual([second.id]);
      await panel.getByRole('button', { name: 'Actions for Shared team key' }).click();
      await page.getByRole('menuitem', { name: 'Manage access' }).click();
      const footer = dialog.getByRole('button', { name: 'Done', exact: true });
      await expect(footer).toBeInViewport();
      await expect(page.getByText('Secret saved', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('provider-key-access-720x480.png') });
    } finally {
      if (resourcePath) await api(session.access_token, 'DELETE', resourcePath, undefined, [200, 404]).catch(() => {});
      await project?.dispose();
      for (const user of [second, first, owner]) await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });

  test('flag gates shared keys; selected keys reach session creation and delete independently', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);
    const runId = Date.now().toString(36);
    const email = `e2e-pooled-secrets-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    let project: ManifestProject | null = null;
    let accountId: string | null = null;
    const createdIds: string[] = [];
    try {
      const accounts = await api<Array<{ account_id: string; personal_account?: boolean; account_role: string }>>(
        session.access_token, 'GET', '/accounts',
      );
      const account = accounts.find((item) => item.personal_account || item.account_role === 'owner');
      if (!account) throw new Error('Seeded user has no account');
      accountId = account.account_id;
      project = await createManifestProject({
        api, accessToken: session.access_token, databaseUrl: databaseUrl!,
        accountId, userId: user.id, name: `Pooled provider secrets ${runId}`,
      });
      projectId = project.id;
      await api(session.access_token, 'PUT', `/projects/${projectId}/agents/kortix/config`, { secrets: ['ANTHROPIC_API_KEY'] });
      await installBrowserSessionDirect(page, session, `/projects/${projectId}/customize/models`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}/customize/models`, { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('region', { name: 'Anthropic API keys' });
      await expect(panel).toHaveCount(0);

      await api(session.access_token, 'PATCH', `/projects/${projectId}/features`, {
        feature: 'pooled_provider_secrets', enabled: true,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(panel).toBeVisible();
      const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
      if (await welcome.isVisible().catch(() => false)) {
        await welcome.getByRole('button', { name: 'Dismiss' }).click();
      }
      for (const label of ['Primary test key', 'Backup test key']) {
        await panel.getByRole('button', { name: 'Add key' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add key · Anthropic' });
        await dialog.getByPlaceholder('Primary key').fill(label);
        await dialog.locator('input[type="password"]').fill(`fake-${label.replaceAll(' ', '-')}`);
        const request = page.waitForRequest((candidate) => candidate.method() === 'POST'
          && candidate.url().endsWith(`/v1/accounts/${accountId}/secret-resources`));
        const response = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
          && candidate.url().endsWith(`/v1/accounts/${accountId}/secret-resources`));
        await dialog.getByRole('button', { name: 'Save key' }).click();
        expect((await request).postDataJSON()).toMatchObject({ label, provider_id: 'anthropic', consumer: 'llm_gateway' });
        const saved = await response;
        expect(saved.status()).toBe(201);
        const body = await saved.json() as { secret_id: string; value?: string };
        expect(body.value).toBeUndefined();
        createdIds.push(body.secret_id);
        await expect(panel.getByText(label, { exact: true })).toBeVisible();
      }
      expect(new Set(createdIds).size).toBe(2);
      const listed = await api<{ secrets: Array<{ secret_id: string; label: string; value?: string }> }>(
        session.access_token, 'GET', `/accounts/${accountId}/secret-resources`,
      );
      expect(listed.secrets.map((secret) => secret.secret_id).sort()).toEqual([...createdIds].sort());
      expect(listed.secrets.every((secret) => secret.value === undefined)).toBe(true);

      const picker = await api<{ models: Record<string, unknown> }>(
        session.access_token, 'GET', `/projects/${projectId}/model-picker`,
      );
      expect(Object.keys(picker.models).some((model) => model.startsWith('anthropic/'))).toBe(true);
      await api(session.access_token, 'PATCH', `/projects/${projectId}/features`, {
        feature: 'pooled_provider_secrets', enabled: false,
      });
      const disabledPicker = await api<{ models: Record<string, unknown> }>(
        session.access_token, 'GET', `/projects/${projectId}/model-picker`,
      );
      expect(Object.keys(disabledPicker.models).some((model) => model.startsWith('anthropic/'))).toBe(false);
      await api(session.access_token, 'PATCH', `/projects/${projectId}/features`, {
        feature: 'pooled_provider_secrets', enabled: true,
      });

      await api(session.access_token, 'PATCH', `/projects/${projectId}/features`, {
        feature: 'llm_gateway', enabled: true,
      });
      let oauthStarts = 0;
      await page.route(`**/v1/projects/${projectId}/oauth/openai/start`, async (route) => {
        oauthStarts++;
        await route.fulfill({ status: 200, json: {
          flow_id: `browser-device-flow-${oauthStarts}`, verification_url: 'https://example.test/device',
          user_code: `TEST-CODE-${oauthStarts}`, expires_at: Date.now() + 60_000, interval_ms: 2000,
        } });
      });
      let releaseFirstPoll: () => void = () => {};
      const firstPollResponse = new Promise<void>((resolve) => { releaseFirstPoll = resolve; });
      await page.route(`**/v1/projects/${projectId}/oauth/openai/poll`, async (route) => {
        if (route.request().postDataJSON().flow_id === 'browser-device-flow-1') {
          await firstPollResponse;
          await route.fulfill({ status: 200, json: { status: 'success', credential: { provider_id: 'codex', expires_in_ms: null, updated_at: new Date().toISOString() } } });
        } else await route.fulfill({ status: 200, json: { status: 'pending' } });
      });
      await page.goto(`/projects/${projectId}/customize/models`, { waitUntil: 'domcontentloaded' });
      const chatGptAccounts = page.getByRole('region', { name: 'ChatGPT accounts' });
      await expect(chatGptAccounts.getByRole('button', { name: 'Add account' })).toBeVisible();
      for (const label of ['Personal ChatGPT', 'Second ChatGPT']) {
        await chatGptAccounts.getByRole('button', { name: 'Add account' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add account · ChatGPT Plus/Pro' });
        await dialog.getByRole('textbox', { name: 'Label' }).fill(label);
        const startRequest = page.waitForRequest((request) => request.method() === 'POST'
          && request.url().endsWith(`/v1/projects/${projectId}/oauth/openai/start`));
        await dialog.getByRole('button', { name: 'Connect account' }).click();
        expect((await startRequest).postDataJSON()).toEqual({ resource_label: label });
        await expect(dialog.getByText(`TEST-CODE-${oauthStarts}`)).toBeVisible();
        if (oauthStarts === 1) {
          await page.waitForRequest((request) => request.url().endsWith('/oauth/openai/poll') && request.postDataJSON().flow_id === 'browser-device-flow-1');
        } else {
          const secondPoll = page.waitForResponse((response) => response.url().endsWith('/oauth/openai/poll')
            && response.request().postDataJSON().flow_id === 'browser-device-flow-2');
          releaseFirstPoll();
          await secondPoll;
          await expect(dialog).toBeVisible();
          await expect(dialog.getByText('TEST-CODE-2')).toBeVisible();
        }
        await dialog.getByRole('button', { name: 'Cancel' }).click();
      }
      await page.unroute(`**/v1/projects/${projectId}/oauth/openai/start`);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Provider keys/ })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('focus-session-textarea')));
      await expect(page.getByRole('button', { name: /Provider keys/ })).toBeVisible();
      await page.getByRole('button', { name: /Provider keys/ }).click();
      await page.getByRole('checkbox', { name: 'Primary test key' }).check();
      await page.getByRole('checkbox', { name: 'Backup test key' }).check();
      await page.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('textbox', { name: 'Message input' }).fill('Verify selected provider keys');
      const createResponse = page.waitForResponse((response) => response.request().method() === 'POST'
        && response.url().endsWith(`/projects/${projectId}/sessions`));
      const send = page.getByRole('button', { name: 'Send message' });
      await expect(send).toBeEnabled();
      await send.click();
      const created = await createResponse;
      expect(created.request().postDataJSON()).toMatchObject({ provider_secret_pools: { anthropic: createdIds } });
      if (isDeployedTarget()) {
        expect(created.status()).toBe(201);
        const createdSession = await created.json() as { session_id: string };
        const savedPool = await api<{ secret_ids: string[] }>(session.access_token, 'GET',
          `/projects/${projectId}/sessions/${createdSession.session_id}/provider-secret-pools/anthropic`);
        expect(savedPool.secret_ids).toEqual(createdIds);
      } else {
        expect(created.status()).toBe(503);
        expect(await created.json()).toMatchObject({ code: 'KORTIX_URL_UNREACHABLE' });
      }
      await page.goto(`/projects/${projectId}/customize/models`, { waitUntil: 'domcontentloaded' });
      await expect(panel.getByText('Primary test key', { exact: true })).toBeVisible();

      await panel.getByRole('button', { name: 'Actions for Primary test key' }).click();
      await page.getByRole('menuitem', { name: 'Delete key' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key', exact: true }).click();
      await expect(panel.getByText('Primary test key', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('Backup test key', { exact: true })).toBeVisible();
      const after = await api<{ secrets: Array<{ secret_id: string }> }>(
        session.access_token, 'GET', `/accounts/${accountId}/secret-resources`,
      );
      expect(after.secrets.map((secret) => secret.secret_id)).toEqual([createdIds[1]]);

      const existingSession = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
      const runtimeId = `ses_${existingSession.replaceAll('-', '')}`;
      await runDatabaseSql("UPDATE kortix.project_sessions SET status = 'stopped', opencode_session_id = $2, sandbox_id = $1, sandbox_url = 'http://127.0.0.1:1' WHERE session_id = $1", [existingSession, runtimeId], databaseUrl);
      await runDatabaseSql("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id, base_url) VALUES ($1::uuid,$1,$2,$3,'stopped',$1,'http://127.0.0.1:1')", [existingSession, accountId, projectId], databaseUrl);
      await runDatabaseSql('INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete) VALUES ($1,$2,$3,$4,true)', [existingSession, projectId, accountId, runtimeId], databaseUrl);
      const messageId = 'msg_000000000000000000000001';
      const createdAt = Date.now() - 60_000;
      await runDatabaseSql('INSERT INTO kortix.session_transcript_messages (session_id, message_id, opencode_session_id, role, message_created_at, info, parts) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        existingSession, messageId, runtimeId, 'user', new Date(createdAt),
        JSON.stringify({ id: messageId, sessionID: runtimeId, role: 'user', agent: 'kortix', time: { created: createdAt }, model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.6' } }),
        JSON.stringify([{ id: 'prt_pool_previous', sessionID: runtimeId, messageID: messageId, type: 'text', text: 'Previous session prompt' }]),
      ], databaseUrl);
      await page.route(`**/sessions/${existingSession}/start?*`, async (route) => {
        await route.fulfill({ status: 200, json: {
          stage: 'ready', agent_name: 'kortix', retriable: false, opencode_session_id: runtimeId,
          sandbox: { sandbox_id: existingSession, session_id: existingSession, project_id: projectId,
            account_id: accountId, provider: 'daytona', external_id: existingSession, base_url: 'http://127.0.0.1:1',
            status: 'active', config: {}, metadata: {}, last_used_at: null,
            created_at: new Date(createdAt).toISOString(), updated_at: new Date(createdAt).toISOString() },
        } });
      });
      const poolPath = `/projects/${projectId}/sessions/${existingSession}/provider-secret-pools`;
      await api(session.access_token, 'PUT', `${poolPath}/anthropic`, { secret_ids: [createdIds[1]] });
      await page.setViewportSize({ width: 720, height: 480 });
      await page.goto(`/projects/${projectId}/sessions/${existingSession}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await page.getByRole('button', { name: 'Provider keys 1 key selected Override', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Backup test key' })).toBeChecked();
      await expect(page.getByRole('button', { name: 'Save key selection', exact: true })).toBeInViewport({ ratio: 1 });
      await api(session.access_token, 'PUT', `${poolPath}/anthropic`, { secret_ids: [] });
      await api(session.access_token, 'DELETE', `/accounts/${accountId}/secret-resources/${createdIds[1]}`);
      let failPoolRead = true;
      await page.route(`**/v1${poolPath}`, async (route) => {
        if (failPoolRead) await route.fulfill({ status: 503, json: { error: 'Temporary pool read failure' } });
        else await route.continue();
      });
      await page.goto(`/projects/${projectId}/sessions/${existingSession}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await page.getByRole('button', { name: /Provider keys/ }).click();
      await expect(page.locator('[data-slot=empty-title]').getByText('Keys could not be loaded.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save key selection' })).toHaveCount(0);
      failPoolRead = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.getByText('This provider is disabled for this session.')).toBeVisible();
      const resetResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
        && response.url().endsWith(`${poolPath}/anthropic`));
      await page.getByRole('button', { name: 'Reset to project default' }).click();
      const reset = await resetResponse;
      expect(reset.status()).toBe(200);
      expect(reset.request().postDataJSON()).toEqual({ secret_ids: null });
      await expect(page.getByText('Add a provider key in Models to build a pool.')).toBeVisible();
      expect((await api<{ pools: unknown[] }>(session.access_token, 'GET', poolPath)).pools).toEqual([]);
    } finally {
      if (accountId) {
        for (const id of createdIds) {
          await api(session.access_token, 'DELETE', `/accounts/${accountId}/secret-resources/${id}`, undefined, [200, 404]).catch(() => {});
        }
      }
      await project?.dispose();
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
