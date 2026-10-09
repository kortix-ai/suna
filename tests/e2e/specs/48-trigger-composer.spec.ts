import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * "New trigger" is one When -> Then composer, not a step wizard. One dialog
 * holds the whole trigger: the When block (Schedule, App event or Webhook),
 * the Then block, the name and the options, and the header sums it up in a
 * sentence. Create shows each problem at its field and sends nothing until the
 * trigger is complete. Switching the kind keeps what was typed under Then.
 *
 * The local profile has no Composio catalog, so the App event browse and its
 * connector-then-trigger order are covered by unit tests
 * (`trigger-composer.test.ts`) and by the dev-stack run in the PR.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eTriggerComposer123!',
};
const api = createApiJsonClient(apiBase);
const INSTRUCTION = 'Post the standup digest to the team channel.';

async function openComposer(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/customize/triggers`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'New trigger', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Set up manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'New trigger', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('48 — the trigger composer shows the whole trigger, flags problems in place, and creates a schedule', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const ownerEmail = `e2e-trigger-composer-${runId}@example.test`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  let project: ManifestProject | undefined;

  try {
    const ownerAuth = await signIn(ownerEmail, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      ownerAuth.access_token,
      'GET',
      '/accounts',
    );
    const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: ownerAuth.access_token,
      accountId,
      userId: owner.id,
      name: `Trigger composer ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    await installBrowserSessionDirect(page, ownerAuth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);

    const created: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/v1\/projects\/[^/]+\/triggers$/.test(request.url())) {
        created.push(request.url());
      }
    });

    const dialog = await openComposer(page, projectId);

    await test.step('the dialog shows When, Then and Name at once, with no Next or Back', async () => {
      await expect(dialog.getByText('When', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Then', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Every day at 09:00');
      await expect(dialog.getByRole('button', { name: 'Next' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Back' })).toHaveCount(0);
      await expect(dialog.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByText('Every day at 09:00 (UTC), default runs your instruction.')).toBeVisible();
    });

    await test.step('Create with no instruction flags it under the field and sends nothing', async () => {
      await dialog.getByRole('button', { name: 'Create trigger' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'Say what the agent should do.' })).toBeVisible();
      expect(created).toEqual([]);
    });

    await test.step('switching to Webhook keeps the instruction and changes the summary', async () => {
      await dialog.getByLabel('Instruction').fill(INSTRUCTION);
      await dialog.getByRole('tab', { name: 'Webhook' }).click();
      await expect(dialog.getByText('When your app calls the webhook, default runs your instruction.')).toBeVisible();
      await expect(dialog.getByLabel('Instruction')).toHaveValue(INSTRUCTION);
      await expect(dialog.getByLabel('Signing key')).toBeVisible();
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Webhook');
    });

    await test.step('an edited name stays when the kind changes back', async () => {
      await dialog.getByLabel('Name', { exact: true }).fill('Standup digest');
      await dialog.getByRole('tab', { name: 'Schedule' }).click();
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Standup digest');
    });

    await test.step('Create writes the schedule in one request and opens it', async () => {
      const post = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/v1\/projects\/[^/]+\/triggers$/.test(r.url()),
      );
      await dialog.getByRole('button', { name: 'Create trigger' }).click();
      expect((await post).status()).toBe(201);
      expect(created).toHaveLength(1);
      await expect(page.getByRole('dialog', { name: 'Standup digest', exact: true })).toBeVisible();
    });

    await test.step('the API read-back has the same schedule', async () => {
      const listing = await api<{
        triggers: Array<{ slug: string; name: string; type: string; cron: string | null; prompt_template: string }>;
      }>(ownerAuth.access_token, 'GET', `/projects/${projectId}/triggers`);
      const row = listing.triggers.find((t) => t.name === 'Standup digest');
      expect(row).toMatchObject({ type: 'cron', cron: '0 0 9 * * *', prompt_template: INSTRUCTION });
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
  }
});
