import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createLocalGitRepository, type LocalGitRepository } from '../../src/fixtures/local-git';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eResourceGrantMulti123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface ResourceGrantsResponse {
  resources: { agents: { id: string; name: string }[] };
  grants: {
    grant_id: string;
    resource_type: string;
    resource_id: string;
    principal_type: 'member' | 'group';
    principal_id: string;
    principal_label: string;
  }[];
}

/**
 * Regression coverage for the "Assign an agent" dialog's multi-select on
 * BOTH steps (members-tab.tsx's ResourceAccessCard): reported live as
 * "right away you can only ever edit one user at a time. you should be able
 * to multi-select users in groups which get access to the agent" — and,
 * once that landed, "sure the agent selection is also a multi-step of
 * course like granting access." Step 1 (agent) and step 2 (member/group)
 * are each independent Checkbox lists / SubjectPicker now; submitting fires
 * one createProjectResourceGrant per (agent, principal) pair via
 * Promise.allSettled. This spec picks one agent and two members — the
 * simplest case that still proves the pair-fan-out (2 grants, not 1) — a
 * fuller multi-agent case is the natural follow-up if that dimension ever
 * regresses independently.
 *
 * `createLocalGitRepository` seeds `kortix.yaml` with `agents:\n  kortix: {}`
 * (local-git.ts), so every project made through it already has a real
 * "kortix" agent to grant — no extra fixture needed.
 */
test.describe('22 — Resource-grant multi-select', () => {
  test('granting one agent to two members in a single dialog creates two grants', async ({
    page,
  }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(120_000);

    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-grant-owner-${runId}@example.test`;
    const memberAEmail = `e2e-grant-a-${runId}@example.test`;
    const memberBEmail = `e2e-grant-b-${runId}@example.test`;

    const owner = await createAuthUser(ownerEmail, authOptions);
    const memberA = await createAuthUser(memberAEmail, authOptions);
    const memberB = await createAuthUser(memberBEmail, authOptions);
    const session = await signIn(ownerEmail, authOptions);
    const env = loadEnv();

    let accountId: string | null = null;
    let projectId: string | null = null;
    let repository: LocalGitRepository | null = null;

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded user owns no account');
      accountId = account.account_id;

      await api<{ status: string }>(
        session.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: memberAEmail, role: 'member' },
        201,
      );
      await api<{ status: string }>(
        session.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: memberBEmail, role: 'member' },
        201,
      );

      repository = await createLocalGitRepository(`Resource grant multiselect ${runId}`);
      const project = await createDatabaseProject(env, {
        accountId,
        userId: owner.id,
        name: `Resource grant multiselect ${runId}`,
        repoUrl: repository.repoUrl,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, `/projects/${projectId}/members`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // The per-project Members page is gone (2026-08-18/19): `/projects/:id/
      // members` redirects into the account hub's Projects panel for this
      // project, and agent access is a field of the ONE "Grant access" dialog
      // (`features/workspace/shared/access/access-dialog.tsx`), not a separate
      // "Assign an agent" flow. Members are deny-by-default for agents, so
      // granting the two members with Agents = "Only these… → kortix" is what
      // creates the two resource grants.
      await expect(page).toHaveURL(
        new RegExp(`/accounts/${accountId}\\?tab=access-projects&project=${projectId}`),
      );
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Grant access', exact: true });
      await expect(dialog).toBeVisible();

      // Multi-select principals in the shared picker (each row is a toggle
      // button named by the member's email), then narrow Agents to kortix.
      await dialog.getByRole('button', { name: memberAEmail }).click();
      await dialog.getByRole('button', { name: memberBEmail }).click();
      await dialog.getByRole('tab', { name: 'Only these…', exact: true }).click();
      await dialog.getByRole('checkbox', { name: 'kortix', exact: true }).click();

      const grantPostStatuses: number[] = [];
      page.on('response', (r) => {
        if (
          r.request().method() === 'POST' &&
          r.url().endsWith(`/v1/projects/${projectId}/resource-grants`)
        ) {
          grantPostStatuses.push(r.status());
        }
      });
      // 2 principals × 1 agent = 2 resource grants (plus one project-role
      // write per principal, which is not what this contract counts).
      await dialog.getByRole('button', { name: 'Grant access (2)', exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(() => grantPostStatuses.length, { timeout: 10_000 })
        .toBe(2);
      // POST /resource-grants returns 201 (created), not 200.
      expect(grantPostStatuses).toEqual([201, 201]);

      // The access list re-renders with both people, each row carrying the
      // narrowed agent count — the actual two rows, not just a total.
      const rowA = page.getByRole('listitem').filter({ hasText: memberAEmail });
      const rowB = page.getByRole('listitem').filter({ hasText: memberBEmail });
      await expect(rowA).toBeVisible();
      await expect(rowB).toBeVisible();
      await expect(rowA.getByText(/Agents: 1\b/)).toBeVisible();
      await expect(rowB.getByText(/Agents: 1\b/)).toBeVisible();

      // API is the source of truth for persistence, not the optimistic re-render.
      const after = await api<ResourceGrantsResponse>(
        session.access_token,
        'GET',
        `/projects/${projectId}/resource-grants`,
      );
      const kortixGrants = after.grants.filter(
        (g) => g.resource_type === 'agent' && g.resource_id === 'kortix',
      );
      expect(kortixGrants).toHaveLength(2);
      expect(kortixGrants.map((g) => g.principal_label).sort()).toEqual(
        [memberAEmail, memberBEmail].sort(),
      );
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      if (repository) await repository.dispose().catch(() => {});
      await deleteAuthUser(memberB.id, authOptions).catch(() => {});
      await deleteAuthUser(memberA.id, authOptions).catch(() => {});
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
    }
  });
});
