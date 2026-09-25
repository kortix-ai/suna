import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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
  test('a failed access change retains grants and retries atomically', async ({ page }) => {
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
      for (const member of [first, second]) await api(session.access_token, 'PUT', `/projects/${project.id}/access/${member.id}`, { role: 'user' });
      const key = await api<{ secret_id: string }>(session.access_token, 'POST', `/accounts/${accountId}/secret-resources`, {
        label: 'Shared team key', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY', value: 'fake-shared-team-key',
        consumer: 'llm_gateway', strategy: 'broker', project_id: project.id, access_mode: 'members', user_ids: [],
      }, 201);
      resourcePath = `/accounts/${accountId}/secret-resources/${key.secret_id}`;
      await installBrowserSessionDirect(page, session, `/projects/${project.id}/customize/models`, authOptions);
      await selectAccountForUi(page, accountId);
      let rejectResourceRead = true;
      await page.route(`**/v1/accounts/${accountId}/secret-resources?*`, async (route) => {
        if (rejectResourceRead) await route.fulfill({ status: 503, json: { error: 'Temporary resource list failure' } });
        else await route.continue();
      });
      await page.goto(`/projects/${project.id}/customize/models`, { waitUntil: 'domcontentloaded' });
      const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
      if (await welcome.isVisible().catch(() => false)) await welcome.getByRole('button', { name: 'Dismiss' }).click();
      const panel = page.getByRole('region', { name: 'Anthropic API keys' });
      await expect(page.getByText('Provider secrets could not be loaded.', { exact: true })).toBeVisible();
      rejectResourceRead = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel.getByText('Shared team key', { exact: true })).toBeVisible();
      await page.unroute(`**/v1/accounts/${accountId}/secret-resources?*`);
      await panel.getByRole('button', { name: 'Actions for Shared team key' }).click();
      await page.getByRole('menuitem', { name: 'Manage access' }).click();
      const dialog = page.getByRole('dialog', { name: 'Access to Shared team key' });
      await dialog.getByRole('radio', { name: /Specific members/ }).click();
      await dialog.getByRole('button', { name: firstEmail }).click();
      await dialog.getByRole('button', { name: secondEmail }).click();
      let rejectAccess = true;
      await page.route(`**/v1${resourcePath}/access`, async (route) => {
        if (rejectAccess) await route.fulfill({ status: 403, json: { error: 'Access change denied' } });
        else await route.continue();
      });
      const denied = page.waitForResponse((response) => response.url().endsWith('/access') && response.status() === 403);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await denied;
      await expect(dialog.getByRole('alert')).toHaveText('Access could not be changed');
      await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
      rejectAccess = false;
      const allowed = page.waitForResponse((response) => response.url().endsWith('/access') && response.status() === 200);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      expect((await allowed).request().postDataJSON()).toMatchObject({ mode: 'members', user_ids: expect.arrayContaining([first.id, second.id]) });
      await expect(dialog).toHaveCount(0);
      const list = await api<{ secrets: Array<{ secret_id: string; granted_user_ids: string[] }> }>(session.access_token, 'GET', `/accounts/${accountId}/secret-resources?project_id=${project.id}`);
      expect(list.secrets.find((item) => item.secret_id === key.secret_id)?.granted_user_ids).toEqual(expect.arrayContaining([first.id, second.id]));
      await page.setViewportSize({ width: 720, height: 480 });
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

  test('flag gates shared keys; selected keys reach session creation and delete independently', async ({ page }, testInfo) => {
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
      await api(session.access_token, 'PUT', `/projects/${projectId}/agents/kortix/config`, { secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] });
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
      for (const label of ['Primary test key', 'Backup test key for shared research and development sessions']) {
        await panel.getByRole('button', { name: 'Add key' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add key · Anthropic' });
        // New connections are private to their creator; sharing is an explicit choice.
        await expect(dialog.getByRole('radio', { name: /Only you/ })).toBeChecked();
        await expect(dialog.getByRole('textbox', { name: 'Search members' })).toHaveCount(0);
        const sharedWithProject = label !== 'Primary test key';
        if (sharedWithProject) await dialog.getByRole('radio', { name: /Everyone in this project/ }).click();
        await dialog.getByPlaceholder('Primary key').fill(label);
        await dialog.locator('input[type="password"]').fill(`fake-${label.replaceAll(' ', '-')}`);
        if (label === 'Primary test key') {
          await page.route(`**/v1/accounts/${accountId}/secret-resources`, async (route) => {
            if (route.request().method() === 'POST') await route.fulfill({ status: 403, json: { error: 'Key creation denied' } });
            else await route.continue();
          });
          await dialog.getByRole('button', { name: 'Save key' }).click();
          await expect(dialog.getByRole('alert')).toHaveText('Key creation denied');
          await expect(dialog.getByPlaceholder('Primary key')).toHaveValue(label);
          await page.unroute(`**/v1/accounts/${accountId}/secret-resources`);
        }
        const request = page.waitForRequest((candidate) => candidate.method() === 'POST'
          && candidate.url().endsWith(`/v1/accounts/${accountId}/secret-resources`));
        const response = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
          && candidate.url().endsWith(`/v1/accounts/${accountId}/secret-resources`));
        await dialog.getByRole('button', { name: 'Save key' }).click();
        expect((await request).postDataJSON()).toMatchObject({ label, project_id: projectId, provider_id: 'anthropic', consumer: 'llm_gateway',
          ...(sharedWithProject ? { access_mode: 'project', user_ids: [] } : { access_mode: 'members', user_ids: [] }) });
        const saved = await response;
        expect(saved.status()).toBe(201);
        const body = await saved.json() as { secret_id: string; value?: string };
        expect(body.value).toBeUndefined();
        createdIds.push(body.secret_id);
        await expect(panel.getByText(label, { exact: true })).toBeVisible();
      }
      expect(new Set(createdIds).size).toBe(2);
      const listed = await api<{ secrets: Array<{ secret_id: string; label: string; value?: string }> }>(
        session.access_token, 'GET', `/accounts/${accountId}/secret-resources?project_id=${projectId}`,
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
      // With no account yet, the panel leads with the one action that matters.
      await expect(chatGptAccounts.getByText('No ChatGPT accounts yet', { exact: true })).toBeVisible();
      await expect(chatGptAccounts.getByRole('button', { name: 'Connect ChatGPT' })).toBeVisible();
      for (const label of ['Personal ChatGPT', 'Second ChatGPT']) {
        await chatGptAccounts.getByRole('button', { name: 'Connect ChatGPT' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add account · ChatGPT Plus/Pro' });
        await dialog.getByRole('textbox', { name: 'Label' }).fill(label);
        const startRequest = page.waitForRequest((request) => request.method() === 'POST'
          && request.url().endsWith(`/v1/projects/${projectId}/oauth/openai/start`));
        await dialog.getByRole('button', { name: 'Connect account' }).click();
        expect((await startRequest).postDataJSON()).toEqual({ resource_label: label, sharing: { mode: 'private', ownerId: user.id } });

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
      await page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' }).check();
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
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
      await page.getByRole('menuitem', { name: 'Manage access' }).click();
      const accessDialog = page.getByRole('dialog', { name: 'Access to Primary test key' });
      await expect(accessDialog.getByRole('radio', { name: /Specific members/ })).toBeChecked();
      await expect(accessDialog.getByRole('textbox', { name: 'Search members' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('provider-access-modes.png'), fullPage: true, animations: 'disabled' });
      await accessDialog.getByRole('radio', { name: /Everyone in this project/ }).click();
      await expect(accessDialog.getByRole('textbox', { name: 'Search members' })).toHaveCount(0);
      const accessRequest = page.waitForRequest((request) => request.method() === 'PUT' &&
        request.url().endsWith(`/accounts/${accountId}/secret-resources/${createdIds[0]}/access`));
      await accessDialog.getByRole('button', { name: 'Done' }).click();
      expect((await accessRequest).postDataJSON()).toMatchObject({ mode: 'project' });
      await expect(panel.getByRole('listitem').filter({ hasText: 'Primary test key' }).getByText('Everyone in this project')).toBeVisible();

      await panel.getByRole('button', { name: 'Actions for Primary test key' }).click();
      await page.getByRole('menuitem', { name: 'Delete key' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key', exact: true }).click();
      await expect(panel.getByText('Primary test key', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('Backup test key for shared research and development sessions', { exact: true })).toBeVisible();
      const after = await api<{ secrets: Array<{ secret_id: string }> }>(
        session.access_token, 'GET', `/accounts/${accountId}/secret-resources?project_id=${projectId}`,
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
      const secondProvider = await api<{ secret_id: string }>(session.access_token, 'POST', `/accounts/${accountId}/secret-resources`, {
        project_id: projectId, access_mode: 'project', user_ids: [], provider_id: 'openai', name: 'OPENAI_API_KEY',
        label: 'Second provider key', value: 'fake-openai-key', consumer: 'llm_gateway', strategy: 'broker',
      }, 201);
      createdIds.push(secondProvider.secret_id);
      // Secrets catalog down + connectors inheriting = nothing for the scope PUT
      // to carry. A keys-only Save must not send `{}` (the API answers 400).
      await page.route(`**/v1/projects/${projectId}/secrets`, async (route) => {
        if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Secrets unavailable' } });
        else await route.continue();
      });
      const scopeWrites: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'PUT' && request.url().endsWith(`/sessions/${existingSession}/scope`)) scopeWrites.push(request.postData() ?? '');
      });
      await page.setViewportSize({ width: 720, height: 480 });
      await page.goto(`/projects/${projectId}/sessions/${existingSession}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await expect(page.getByRole('button', { name: /^Secrets Unavailable/ })).toBeVisible();
      await page.getByRole('button', { name: 'Provider keys 1 key selected Override', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' })).toBeChecked();
      const saveChanges = page.getByRole('button', { name: 'Save changes', exact: true });
      await expect(saveChanges).toBeInViewport({ ratio: 1 });
      await page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' }).uncheck();
      await page.getByRole('combobox', { name: 'Provider', exact: true }).click();
      await page.getByRole('option', { name: 'OpenAI', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Second provider key' }).check();
      await page.getByRole('button', { name: /^Sandbox/ }).click();
      await page.getByRole('button', { name: /Provider keys/ }).click();
      await expect(page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' })).not.toBeChecked();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await page.getByRole('button', { name: /Provider keys/ }).click();
      await expect(page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' })).not.toBeChecked();
      await expect(page.getByText('Unsaved key changes', { exact: true })).toBeVisible();
      const overrides = page.getByRole('dialog', { name: 'Session overrides', exact: true });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add(value); }, theme);
        for (const size of [{ width: 390, height: 844 }, { width: 720, height: 480 }, { width: 1440, height: 900 }]) {
          await page.setViewportSize(size);
          // Radix dismisses this popover on the layout changes the loop makes —
          // the theme swap, and the 1440 -> 390 SHRINK at the theme boundary.
          // The dismissal is asynchronous, so a single `isVisible()` guard reads
          // `true` while it is in flight and ANY assertion in the group can land
          // on a closing panel (observed on both `Save changes` and `Unsaved key
          // changes`). Re-establish the panel by its own control and retry the
          // whole group, so a dismissal costs a retry instead of the run. Every
          // assertion below is unchanged.
          await expect(async () => {
            if (!(await saveChanges.isVisible().catch(() => false))) {
              if (!(await overrides.isVisible().catch(() => false))) {
                await page.getByRole('button', { name: 'Session overrides' }).click();
                await expect(overrides).toBeVisible({ timeout: 5_000 });
              }
              await page.getByRole('button', { name: /Provider keys/ }).click();
            }
            const backup = page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' });
            await expect(backup).not.toBeChecked({ timeout: 5_000 });
            await expect(page.getByText('Unsaved key changes', { exact: true })).toBeVisible({ timeout: 5_000 });
            await expect(saveChanges).toBeInViewport({ ratio: 1, timeout: 5_000 });
            await expect(backup).toBeInViewport({ ratio: 1, timeout: 5_000 });
            const bounds = await overrides.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
          }).toPass({ timeout: 60_000 });
          await page.screenshot({ path: testInfo.outputPath(`provider-selection-${theme}-${size.width}x${size.height}.png`), animations: 'disabled' });
        }
        // The scan targets the popover by selector, so an empty result would
        // report zero violations for a panel that simply is not open.
        await expect(saveChanges).toBeVisible();
        const accessibility = await new AxeBuilder({ page }).include('[data-slot="popover-content"][aria-label="Session overrides"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(accessibility.violations).toEqual([]);
      }
      let rejectSave = true;
      let releaseSave: () => void = () => {};
      const heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
      await page.route(`**/v1${poolPath}/anthropic`, async (route) => {
        if (rejectSave && route.request().method() === 'PUT') { await heldSave; await route.fulfill({ status: 403, json: { error: 'Selected key access changed' } }); }
        else await route.continue();
      });
      await saveChanges.click();
      await expect(page.getByRole('button', { name: /^Saving/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Manage provider keys', exact: true })).toBeDisabled();
      await expect(page.getByRole('link', { name: 'Manage provider keys', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(overrides).toBeVisible();
      releaseSave();
      await expect(page.getByRole('alert').filter({ hasText: 'Selected key access changed' })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' })).not.toBeChecked();
      rejectSave = false;
      // The forced 403 also raises the global "Failed to perform action" toast.
      // At 1440x900 that toast sits on top of Save changes and swallows the
      // click for its whole lifetime (preview runs 35707181258, 35709014601,
      // 35709807756, 35708105773: `<section aria-label="Notifications alt+T">
      // subtree intercepts pointer events`). The inline alert above is the
      // asserted error surface, so dismiss the toast before retrying the save.
      for (const close of await page.getByRole('button', { name: 'Close notification' }).all()) {
        await close.click().catch(() => {});
      }
      await expect(page.getByRole('region', { name: /Notifications/ }).getByRole('listitem')).toHaveCount(0);
      // A click on the toast is outside the popover, so Radix may dismiss it.
      // The unsaved selection survives a close (asserted above); reopen it.
      if (!(await saveChanges.isVisible().catch(() => false))) {
        if (!(await overrides.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: 'Session overrides' }).click();
          await expect(overrides).toBeVisible();
        }
        await page.getByRole('button', { name: /Provider keys/ }).click();
      }
      await expect(page.getByRole('checkbox', { name: 'Backup test key for shared research and development sessions' })).not.toBeChecked();
      const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
        && response.url().endsWith(`${poolPath}/anthropic`) && response.status() === 200);
      await saveChanges.click();
      // Unchecking the last key resets to the default; an empty pool fails every turn.
      expect((await saveResponse).request().postDataJSON()).toEqual({ secret_ids: null });
      await expect(page.getByRole('dialog', { name: 'Session overrides', exact: true })).toHaveCount(0);
      await expect(page.getByText('Validation failed')).toHaveCount(0);
      expect(scopeWrites).toEqual([]);
      await page.unroute(`**/v1/projects/${projectId}/secrets`);
      expect((await api<{ pools: Array<{ provider_id: string; secret_ids: string[] }> }>(session.access_token, 'GET', poolPath)).pools
        .map((pool) => pool.provider_id)).not.toContain('anthropic');
      await page.unroute(`**/v1${poolPath}/anthropic`);
      expect((await api<{ secret_ids: string[] }>(session.access_token, 'GET', `${poolPath}/openai`)).secret_ids).toEqual([secondProvider.secret_id]);
      await api(session.access_token, 'PUT', `${poolPath}/openai`, { secret_ids: null });
      await api(session.access_token, 'DELETE', `/accounts/${accountId}/secret-resources/${secondProvider.secret_id}`);
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
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      const reset = await resetResponse;
      expect(reset.status()).toBe(200);
      expect(reset.request().postDataJSON()).toEqual({ secret_ids: null });
      await page.getByRole('button', { name: 'Session overrides' }).click();
      await page.getByRole('button', { name: /Provider keys/ }).click();
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

  // Bring your own ChatGPT subscription as a plain project member: no
  // project.secret.write and no Customize. The composer is the way in.
  test('a project member brings their own ChatGPT subscription from the composer', async ({ page }, testInfo) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);
    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-byos-owner-${runId}@example.test`;
    const memberEmail = `e2e-byos-member-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const member = await createAuthUser(memberEmail, authOptions);
    const ownerSession = await signIn(ownerEmail, authOptions);
    const accountSecretId = randomUUID();
    let project: ManifestProject | null = null;
    let accountId: string | null = null;
    try {
      const accounts = await api<Array<{ account_id: string }>>(ownerSession.access_token, 'GET', '/accounts');
      accountId = accounts[0]!.account_id;
      await api(ownerSession.access_token, 'POST', `/accounts/${accountId}/members`, { email: memberEmail, role: 'member' }, 201);
      project = await createManifestProject({ api, accessToken: ownerSession.access_token, accountId, userId: owner.id,
        name: `ChatGPT BYOS ${runId}`, databaseUrl: databaseUrl! });
      const projectId = project.id;
      for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
        await api(ownerSession.access_token, 'PATCH', `/projects/${projectId}/features`, { feature, enabled: true });
      }
      await api(ownerSession.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, { role: 'user' });
      const memberSession = await signIn(memberEmail, authOptions);

      // The device flow is OpenAI's; the browser contract is what the page sends
      // and shows. The first authorization is refused, the next ones succeed.
      const starts: Array<Record<string, unknown>> = [];
      await page.route(`**/v1/projects/${projectId}/oauth/openai/start`, async (route) => {
        starts.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, json: {
          flow_id: `byos-flow-${starts.length}`, verification_url: 'https://example.test/device',
          user_code: `BYOS-${starts.length}`, expires_at: Date.now() + 60_000, interval_ms: 2000,
        } });
      });
      await page.route(`**/v1/projects/${projectId}/oauth/openai/poll`, async (route) => {
        if (route.request().postDataJSON().flow_id === 'byos-flow-1') {
          await route.fulfill({ status: 200, json: { status: 'failed', error: 'ChatGPT denied the authorization' } });
          return;
        }
        // What a completed poll persists: an account only its member can use.
        const label = String(starts.find((start) => typeof start.resource_label === 'string')?.resource_label);
        await runDatabaseSql(`INSERT INTO kortix.account_secret_resources
          (secret_id, account_id, project_id, access_mode, label, provider_id, name, value_enc, consumer, strategy, created_by)
          VALUES ($1, $2, $3, 'members', $4, 'codex', 'CODEX_AUTH_JSON', 'v1:not:a:login', 'llm_gateway', 'broker', $5)
          ON CONFLICT DO NOTHING`, [accountSecretId, accountId, projectId, label, member.id], databaseUrl);
        await runDatabaseSql(`INSERT INTO kortix.account_secret_grants (secret_id, account_id, user_id, granted_by)
          VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`, [accountSecretId, accountId, member.id], databaseUrl);
        await route.fulfill({ status: 200, json: { status: 'success', credential: {
          provider_id: 'codex', secret_id: accountSecretId, label, expires_in_ms: null, updated_at: new Date().toISOString(),
        } } });
      });

      await installBrowserSessionDirect(page, memberSession, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
      if (await welcome.isVisible().catch(() => false)) await welcome.getByRole('button', { name: 'Dismiss' }).click();
      const openModelPicker = async () => {
        const input = page.getByRole('textbox', { name: 'Message input' });
        await expect(input).toBeVisible();
        await input.click();
        await input.pressSequentially('/model');
        await page.getByRole('option', { name: /Switch model/ }).click();
      };

      // The composer's own call to action reaches the same accounts panel. A
      // member cannot read project secrets; the modal must settle instead of
      // re-reading them in a loop (it used to send ~6 requests a second).
      let secretReads = 0;
      page.on('request', (request) => {
        if (request.method() === 'GET' && request.url().endsWith(`/v1/projects/${projectId}/secrets`)) secretReads++;
      });
      await page.getByRole('button', { name: 'Connect model', exact: true }).click();
      const providerAccounts = page.getByRole('region', { name: 'ChatGPT accounts' });
      await expect(providerAccounts.getByRole('button', { name: 'Connect ChatGPT' })).toBeVisible({ timeout: 60_000 });
      const readsWhenSettled = secretReads;
      await page.waitForTimeout(3_000);
      expect(secretReads - readsWhenSettled).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(providerAccounts).toHaveCount(0);

      await openModelPicker();
      // A member with no models yet gets the empty picker; ChatGPT sits beside
      // the provider gate. Once its models exist, the list ends with a row.
      await expect(page.getByText('No models available', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
      const accountsDialog = page.getByRole('dialog', { name: 'ChatGPT subscription' });
      await expect(accountsDialog.getByText('No ChatGPT accounts yet', { exact: true })).toBeVisible();
      await accountsDialog.getByRole('button', { name: 'Connect ChatGPT' }).click();

      const dialog = page.getByRole('dialog', { name: 'Add account · ChatGPT Plus/Pro' });
      await expect(dialog.getByRole('textbox', { name: 'Label' })).toHaveValue(/^ChatGPT · e2e-byos-member-/);
      await expect(dialog.getByRole('radio', { name: /Only you/ })).toBeChecked();
      await expect(dialog.getByRole('radio', { name: /Everyone in this project/ })).toBeDisabled();
      await expect(dialog.getByRole('radio', { name: /Specific members/ })).toBeDisabled();
      await expect(dialog.getByText('Sharing with others requires permission to manage project secrets.', { exact: true })).toBeVisible();
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add(value); }, theme);
        for (const size of [{ width: 720, height: 480 }, { width: 1280, height: 720 }]) {
          await page.setViewportSize(size);
          await expect(dialog.getByRole('button', { name: 'Connect account' })).toBeInViewport({ ratio: 1 });
          await page.screenshot({ path: testInfo.outputPath(`byos-member-connect-${theme}-${size.width}x${size.height}.png`), animations: 'disabled' });
        }
        const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(accessibility.violations).toEqual([]);
      }
      await page.evaluate(() => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('light'); });

      await dialog.getByRole('button', { name: 'Connect account' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('ChatGPT denied the authorization');
      await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(starts).toEqual([1, 2].map(() => ({
        resource_label: expect.stringMatching(/^ChatGPT · e2e-byos-member-/),
        sharing: { mode: 'private', ownerId: member.id },
      })));
      const row = accountsDialog.getByRole('listitem').filter({ hasText: /^ChatGPT · / });
      await expect(row.getByText('Only you', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('byos-member-connected.png'), animations: 'disabled' });

      // Reconnect refreshes the same account in place; sharing stays a manager's call.
      await row.getByRole('button', { name: /^Actions for ChatGPT · / }).click();
      await expect(page.getByRole('menuitem', { name: 'Manage access' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Delete account' })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Reconnect' }).click();
      await expect(page.getByRole('dialog', { name: /^Reconnect ChatGPT · / })).toHaveCount(0, { timeout: 15_000 });
      expect(starts[2]).toEqual({ resource_id: accountSecretId });
      const listed = await api<{ secrets: Array<{ secret_id: string; created_by: string; granted_user_ids: string[] }> }>(
        memberSession.access_token, 'GET', `/accounts/${accountId}/secret-resources?project_id=${projectId}`);
      expect(listed.secrets.map((secret) => secret.secret_id)).toEqual([accountSecretId]);

      // Modal ignores Escape while a menu or tooltip layer is open (z-stack's
      // hasOpenFloatingLayer); the explicit Close is deterministic.
      await accountsDialog.getByRole('button', { name: 'Close' }).click();
      await expect(accountsDialog).toHaveCount(0);
      await openModelPicker();
      await expect(page.getByRole('option', { name: 'Manage ChatGPT accounts' })).toBeVisible();
    } finally {
      if (accountId) {
        await runDatabaseSql('DELETE FROM kortix.account_secret_resources WHERE secret_id = $1', [accountSecretId], databaseUrl).catch(() => {});
      }
      await project?.dispose();
      for (const user of [member, owner]) await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
