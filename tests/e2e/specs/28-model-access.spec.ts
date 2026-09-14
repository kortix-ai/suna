import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const api = createApiJsonClient(process.env.E2E_API_URL || 'http://localhost:15108/v1');
const auth = { supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321', password: 'ModelAccessE2e123!' };

test('provider and model access persists, keeps credentials, and updates controls', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const email = `model-access-${Date.now()}@example.test`;
  const user = await createAuthUser(email, auth);
  const session = await signIn(email, auth);
  const env = loadEnv();
  let projectId: string | undefined;
  try {
    const accounts = await api<{ account_id: string }[]>(session.access_token, 'GET', '/accounts');
    const account = accounts[0];
    expect(account).toBeDefined();
    const project = await createDatabaseProject(env, { accountId: account.account_id, userId: user.id, name: 'Provider and model control' });
    projectId = project.id;
    const base = `/projects/${project.id}`;
    await api(session.access_token, 'PATCH', `${base}/experimental`, { feature: 'llm_gateway', enabled: true });
    await api(session.access_token, 'POST', `${base}/secrets`, { name: 'OPENAI_API_KEY', value: 'sk-e2e-unused-model-access', strategy: 'broker', consumer: 'llm_gateway' }, [200, 201]);
    await api(session.access_token, 'PUT', `${base}/gateway/routing-policy`, {
      defaultModel: 'codex/gpt-5.6-sol', visionModel: null, defaultFallback: null, rules: [],
    });
    await api(session.access_token, 'PUT', `${base}/model-enablement`, { modelOverrides: { 'openai/gpt-4o-mini': false } });
    const beforeSecrets = await api(session.access_token, 'GET', `${base}/secrets`);
    await installBrowserSessionDirect(page, session, `${base}/models`, auth);
    await selectAccountForUi(page, account.account_id);
    await page.goto(`${base}/models`);
    await dismissOnboarding(page);
    const dismissWelcome = page.getByRole('button', { name: 'Dismiss', exact: true });
    if (await dismissWelcome.isVisible()) await dismissWelcome.click();
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();

    async function toggle(name: string, expected: { target: string; id: string; enabled: boolean }) {
      const response = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`${base}/model-access`));
      await page.getByRole('switch', { name, exact: true }).click();
      const saved = await response;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual(expected);
      await expect(page.getByRole('switch', { name, exact: true })).toHaveAttribute('aria-checked', String(expected.enabled));
    }

    await expect(page.getByRole('switch', { name: 'Enable ChatGPT subscription', exact: true })).toBeDisabled();
    await toggle('Enable Kortix Managed Models', { target: 'provider', id: 'kortix', enabled: false });
    await toggle('Enable OpenAI', { target: 'provider', id: 'openai', enabled: false });
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Enable Kortix Managed Models', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Enable OpenAI', exact: true })).toHaveAttribute('aria-checked', 'false');
    expect(await api(session.access_token, 'GET', `${base}/secrets`)).toEqual(beforeSecrets);
    await toggle('Enable OpenAI', { target: 'provider', id: 'openai', enabled: true });
    await page.locator('button[role=tab]').filter({ hasText: /^Models$/ }).click();
    const hiddenRow = page.locator('[data-model-id="openai/gpt-4o-mini"]');
    await expect(hiddenRow.getByText('Hidden from picker', { exact: true })).toBeVisible();
    await hiddenRow.getByRole('button', { name: 'Default settings for GPT-4o mini', exact: true }).click();
    const hiddenDisabled = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`${base}/model-access`));
    await page.getByRole('menuitem', { name: 'Disable model', exact: true }).click();
    const hiddenSaved = await hiddenDisabled;
    expect(hiddenSaved.status()).toBe(200);
    expect(hiddenSaved.request().postDataJSON()).toEqual({ target: 'model', id: 'openai/gpt-4o-mini', enabled: false });
    await expect(hiddenRow.getByText('Disabled', { exact: true })).toBeVisible();
    await expect(hiddenRow.getByText('Hidden from picker', { exact: true })).toHaveCount(0);
    const modelSwitch = page.getByRole('switch', { name: 'Enable GPT-5.5', exact: true });
    await expect(modelSwitch).toBeVisible();
    // Explicit enable makes this catalog model visible regardless of its recency default.
    if (await modelSwitch.getAttribute('aria-checked') === 'false') {
      await toggle('Enable GPT-5.5', { target: 'model', id: 'openai/gpt-5.5', enabled: true });
    }
    await toggle('Enable GPT-5.5', { target: 'model', id: 'openai/gpt-5.5', enabled: false });
    const picker = await api<{ models: Record<string, { enabled: boolean }> }>(session.access_token, 'GET', `${base}/model-picker`);
    expect(picker.models['openai/gpt-5.5'].enabled).toBe(false);
    await toggle('Enable GPT-5.5', { target: 'model', id: 'openai/gpt-5.5', enabled: true });
    await page.getByRole('button', { name: 'Default settings for GPT-5.5', exact: true }).click();
    const defaultSaved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`${base}/model-defaults`));
    await page.getByRole('menuitem', { name: "Start this project's sessions with it" }).click();
    expect((await defaultSaved).status()).toBe(200);
    await expect(page.getByRole('switch', { name: 'Enable OpenAI', exact: true })).toBeDisabled();
    await expect(page.getByRole('switch', { name: "GPT-5.5 is this project's default model and cannot be turned off", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('model-access.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Providers', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enable ChatGPT subscription', exact: true })).toBeEnabled();
    await toggle('Enable ChatGPT subscription', { target: 'provider', id: 'codex', enabled: false });
    await toggle('Enable ChatGPT subscription', { target: 'provider', id: 'codex', enabled: true });
    await toggle('Enable Kortix Managed Models', { target: 'provider', id: 'kortix', enabled: true });
    await page.screenshot({ path: testInfo.outputPath('provider-access.png'), fullPage: true });
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, auth);
  }
});
