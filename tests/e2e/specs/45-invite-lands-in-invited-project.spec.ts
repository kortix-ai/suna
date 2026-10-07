import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1731: accepting a project invite from its email link went to the
 * landing door, which reopened the project this browser remembered, in the
 * invitee's own account. The invited project was reachable only through the
 * switcher. Accept now lands in the project the invite granted.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eInviteLanding123!',
};
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

test('45 — accepting a project invite lands in the invited project, not the remembered one', async ({ page }) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const ownerEmail = `e2e-invite-landing-owner-${runId}@example.test`;
  const inviteeEmail = `e2e-invite-landing-invitee-${runId}@example.test`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  const invitee = await createAuthUser(inviteeEmail, authOptions);
  const projectIds: string[] = [];

  try {
    const ownerAuth = await signIn(ownerEmail, authOptions);
    const inviteeAuth = await signIn(inviteeEmail, authOptions);
    const ownerAccount = (await api<AccountSummary[]>(ownerAuth.access_token, 'GET', '/accounts')).find(
      (a) => a.personal_account,
    )!.account_id;
    const inviteeAccount = (await api<AccountSummary[]>(inviteeAuth.access_token, 'GET', '/accounts')).find(
      (a) => a.personal_account,
    )!.account_id;

    // The invitee's own project, open in this browser: the remembered one.
    const scratch = await createDatabaseProject(env, {
      accountId: inviteeAccount,
      userId: invitee.id,
      name: `Scratch ${runId}`,
    });
    projectIds.push(scratch.id);
    // The project the invitee is invited to, in the owner's account.
    const website = await createDatabaseProject(env, {
      accountId: ownerAccount,
      userId: owner.id,
      name: `Website ${runId}`,
    });
    projectIds.push(website.id);

    const invited = await api<{ status: string; invite_id: string }>(
      ownerAuth.access_token,
      'POST',
      `/projects/${website.id}/access/invite`,
      { email: inviteeEmail, role: 'member' },
    );
    expect(invited.status).toBe('invited');

    await installBrowserSessionDirect(page, inviteeAuth, `/projects/${scratch.id}`, authOptions);
    await selectAccountForUi(page, inviteeAccount);
    await page.goto(`/projects/${scratch.id}`, { waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);
    await expect(page).toHaveURL(new RegExp(`/projects/${scratch.id}`));

    await page.goto(`/invites/${invited.invite_id}`, { waitUntil: 'domcontentloaded' });
    const accepted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/v1/account-invites/${invited.invite_id}/accept`),
    );
    await page.getByRole('button', { name: 'Accept' }).click();
    expect((await accepted).status()).toBe(200);

    await expect(page).toHaveURL(new RegExp(`/projects/${website.id}(\\?|$)`), { timeout: 30_000 });
  } finally {
    for (const id of projectIds) await deleteDatabaseProject(env, id).catch(() => undefined);
    await deleteAuthUser(invitee.id, authOptions).catch(() => undefined);
    await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
  }
});
