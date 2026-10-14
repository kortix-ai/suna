import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const api = createApiJsonClient(process.env.E2E_API_URL || 'http://localhost:15108/v1');
const auth = { supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321', password: 'ModelAccessE2e123!' };

test('ChatGPT picker shows published model prices instead of Free', async ({ page }, testInfo) => {
  const env = loadEnv();
  const email = `chatgpt-picker-${Date.now()}@example.test`;
  const user = await createAuthUser(email, auth);
  let projectId: string | undefined;
  try {
    const session = await signIn(email, auth);
    const accounts = await api<{ account_id: string }[]>(session.access_token, 'GET', '/accounts');
    const project = await createDatabaseProject(env, {
      accountId: accounts[0].account_id,
      userId: user.id,
      name: 'ChatGPT picker pricing',
      repoUrl: '',
    });
    projectId = project.id;
    const base = `/projects/${project.id}`;
    await api(session.access_token, 'PATCH', `${base}/experimental`, { feature: 'llm_gateway', enabled: true });
    await api(session.access_token, 'PUT', `${base}/gateway/routing-policy`, {
      defaultModel: 'codex/gpt-5.6-sol', visionModel: null, defaultFallback: null, rules: [],
    });
    await installBrowserSessionDirect(page, session, `${base}/models`, auth);
    await selectAccountForUi(page, accounts[0].account_id);
    const pickerResponse = page.waitForResponse((r) =>
      r.request().method() === 'GET' && r.url().endsWith(`${base}/model-picker`) && r.status() === 200,
    );
    await page.goto(`${base}/models`);
    await dismissOnboarding(page);
    expect((await pickerResponse).status()).toBe(200);
    const picker = await api<{ models: Record<string, { cost: { input: number } }> }>(
      session.access_token, 'GET', `${base}/model-picker`,
    );
    expect(picker.models['codex/gpt-5.6-sol'].cost.input).toBeGreaterThan(0);
    await page.locator('button[role=tab]').filter({ hasText: /^Models$/ }).click();
    const row = page.locator('[data-model-id="codex/gpt-5.6-sol"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\$[\d.]+\s*\/\s*\$[\d.]+\s*per 1M/);
    await expect(row).not.toContainText('Free');
    await page.screenshot({ path: testInfo.outputPath('chatgpt-picker-pricing.png') });
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, auth);
  }
});

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
    // Scoped to the welcome card: the sidebar's "Connect your computer" card
    // carries a Dismiss button too, and an unscoped locator matched both.
    const dismissWelcome = page
      .getByRole('complementary', { name: 'Welcome from Marko' })
      .getByRole('button', { name: 'Dismiss', exact: true });
    if (await dismissWelcome.isVisible()) await dismissWelcome.click();
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();

    // Since #9801 a provider is switched on and off in two places: its side
    // sheet (Providers tab, "Enable <provider>") and its group header on the
    // Models tab. Each test step says which one is open.
    async function toggle(name: string, expected: { target: string; id: string; enabled: boolean }) {
      const response = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`${base}/model-access`));
      const control = page.getByRole('switch', { name, exact: true });
      await control.click();
      const saved = await response;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual(expected);
      await expect(control).toHaveAttribute('aria-checked', String(expected.enabled));
    }
    const modelsTab = page.locator('button[role=tab]').filter({ hasText: /^Models$/ });
    const providersTab = page.getByRole('tab', { name: 'Providers', exact: true });
    const openProvider = (id: string) => page.locator(`[data-provider-row="${id}"]`).click();
    // The project default's provider cannot be turned off.
    const expectProtectedProvider = (name: string) =>
      expect(page.getByRole('switch', { name: `Enable ${name}`, exact: true })).toBeDisabled();

    await modelsTab.click();
    await expect(modelsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('combobox', { name: 'Filter by provider' })).toHaveCount(0);
    await expect(page.locator('[data-model-id^="openai/"]').first()).toBeVisible();
    await expect(page.locator('[data-model-id^="codex/"]').first()).toBeAttached();
    await expectProtectedProvider('ChatGPT subscription');
    await providersTab.click();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByText('Enabled', { exact: true })).toHaveCount(0);
    await openProvider('kortix');
    await toggle('Enable Kortix Managed Models', { target: 'provider', id: 'kortix', enabled: false });
    await openProvider('openai');
    await toggle('Enable OpenAI', { target: 'provider', id: 'openai', enabled: false });
    await page.reload();
    await expect(page.locator('[data-provider-row="kortix"]').getByText('Turned off', { exact: true })).toBeVisible();
    await expect(page.locator('[data-provider-row="openai"]').getByText('Turned off', { exact: true })).toBeVisible();
    expect(await api(session.access_token, 'GET', `${base}/secrets`)).toEqual(beforeSecrets);
    await openProvider('openai');
    await toggle('Enable OpenAI', { target: 'provider', id: 'openai', enabled: true });
    await expect(page.locator('[data-provider-row="openai"]').getByText('Turned off', { exact: true })).toHaveCount(0);
    await modelsTab.click();
    await expect(page.getByRole('combobox', { name: 'Filter by provider' })).toHaveCount(0);
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
    await expectProtectedProvider('OpenAI');
    await expect(page.getByRole('switch', { name: "GPT-5.5 is this project's default model and cannot be turned off", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('model-access.png'), fullPage: true });
    // ChatGPT subscription is not connected here: its group was listed only
    // while it held the project default, and has no switch to offer now.
    await expect(page.locator('[data-provider-group="codex"]')).toHaveCount(0);
    await providersTab.click();
    await openProvider('kortix');
    await toggle('Enable Kortix Managed Models', { target: 'provider', id: 'kortix', enabled: true });
    await page.screenshot({ path: testInfo.outputPath('provider-access.png'), fullPage: true });

    await api(session.access_token, 'PATCH', `${base}/experimental`, { feature: 'pooled_provider_secrets', enabled: true });
    await page.reload();
    await openProvider('anthropic');
    const anthropicKeys = page.getByRole('region', { name: 'Anthropic API keys' });
    await expect(anthropicKeys.getByRole('button', { name: 'Add key' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Anthropic API key' })).toHaveCount(0);
    for (const label of ['Primary test key', 'Backup test key']) {
      await anthropicKeys.getByRole('button', { name: 'Add key' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Label' }).fill(label);
      await dialog.getByRole('textbox', { name: 'API key' }).fill(`sk-ant-e2e-${label.replaceAll(' ', '-').toLowerCase()}`);
      const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/accounts/${account.account_id}/secret-resources`));
      await dialog.getByRole('button', { name: 'Save key' }).click();
      expect((await created).status()).toBe(201);
      await expect(anthropicKeys.getByText(label, { exact: true })).toBeVisible();
    }
    const listed = await api<{ secrets: Array<{ label: string; provider_id: string }> }>(session.access_token, 'GET', `/accounts/${account.account_id}/secret-resources?project_id=${project.id}`);
    expect(listed.secrets.filter((secret) => secret.provider_id === 'anthropic').map((secret) => secret.label).sort()).toEqual(['Backup test key', 'Primary test key']);
    await anthropicKeys.getByRole('button', { name: 'Actions for Primary test key' }).click();
    await page.getByRole('menuitem', { name: 'Manage access' }).click();
    const accessDialog = page.getByRole('dialog');
    await expect(accessDialog.getByRole('heading', { name: 'Access to Primary test key' })).toBeVisible();
    // The Add dialog creates keys as "Specific members" with the creator
    // preselected (sharing with the project is an explicit opt-in), so Manage
    // access opens on that mode rather than "Everyone in this project".
    await expect(accessDialog.getByRole('radio', { name: /Specific members/ })).toBeChecked();
    await expect(accessDialog.getByRole('textbox', { name: 'Search members' })).toBeVisible();
    await expect(accessDialog.getByRole('button', { name: new RegExp(email) })).toBeVisible();
    await accessDialog.getByRole('button', { name: 'Done' }).click();
    await expect(accessDialog).toHaveCount(0);

    await openProvider('google');
    const googleKeys = page.getByRole('region', { name: 'Google API keys' });
    await googleKeys.getByRole('button', { name: 'Add key' }).click();
    const googleDialog = page.getByRole('dialog');
    await googleDialog.getByRole('textbox', { name: 'Label' }).fill('Gemini test key');
    await googleDialog.getByRole('textbox', { name: 'API key' }).fill('gemini-e2e-unused');
    const googleCreated = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/accounts/${account.account_id}/secret-resources`));
    await googleDialog.getByRole('button', { name: 'Save key' }).click();
    expect((await googleCreated).status()).toBe(201);
    await expect(googleKeys.getByText('Gemini test key', { exact: true })).toBeVisible();
    await googleKeys.getByRole('button', { name: 'Actions for Gemini test key' }).click();
    await page.getByRole('menuitem', { name: 'Delete key' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key' }).click();
    await expect(googleKeys.getByText('Gemini test key', { exact: true })).toHaveCount(0);
    await openProvider('anthropic');
    for (const label of ['Primary test key', 'Backup test key']) {
      await anthropicKeys.getByRole('button', { name: `Actions for ${label}` }).click();
      await page.getByRole('menuitem', { name: 'Delete key' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key' }).click();
      await expect(anthropicKeys.getByText(label, { exact: true })).toHaveCount(0);
    }
    await page.getByRole('tab', { name: 'Secrets', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Shared provider secrets' })).toHaveCount(0);
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, auth);
  }
});
