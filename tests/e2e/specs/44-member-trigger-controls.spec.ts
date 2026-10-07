import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1720: every trigger control sat under one flag. On the Triggers page it
 * was `project.trigger.create`, so a built-in member (who holds
 * `project.trigger.fire`, and the docs say may fire) saw no Run now. Each
 * control now follows the leaf its route asserts: the member gets Run now and
 * no Pause or Delete; the owner gets all three.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eMemberTriggerControls123!',
};
const api = createApiJsonClient(apiBase);
const TRIGGER = 'Nightly digest';

async function openTrigger(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/customize/triggers`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  await page.getByRole('button', { name: TRIGGER, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: TRIGGER, exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('44 — a member gets Run now on a trigger, and no Pause or Delete', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const ownerEmail = `e2e-trigger-controls-owner-${runId}@example.test`;
  const memberEmail = `e2e-trigger-controls-member-${runId}@example.test`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  const member = await createAuthUser(memberEmail, authOptions);
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
      name: `Trigger controls ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    await api(ownerAuth.access_token, 'POST', `/accounts/${accountId}/members`, { email: memberEmail, role: 'member' }, 201);
    await api(ownerAuth.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, { role: 'member' });
    await api(
      ownerAuth.access_token,
      'POST',
      `/projects/${projectId}/triggers`,
      { name: TRIGGER, type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'Summarize the day.' },
      201,
    );

    const memberAuth = await signIn(memberEmail, authOptions);
    await installBrowserSessionDirect(page, memberAuth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);

    await test.step('the member sees Run now, and no Pause and no More actions (Delete)', async () => {
      const sheet = await openTrigger(page, projectId);
      await expect(sheet.getByRole('button', { name: 'Run now' })).toBeVisible();
      await expect(sheet.getByRole('button', { name: /^(Pause|Resume)$/ })).toHaveCount(0);
      await expect(sheet.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    });

    await test.step('Run now reaches the fire route, and the API does not refuse the member', async () => {
      const fire = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/v1\/projects\/[^/]+\/triggers\/[^/]+\/fire$/.test(r.url()),
      );
      await page.getByRole('dialog', { name: TRIGGER, exact: true }).getByRole('button', { name: 'Run now' }).click();
      expect((await fire).status()).not.toBe(403);
    });

    await test.step('the owner keeps Run now, Pause and More actions on the same trigger', async () => {
      const ownerContext = await browser.newContext();
      try {
        const ownerPage = await ownerContext.newPage();
        await installBrowserSessionDirect(ownerPage, ownerAuth, `/projects/${projectId}`, authOptions);
        await selectAccountForUi(ownerPage, accountId);
        const sheet = await openTrigger(ownerPage, projectId);
        await expect(sheet.getByRole('button', { name: 'Run now' })).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Pause' })).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'More actions' })).toBeVisible();
      } finally {
        await ownerContext.close();
      }
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(member.id, authOptions).catch(() => undefined);
    await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
  }
});
