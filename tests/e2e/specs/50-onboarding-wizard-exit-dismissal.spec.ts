import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { type Env, loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { queryDatabaseRows, runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { fundAccount } from '../helpers/manifest-project';
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

/** The promo's title in the DOM, open or not: a modal behind another one is aria-hidden, so no role query. */
const promoTitle = (page: Parameters<typeof installBrowserSessionDirect>[0]) =>
  page.getByText('Kortix, now on your phone', { exact: true });

interface Provisioned {
  projectId: string;
  accountId: string;
  session: AuthSession;
  userId: string;
  email: string;
  env: Env;
}

async function freshUserWithProject(): Promise<Provisioned> {
  // Two workers reach this line in the same millisecond more often than one
  // would guess, and auth.users enforces the email uniqueness; the UUID suffix
  // keeps the four parallel provisions collision-free.
  const email = `e2e-wizard-exit-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@example.test`;
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
    // The database fixture stamps `onboarding_completed_at` by default so
    // other journeys do not fight the wizard; null it here so this fresh
    // project starts pending and the wizard opens on first landing.
    const env = loadEnv();
    const project = await createDatabaseProject(env, {
      accountId: account.account_id,
      userId: user.id,
      name: `Wizard exit ${randomUUID().slice(0, 8)}`,
      metadata: { onboarding_completed_at: null },
    });
    return { projectId: project.id, accountId: account.account_id, session, userId: user.id, email, env };
  } catch (error) {
    await cleanup({ userId: user.id, email });
    throw error;
  }
}

async function cleanup(user: Provisioned) {
  const { env, projectId, userId, email } = user;
  const databaseUrl = env.databaseUrl ?? undefined;
  await deleteDatabaseProject(env, projectId).catch(() => undefined);
  const rows = await queryDatabaseRows<{ account_id: string }>(
    'select distinct account_id::text from kortix.account_members where user_id = $1::uuid',
    [userId],
    databaseUrl,
  );
  try {
    for (const row of rows) {
      await runDatabaseSql(
        'delete from kortix.accounts where account_id = $1::uuid',
        [row.account_id],
        databaseUrl,
      );
      expect(
        await queryDatabaseRows(
          'select account_id from kortix.accounts where account_id = $1::uuid',
          [row.account_id],
          databaseUrl,
        ),
      ).toEqual([]);
    }
  } finally {
    await deleteAuthUser(userId, authOptions);
  }
  expect(
    await queryDatabaseRows('select id from auth.users where id = $1::uuid', [userId], databaseUrl),
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
        // "Open workspace" is the models step's primary action only for an account that can run
        // Kortix models (`planAction`). Free cannot (#10297): its primary action is "See plans".
        // A paid tier with credits gets the button this exit tests.
        if (exit.button === 'Open workspace') await fundAccount(user.env.databaseUrl!, user.accountId);
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

  test('the promo does not follow a wizard exit onto the fresh project (KRTX-2635)', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
    test.setTimeout(300_000);
    const user = await freshUserWithProject();
    try {
      // showMobileAppPromo keeps the helper's pre-close handler out of the
      // way: this test must see exactly what the page does with the promo.
      await installBrowserSessionDirect(page, user.session, `/projects/${user.projectId}`, {
        ...authOptions,
        showMobileAppPromo: true,
      });
      await expect(wizardDialog(page)).toBeVisible({ timeout: 60_000 });

      // The exit stamps the project, and the stamp is what previously armed
      // the promo: the moment the wizard closed, the promo stacked on top of
      // the page the user just asked for. After the fix the first-chat era —
      // which this exit starts — owns the screen, so the promo stays closed.
      await page.getByRole('button', { name: 'Skip for now' }).first().click();
      await expect(wizardDialog(page)).toHaveCount(0, { timeout: 10_000 });
      // The promo opens right after hydration; give it the time it would take.
      await page.waitForTimeout(3_000);
      await expect(promoTitle(page)).toHaveCount(0);
    } finally {
      await cleanup(user);
    }
  });

  test('a dismissed promo stays closed across a reload on a promo-eligible project (KRTX-2640)', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
    test.setTimeout(300_000);
    const user = await freshUserWithProject();
    // A SECOND, stamped project: the create flow stamps later projects, so no
    // wizard runs and no first-chat era starts — the one surface the promo
    // opens on. The sign-out sweep keeps this dismissal (it is device-scoped,
    // KEEP_STORAGE_KEYS), so a reload — and a fresh sign-in, covered at the
    // sweep's own level in `clear-local-storage.test.ts` — never re-asks.
    let secondProjectId: string | undefined;
    try {
      secondProjectId = (
        await createDatabaseProject(user.env, {
          accountId: user.accountId,
          userId: user.userId,
          name: `Promo eligible ${Date.now().toString(36)}`,
        })
      ).id;
      await installBrowserSessionDirect(page, user.session, `/projects/${secondProjectId}`, {
        ...authOptions,
        showMobileAppPromo: true,
      });
      await expect(promoTitle(page)).toBeVisible({ timeout: 30_000 });

      await page
        .getByRole('dialog')
        .filter({ has: promoTitle(page) })
        .getByRole('button', { name: /close/i })
        .first()
        .click();
      await expect(promoTitle(page)).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('kortix.mobileAppPromo'))).toContain(
        '"closed":true',
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3_000);
      await expect(promoTitle(page)).toHaveCount(0);
    } finally {
      if (secondProjectId) {
        await deleteDatabaseProject(user.env, secondProjectId).catch(() => undefined);
      }
      await cleanup(user);
    }
  });
});
