import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { runDatabaseSql } from '../helpers/database';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const api = createApiJsonClient(apiBase);
const auth = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'ProviderScopeE2e123!',
};

test.describe('28 — provider connection scope', () => {
  test('opens one connection dialog, commits explicit choices, and reuses personal credentials across projects', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const env = loadEnv();
    const email = `e2e-provider-scope-${Date.now()}@example.test`;
    const user = await createAuthUser(email, auth);
    const session = await signIn(email, auth);
    const projects: string[] = [];
    let readerId: string | undefined;
    let teamId: string | undefined;
    try {
      const accounts = await api<{ account_id: string; personal_account: boolean }[]>(
        session.access_token,
        'GET',
        '/accounts',
      );
      const account = accounts.find((a) => a.personal_account) ?? accounts[0]!;
      for (let i = 0; i < 2; i++) {
        projects.push(
          (
            await createDatabaseProject(env, {
              accountId: account.account_id,
              userId: user.id,
              name: `Provider scope ${i}`,
              metadata: { experimental: { llm_gateway: true } },
            })
          ).id,
        );
      }
      await installBrowserSessionDirect(page, session, '/favicon.png', auth);
      await selectAccountForUi(page, account.account_id);
      const open = async (id: string) => {
        await page.goto(`/projects/${id}/customize/models`);
        await dismissOnboarding(page);
        const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
        if (await dismiss.isVisible()) await dismiss.click();
      };
      await open(projects[0]!);
      const row = page.locator('[data-provider-row="openai"]');
      const dialog = page.getByRole('dialog', { name: 'Connection for OpenAI', exact: true });
      const openConnection = async () => {
        await row.getByRole('button', { name: /^(Connect|Manage)$/ }).click();
        await expect(dialog).toBeVisible();
      };
      const chooseMethod = async (name: string) => {
        await dialog.getByRole('combobox', { name: 'Connection method' }).click();
        await page.getByRole('option', { name, exact: true }).click();
      };
      const key = dialog.getByRole('textbox', { name: 'OpenAI API key', exact: true });
      const mutations: string[] = [];
      page.on('request', (r) => {
        if (
          ['POST', 'PUT', 'DELETE'].includes(r.method()) &&
          /provider-connections|personal-providers|\/secrets$|\/oauth\//.test(r.url())
        )
          mutations.push(r.url());
      });
      await expect(row).toHaveCount(1);
      await expect(page.locator('[data-provider-row] input')).toHaveCount(0);
      await expect(page.locator('[data-provider-row] [role="combobox"]')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Personal provider connections' })).toHaveCount(
        0,
      );
      await expect(row).toContainText('Not connected');
      await openConnection();
      await expect(
        dialog.getByRole('radio', { name: 'Use my account', exact: true }),
      ).toBeChecked();
      await expect(dialog.getByRole('combobox')).toHaveText('ChatGPT subscription');
      await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toHaveCount(
        1,
      );
      await chooseMethod('API key');
      await key.fill('cancelled-personal-fixture');
      await dialog.getByRole('radio', { name: 'Share with this project', exact: true }).click();
      await expect(key).toHaveValue('');
      await key.fill('cancelled-project-fixture');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(mutations).toEqual([]);
      expect(
        (await api<{ items: unknown[] }>(session.access_token, 'GET', '/provider-connections'))
          .items,
      ).toEqual([]);

      // Save shared credentials only after explicit ownership and submission.
      await openConnection();
      await chooseMethod('API key');
      await dialog.getByRole('radio', { name: 'Share with this project', exact: true }).click();
      await key.fill('project-scope-ui-fixture');
      const projectSave = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith(`/projects/${projects[0]}/secrets`),
      );
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      const projectSaved = await projectSave;
      expect(projectSaved.status()).toBe(200);
      expect(projectSaved.request().postDataJSON()).toMatchObject({
        name: 'OPENAI_API_KEY',
        value: 'project-scope-ui-fixture',
        strategy: 'broker',
      });
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Connected · Project');

      await openConnection();
      await expect(
        dialog.getByRole('radio', { name: 'Share with this project', exact: true }),
      ).toBeChecked();
      await dialog.getByRole('radio', { name: 'Use my account', exact: true }).click();
      await expect(key).toHaveValue('');
      const personalSave = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().endsWith('/provider-connections/openai'),
      );
      const bind = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/projects/${projects[0]}/personal-providers/openai`),
      );
      await key.fill('personal-scope-ui-fixture');
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      const saved = await personalSave;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({ api_key: 'personal-scope-ui-fixture' });
      const bound = await bind;
      expect(bound.status()).toBe(200);
      expect(bound.request().postDataJSON()).toEqual({
        enabled: true,
        connection_id: (await saved.json()).connection_id,
      });
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Connected · Your account');
      const list = await api<{ items: { connection_id: string; provider_id: string }[] }>(
        session.access_token,
        'GET',
        '/provider-connections',
      );
      const connection = list.items.find((c) => c.provider_id === 'openai')!;
      expect(JSON.stringify(list)).not.toContain('personal-scope-ui-fixture');
      await page.reload();
      await expect(row).toContainText('Connected · Your account');
      await openConnection();
      await expect(key).toHaveAttribute('placeholder', 'Saved — paste a new key to replace it');
      await dialog.getByRole('radio', { name: 'Share with this project', exact: true }).click();
      // Choice alone preserves the existing binding.
      expect(
        (
          await api<{ items: unknown[] }>(
            session.access_token,
            'GET',
            `/projects/${projects[0]}/personal-providers`,
          )
        ).items,
      ).toHaveLength(1);
      const unbind = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/projects/${projects[0]}/personal-providers/openai`),
      );
      await dialog.getByRole('button', { name: 'Use project connection', exact: true }).click();
      expect((await unbind).request().postDataJSON()).toEqual({ enabled: false });
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Connected · Project');
      expect(
        (
          await api<{ items: unknown[] }>(
            session.access_token,
            'GET',
            `/projects/${projects[0]}/personal-providers`,
          )
        ).items,
      ).toEqual([]);

      // Reusing a saved account creates only a project binding.
      await open(projects[1]!);
      mutations.length = 0;
      await openConnection();
      await chooseMethod('API key');
      await dialog.getByRole('button', { name: 'Use this account', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      const second = await api<{ items: { connection_id: string }[] }>(
        session.access_token,
        'GET',
        `/projects/${projects[1]}/personal-providers`,
      );
      expect(second.items[0]?.connection_id).toBe(connection.connection_id);
      expect(mutations.filter((url) => url.endsWith('/provider-connections/openai'))).toEqual([]);

      await openConnection();
      await chooseMethod('ChatGPT subscription');
      await expect(dialog.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toHaveCount(
        1,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        dialog.getByRole('button', { name: 'Connect ChatGPT', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect.poll(async () => (await dialog.boundingBox())?.width).toBeGreaterThan(320);
      await page.screenshot({
        path: test.info().outputPath('provider-connect-mobile.png'),
        animations: 'disabled',
      });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: test.info().outputPath('provider-list-desktop.png'),
        animations: 'disabled',
      });

      await page.goto('/settings/provider-connections');
      const personalSettings = page.getByRole('region', { name: 'Personal provider connections' });
      await expect(personalSettings).toBeVisible();
      await personalSettings.getByRole('combobox', { name: 'Provider', exact: true }).click();
      await page.getByRole('option', { name: 'OpenAI', exact: true }).click();
      await personalSettings
        .getByRole('textbox', { name: 'Your API key', exact: true })
        .fill('discard-on-provider-change');
      await personalSettings.getByRole('combobox', { name: 'Provider', exact: true }).click();
      await page.getByRole('option', { name: 'Anthropic', exact: true }).click();
      await expect(
        personalSettings.getByRole('textbox', { name: 'Your API key', exact: true }),
      ).toHaveValue('');
      await personalSettings.getByRole('combobox', { name: 'Provider', exact: true }).click();
      await page.getByRole('option', { name: 'OpenAI', exact: true }).click();
      await personalSettings
        .getByRole('textbox', { name: 'Connection name', exact: true })
        .fill('Work');
      await personalSettings
        .getByRole('textbox', { name: 'Your API key', exact: true })
        .fill('second-personal-ui-fixture');
      const addConnection = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().endsWith('/provider-connections/openai'),
      );
      await personalSettings
        .getByRole('button', { name: 'Save personal key', exact: true })
        .click();
      const added = await addConnection;
      expect(added.status()).toBe(200);
      expect(added.request().postDataJSON()).toEqual({
        api_key: 'second-personal-ui-fixture',
        create: true,
        label: 'Work',
      });
      const workConnection = await added.json();
      await expect(personalSettings.getByText('Work', { exact: true })).toBeVisible();

      await open(projects[1]!);
      await openConnection();
      const connectionSelect = dialog.getByRole('combobox', {
        name: 'Personal connection',
        exact: true,
      });
      await connectionSelect.click();
      await page.getByRole('option', { name: 'Use my pool (2)', exact: true }).click();
      await expect(key).toHaveCount(0);
      const usePool = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/projects/${projects[1]}/personal-providers/openai`),
      );
      await dialog.getByRole('button', { name: 'Use this account', exact: true }).click();
      expect((await usePool).request().postDataJSON()).toEqual({ enabled: true, pool: true });
      await expect(dialog).not.toBeVisible();
      expect(
        (
          await api<{ items: { pool: boolean }[] }>(
            session.access_token,
            'GET',
            `/projects/${projects[1]}/personal-providers`,
          )
        ).items[0]?.pool,
      ).toBe(true);

      await openConnection();
      await connectionSelect.click();
      await page.getByRole('option', { name: 'Work', exact: true }).click();
      const selectWork = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/projects/${projects[1]}/personal-providers/openai`),
      );
      await dialog.getByRole('button', { name: 'Use this account', exact: true }).click();
      expect((await selectWork).request().postDataJSON()).toEqual({
        enabled: true,
        connection_id: workConnection.connection_id,
      });
      await expect(dialog).not.toBeVisible();

      await page.goto('/settings/provider-connections');
      const workRow = personalSettings.getByRole('listitem').filter({ hasText: 'Work' });
      await workRow.getByRole('button', { name: 'Disconnect', exact: true }).click();
      const confirmDisconnect = page.getByRole('alertdialog');
      await expect(confirmDisconnect).toBeVisible();
      const removeConnection = page.waitForResponse(
        (r) =>
          r.request().method() === 'DELETE' &&
          r
            .url()
            .endsWith(`/provider-connections/openai/connections/${workConnection.connection_id}`),
      );
      await confirmDisconnect.getByRole('button', { name: 'Disconnect', exact: true }).click();
      expect((await removeConnection).status()).toBe(200);
      await expect(workRow).toHaveCount(0);
      expect(
        (await api<{ items: unknown[] }>(session.access_token, 'GET', '/provider-connections'))
          .items,
      ).toHaveLength(1);
      await open(projects[1]!);
      await openConnection();
      await chooseMethod('API key');
      await dialog.getByRole('button', { name: 'Use this account', exact: true }).click();
      await expect(dialog).not.toBeVisible();

      // A stale saved account fails visibly without enabling a missing credential.
      await openConnection();
      await api(session.access_token, 'DELETE', '/provider-connections/openai');
      await dialog.getByRole('button', { name: 'Use this account', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(
        (
          await api<{ items: unknown[] }>(
            session.access_token,
            'GET',
            `/projects/${projects[1]}/personal-providers`,
          )
        ).items,
      ).toEqual([]);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(row).toContainText('Not connected');

      const native = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: 'Native provider scope',
        metadata: { experimental: { llm_gateway: false } },
      });
      projects.push(native.id);
      await open(native.id);
      await openConnection();
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(dialog).toContainText('Everyone in this project can use this connection.');
      await expect(
        dialog.getByRole('button', { name: 'Connect ChatGPT', exact: true }),
      ).toBeVisible();
      await chooseMethod('API key');
      await key.fill('native-project-ui-fixture');
      const nativeSave = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith(`/projects/${native.id}/secrets`),
      );
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      expect((await nativeSave).status()).toBe(200);
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Connected · Project');
      const readerEmail = `e2e-provider-reader-${Date.now()}@example.test`;
      const reader = await createAuthUser(readerEmail, auth);
      readerId = reader.id;
      const readerSession = await signIn(readerEmail, auth);
      const team = await api<{ account_id: string }>(
        session.access_token,
        'POST',
        '/accounts',
        { name: 'Provider scope readers' },
        201,
      );
      teamId = team.account_id;
      await api(
        session.access_token,
        'POST',
        `/accounts/${teamId}/members`,
        { email: readerEmail, role: 'member' },
        201,
      );
      const shared = await createDatabaseProject(env, {
        accountId: teamId,
        userId: user.id,
        name: 'Reader personal provider',
        metadata: { experimental: { llm_gateway: true } },
      });
      projects.push(shared.id);
      await api(session.access_token, 'PUT', `/projects/${shared.id}/access/${readerId}`, {
        role: 'member',
      });
      await installBrowserSessionDirect(page, readerSession, '/favicon.png', auth);
      await selectAccountForUi(page, teamId);
      await open(shared.id);
      await expect(row.getByRole('textbox')).toHaveCount(0);
      await openConnection();
      await expect(
        dialog.getByRole('radio', { name: 'Use my account', exact: true }),
      ).toBeChecked();
      await expect(
        dialog.getByRole('radio', { name: 'Project connection', exact: true }),
      ).toBeDisabled();
      await chooseMethod('API key');
      const readerBind = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/projects/${shared.id}/personal-providers/openai`),
      );
      await key.fill('reader-personal-ui-fixture');
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      expect((await readerBind).status()).toBe(200);
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Connected · Your account');
      await openConnection();
      await dialog.getByRole('button', { name: 'Stop using my account', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(row).toContainText('Not connected');
      expect(
        (
          await api<{ items: unknown[] }>(
            readerSession.access_token,
            'GET',
            '/provider-connections',
          )
        ).items,
      ).toHaveLength(1);
      await api(readerSession.access_token, 'DELETE', '/provider-connections/openai');
    } finally {
      await api(session.access_token, 'DELETE', '/provider-connections/openai').catch(() => {});
      for (const project of projects) await deleteDatabaseProject(env, project);
      if (teamId)
        await runDatabaseSql('delete from kortix.accounts where account_id = $1::uuid', [teamId]);
      if (readerId) await deleteAuthUser(readerId, auth);
      await deleteAuthUser(user.id, auth);
    }
  });
});
