import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { setDatabaseEnterpriseDemo } from '../../src/fixtures/database-project';

import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject, fundAccount } from '../helpers/manifest-project';
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
      // The account hub is a MODAL over the project, not a route (2026-09-08):
      // `/accounts/**` is deleted, and the hub's state is `?accountId=` plus
      // its prefixed params on whatever page it opened over. So the redirect
      // lands back on this project with the hub open on Access > Projects,
      // scoped to it.
      await expect(page).toHaveURL(
        new RegExp(
          `/projects/${projectId}\\?accountId=${accountId}&accountTab=access-projects&accountProject=${projectId}`,
        ),
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

for (const selection of ['selected', 'all'] as const) {
  test(`group attachment grants ${selection} agents and retries an incomplete save`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const runId = `${selection}-${crypto.randomUUID()}`;
    const ownerEmail = `e2e-group-agents-${runId}@example.test`;
    const memberEmail = `e2e-group-member-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const member = await createAuthUser(memberEmail, authOptions);
    const session = await signIn(ownerEmail, authOptions);
    let project: ManifestProject | undefined;
    try {
      const accounts = await api<AccountSummary[]>(
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId = accounts.find(
        (item) => item.account_role === 'owner',
      )!.account_id;
      await api(
        session.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: memberEmail, role: 'member' },
        201,
      );
      await fundAccount(databaseUrl!, accountId);
      await setDatabaseEnterpriseDemo(loadEnv(), accountId, true);
      const group = await api<{ group_id: string }>(
        session.access_token,
        'POST',
        `/accounts/${accountId}/iam/groups`,
        { name: `SSO verification ${runId}` },
        201,
      );
      await api(
        session.access_token,
        'POST',
        `/accounts/${accountId}/iam/groups/${group.group_id}/members`,
        { userIds: [member.id] },
        [200, 201],
      );
      const projectName = `Group agent access ${runId}`;
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId,
        userId: owner.id,
        name: projectName,
        databaseUrl: databaseUrl!,
      });
      const projectId = project.id;
      await api(
        session.access_token,
        'PATCH',
        `/projects/${projectId}/experimental`,
        { feature: 'llm_gateway', enabled: true },
      );
      await api(
        session.access_token,
        'POST',
        `/projects/${projectId}/secrets`,
        {
          name: 'OPENAI_API_KEY',
          value: 'sk-e2e-unused-group-access',
          strategy: 'broker',
          consumer: 'llm_gateway',
        },
        [200, 201],
      );
      await api(
        session.access_token,
        'PUT',
        `/projects/${projectId}/model-defaults`,
        { scope: 'project', model: 'openai/gpt-4o-mini' },
      );
      let rejectInventory = true;
      await page.route(
        `**/v1/projects/${projectId}/resource-grants`,
        async (route) => {
          if (rejectInventory)
            await route.fulfill({
              status: 403,
              json: { error: 'Agent inventory is unavailable' },
            });
          else await route.continue();
        },
      );
      const path = `/projects/${projectId}?accountId=${accountId}&accountTab=groups&accountGroup=${group.group_id}`;
      await installBrowserSessionDirect(page, session, path, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(path);
      await dismissOnboarding(page);
      await page
        .getByRole('button', { name: 'Attach to project', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Grant access',
        exact: true,
      });
      await dialog
        .getByRole('combobox', { name: 'Project', exact: true })
        .click();
      await page
        .getByRole('option', { name: projectName, exact: true })
        .click();
      await expect(
        dialog.getByRole('tab', { name: 'All agents', exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText('Agent inventory is unavailable', { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Attach', exact: true }),
      ).toBeDisabled();
      rejectInventory = false;
      await dialog
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await expect(
        dialog.getByRole('button', { name: 'Attach', exact: true }),
      ).toBeEnabled();
      if (selection === 'selected') {
        await dialog
          .getByRole('tab', { name: 'Only these…', exact: true })
          .click();
        await dialog
          .getByRole('checkbox', { name: 'kortix', exact: true })
          .click();
      }
      const assignmentPath = `/accounts/${accountId}/iam/assignments`;
      let rejectAgentGrant = true;
      await page.route(`**/v1${assignmentPath}`, async (route) => {
        const body =
          route.request().method() === 'POST'
            ? route.request().postDataJSON()
            : {};
        if (
          route.request().method() === 'POST' &&
          body.object_type === 'agent' &&
          rejectAgentGrant
        ) {
          await route.fulfill({
            status: 503,
            json: { error: 'Temporary agent grant failure' },
          });
        } else {
          await route.continue();
        }
      });
      const failed = page.waitForResponse(
        (response) =>
          response.url().endsWith(assignmentPath) && response.status() === 503,
      );
      await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
      await failed;
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Attach', exact: true }),
      ).toBeEnabled();
      rejectAgentGrant = false;
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(assignmentPath) &&
          response.status() === 201 &&
          response.request().postDataJSON().object_id === 'kortix',
      );
      await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
      expect((await saved).request().postDataJSON()).toMatchObject({
        principal_type: 'group',
        principal_id: group.group_id,
        scope_id: projectId,
        object_type: 'agent',
        object_id: 'kortix',
      });
      await expect(dialog).toHaveCount(0);
      const after = await api<ResourceGrantsResponse>(
        session.access_token,
        'GET',
        `/projects/${projectId}/resource-grants`,
      );
      expect(
        after.grants.filter(
          (grant) =>
            grant.principal_id === group.group_id &&
            grant.resource_id === 'kortix',
        ),
      ).toHaveLength(1);
      const memberSession = await signIn(memberEmail, authOptions);
      await installBrowserSessionDirect(
        page,
        memberSession,
        `/projects/${projectId}`,
        authOptions,
      );
      await page.goto(`/projects/${projectId}`);
      await expect(
        page.getByRole('button', {
          name: 'No agents available to you — ask a manager for access',
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Select agent', exact: true }),
      ).toBeEnabled();
      await page
        .getByRole('textbox', { name: 'Message input' })
        .fill('Verify group access');
      await expect(
        page.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeEnabled();
    } finally {
      await project?.dispose();
      await deleteAuthUser(member.id, authOptions);
      await deleteAuthUser(owner.id, authOptions);
    }
  });
}

test('directory pages refresh external SCIM group and member changes without reloading', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const runId = crypto.randomUUID();
  const ownerEmail = `e2e-directory-owner-${runId}@example.test`;
  const memberEmail = `e2e-directory-member-${runId}@example.test`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  const member = await createAuthUser(memberEmail, authOptions);
  const session = await signIn(ownerEmail, authOptions);
  let project: ManifestProject | undefined;
  try {
    const accounts = await api<AccountSummary[]>(
      session.access_token,
      'GET',
      '/accounts',
    );
    const accountId = accounts.find((item) => item.account_role === 'owner')!.account_id;
    await fundAccount(databaseUrl!, accountId);
    await setDatabaseEnterpriseDemo(loadEnv(), accountId, true);
    project = await createManifestProject({
      api,
      accessToken: session.access_token,
      accountId,
      userId: owner.id,
      name: `Directory refresh ${runId}`,
      databaseUrl: databaseUrl!,
    });
    const { secret } = await api<{ secret: string }>(
      session.access_token,
      'POST',
      `/accounts/${accountId}/iam/scim/tokens`,
      { name: 'Directory refresh browser test' },
      201,
    );
    const scim = createApiJsonClient(
      `${new URL(apiBase).origin}/scim/v2/accounts/${accountId}`,
    );
    const user = await scim<{ id: string }>(
      secret,
      'POST',
      '/Users',
      { userName: memberEmail, active: true },
      201,
    );
    const path = `/projects/${project.id}?accountId=${accountId}&accountTab=groups`;
    await installBrowserSessionDirect(page, session, path, authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(path);
    await dismissOnboarding(page);
    await expect(
      page.getByRole('button', { name: 'Create a group', exact: true }),
    ).toBeVisible();
    const groupName = `SCIM live ${runId}`;
    const groupsRead = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/accounts/${accountId}/iam/groups`) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    const group = await scim<{ id: string }>(
      secret,
      'POST',
      '/Groups',
      { displayName: groupName, members: [{ value: user.id }] },
      201,
    );
    await expect(page.getByText(groupName, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect((await (await groupsRead).json()).groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_id: group.id, member_count: 1 }),
      ]),
    );
    await page.getByText(groupName, { exact: true }).click();
    await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();
    const groupReadPath = `/accounts/${accountId}/iam/groups/${group.id}/members`;
    const removedRead = page.waitForResponse(
      async (r) =>
        r.url().endsWith(groupReadPath) &&
        r.status() === 200 &&
        (await r.json()).members.length === 0,
    );
    await scim(secret, 'PATCH', `/Groups/${group.id}`, {
      Operations: [{ op: 'Remove', path: 'members', value: [{ value: user.id }] }],
    });
    await expect(page.getByText(memberEmail, { exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
    expect((await (await removedRead).json()).members).toEqual([]);
    const renamed = `${groupName} renamed`;
    await scim(secret, 'PATCH', `/Groups/${group.id}`, {
      Operations: [
        { op: 'Replace', path: 'displayName', value: renamed },
        { op: 'Add', path: 'members', value: [{ value: user.id }] },
      ],
    });
    await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(memberEmail, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('link', { name: /^Members \d+$/ }).click();
    await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();
    await scim(secret, 'PATCH', `/Users/${user.id}`, {
      Operations: [{ op: 'Replace', path: 'active', value: false }],
    });
    await expect(page.getByText(memberEmail, { exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
    await scim(secret, 'PATCH', `/Users/${user.id}`, {
      Operations: [{ op: 'Replace', path: 'active', value: true }],
    });
    await expect(page.getByText(memberEmail, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('link', { name: 'Groups', exact: true }).click();
    await expect(page.getByText(renamed, { exact: true })).toBeVisible();
    await scim(secret, 'DELETE', `/Groups/${group.id}`, undefined, 204);
    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
  } finally {
    if (project) await project.dispose().catch(() => {});
    await deleteAuthUser(member.id, authOptions).catch(() => {});
    await deleteAuthUser(owner.id, authOptions).catch(() => {});
  }
});
