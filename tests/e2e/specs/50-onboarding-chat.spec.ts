import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { type Env, loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { queryDatabaseRows, runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { fundAccount, isDeployedTarget } from '../helpers/manifest-project';
import {
  type AuthSession,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'E2eOnboardingChat123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

/** The project home composer's editor. The onboarding chat holds "Onboard me" in it. */
const composerEditor = (page: Parameters<typeof installBrowserSessionDirect>[0]) =>
  page.locator('[contenteditable="true"]').last();

/** The promo's title in the DOM, open or not: a modal behind another one is aria-hidden, so no role query. */
const promoTitle = (page: Parameters<typeof installBrowserSessionDirect>[0]) =>
  page.getByText('Kortix, now on your phone', { exact: true });

interface Provisioned {
  projectId: string;
  /** A managed-git project from `POST /projects/provision`, deleted through the API. */
  provisioned?: boolean;
  accountId: string;
  session: AuthSession;
  userId: string;
  email: string;
  env: Env;
}

/**
 * `realProject`: on a deployed target, fund the account and provision a real
 * managed-git project, as a new user's sign-up does. A database project has no
 * repository, so its first session cannot start and the kickoff never stamps.
 */
async function freshUserWithProject(options: { realProject?: boolean } = {}): Promise<Provisioned> {
  // Two workers reach this line in the same millisecond more often than one
  // would guess, and auth.users enforces the email uniqueness; the UUID suffix
  // keeps the four parallel provisions collision-free.
  const email = `e2e-onboarding-chat-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@example.test`;
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
    // The database fixture stamps `onboarding_completed_at` by default so
    // other journeys land on the usual home; null it here so this fresh
    // project opens on the onboarding chat.
    const env = loadEnv();
    if (options.realProject && isDeployedTarget()) {
      await fundAccount(env.databaseUrl!, account.account_id);
      const real = await api<{ project_id: string }>(
        session.access_token,
        'POST',
        '/projects/provision',
        { account_id: account.account_id, name: `Onboarding chat ${randomUUID().slice(0, 8)}`, seed_starter: true },
        201,
      );
      return { projectId: real.project_id, provisioned: true, accountId: account.account_id, session, userId: user.id, email, env };
    }
    const project = await createDatabaseProject(env, {
      accountId: account.account_id,
      userId: user.id,
      name: `Onboarding chat ${randomUUID().slice(0, 8)}`,
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
  if (user.provisioned) {
    await api(user.session.access_token, 'DELETE', `/projects/${projectId}`, undefined, [200, 204, 404]).catch(() => undefined);
  } else {
    await deleteDatabaseProject(env, projectId).catch(() => undefined);
  }
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

test.describe('50 — a new project opens on the first chat, which runs the onboarding', () => {
  // A Free account has no model, so nothing can be sent: the chat holds the
  // kickoff in the composer and the tray offers the two ways to get a model.
  test('without a model: "Onboard me" waits in the composer, nothing is sent', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
    test.setTimeout(300_000);
    const user = await freshUserWithProject();
    try {
      const stamps: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === `/v1/projects/${user.projectId}/onboarding`) {
          stamps.push(request.method());
        }
      });
      // showMobileAppPromo: true lets the promo open if the page allows it.
      // Onboarding owns the screen, so it must not (KRTX-2635).
      await installBrowserSessionDirect(page, user.session, `/projects/${user.projectId}`, {
        ...authOptions,
        showMobileAppPromo: true,
      });
      await expect(composerEditor(page)).toHaveText('Onboard me', { timeout: 60_000 });
      // The landing is the first chat: its welcome, what Kortix can do, its sidebar row.
      // (#10878 replaced the starter tiles with the "What you can do" list.)
      await expect(page.getByRole('heading', { level: 1, name: /I'm Kortix\./ })).toBeVisible();
      await expect(page.getByText('What you can do with Kortix')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Your first chat with Kortix' })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('chat')).toBe('first');
      await expect(page.getByText('No model connected')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Connect model' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveCount(0);

      // The promo opens right after hydration; give it the time it would take.
      await page.waitForTimeout(3_000);
      await expect(promoTitle(page)).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(`/projects/${user.projectId}`);
      expect(stamps).toEqual([]);
    } finally {
      await cleanup(user);
    }
  });

  // With a usable model the kickoff sends itself: the agent speaks first.
  test('with a model: the kickoff opens a session and stamps the project onboarded', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
    test.setTimeout(300_000);
    const user = await freshUserWithProject({ realProject: true });
    try {
      // Credits buy Kortix models; Free cannot run them (#10297).
      await fundAccount(user.env.databaseUrl!, user.accountId);
      const stamp = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/v1/projects/${user.projectId}/onboarding` &&
          response.request().method() === 'PATCH' &&
          response.request().postDataJSON()?.completed === true,
        { timeout: 120_000 },
      );
      await installBrowserSessionDirect(page, user.session, `/projects/${user.projectId}`, authOptions);
      expect((await stamp).status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`/projects/${user.projectId}/sessions/`), {
        timeout: 60_000,
      });
      await expect(page.getByText('Onboard me').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await cleanup(user);
    }
  });

  test('a dismissed promo stays closed across a reload on a promo-eligible project (KRTX-2640)', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL is required');
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const user = await freshUserWithProject();
    // A SECOND, stamped project: the create flow stamps later projects, so it
    // opens on the usual home — the one surface the promo opens on. The sign-out sweep keeps this dismissal (it is device-scoped,
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
