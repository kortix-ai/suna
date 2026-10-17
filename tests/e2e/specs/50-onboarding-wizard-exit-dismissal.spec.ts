import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { queryDatabaseRows, runDatabaseSql, seedDatabaseProject } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'E2eWizardExit123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

const wizardDialog = (page: Parameters<typeof installBrowserSessionDirect>[0]) =>
  page
    .getByRole('dialog')
    .filter({ has: page.getByRole('progressbar', { name: 'Setup progress' }) })
    .last();

interface Provisioned {
  projectId: string;
  session: AuthSession;
  userId: string;
  email: string;
}

async function freshUserWithProject(): Promise<Provisioned> {
  const email = `e2e-wizard-exit-${Date.now().toString(36)}@example.test`;
  const user = await createAuthUser(email, authOptions);
  try {
    const session = await signIn(email, authOptions);
    const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
      session.access_token,
      'GET',
      '/accounts',
    );
    const account = accounts.find((row) => row.personal_account) ?? accounts[0];
    expect(account).toBeDefined();
    // This journey tests dismissal, not external managed Git provisioning.
    const projectId = await seedDatabaseProject({
      accountId: account.account_id,
      userId: user.id,
      name: `Wizard exit ${randomUUID().slice(0, 8)}`,
    });
    await api(session.access_token, 'PATCH', `/projects/${projectId}/onboarding`, {
      completed: false,
    });
    return { projectId, session, userId: user.id, email };
  } catch (error) {
    await cleanup({ userId: user.id, email });
    throw error;
  }
}

async function cleanup(user: { userId: string; email: string }) {
  const rows = await queryDatabaseRows<{ account_id: string }>(
    'select distinct account_id::text from kortix.account_members where user_id = $1::uuid',
    [user.userId],
  );
  try {
    for (const row of rows) {
      await runDatabaseSql('delete from kortix.accounts where account_id = $1::uuid', [
        row.account_id,
      ]);
      expect(
        await queryDatabaseRows(
          'select account_id from kortix.accounts where account_id = $1::uuid',
          [row.account_id],
        ),
      ).toEqual([]);
    }
  } finally {
    await deleteAuthUser(user.userId, authOptions);
  }
  expect(
    await queryDatabaseRows('select id from auth.users where id = $1::uuid', [user.userId]),
  ).toEqual([]);
}

test.describe("50 — the onboarding wizard's exit buttons dismiss it", () => {
  for (const exit of [
    { step: 1, button: 'Skip for now' },
    { step: 2, button: 'Skip for now' },
    { step: 3, button: 'Decide later' },
    { step: 3, button: 'Open workspace' },
  ]) {
    test(`step ${exit.step}: ${exit.button} dismisses without a reload`, async ({ page }) => {
      test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
      test.setTimeout(300_000);
      const user = await freshUserWithProject();
      try {
        await installBrowserSessionDirect(
          page,
          user.session,
          `/projects/${user.projectId}`,
          authOptions,
        );
        await expect(wizardDialog(page)).toBeVisible({ timeout: 60_000 });
        await expect(
          page.getByRole('heading', { name: 'What do you mostly work on?' }),
        ).toBeVisible();
        if (exit.step >= 2) {
          await page.getByRole('radio', { name: 'Running a company' }).click();
          await page.getByRole('button', { name: 'Continue' }).click();
          await expect(page.getByRole('heading', { name: 'Which apps do you use?' })).toBeVisible({
            timeout: 15_000,
          });
        }
        if (exit.step === 3) {
          await page.getByRole('button', { name: 'Continue' }).click();
          await expect(
            page.getByRole('heading', {
              name: 'Which models should Kortix use?',
            }),
          ).toBeVisible({ timeout: 15_000 });
        }
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        const completion = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/v1/projects/${user.projectId}/onboarding` &&
            response.request().method() === 'PATCH' &&
            response.request().postDataJSON()?.completed === true,
        );
        await page.getByRole('button', { name: exit.button, exact: true }).click();
        expect((await completion).status()).toBe(200);
        await expect(wizardDialog(page)).toHaveCount(0, { timeout: 10_000 });
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(new URL(page.url()).pathname).toBe(`/projects/${user.projectId}`);
      } finally {
        await cleanup(user);
      }
    });
  }
});
