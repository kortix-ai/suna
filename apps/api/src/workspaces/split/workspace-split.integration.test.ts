/**
 * The workspace split against real PostgreSQL: dry-run, apply, resume after a
 * crash mid-move, reverse, the billing hold, and the invariants I1–I7 on a
 * seeded legacy multi-project account. Every value is synthetic.
 *
 * Runs against `TEST_DATABASE_URL` (its own migrated database per file); see
 * `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountGithubInstallations,
  accountGithubUserTokens,
  accountGroupMembers,
  accountGroups,
  accountInvitations,
  accountMemberships,
  accountSecretGrants,
  accountSecretResources,
  accounts,
  apps,
  appDeployments,
  appSiteBlobs,
  appSiteFiles,
  claudeSubscriptionLogins,
  creditPurchases,
  iamRoleActions,
  iamRoles,
  projectSessions,
  projects,
  roleAssignments,
  sessionProviderSecretPools,
  workspaceSplitRuns,
} from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { pendingPrincipalId } from '../../iam/actor';
import type { SiteStorage } from '../../apps/static-site';
import type { SplitCopiedIds } from '../../projects/surface';
import {
  applyWorkspaceSplitRun,
  confirmWorkspaceSplitKeeper,
  planWorkspaceSplits,
  processWorkspaceSplits,
  reopenWorkspaceSplitRun,
  resetWorkspaceSplitPlanClock,
  reverseWorkspaceSplitRun,
} from './split-runner';
import { checkWorkspaceInvariants } from './invariants';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const LEGACY = '00000000-0000-4000-a000-0000000e0001';
const PAYING = '00000000-0000-4000-a000-0000000e0002';
const KEEPER = '00000000-0000-4000-a000-0000000e0101';
const MOVED = '00000000-0000-4000-a000-0000000e0102';
const OLDEST = '00000000-0000-4000-a000-0000000e0103';
const PAYING_A = '00000000-0000-4000-a000-0000000e0104';
const PAYING_B = '00000000-0000-4000-a000-0000000e0105';
const OWNER = '00000000-0000-4000-a000-0000000e0201';
const ADMIN = '00000000-0000-4000-a000-0000000e0202';
const MEMBER = '00000000-0000-4000-a000-0000000e0203';
const GROUP_USER = '00000000-0000-4000-a000-0000000e0204';
const CUSTOM_USER = '00000000-0000-4000-a000-0000000e0205';
const GROUP = '00000000-0000-4000-a000-0000000e0301';
const CUSTOM_ROLE = '00000000-0000-4000-a000-0000000e0302';
const ACCOUNT_SECRET = '00000000-0000-4000-a000-0000000e0401';
const PROJECT_SECRET = '00000000-0000-4000-a000-0000000e0402';
const SESSION = 'split-test-session-moved';
const INVITEE = 'invitee@example.invalid';
const SHA = 'd'.repeat(64);

async function systemRole(key: string, scopeType: 'account' | 'project'): Promise<string> {
  const [role] = await db.select({ roleId: iamRoles.roleId }).from(iamRoles)
    .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, key), eq(iamRoles.scopeType, scopeType)));
  if (!role) throw new Error(`system role ${key}/${scopeType} missing`);
  return role.roleId;
}

function memoryStorage(): SiteStorage & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (key, body) => { objects.set(key, await body.text()); },
    open: async (key) => (objects.has(key) ? new Blob([objects.get(key)!]).stream() : null),
    remove: async (keys) => { for (const key of keys) objects.delete(key); },
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function seed(storage: ReturnType<typeof memoryStorage>): Promise<void> {
  await db.insert(accounts).values([
    { accountId: LEGACY, name: 'Synthetic legacy', mfaRequired: true },
    { accountId: PAYING, name: 'Synthetic paying' },
  ]);
  await db.insert(projects).values([
    { projectId: KEEPER, accountId: LEGACY, name: 'Keeper', repoUrl: 'https://example.invalid/k.git', splitPending: true, lastOpenedAt: minutesAgo(1) },
    { projectId: MOVED, accountId: LEGACY, name: 'Moved', repoUrl: 'https://example.invalid/m.git', splitPending: true, lastOpenedAt: minutesAgo(60) },
    { projectId: OLDEST, accountId: LEGACY, name: 'Oldest', repoUrl: 'https://example.invalid/o.git', splitPending: true },
    { projectId: PAYING_A, accountId: PAYING, name: 'Paying A', repoUrl: 'https://example.invalid/a.git', splitPending: true, lastOpenedAt: minutesAgo(5) },
    { projectId: PAYING_B, accountId: PAYING, name: 'Paying B', repoUrl: 'https://example.invalid/b.git', splitPending: true, lastOpenedAt: minutesAgo(50) },
  ]);
  await db.insert(creditPurchases).values({ accountId: PAYING, amountDollars: '10.00', status: 'completed' });
  await db.insert(accountMemberships).values([OWNER, ADMIN, MEMBER, GROUP_USER, CUSTOM_USER].map((userId) => ({ userId, accountId: LEGACY })));
  await db.insert(accountMemberships).values({ userId: OWNER, accountId: PAYING });
  await db.insert(accountGroups).values({ groupId: GROUP, accountId: LEGACY, name: 'Synthetic group' });
  await db.insert(accountGroupMembers).values({ groupId: GROUP, userId: GROUP_USER });
  await db.insert(iamRoles).values({ roleId: CUSTOM_ROLE, accountId: LEGACY, key: 'split_custom', name: 'Split custom', scopeType: 'project' });
  await db.insert(iamRoleActions).values({ roleId: CUSTOM_ROLE, action: 'project.read' });
  const [owner, admin, member, projectMember] = await Promise.all([
    systemRole('owner', 'account'), systemRole('admin', 'account'), systemRole('member', 'account'), systemRole('member', 'project'),
  ]);
  await db.insert(roleAssignments).values([
    { accountId: LEGACY, principalType: 'user', principalId: OWNER, roleId: owner, scopeType: 'account' },
    { accountId: LEGACY, principalType: 'user', principalId: ADMIN, roleId: admin, scopeType: 'account' },
    { accountId: LEGACY, principalType: 'user', principalId: MEMBER, roleId: member, scopeType: 'account' },
    { accountId: LEGACY, principalType: 'user', principalId: MEMBER, roleId: projectMember, scopeType: 'project', scopeId: MOVED },
    { accountId: LEGACY, principalType: 'group', principalId: GROUP, roleId: projectMember, scopeType: 'project', scopeId: MOVED },
    { accountId: LEGACY, principalType: 'user', principalId: CUSTOM_USER, roleId: CUSTOM_ROLE, scopeType: 'project', scopeId: MOVED },
    { accountId: LEGACY, principalType: 'pending', principalId: pendingPrincipalId(INVITEE), roleId: projectMember, scopeType: 'project', scopeId: MOVED },
    { accountId: PAYING, principalType: 'user', principalId: OWNER, roleId: owner, scopeType: 'account' },
  ]);
  await db.insert(accountInvitations).values({
    accountId: LEGACY, email: INVITEE, invitedBy: OWNER,
    bootstrapGrants: [{ project_id: MOVED, role: 'member' }, { project_id: KEEPER, role: 'member' }],
  });
  await db.insert(accountSecretResources).values([
    { secretId: ACCOUNT_SECRET, accountId: LEGACY, label: 'Account key', name: 'ACCOUNT_KEY', providerId: 'anthropic',
      valueEnc: encryptAccountSecret(LEGACY, 'synthetic-account-value'), consumer: 'llm_gateway', strategy: 'runtime', createdBy: MEMBER },
    { secretId: PROJECT_SECRET, accountId: LEGACY, projectId: MOVED, label: 'Project key', name: 'PROJECT_KEY',
      valueEnc: encryptAccountSecret(LEGACY, 'synthetic-project-value'), consumer: 'llm_gateway', strategy: 'runtime', createdBy: MEMBER },
  ]);
  await db.insert(accountSecretGrants).values([
    { secretId: ACCOUNT_SECRET, accountId: LEGACY, userId: MEMBER, grantedBy: OWNER },
    { secretId: PROJECT_SECRET, accountId: LEGACY, userId: MEMBER, grantedBy: OWNER },
  ]);
  await db.insert(projectSessions).values({ sessionId: SESSION, accountId: LEGACY, projectId: MOVED, branchName: 'main' });
  await db.insert(sessionProviderSecretPools).values({ sessionId: SESSION, providerId: 'anthropic', secretIds: [ACCOUNT_SECRET, PROJECT_SECRET] });
  await db.insert(accountGithubInstallations).values({ accountId: LEGACY, installationId: '9001', ownerLogin: 'synthetic-org' });
  await db.insert(accountGithubUserTokens).values({ accountId: LEGACY, userId: OWNER, githubLogin: 'synthetic-user', valueEnc: encryptAccountSecret(LEGACY, 'synthetic-gh-token') });
  await db.insert(claudeSubscriptionLogins).values({ accountId: LEGACY, userId: OWNER, valueEnc: encryptAccountSecret(LEGACY, 'synthetic-claude-token'), source: 'pasted' });
  const [app] = await db.insert(apps).values({ accountId: LEGACY, projectId: MOVED, slug: 'split-site', name: 'Split site', routeKey: 'split001' }).returning();
  const [deployment] = await db.insert(appDeployments).values({
    appId: app!.appId, version: 1, sourceKind: 'static', hostingType: 'static', runtimeVersion: 'synthetic', createdBy: OWNER,
  }).returning();
  await db.insert(appSiteBlobs).values({ accountId: LEGACY, sha256: SHA, sizeBytes: 4 });
  await db.insert(appSiteFiles).values({ deploymentId: deployment!.deploymentId, accountId: LEGACY, path: 'index.html', sha256: SHA, sizeBytes: 4, contentType: 'text/html' });
  storage.objects.set(`${LEGACY}/${SHA}`, 'site');
}

async function cleanup(): Promise<void> {
  const runs = await db.select({ to: workspaceSplitRuns.toAccountId }).from(workspaceSplitRuns);
  const targets = runs.map((run) => run.to).filter((id): id is string => Boolean(id));
  const all = [LEGACY, PAYING, ...targets];
  await db.delete(workspaceSplitRuns);
  await db.delete(appSiteBlobs).where(inArray(appSiteBlobs.accountId, all));
  await db.delete(creditPurchases).where(inArray(creditPurchases.accountId, all));
  await db.delete(accounts).where(inArray(accounts.accountId, all));
}

async function runFor(projectId: string) {
  const [run] = await db.select().from(workspaceSplitRuns).where(eq(workspaceSplitRuns.projectId, projectId))
    .orderBy(sql`${workspaceSplitRuns.createdAt} DESC`);
  return run;
}

async function accountOfProject(projectId: string) {
  const [row] = await db.select({ accountId: projects.accountId, splitPending: projects.splitPending }).from(projects).where(eq(projects.projectId, projectId));
  return row;
}

withDb('workspace split', () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(async () => {
    resetWorkspaceSplitPlanClock();
    await cleanup();
    storage = memoryStorage();
    await seed(storage);
  });
  afterEach(cleanup);

  test('dry-run plans every non-keeper project, holds the paying account, and moves nothing', async () => {
    const result = await processWorkspaceSplits({ mode: 'dry_run' });
    expect(result.planned).toBe(true);
    const runs = await db.select().from(workspaceSplitRuns).orderBy(workspaceSplitRuns.projectId);
    expect(runs.map((run) => [run.projectId, run.phase, run.mode])).toEqual([
      [MOVED, 'planned', 'dry_run'],
      [OLDEST, 'planned', 'dry_run'],
      [PAYING_B, 'held', 'dry_run'],
    ]);
    expect(runs[0]!.plan.keeper_project_id).toBe(KEEPER);
    expect(runs[2]!.plan.keeper_project_id).toBe(PAYING_A);
    expect((runs[0]!.plan.account as Record<string, number>).members).toBe(5);
    expect((runs[0]!.plan.project as Record<string, number>).invites_to_split).toBe(1);
    expect((await accountOfProject(MOVED))?.accountId).toBe(LEGACY);
    // A second pass updates the same rows instead of adding more.
    await processWorkspaceSplits({ mode: 'dry_run' });
    expect(await db.select().from(workspaceSplitRuns)).toHaveLength(3);
    // `off` touches nothing.
    expect((await processWorkspaceSplits({ mode: 'off' })).planned).toBe(false);
  });

  test('apply splits each non-keeper project into its own workspace with everything that reached it', async () => {
    const result = await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    expect(result.outcomes.done).toBe(2);
    const run = (await runFor(MOVED))!;
    expect(run.phase).toBe('done');
    const target = run.toAccountId!;
    const copied = run.copiedIds as unknown as SplitCopiedIds;

    // The workspace: its own account, named after the project, settings kept, 1:1.
    expect(await accountOfProject(MOVED)).toEqual({ accountId: target, splitPending: false });
    expect(await accountOfProject(KEEPER)).toEqual({ accountId: LEGACY, splitPending: false });
    expect((await accountOfProject(OLDEST))?.accountId).not.toBe(LEGACY);
    const [account] = await db.select().from(accounts).where(eq(accounts.accountId, target));
    expect(account?.name).toBe('Moved');
    expect(account?.mfaRequired).toBe(true);

    // Directory: every member, the group with its member, the custom role.
    const members = await db.select({ userId: accountMemberships.userId }).from(accountMemberships).where(eq(accountMemberships.accountId, target));
    expect(members.map((m) => m.userId).sort()).toEqual([OWNER, ADMIN, MEMBER, GROUP_USER, CUSTOM_USER].sort());
    const groupCopy = copied.groups[GROUP]!;
    expect(await db.select({ userId: accountGroupMembers.userId }).from(accountGroupMembers).where(eq(accountGroupMembers.groupId, groupCopy))).toEqual([{ userId: GROUP_USER }]);
    const roleCopy = copied.roles[CUSTOM_ROLE]!;
    expect(await db.select({ action: iamRoleActions.action }).from(iamRoleActions).where(eq(iamRoleActions.roleId, roleCopy))).toEqual([{ action: 'project.read' }]);
    const grants = await db.select().from(roleAssignments).where(eq(roleAssignments.accountId, target));
    const has = (type: string, id: string, scope: string, roleId?: string) =>
      grants.some((g) => g.principalType === type && g.principalId === id && g.scopeType === scope && (!roleId || g.roleId === roleId));
    expect(has('user', OWNER, 'account', await systemRole('owner', 'account'))).toBe(true);
    expect(has('user', ADMIN, 'account', await systemRole('admin', 'account'))).toBe(true);
    expect(has('user', MEMBER, 'project')).toBe(true);
    expect(has('group', groupCopy, 'project')).toBe(true);
    expect(has('user', CUSTOM_USER, 'project', roleCopy)).toBe(true);
    expect(has('pending', pendingPrincipalId(INVITEE), 'project')).toBe(true);
    // Nothing of the moved project's grants stays in the source.
    expect(await db.select().from(roleAssignments).where(and(eq(roleAssignments.accountId, LEGACY), eq(roleAssignments.scopeId, MOVED)))).toEqual([]);

    // The invite: the moved project's entry left the source invite for a new one.
    const invites = await db.select().from(accountInvitations).where(eq(accountInvitations.email, INVITEE)).orderBy(accountInvitations.createdAt);
    const byAccount = new Map(invites.map((i) => [i.accountId, i.bootstrapGrants]));
    expect(byAccount.get(LEGACY)).toEqual([{ project_id: KEEPER, role: 'member' }]);
    expect(byAccount.get(target)).toEqual([{ project_id: MOVED, role: 'member' }]);

    // Secrets: the account-wide one copied and re-sealed; the pool points at the copy.
    const secretCopy = copied.secrets[ACCOUNT_SECRET]!;
    const [copySecret] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secretCopy));
    expect(decryptAccountSecret(target, copySecret!.valueEnc)).toBe('synthetic-account-value');
    expect(await db.select({ userId: accountSecretGrants.userId }).from(accountSecretGrants).where(eq(accountSecretGrants.secretId, secretCopy))).toEqual([{ userId: MEMBER }]);
    const [original] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, ACCOUNT_SECRET));
    expect(original?.accountId).toBe(LEGACY);
    const [pool] = await db.select().from(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, SESSION));
    expect(pool?.secretIds).toEqual([secretCopy, PROJECT_SECRET]);
    // The project secret moved with its member grant (a plain transfer drops it).
    const [projectSecret] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, PROJECT_SECRET));
    expect(projectSecret?.accountId).toBe(target);
    expect(decryptAccountSecret(target, projectSecret!.valueEnc)).toBe('synthetic-project-value');
    expect(await db.select({ accountId: accountSecretGrants.accountId }).from(accountSecretGrants).where(eq(accountSecretGrants.secretId, PROJECT_SECRET))).toEqual([{ accountId: target }]);

    // Integrations, re-sealed for the target.
    expect(await db.select({ owner: accountGithubInstallations.ownerLogin }).from(accountGithubInstallations).where(eq(accountGithubInstallations.accountId, target))).toEqual([{ owner: 'synthetic-org' }]);
    const [token] = await db.select().from(accountGithubUserTokens).where(eq(accountGithubUserTokens.accountId, target));
    expect(decryptAccountSecret(target, token!.valueEnc)).toBe('synthetic-gh-token');
    const [login] = await db.select().from(claudeSubscriptionLogins).where(eq(claudeSubscriptionLogins.accountId, target));
    expect(decryptAccountSecret(target, login!.valueEnc)).toBe('synthetic-claude-token');

    // The static site: rows and object under the new account.
    expect(await db.select({ accountId: appSiteFiles.accountId }).from(appSiteFiles).where(eq(appSiteFiles.sha256, SHA))).toEqual([{ accountId: target }]);
    expect(storage.objects.get(`${target}/${SHA}`)).toBe('site');

    // The new wallet committed with the split: Free, not eligible, never granted.
    const [wallet] = await db.execute<{ tier: string; free_credits_eligible: boolean; grants: number }>(sql`
      SELECT c.tier, c.free_credits_eligible,
        (SELECT count(*)::int FROM kortix.credit_ledger l WHERE l.account_id = c.account_id AND l.type = 'free_tier_grant') AS grants
        FROM kortix.credit_accounts c WHERE c.account_id = ${target}`);
    expect(wallet).toEqual({ tier: 'free', free_credits_eligible: false, grants: 0 });

    // Money stays: the paying account is held, nothing of it moved.
    expect((await runFor(PAYING_B))?.phase).toBe('held');
    expect((await accountOfProject(PAYING_B))?.accountId).toBe(PAYING);

    const report = await checkWorkspaceInvariants();
    expect(Object.fromEntries(Object.entries(report).map(([id, r]) => [id, r.violations]))).toEqual({ I1: 0, I2: 0, I3: 0, I4: 0, I5: 0, I6: 0, I7: 0 });
  });

  test('a project secret that does not decrypt moves unchanged, marked for a reconnect; the split still lands', async () => {
    const corrupt = 'synthetic-not-an-envelope';
    await db.update(accountSecretResources).set({ valueEnc: corrupt }).where(eq(accountSecretResources.secretId, PROJECT_SECRET));
    const result = await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    expect(result.outcomes.done).toBe(2);
    const run = (await runFor(MOVED))!;
    expect(run.phase).toBe('done');
    const copied = run.copiedIds as unknown as SplitCopiedIds;
    expect(copied.undecryptableSecrets).toContain(PROJECT_SECRET);
    const [projectSecret] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, PROJECT_SECRET));
    expect(projectSecret?.accountId).toBe(run.toAccountId!);
    expect(projectSecret?.valueEnc).toBe(corrupt);
    expect(projectSecret?.needsReauthAt).not.toBeNull();
    const report = await checkWorkspaceInvariants();
    expect(report.I3.violations).toBe(0);
  });

  test('a crash mid-move leaves nothing moved, and the next pass resumes after the lease expires', async () => {
    await planWorkspaceSplits();
    const run = (await runFor(MOVED))!;
    // Fail the transaction after the account and memberships were written.
    await db.execute(sql`CREATE FUNCTION kortix.split_crash_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic crash mid-move'; END $$`);
    await db.execute(sql`CREATE TRIGGER split_crash_test BEFORE INSERT ON kortix.account_groups FOR EACH ROW EXECUTE FUNCTION kortix.split_crash_test()`);
    try {
      expect(await applyWorkspaceSplitRun(run.runId, { siteStorage: storage })).toBe('error');
    } finally {
      await db.execute(sql`DROP TRIGGER split_crash_test ON kortix.account_groups`);
      await db.execute(sql`DROP FUNCTION kortix.split_crash_test()`);
    }
    const failed = (await runFor(MOVED))!;
    expect(failed.phase).toBe('storage_copied');
    expect(failed.attempts).toBe(1);
    expect(failed.error).toContain('synthetic crash mid-move');
    expect((await accountOfProject(MOVED))?.accountId).toBe(LEGACY);
    expect(await db.select().from(accounts).where(eq(accounts.accountId, failed.toAccountId!))).toEqual([]);

    // A process that died holding the lease: a fresh heartbeat blocks, a stale one is reclaimed.
    await db.update(workspaceSplitRuns).set({ heartbeatAt: new Date() }).where(eq(workspaceSplitRuns.runId, run.runId));
    expect(await applyWorkspaceSplitRun(run.runId, { siteStorage: storage })).toBe('busy');
    await db.update(workspaceSplitRuns).set({ heartbeatAt: minutesAgo(60) }).where(eq(workspaceSplitRuns.runId, run.runId));
    expect(await applyWorkspaceSplitRun(run.runId, { siteStorage: storage })).toBe('done');
    const done = (await runFor(MOVED))!;
    // The blocked call claimed nothing: one failed attempt, one that finished.
    expect(done.attempts).toBe(2);
    expect(done.toAccountId).toBe(failed.toAccountId);
    expect((await accountOfProject(MOVED))?.accountId).toBe(failed.toAccountId!);
    expect((await checkWorkspaceInvariants({ runIds: [run.runId] })).I7.violations).toBe(0);
  });

  test('reverse returns the project with its grants, invite and pool, and deletes every copy', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    const run = (await runFor(MOVED))!;
    const target = run.toAccountId!;
    await reverseWorkspaceSplitRun(run.runId);

    expect(await accountOfProject(MOVED)).toEqual({ accountId: LEGACY, splitPending: true });
    expect(await accountOfProject(KEEPER)).toEqual({ accountId: LEGACY, splitPending: true });
    const grants = await db.select().from(roleAssignments).where(and(eq(roleAssignments.scopeType, 'project'), eq(roleAssignments.scopeId, MOVED)));
    expect(grants.every((g) => g.accountId === LEGACY)).toBe(true);
    expect(grants.some((g) => g.principalType === 'group' && g.principalId === GROUP)).toBe(true);
    expect(grants.some((g) => g.principalId === CUSTOM_USER && g.roleId === CUSTOM_ROLE)).toBe(true);
    const [invite] = await db.select().from(accountInvitations).where(and(eq(accountInvitations.accountId, LEGACY), eq(accountInvitations.email, INVITEE)));
    expect(invite?.bootstrapGrants).toEqual([{ project_id: KEEPER, role: 'member' }, { project_id: MOVED, role: 'member' }]);
    const [pool] = await db.select().from(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, SESSION));
    expect(pool?.secretIds).toEqual([ACCOUNT_SECRET, PROJECT_SECRET]);
    const [projectSecret] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, PROJECT_SECRET));
    expect(decryptAccountSecret(LEGACY, projectSecret!.valueEnc)).toBe('synthetic-project-value');

    // The split-off account is a dormant record: no member, grant, secret, group or invite.
    for (const table of ['account_memberships', 'role_assignments', 'account_secret_resources', 'account_groups', 'roles',
      'account_invitations', 'account_github_installations', 'account_github_user_tokens', 'claude_subscription_logins']) {
      const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM kortix.${sql.raw(table)} WHERE account_id = ${target}`);
      expect([table, row?.n]).toEqual([table, 0]);
    }
    // The source is a legacy account again: it gets its own name back.
    const [source] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, LEGACY));
    expect(source?.name).toBe('Synthetic legacy');
    expect((await runFor(MOVED))?.phase).toBe('reversed');
    // A reversed project is not planned again.
    resetWorkspaceSplitPlanClock();
    await planWorkspaceSplits();
    expect((await runFor(MOVED))?.phase).toBe('reversed');
    const report = await checkWorkspaceInvariants();
    expect([report.I1.violations, report.I4.violations, report.I6.violations]).toEqual([0, 0, 0]);
  });

  test('an operator reopens a reversed run and the project splits again into a fresh account', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    const first = (await runFor(MOVED))!;
    await reverseWorkspaceSplitRun(first.runId);
    // Only a reversed run reopens.
    await expect(reopenWorkspaceSplitRun((await runFor(OLDEST))!.runId)).rejects.toThrow(/not reversed/);

    await reopenWorkspaceSplitRun(first.runId);
    const reopened = (await runFor(MOVED))!;
    expect([reopened.runId, reopened.phase, reopened.toAccountId, reopened.attempts]).toEqual([first.runId, 'planned', null, 0]);
    expect(reopened.plan.reversed_to_account_ids).toEqual([first.toAccountId]);

    expect(await applyWorkspaceSplitRun(first.runId, { siteStorage: storage })).toBe('done');
    const again = (await runFor(MOVED))!;
    expect(again.toAccountId).not.toBe(first.toAccountId);
    expect((await accountOfProject(MOVED))).toEqual({ accountId: again.toAccountId!, splitPending: false });
    const [source] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, LEGACY));
    expect(source?.name).toBe('Keeper');
    const report = await checkWorkspaceInvariants();
    expect(Object.entries(report).filter(([, r]) => !r.ok).map(([id]) => id)).toEqual([]);
  });

  test('an owner confirming the keeper releases a held account', async () => {
    await planWorkspaceSplits();
    expect((await runFor(PAYING_B))?.phase).toBe('held');
    expect((await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } })).outcomes.done).toBe(2);
    expect((await accountOfProject(PAYING_B))?.accountId).toBe(PAYING);
    // The owner keeps billing on the older project instead.
    await confirmWorkspaceSplitKeeper(PAYING, PAYING_B);
    expect((await runFor(PAYING_B))?.phase).toBe('skipped');
    const released = (await runFor(PAYING_A))!;
    expect(released.phase).toBe('planned');
    expect(released.plan.keeper_project_id).toBe(PAYING_B);
    expect(await applyWorkspaceSplitRun(released.runId, { siteStorage: storage })).toBe('done');
    expect((await accountOfProject(PAYING_B))).toEqual({ accountId: PAYING, splitPending: false });
    expect((await accountOfProject(PAYING_A))?.accountId).not.toBe(PAYING);
    const report = await checkWorkspaceInvariants();
    expect(report.I5.violations).toBe(0);
  });

  test('the invariant checker reports a broken shape', async () => {
    // I6: a 1:1 workspace whose account name drifted from the project name.
    const LONE = '00000000-0000-4000-a000-0000000e0003';
    await db.insert(accounts).values({ accountId: LONE, name: 'Drifted name' });
    await db.insert(projects).values({ projectId: '00000000-0000-4000-a000-0000000e0106', accountId: LONE, name: 'Project name', repoUrl: 'https://example.invalid/l.git' });
    // I4: a grant whose holder is not a member.
    await db.insert(roleAssignments).values({ accountId: LONE, principalType: 'user', principalId: OWNER, roleId: await systemRole('member', 'account'), scopeType: 'account' });
    try {
      const report = await checkWorkspaceInvariants();
      expect(report.I6.sample).toContain(LONE);
      expect(report.I4.sample).toContain(`${LONE}:${OWNER}`);
      expect(report.I1.violations).toBe(0);
    } finally {
      await db.delete(accounts).where(eq(accounts.accountId, LONE));
    }
  });
});
