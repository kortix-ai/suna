import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';

/**
 * KRTX-1716: an account that enforces SSO on a verified domain refuses a
 * password identity of that domain on every credential (`sso_required`, flow
 * SSO-6). The web app turns that answer into one dialog, "Sign in with single
 * sign-on", whose only action signs out. This drives it in a real browser:
 * a member with a password identity on the enforced domain opens a project of
 * the account.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eSsoRequiredDialog123!',
};
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role?: string;
}

test('46 — a password identity on an SSO-only domain gets the sign-in-with-SSO dialog', async ({ page }) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const domain = `e2e-sso-${runId}.test`;
  const ownerEmail = `e2e-sso-dialog-owner-${runId}@example.test`;
  const memberEmail = `admin@${domain}`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  const member = await createAuthUser(memberEmail, authOptions);
  let accountId: string | null = null;
  let projectId: string | null = null;

  try {
    const ownerAuth = await signIn(ownerEmail, authOptions);
    const accounts = await api<AccountSummary[]>(ownerAuth.access_token, 'GET', '/accounts');
    const own = accounts.find((a) => a.personal_account || a.is_primary_owner || a.account_role === 'owner');
    if (!own) throw new Error('the seeded owner owns no account');
    accountId = own.account_id;
    projectId = (await createDatabaseProject(env, { accountId, userId: owner.id, name: `SSO only ${runId}` })).id;
    await api(ownerAuth.access_token, 'POST', `/accounts/${accountId}/members`, { email: memberEmail, role: 'member' }, 201);
    await api(ownerAuth.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, { role: 'member' });

    // The account's IdP enforces sign-in for a domain it proved control of.
    // (The API routes that set this are covered by flows SSO-1 and SSO-6.)
    await runDatabaseSql(
      `INSERT INTO kortix.account_sso_providers
         (account_id, supabase_sso_provider_id, name, primary_domain, enforce_sso, domain_verified_at)
       VALUES ($1::uuid, gen_random_uuid(), 'Synthetic IdP', $2, true, now())`,
      [accountId, domain],
      env.databaseUrl,
    );

    const refused: string[] = [];
    page.on('response', async (response) => {
      if (response.status() !== 403 || !response.url().includes('/v1/')) return;
      const body = await response.json().catch(() => null);
      if (body?.code === 'sso_required') refused.push(new URL(response.url()).pathname);
    });

    const memberAuth = await signIn(memberEmail, authOptions);
    await installBrowserSessionDirect(page, memberAuth, `/projects/${projectId}`, authOptions);
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });

    await test.step('the API refuses the password identity, and the app says why', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in with single sign-on' });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(dialog).toContainText('Your organization requires single sign-on');
      expect(refused.length).toBeGreaterThan(0);
    });

    await test.step('its one action signs out to the sign-in page', async () => {
      await page.getByRole('button', { name: 'Sign out and use SSO' }).click();
      await expect(page).toHaveURL(/\/auth/, { timeout: 30_000 });
    });
  } finally {
    if (accountId) {
      await runDatabaseSql('DELETE FROM kortix.account_sso_providers WHERE account_id = $1::uuid', [accountId], env.databaseUrl).catch(
        () => undefined,
      );
    }
    if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
    await deleteAuthUser(member.id, authOptions).catch(() => undefined);
    await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
  }
});
