import { expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
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
 * The project comes from `createManifestProject`, so its `kortix.yaml` really
 * declares a "kortix" agent on both lanes: a local bare repo locally, a
 * starter-seeded managed-git project against a deployed API. The agent
 * checkboxes are read from that manifest, so a repo the API cannot fetch shows
 * an empty picker instead of failing loudly.
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

    let accountId: string | null = null;
    let projectId: string | null = null;
    let project: ManifestProject | null = null;

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

      // The agent checkboxes come from GET /projects/:id/resource-grants, which
      // reads `agents:` out of the project's kortix.yaml. A repo the API cannot
      // read yields an EMPTY picker rather than an error, so the project must
      // carry a manifest the deployed API can actually fetch.
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId,
        userId: owner.id,
        name: `Resource grant multiselect ${runId}`,
        databaseUrl: databaseUrl!,
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

      // Canonical RBAC: an agent grant is ONE role assignment — role
      // `agent-user` on object (agent, kortix) — written through
      // POST /accounts/:id/iam/assignments. The legacy POST /resource-grants
      // must NOT be called by the dialog any more (it dual-writes only for
      // pre-cutover clients); the legacy GET below still lists the grants
      // because the dual-read window keeps both stores consistent.
      const assignmentPosts: { status: number; objectType?: string; objectId?: string }[] = [];
      const legacyGrantPosts: number[] = [];
      page.on('response', (r) => {
        const url = r.url();
        const method = r.request().method();
        if (method === 'POST' && /\/v1\/accounts\/[^/]+\/iam\/assignments$/.test(url)) {
          let body: { object_type?: string; object_id?: string } = {};
          try { body = JSON.parse(r.request().postData() ?? '{}'); } catch {}
          assignmentPosts.push({ status: r.status(), objectType: body.object_type, objectId: body.object_id });
        }
        if (method === 'POST' && url.endsWith(`/v1/projects/${projectId}/resource-grants`)) {
          legacyGrantPosts.push(r.status());
        }
      });
      // 2 principals × 1 agent = 2 object assignments (plus one project-role
      // write per principal, which is not what this contract counts).
      await dialog.getByRole('button', { name: 'Grant access (2)', exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(
          () => assignmentPosts.filter((p) => p.objectType === 'agent' && p.objectId === 'kortix').length,
          { timeout: 10_000 },
        )
        .toBe(2);
      expect(
        assignmentPosts.filter((p) => p.objectType === 'agent').map((p) => p.status),
      ).toEqual([201, 201]);
      expect(legacyGrantPosts).toEqual([]);

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
      if (project) await project.dispose().catch(() => {});
      await deleteAuthUser(memberB.id, authOptions).catch(() => {});
      await deleteAuthUser(memberA.id, authOptions).catch(() => {});
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
    }
  });
});
