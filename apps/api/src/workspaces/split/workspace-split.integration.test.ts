/**
 * The workspace split against real PostgreSQL: dry-run, apply, resume after a
 * crash mid-move, reverse, the billing hold and split-off billing, the reach
 * rule, rotating logins, the model defaults, the repair pass, the notice, the
 * owner email, and the invariants I1–I12 on a seeded legacy multi-project
 * account. Every value is synthetic.
 *
 * Runs against `TEST_DATABASE_URL` (its own migrated database per file); see
 * `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EmailMessage } from '../../lib/email/types';
import {
  accountGithubInstallations,
  accountGithubUserTokens,
  accountGroupMembers,
  accountGroups,
  accountInvitations,
  accountMemberships,
  accountModelPreferences,
  accountSecretGrants,
  accountSecretResources,
  accounts,
  apps,
  oauthAccessTokens,
  oauthClients,
  appDeployments,
  appSiteBlobs,
  appSiteFiles,
  claudeSubscriptionLogins,
  creditAccounts,
  creditPurchases,
  gatewayRequestLogs,
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
  repairWorkspaceSplitRun,
  resetWorkspaceSplitPlanClock,
  reverseWorkspaceSplitRun,
  workspaceSplitReport,
} from './split-runner';
import { checkWorkspaceInvariants } from './invariants';
import { workspaceSplitNotice } from './notice';
import { deliverSplitOwnerEmails, OWNER_EMAIL_MAX_ATTEMPTS, renderSplitOwnerEmail, type SendEmail } from './owner-email';
import { getAccountModelDefaults } from '../../repositories/model-preferences';
import { listCostByProject } from '../../shared/cost-rollups';
import { getSessionCostRecord } from '../../shared/session-costs';
import { resolveOpencodeLogin } from '../../llm-gateway/credentials/opencode-console';

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
// A member with the account member role only, and a grant on the account-wide secret.
const BARE_USER = '00000000-0000-4000-a000-0000000e0206';
// A member with the account member role and a grant on KEEPER only (the prod shape).
const KEEPER_USER = '00000000-0000-4000-a000-0000000e0207';
// A member of a group whose only grant is the account member role.
const MEMBER_GROUP_USER = '00000000-0000-4000-a000-0000000e0208';
const MEMBER_GROUP = '00000000-0000-4000-a000-0000000e0303';
const CODEX_LOGIN = '00000000-0000-4000-a000-0000000e0403';
const OPENCODE_LOGIN = '00000000-0000-4000-a000-0000000e0404';
const OPENCODE_KEY = '00000000-0000-4000-a000-0000000e0405';
const PROJECT_LOGIN = '00000000-0000-4000-a000-0000000e0406';
const KEEPER_SESSION = 'split-test-session-keeper';
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
  const people = [OWNER, ADMIN, MEMBER, GROUP_USER, CUSTOM_USER, BARE_USER, KEEPER_USER, MEMBER_GROUP_USER];
  await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES ${sql.join(
    people.map((id) => sql`(${id}::uuid, ${`split-${id.slice(-4)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`),
    sql`, `)} ON CONFLICT (id) DO NOTHING`);
  await db.insert(accountMemberships).values(people.map((userId) => ({ userId, accountId: LEGACY })));
  await db.insert(accountMemberships).values({ userId: OWNER, accountId: PAYING });
  await db.insert(accountGroups).values([
    { groupId: GROUP, accountId: LEGACY, name: 'Synthetic group' },
    { groupId: MEMBER_GROUP, accountId: LEGACY, name: 'Synthetic member group' },
  ]);
  await db.insert(accountGroupMembers).values([{ groupId: GROUP, userId: GROUP_USER }, { groupId: MEMBER_GROUP, userId: MEMBER_GROUP_USER }]);
  await db.insert(iamRoles).values({ roleId: CUSTOM_ROLE, accountId: LEGACY, key: 'split_custom', name: 'Split custom', scopeType: 'project' });
  await db.insert(iamRoleActions).values({ roleId: CUSTOM_ROLE, action: 'project.read' });
  const [owner, admin, member, projectMember] = await Promise.all([
    systemRole('owner', 'account'), systemRole('admin', 'account'), systemRole('member', 'account'), systemRole('member', 'project'),
  ]);
  await db.insert(roleAssignments).values([
    { accountId: LEGACY, principalType: 'user', principalId: OWNER, roleId: owner, scopeType: 'account' },
    { accountId: LEGACY, principalType: 'user', principalId: ADMIN, roleId: admin, scopeType: 'account' },
    // Every member holds the account member role (the real shape: 3,651 of 3,743 memberships).
    ...[MEMBER, GROUP_USER, CUSTOM_USER, BARE_USER, KEEPER_USER, MEMBER_GROUP_USER].map((principalId) => (
      { accountId: LEGACY, principalType: 'user' as const, principalId, roleId: member, scopeType: 'account' as const })),
    { accountId: LEGACY, principalType: 'user', principalId: MEMBER, roleId: projectMember, scopeType: 'project', scopeId: MOVED },
    { accountId: LEGACY, principalType: 'user', principalId: KEEPER_USER, roleId: projectMember, scopeType: 'project', scopeId: KEEPER },
    { accountId: LEGACY, principalType: 'group', principalId: MEMBER_GROUP, roleId: member, scopeType: 'account' },
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
    { secretId: ACCOUNT_SECRET, accountId: LEGACY, userId: BARE_USER, grantedBy: OWNER },
    { secretId: PROJECT_SECRET, accountId: LEGACY, userId: MEMBER, grantedBy: OWNER },
  ]);
  // Rotating logins and a static OpenCode key, account-wide. The moved
  // project's session used the ChatGPT login last; the keeper's session used
  // the OpenCode login last.
  const codex = (refresh: string) => JSON.stringify({ openai: { type: 'oauth', access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 } });
  const opencode = (refresh: string, expires = Date.now() + 10 * 86_400_000) => JSON.stringify({ type: 'oauth', access: `access-${refresh}`, refresh, expires });
  await db.insert(accountSecretResources).values([
    { secretId: CODEX_LOGIN, accountId: LEGACY, label: 'ChatGPT', name: 'CODEX_AUTH_JSON', providerId: 'codex',
      valueEnc: encryptAccountSecret(LEGACY, codex('codex-r1')), consumer: 'llm_gateway', strategy: 'broker', createdBy: MEMBER },
    { secretId: OPENCODE_LOGIN, accountId: LEGACY, label: 'OpenCode login', name: 'OPENCODE_API_KEY', providerId: 'opencode',
      valueEnc: encryptAccountSecret(LEGACY, opencode('oc-r1')), consumer: 'llm_gateway', strategy: 'runtime', createdBy: OWNER },
    { secretId: OPENCODE_KEY, accountId: LEGACY, label: 'OpenCode key', name: 'OPENCODE_GO_API_KEY', providerId: 'opencode-go',
      valueEnc: encryptAccountSecret(LEGACY, 'synthetic-static-key'), consumer: 'llm_gateway', strategy: 'runtime', createdBy: OWNER },
    // A project-scoped OpenCode login of MOVED: it moves with the project (re-sealed), never copied.
    { secretId: PROJECT_LOGIN, accountId: LEGACY, projectId: MOVED, label: 'Project OpenCode login', name: 'OPENCODE_API_KEY', providerId: 'opencode',
      valueEnc: encryptAccountSecret(LEGACY, opencode('project-r1')), consumer: 'llm_gateway', strategy: 'runtime', createdBy: MEMBER },
  ]);
  await db.insert(projectSessions).values([
    { sessionId: SESSION, accountId: LEGACY, projectId: MOVED, branchName: 'main', createdBy: MEMBER },
    { sessionId: KEEPER_SESSION, accountId: LEGACY, projectId: KEEPER, branchName: 'main', createdBy: OWNER },
  ]);
  await db.insert(sessionProviderSecretPools).values([
    { sessionId: SESSION, providerId: 'anthropic', secretIds: [ACCOUNT_SECRET, PROJECT_SECRET] },
    { sessionId: SESSION, providerId: 'codex', secretIds: [CODEX_LOGIN], updatedAt: minutesAgo(1) },
    { sessionId: SESSION, providerId: 'opencode', secretIds: [OPENCODE_LOGIN, OPENCODE_KEY], updatedAt: minutesAgo(30) },
    { sessionId: KEEPER_SESSION, providerId: 'opencode', secretIds: [OPENCODE_LOGIN], updatedAt: minutesAgo(2) },
  ]);
  // The account default model and the moved project's own default.
  await db.insert(accountModelPreferences).values([
    { accountId: LEGACY, scope: 'account', scopeKey: 'default', model: 'synthetic-account-model' },
    { accountId: LEGACY, scope: 'project', scopeKey: MOVED, model: 'synthetic-moved-model' },
  ]);
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
  // The App's implicit OAuth client and one viewer token it minted.
  const [client] = await db.insert(oauthClients).values({
    clientSecretHash: `h_${crypto.randomUUID()}`, name: 'Kortix App — Split site', accountId: LEGACY, appId: app!.appId,
  }).returning();
  await db.insert(oauthAccessTokens).values({
    tokenHash: `h_${crypto.randomUUID()}`, clientId: client!.clientId, userId: OWNER, accountId: LEGACY,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

async function cleanup(): Promise<void> {
  const runs = await db.select({ to: workspaceSplitRuns.toAccountId }).from(workspaceSplitRuns);
  const targets = runs.map((run) => run.to).filter((id): id is string => Boolean(id));
  const all = [LEGACY, PAYING, ...targets];
  await db.delete(workspaceSplitRuns);
  await db.execute(sql`DELETE FROM kortix.workspace_split_emails`);
  await db.delete(appSiteBlobs).where(inArray(appSiteBlobs.accountId, all));
  await db.delete(gatewayRequestLogs).where(inArray(gatewayRequestLogs.accountId, all));
  await db.delete(creditPurchases).where(inArray(creditPurchases.accountId, all));
  await db.execute(sql`DELETE FROM kortix.enterprise_contracts WHERE account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(all)}::jsonb))`);
  await db.execute(sql`DELETE FROM kortix.credit_ledger WHERE account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(all)}::jsonb))`);
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, all));
  await db.delete(accounts).where(inArray(accounts.accountId, all));
}

/** The test seam for the owner email: every message, nothing sent. */
function mailStub() {
  const sent: EmailMessage[] = [];
  return { sent, sendEmail: async (message: EmailMessage) => { sent.push(message); return { ok: true as const, provider: 'mailpit' as const, status: 200 }; } };
}

/** The owner email outbox rows, oldest first. */
async function outbox() {
  return [...(await db.execute<{ idempotency_key: string; state: string; attempts: number; last_error: string | null; due: boolean }>(sql`
    SELECT idempotency_key, state, attempts, last_error, next_attempt_at <= now() AS due
      FROM kortix.workspace_split_emails ORDER BY created_at, email_id`))];
}

/** LEGACY split to the end in apply mode, with the email transport `send`. */
async function splitLegacy(siteStorage: SiteStorage, send: SendEmail, mode: 'apply' | 'dry_run' = 'apply') {
  await planWorkspaceSplits({ accountIds: [LEGACY] });
  for (const projectId of [MOVED, OLDEST]) {
    expect(await applyWorkspaceSplitRun((await runFor(projectId))!.runId, { siteStorage, sendEmail: send, mode })).toBe('done');
  }
}

async function secretRow(secretId: string) {
  const [row] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secretId));
  return row!;
}

/** A row that works: active, not waiting for a reconnect, and a value. */
function live(row: typeof accountSecretResources.$inferSelect): boolean {
  return row.active && row.needsReauthAt === null && decryptAccountSecret(row.accountId, row.valueEnc) !== '';
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
    expect((runs[0]!.plan.account as Record<string, number>).members).toBe(8);
    // Aggregates only: the rotating logins one side keeps, and what each split-off gets.
    expect((runs[0]!.plan.account as Record<string, number>).rotating_logins).toBe(2);
    expect((runs[0]!.plan.account as Record<string, unknown>).split_off_billing).toMatchObject({ kind: 'free', comped_until: null });
    const report = await workspaceSplitReport();
    expect(report).toMatchObject({ accounts: 2, projects_to_move: 3, projects_held: 1, accounts_held: 1, rotating_logins: 2, split_offs_comped: 0 });
    expect(report.free_grant_credits_total).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(LEGACY);
    expect((runs[0]!.plan.project as Record<string, number>).invites_to_split).toBe(1);
    expect((await accountOfProject(MOVED))?.accountId).toBe(LEGACY);
    // A second pass updates the same rows instead of adding more.
    await processWorkspaceSplits({ mode: 'dry_run' });
    expect(await db.select().from(workspaceSplitRuns)).toHaveLength(3);
    // `off` touches nothing.
    expect((await processWorkspaceSplits({ mode: 'off' })).planned).toBe(false);
    // A dry run moves nothing, bills nothing, mails nobody.
    expect(await db.select().from(creditAccounts).where(inArray(creditAccounts.accountId, runs.map((run) => run.toAccountId).filter((id): id is string => Boolean(id))))).toEqual([]);
    expect(runs.every((run) => run.toAccountId === null)).toBe(true);
  });

  test('the keeper is the most active project: most sessions created in the last 30 days, then most recently opened', async () => {
    // OLDEST was never opened but holds the most recent sessions; MOVED's
    // extra sessions are older than 30 days and do not count.
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.insert(projectSessions).values([
      { sessionId: 'split-test-active-1', accountId: LEGACY, projectId: OLDEST, branchName: 'active-1', createdBy: OWNER, createdAt: daysAgo(2) },
      { sessionId: 'split-test-active-2', accountId: LEGACY, projectId: OLDEST, branchName: 'active-2', createdBy: OWNER, createdAt: daysAgo(29) },
      ...[31, 45, 60].map((days) => (
        { sessionId: `split-test-stale-${days}`, accountId: LEGACY, projectId: MOVED, branchName: `stale-${days}`, createdBy: OWNER, createdAt: daysAgo(days) })),
    ]);
    await planWorkspaceSplits();
    expect((await runFor(KEEPER))?.plan.keeper_project_id).toBe(OLDEST);
    expect((await runFor(MOVED))?.plan.keeper_project_id).toBe(OLDEST);
    expect((await runFor(KEEPER))?.plan.recent_sessions).toBe(1);
    expect(await runFor(OLDEST)).toBeUndefined();
    // A tie on recent sessions falls to the most recently opened: PAYING_A
    // (opened 5 min ago) over PAYING_B (50 min ago), both with none.
    expect((await runFor(PAYING_B))?.plan.keeper_project_id).toBe(PAYING_A);
    // A confirmed keeper stays, however the activity changes.
    await confirmWorkspaceSplitKeeper(LEGACY, KEEPER);
    await db.insert(projectSessions).values(
      { sessionId: 'split-test-active-3', accountId: LEGACY, projectId: OLDEST, branchName: 'active-3', createdBy: OWNER, createdAt: daysAgo(1) });
    await planWorkspaceSplits();
    expect((await runFor(OLDEST))?.plan.keeper_project_id).toBe(KEEPER);
    expect((await runFor(MOVED))?.plan.keeper_project_id).toBe(KEEPER);
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

    // Directory (design.md §3.1 row 6): a membership for everyone who reaches
    // the project (a grant on it, through a group, a custom role, owners and
    // admins). An account member grant alone reaches nothing: BARE_USER,
    // KEEPER_USER (a grant on the keeper only) and the member of a group with
    // only the account member role stay behind.
    const members = await db.select({ userId: accountMemberships.userId }).from(accountMemberships).where(eq(accountMemberships.accountId, target));
    expect(members.map((m) => m.userId).sort()).toEqual([OWNER, ADMIN, MEMBER, GROUP_USER, CUSTOM_USER].sort());
    // OLDEST has no grant of anyone but owners and admins.
    const oldest = (await runFor(OLDEST))!;
    const oldestMembers = await db.select({ userId: accountMemberships.userId }).from(accountMemberships).where(eq(accountMemberships.accountId, oldest.toAccountId!));
    expect(oldestMembers.map((m) => m.userId).sort()).toEqual([OWNER, ADMIN].sort());
    // The group reaches only MOVED: OLDEST gets no copy of it; the member-only group is copied nowhere.
    expect(Object.keys((oldest.copiedIds as unknown as SplitCopiedIds).groups)).toEqual([]);
    expect(Object.keys(copied.groups)).toEqual([GROUP]);
    // Every account-scope grant in the target belongs to someone who came along.
    const accountGrantHolders = (await db.select({ id: roleAssignments.principalId, type: roleAssignments.principalType }).from(roleAssignments)
      .where(and(eq(roleAssignments.accountId, target), eq(roleAssignments.scopeType, 'account')))).filter((g) => g.type === 'user').map((g) => g.id);
    expect([...new Set(accountGrantHolders)].sort()).toEqual([OWNER, ADMIN, MEMBER, GROUP_USER, CUSTOM_USER].sort());
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
    expect(decryptAccountSecret(LEGACY, (await secretRow(ACCOUNT_SECRET)).valueEnc)).toBe('synthetic-account-value');
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
    // The App's implicit OAuth client and its tokens follow the App.
    const [appClient] = await db.select({ accountId: oauthClients.accountId, clientId: oauthClients.clientId }).from(oauthClients)
      .where(eq(oauthClients.name, 'Kortix App — Split site'));
    expect(appClient?.accountId).toBe(target);
    expect((await db.select({ accountId: oauthAccessTokens.accountId }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, appClient!.clientId))))
      .toEqual([{ accountId: target }]);

    // Billing (C6): a split-off of a free account goes on Free, keeps the
    // free-credit eligibility as a one-time exception, and gets one grant.
    const [wallet] = await db.execute<{ tier: string; free_credits_eligible: boolean; grants: number; comp: string | null }>(sql`
      SELECT c.tier, c.free_credits_eligible, c.comp_plan_until::text AS comp,
        (SELECT count(*)::int FROM kortix.credit_ledger l WHERE l.account_id = c.account_id AND l.stripe_event_id = ${`split_off_grant:${run.runId}:${target}`}) AS grants
        FROM kortix.credit_accounts c WHERE c.account_id = ${target}`);
    expect(wallet).toEqual({ tier: 'free', free_credits_eligible: true, grants: 1, comp: null });
    expect(run.plan.billing).toMatchObject({ kind: 'free' });

    // Money stays: the paying account is held, nothing of it moved.
    expect((await runFor(PAYING_B))?.phase).toBe('held');
    expect((await accountOfProject(PAYING_B))?.accountId).toBe(PAYING);

    const report = await checkWorkspaceInvariants();
    expect(Object.fromEntries(Object.entries(report).map(([id, r]) => [id, r.violations]))).toEqual({ I1: 0, I2: 0, I3: 0, I4: 0, I5: 0, I6: 0, I7: 0, I8: 0, I9: 0, I10: 0, I11: 0, I12: 0 });
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
    // The reversed move's billing record names the dormant account: the reopen
    // drops it, so the billing retry and the owner-email gate wait for the new one.
    expect(first.plan.billing).toBeDefined();
    expect(reopened.plan.billing).toBeUndefined();
    expect(reopened.plan.billing_attempts).toBeUndefined();
    // The worker plans before it applies: a plan pass keeps the reopen record.
    resetWorkspaceSplitPlanClock();
    await planWorkspaceSplits({ accountIds: [LEGACY] });
    expect((await runFor(MOVED))!.plan.reversed_to_account_ids).toEqual([first.toAccountId]);

    expect(await applyWorkspaceSplitRun(first.runId, { siteStorage: storage })).toBe('done');
    const again = (await runFor(MOVED))!;
    expect(again.toAccountId).not.toBe(first.toAccountId);
    // The fresh split-off gets its own grant: the dormant account's grant is not a replay of it.
    const [wallet] = await db.execute<{ balance: string; grants: number }>(sql`
      SELECT c.balance_precise::text AS balance,
        (SELECT count(*)::int FROM kortix.credit_ledger l WHERE l.account_id = c.account_id AND l.stripe_event_id LIKE 'split\_off\_%') AS grants
        FROM kortix.credit_accounts c WHERE c.account_id = ${again.toAccountId}`);
    expect(wallet?.grants).toBe(1);
    expect(Number(wallet?.balance)).toBeGreaterThan(0);
    expect((await accountOfProject(MOVED))).toEqual({ accountId: again.toAccountId!, splitPending: false });
    const [source] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, LEGACY));
    expect(source?.name).toBe('Keeper');
    const report = await checkWorkspaceInvariants();
    expect(Object.entries(report).filter(([, r]) => !r.ok).map(([id]) => id)).toEqual([]);
  });

  test('an account that pays outside Stripe (RevenueCat, a paid plan set by hand) is held too', async () => {
    // LEGACY has no Stripe purchase; each paid source alone must hold it.
    const sources = [
      { tier: 'credits', provider: 'revenuecat', revenuecatSubscriptionId: 'synthetic-rc-sub', revenuecatCustomerId: 'synthetic-rc-customer' },
      { tier: 'credits', provider: 'manual' },
    ];
    for (const source of sources) {
      await db.delete(workspaceSplitRuns);
      await db.delete(creditAccounts).where(eq(creditAccounts.accountId, LEGACY));
      await db.insert(creditAccounts).values({ accountId: LEGACY, ...source });
      await planWorkspaceSplits({ accountIds: [LEGACY] });
      expect([source.provider, (await runFor(MOVED))?.phase]).toEqual([source.provider, 'held']);
      expect((await runFor(MOVED))?.plan.held_reason).toBe('account_has_billing');
    }
    // A free account with a credit row is not held, and neither is one that
    // only carries a stale Stripe subscription id on Free (C6: it pays nothing).
    for (const free of [{ tier: 'free' }, { tier: 'free', stripeSubscriptionId: 'sub_synthetic_stale', stripeSubscriptionStatus: 'canceled' }]) {
      await db.delete(workspaceSplitRuns);
      await db.delete(creditAccounts).where(eq(creditAccounts.accountId, LEGACY));
      await db.insert(creditAccounts).values({ accountId: LEGACY, ...free });
      await planWorkspaceSplits({ accountIds: [LEGACY] });
      expect([free, (await runFor(MOVED))?.phase]).toEqual([free, 'planned']);
    }
  });

  test('a Free account that only bought credits, or holds an enterprise contract, is held until an owner confirms; its split-offs get Free, never a comp (D3)', async () => {
    const sources: { name: string; setup: () => Promise<void> }[] = [
      { name: 'top-up only', setup: async () => {
        await db.insert(creditAccounts).values({ accountId: LEGACY, tier: 'free', lifetimePurchased: '25', balance: '25' });
      } },
      { name: 'enterprise contract on Free', setup: async () => {
        await db.insert(creditAccounts).values({ accountId: LEGACY, tier: 'free' });
        await db.execute(sql`INSERT INTO kortix.enterprise_contracts (account_id, status, license_usd, credits_usd, collection)
          VALUES (${LEGACY}, 'active', 1000, 500, 'manual')`);
      } },
    ];
    for (const source of sources) {
      await db.delete(workspaceSplitRuns);
      await db.execute(sql`DELETE FROM kortix.enterprise_contracts WHERE account_id = ${LEGACY}`);
      await db.delete(creditAccounts).where(eq(creditAccounts.accountId, LEGACY));
      await source.setup();
      // No auto split: the whole account waits for its owner.
      await planWorkspaceSplits({ accountIds: [LEGACY] });
      expect([source.name, (await runFor(MOVED))?.phase, (await runFor(OLDEST))?.phase]).toEqual([source.name, 'held', 'held']);
      expect((await runFor(MOVED))?.plan.held_reason).toBe('account_has_billing');
      const tick = await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mailStub().sendEmail } });
      expect([source.name, (await accountOfProject(MOVED))?.accountId]).toEqual([source.name, LEGACY]);
      expect(tick.outcomes.done).toBe(0);
      // The dry-run report counts what each split-off gets: Free.
      expect((await runFor(MOVED))?.plan.account).toMatchObject({ split_off_billing: { kind: 'free', comped_until: null } });
    }
    // The owner confirms: the account splits, the keeper keeps the purchased
    // credits and the contract, and each split-off gets Free with its free credits.
    await confirmWorkspaceSplitKeeper(LEGACY, KEEPER);
    expect((await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mailStub().sendEmail } })).outcomes.done).toBe(2);
    for (const projectId of [MOVED, OLDEST]) {
      const run = (await runFor(projectId))!;
      expect([run.phase, (run.plan.billing as { kind: string }).kind]).toEqual(['done', 'free']);
      const [wallet] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, run.toAccountId!));
      expect([wallet?.tier, wallet?.compPlanUntil ?? null, wallet?.freeCreditsEligible]).toEqual(['free', null, true]);
    }
    await db.execute(sql`DELETE FROM kortix.enterprise_contracts WHERE account_id = ${LEGACY}`);
  });

  test('an account with an identity provider (SSO or a SCIM token) is held, keeper confirmed or not', async () => {
    // The split-off would copy the members but not the IdP: SSO enforcement
    // and SCIM deprovisioning would stop at the keeper (design.md §3.1).
    const idps = [
      sql`INSERT INTO kortix.account_sso_providers (account_id, supabase_sso_provider_id, name, primary_domain)
            VALUES (${LEGACY}, ${crypto.randomUUID()}, 'Synthetic IdP', 'example.test')`,
      sql`INSERT INTO kortix.scim_tokens (account_id, name, secret_hash, public_prefix)
            VALUES (${LEGACY}, 'synthetic scim', ${`h_${crypto.randomUUID()}`}, 'kortix_scim_syn')`,
    ];
    for (const insert of idps) {
      await db.delete(workspaceSplitRuns);
      await db.execute(sql`DELETE FROM kortix.account_sso_providers WHERE account_id = ${LEGACY}`);
      await db.execute(sql`DELETE FROM kortix.scim_tokens WHERE account_id = ${LEGACY}`);
      await db.execute(insert);
      await planWorkspaceSplits({ accountIds: [LEGACY] });
      expect((await runFor(MOVED))?.phase).toBe('held');
      expect((await runFor(MOVED))?.plan.held_reason).toBe('account_has_identity_provider');
      expect(await applyWorkspaceSplitRun((await runFor(MOVED))!.runId, { siteStorage: storage })).toBe('busy');
      expect((await accountOfProject(MOVED))?.accountId).toBe(LEGACY);
    }
    await db.execute(sql`DELETE FROM kortix.account_sso_providers WHERE account_id = ${LEGACY}`);
    await db.execute(sql`DELETE FROM kortix.scim_tokens WHERE account_id = ${LEGACY}`);
  });

  test('apply re-checks the hold: an account that starts paying or adds an IdP after the plan pass is held, nothing moves', async () => {
    await planWorkspaceSplits({ accountIds: [LEGACY] });
    const planned = (await runFor(MOVED))!;
    expect(planned.phase).toBe('planned');
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, LEGACY));
    await db.insert(creditAccounts).values({ accountId: LEGACY, tier: 'credits', planMonthlyUsd: '20' });
    expect(await applyWorkspaceSplitRun(planned.runId, { siteStorage: storage })).toBe('skipped');
    expect((await runFor(MOVED))?.phase).toBe('held');
    expect((await runFor(MOVED))?.plan.held_reason).toBe('account_has_billing');
    expect((await accountOfProject(MOVED))?.accountId).toBe(LEGACY);
  });

  test('an owner confirming the keeper releases a held account', async () => {
    await planWorkspaceSplits();
    expect((await runFor(PAYING_B))?.phase).toBe('held');
    expect((await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } })).outcomes.done).toBe(2);
    expect((await accountOfProject(PAYING_B))?.accountId).toBe(PAYING);
    // The owner keeps billing on the older project instead.
    await db.insert(creditAccounts).values({ accountId: PAYING, tier: 'credits', planMonthlyUsd: '300', billingCycleAnchor: new Date().toISOString() });
    await confirmWorkspaceSplitKeeper(PAYING, PAYING_B);
    expect((await runFor(PAYING_B))?.phase).toBe('skipped');
    const released = (await runFor(PAYING_A))!;
    expect(released.phase).toBe('planned');
    expect(released.plan.keeper_project_id).toBe(PAYING_B);
    expect(await applyWorkspaceSplitRun(released.runId, { siteStorage: storage })).toBe('done');
    expect((await accountOfProject(PAYING_B))).toEqual({ accountId: PAYING, splitPending: false });
    expect((await accountOfProject(PAYING_A))?.accountId).not.toBe(PAYING);
    // A split-off of a paying account gets the keeper's plan comped until the
    // keeper's period ends (at most 31 days), with no Stripe subscription.
    const done = (await runFor(PAYING_A))!;
    expect(done.plan.billing).toMatchObject({ kind: 'comped', tier: 'credits' });
    const [comped] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, done.toAccountId!));
    expect([comped?.tier, comped?.stripeSubscriptionId ?? null, comped?.compPlanUntil !== null]).toEqual(['credits', null, true]);
    const notice = await workspaceSplitNotice(done.toAccountId!);
    expect(notice).toMatchObject({ role: 'moved', source_name: 'Synthetic paying', billing: 'comped' });
    expect(notice?.comped_until).toBe((done.plan.billing as { compedUntil: string }).compedUntil);
    const report = await checkWorkspaceInvariants();
    expect(report.I5.violations).toBe(0);
  });

  test('I8 reports a member the split added who no longer reaches the moved workspace; an account member grant alone does not count', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    const target = (await runFor(MOVED))!.toAccountId!;
    expect((await checkWorkspaceInvariants()).I8.violations).toBe(0);
    // MEMBER keeps the account member grant; only the project grant goes.
    await db.delete(roleAssignments).where(and(eq(roleAssignments.accountId, target), eq(roleAssignments.principalId, MEMBER), eq(roleAssignments.scopeType, 'project')));
    await db.delete(accountSecretGrants).where(and(eq(accountSecretGrants.accountId, target), eq(accountSecretGrants.userId, MEMBER)));
    expect((await checkWorkspaceInvariants()).I8.sample).toEqual([`${target}:${MEMBER}`]);
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

  test('a rotating login is never duplicated: the side that used it last keeps it, the other side reconnects; a static key is copied', async () => {
    expect(await applyWorkspaceSplitRun((await planWorkspaceSplits(), (await runFor(MOVED))!).runId, { siteStorage: storage })).toBe('done');
    const run = (await runFor(MOVED))!;
    const target = run.toAccountId!;
    const copied = run.copiedIds as unknown as SplitCopiedIds;

    // ChatGPT: the moved project's session used it last: the copy is live, the source row reconnects.
    const codexCopy = await secretRow(copied.secrets[CODEX_LOGIN]!);
    const codexSource = await secretRow(CODEX_LOGIN);
    expect([live(codexCopy), live(codexSource)]).toEqual([true, false]);
    expect(JSON.parse(decryptAccountSecret(target, codexCopy.valueEnc)).openai.refresh).toBe('codex-r1');
    expect([codexSource.active, codexSource.needsReauthAt !== null, decryptAccountSecret(LEGACY, codexSource.valueEnc)]).toEqual([false, true, '']);
    // OpenCode login: the keeper's session used it last: the source stays live, the copy reconnects.
    const opencodeCopy = await secretRow(copied.secrets[OPENCODE_LOGIN]!);
    expect([live(await secretRow(OPENCODE_LOGIN)), live(opencodeCopy)]).toEqual([true, false]);
    expect([opencodeCopy.active, opencodeCopy.needsReauthAt !== null, opencodeCopy.label]).toEqual([false, true, 'OpenCode login']);
    // A static OpenCode API key works on both sides.
    expect([live(await secretRow(OPENCODE_KEY)), live(await secretRow(copied.secrets[OPENCODE_KEY]!))]).toEqual([true, true]);
    expect(decryptAccountSecret(target, (await secretRow(copied.secrets[OPENCODE_KEY]!)).valueEnc)).toBe('synthetic-static-key');
    // Exactly one live row per login across the two accounts.
    for (const login of [CODEX_LOGIN, OPENCODE_LOGIN]) {
      const rows = [await secretRow(login), await secretRow(copied.secrets[login]!)];
      expect([login, rows.filter(live).length]).toEqual([login, 1]);
    }
    expect(copied.rotatingLogins?.map((l) => [l.sourceSecretId, l.live]).sort()).toEqual([[CODEX_LOGIN, 'target'], [OPENCODE_LOGIN, 'source']].sort());
    // The moved session's pools name the copies; the keeper's pool still names its source row.
    const pools = await db.select().from(sessionProviderSecretPools).where(inArray(sessionProviderSecretPools.sessionId, [SESSION, KEEPER_SESSION]));
    const pool = (session: string, provider: string) => pools.find((p) => p.sessionId === session && p.providerId === provider)?.secretIds;
    expect(pool(SESSION, 'codex')).toEqual([copied.secrets[CODEX_LOGIN]]);
    expect(pool(SESSION, 'opencode')).toEqual([copied.secrets[OPENCODE_LOGIN], copied.secrets[OPENCODE_KEY]]);
    expect(pool(KEEPER_SESSION, 'opencode')).toEqual([OPENCODE_LOGIN]);
    // The next move of the account copies the placeholder as a placeholder.
    expect(await applyWorkspaceSplitRun((await runFor(OLDEST))!.runId, { siteStorage: storage })).toBe('done');
    const oldest = (await runFor(OLDEST))!.copiedIds as unknown as SplitCopiedIds;
    expect(live(await secretRow(oldest.secrets[CODEX_LOGIN]!))).toBe(false);
    expect(live(await secretRow(oldest.secrets[OPENCODE_LOGIN]!))).toBe(false);
    expect(live(await secretRow(oldest.secrets[OPENCODE_KEY]!))).toBe(true);
    expect((await checkWorkspaceInvariants()).I3.violations).toBe(0);
  });

  test('reverse gives a rotating login back to the source with the value it rotated to meanwhile', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mailStub().sendEmail } });
    const run = (await runFor(MOVED))!;
    const target = run.toAccountId!;
    const copyId = (run.copiedIds as unknown as SplitCopiedIds).secrets[CODEX_LOGIN]!;
    // The split-off refreshed the login after the split.
    const rotated = JSON.stringify({ openai: { type: 'oauth', access: 'access-codex-r2', refresh: 'codex-r2', expires: Date.now() + 3_600_000 } });
    await db.update(accountSecretResources).set({ valueEnc: encryptAccountSecret(target, rotated) }).where(eq(accountSecretResources.secretId, copyId));
    await reverseWorkspaceSplitRun(run.runId);
    const source = await secretRow(CODEX_LOGIN);
    expect(live(source)).toBe(true);
    expect(JSON.parse(decryptAccountSecret(LEGACY, source.valueEnc)).openai.refresh).toBe('codex-r2');
    expect(await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, copyId))).toEqual([]);
    // The reverse took back the split-off billing: no comp, no eligibility, no credits.
    const [wallet] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, target));
    expect([wallet?.freeCreditsEligible, Number(wallet?.balance ?? 0)]).toEqual([false, 0]);
  });

  test('a refresh that finishes after the move lands on the moved row, sealed for its new account', async () => {
    await planWorkspaceSplits();
    const runId = (await runFor(MOVED))!.runId;
    // A refresh started before the move read the row under the source account.
    const stale = { storage: 'account_resource' as const, accountId: LEGACY, projectId: MOVED, secretId: PROJECT_LOGIN, actorUserId: MEMBER,
      sessionId: SESSION, value: JSON.stringify({ type: 'oauth', access: 'access-project-r1', refresh: 'project-r1', expires: Date.now() + 3_600_000 }) };
    expect(await applyWorkspaceSplitRun(runId, { siteStorage: storage })).toBe('done');
    const target = (await runFor(MOVED))!.toAccountId!;
    const login = await resolveOpencodeLogin(stale, async () => new Response(JSON.stringify({ access_token: 'access-project-r2', refresh_token: 'project-r2', expires_in: 2_592_000 })));
    expect(login?.refresh).toBe('project-r2');
    const row = await secretRow(PROJECT_LOGIN);
    expect(row.accountId).toBe(target);
    expect(JSON.parse(decryptAccountSecret(target, row.valueEnc)).refresh).toBe('project-r2');
    // A second refresh with the consumed token writes nothing over the newer login.
    await resolveOpencodeLogin(stale, async () => new Response(JSON.stringify({ access_token: 'access-project-r3', refresh_token: 'project-r3', expires_in: 2_592_000 })));
    expect(JSON.parse(decryptAccountSecret(target, (await secretRow(PROJECT_LOGIN)).valueEnc)).refresh).toBe('project-r2');
  });

  test('the moved workspace keeps its default model and the account default; a reverse takes both back', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mailStub().sendEmail } });
    const run = (await runFor(MOVED))!;
    const target = run.toAccountId!;
    expect(await getAccountModelDefaults(target, MOVED)).toMatchObject({ account: 'synthetic-account-model', projects: { [MOVED]: 'synthetic-moved-model' } });
    // The source keeps its account default and no longer holds the moved project's row.
    const source = await getAccountModelDefaults(LEGACY, KEEPER);
    expect(source.account).toBe('synthetic-account-model');
    expect(MOVED in source.projects).toBe(false);
    // OLDEST had no project default: it inherits the account default only.
    expect((await getAccountModelDefaults((await runFor(OLDEST))!.toAccountId!, OLDEST)).account).toBe('synthetic-account-model');
    expect((await checkWorkspaceInvariants({ runIds: [run.runId] })).I2.violations).toBe(0);
    await reverseWorkspaceSplitRun(run.runId);
    expect((await getAccountModelDefaults(LEGACY, MOVED)).projects[MOVED]).toBe('synthetic-moved-model');
    expect(await db.select().from(accountModelPreferences).where(eq(accountModelPreferences.accountId, target))).toEqual([]);
  });

  test('the repair pass moves a row a request wrote with the old account during the move, then I2 is clean', async () => {
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mailStub().sendEmail } });
    const run = (await runFor(MOVED))!;
    const target = run.toAccountId!;
    // A session create that read the project before the move commits after it.
    await db.insert(projectSessions).values({ sessionId: 'split-test-session-late', accountId: LEGACY, projectId: MOVED, branchName: 'late' });
    expect((await checkWorkspaceInvariants({ runIds: [run.runId] })).I2.sample).toEqual(['project_sessions:1']);
    // Not due before completed_at + 120 s.
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    expect((await runFor(MOVED))!.plan.repaired_at).toBeUndefined();
    await db.execute(sql`UPDATE kortix.workspace_split_runs SET completed_at = now() - interval '3 minutes' WHERE run_id = ${run.runId}`);
    const tick = await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage } });
    const repaired = (await runFor(MOVED))!;
    expect(repaired.plan.repaired_rows).toEqual({ project_sessions: 1 });
    expect(repaired.plan.repair_i2_violations).toBe(0);
    const [late] = await db.select({ accountId: projectSessions.accountId }).from(projectSessions).where(eq(projectSessions.sessionId, 'split-test-session-late'));
    expect(late?.accountId).toBe(target);
    // Repaired once: the CLI's second repair changes nothing.
    expect(await repairWorkspaceSplitRun(run.runId)).toEqual({ rows: {}, i2Violations: 0 });
    expect(tick.nextDelayMs).toBeGreaterThan(0);
  });

  test('each owner gets one email when the account\'s last move is done; members get none; a replay sends nothing', async () => {
    const mail = mailStub();
    await planWorkspaceSplits();
    // The first move is not the last: no email yet.
    expect(await applyWorkspaceSplitRun((await runFor(MOVED))!.runId, { siteStorage: storage, sendEmail: mail.sendEmail, mode: 'apply' })).toBe('done');
    expect(mail.sent).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect(await applyWorkspaceSplitRun((await runFor(OLDEST))!.runId, { siteStorage: storage, sendEmail: mail.sendEmail, mode: 'apply' })).toBe('done');
    // LEGACY has one owner; the admin and the members are not mailed.
    expect(mail.sent.map((m) => m.to)).toEqual([[`split-${OWNER.slice(-4)}@example.test`]]);
    expect(mail.sent[0]!.subject).toBe('Review your new Kortix workspaces');
    expect(mail.sent[0]!.html).toContain('Moved');
    expect(mail.sent[0]!.html).toContain('Oldest');
    expect(mail.sent[0]!.text).toContain(`/workspaces/${KEEPER}/admin/general`);
    // Measured: the HTML part stays above the 3,200-byte image-only spam window (brand voice 5.5).
    expect(mail.sent[0]!.html.length).toBeGreaterThan(3_200);
    // The provider gets the row's key, so a resend after a crash is a repeat it drops.
    expect(mail.sent[0]!.idempotencyKey).toBe(`workspace-split-email:${LEGACY}:${OWNER}`);
    expect((await outbox()).map((r) => [r.idempotency_key, r.state, r.attempts])).toEqual([[`workspace-split-email:${LEGACY}:${OWNER}`, 'sent', 1]]);
    // The tick and a second finish send nothing more.
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mail.sendEmail } });
    expect(mail.sent).toHaveLength(1);
  });

  test('no owner email while a done move has no billing recorded; it goes out once the billing lands', async () => {
    const mail = mailStub();
    await planWorkspaceSplits();
    expect(await applyWorkspaceSplitRun((await runFor(MOVED))!.runId, { siteStorage: storage, sendEmail: mail.sendEmail, mode: 'apply' })).toBe('done');
    // The moved run's billing failed every retry: plan.billing is absent.
    const moved = (await runFor(MOVED))!;
    await db.execute(sql`UPDATE kortix.workspace_split_runs SET plan = (plan - 'billing') || '{"billing_attempts": 5}'::jsonb WHERE run_id = ${moved.runId}`);
    expect(await applyWorkspaceSplitRun((await runFor(OLDEST))!.runId, { siteStorage: storage, sendEmail: mail.sendEmail, mode: 'apply' })).toBe('done');
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mail.sendEmail } });
    expect(mail.sent).toEqual([]);
    // An operator fixes the billing: the next tick sends the email, and it never says Free for a run it has no billing for.
    await db.execute(sql`UPDATE kortix.workspace_split_runs SET plan = plan || '{"billing": {"kind": "free", "grantedCredits": 500}}'::jsonb WHERE run_id = ${moved.runId}`);
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mail.sendEmail } });
    expect(mail.sent).toHaveLength(1);
    const unbilled = renderSplitOwnerEmail({
      email: 'owner@example.test', sourceName: 'Synthetic legacy', keeperWorkspaceId: KEEPER,
      workspaces: [{ name: 'Moved', role: 'moved', billing: null, compedUntil: null }],
    });
    expect(unbilled.text).not.toContain('Free');
  });

  test('the owner email never goes out unless the split mode is apply; the row waits and goes out once apply runs', async () => {
    const mail = mailStub();
    // An operator applied the moves while the worker is in dry_run.
    await splitLegacy(storage, mail.sendEmail, 'dry_run');
    expect(mail.sent).toEqual([]);
    expect((await outbox()).map((r) => [r.state, r.attempts])).toEqual([['pending', 0]]);
    for (const mode of ['off', 'dry_run'] as const) {
      expect(await deliverSplitOwnerEmails(mode, { send: mail.sendEmail })).toEqual({ sent: 0, failed: 0, skipped: 0 });
      await processWorkspaceSplits({ mode, deps: { siteStorage: storage, sendEmail: mail.sendEmail } });
    }
    expect(mail.sent).toEqual([]);
    await processWorkspaceSplits({ mode: 'apply', deps: { siteStorage: storage, sendEmail: mail.sendEmail } });
    expect(mail.sent).toHaveLength(1);
    expect((await outbox()).map((r) => r.state)).toEqual(['sent']);
  });

  test('a crash between the claim and the result never loses the email, and a live claim is never sent twice', async () => {
    const mail = mailStub();
    await splitLegacy(storage, mail.sendEmail, 'dry_run');
    // A process claimed the row and died before it recorded a result.
    await db.execute(sql`UPDATE kortix.workspace_split_emails
      SET state = 'sending', attempts = 1, lease_until = now() + interval '5 minutes'`);
    // While its lease runs, no other tick sends it: two concurrent ticks send nothing.
    await Promise.all([deliverSplitOwnerEmails('apply', { send: mail.sendEmail }), deliverSplitOwnerEmails('apply', { send: mail.sendEmail })]);
    expect(mail.sent).toEqual([]);
    // The lease expires: the next tick takes it back and sends it once.
    await db.execute(sql`UPDATE kortix.workspace_split_emails SET lease_until = now() - interval '1 second'`);
    const [first, second] = await Promise.all([
      deliverSplitOwnerEmails('apply', { send: mail.sendEmail }),
      deliverSplitOwnerEmails('apply', { send: mail.sendEmail }),
    ]);
    expect(first.sent + second.sent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect((await outbox()).map((r) => [r.state, r.attempts])).toEqual([['sent', 2]]);
  });

  test('a failed send retries after its backoff and stops after the last attempt', async () => {
    let calls = 0;
    const failing = async (_message: EmailMessage) => {
      calls += 1;
      return { ok: false as const, provider: 'mailpit' as const, status: 503, error: 'synthetic outage' };
    };
    await splitLegacy(storage, failing);
    expect(calls).toBe(1);
    const [failed] = await outbox();
    // The stored reason keeps the status only, never the provider's text.
    expect([failed!.state, failed!.attempts, failed!.last_error, failed!.due]).toEqual(['failed', 1, 'send_failed:503', false]);
    // Not due yet: nothing is sent.
    await deliverSplitOwnerEmails('apply', { send: failing });
    expect(calls).toBe(1);
    for (let attempt = 2; attempt <= OWNER_EMAIL_MAX_ATTEMPTS; attempt += 1) {
      await db.execute(sql`UPDATE kortix.workspace_split_emails SET next_attempt_at = now() - interval '1 second'`);
      await deliverSplitOwnerEmails('apply', { send: failing });
    }
    expect(calls).toBe(OWNER_EMAIL_MAX_ATTEMPTS);
    // Out of attempts: it stays failed, for an operator.
    await db.execute(sql`UPDATE kortix.workspace_split_emails SET next_attempt_at = now() - interval '1 second'`);
    const mail = mailStub();
    await deliverSplitOwnerEmails('apply', { send: mail.sendEmail });
    expect(mail.sent).toEqual([]);
    expect((await outbox()).map((r) => [r.state, r.attempts])).toEqual([['failed', OWNER_EMAIL_MAX_ATTEMPTS]]);
    // A retry that succeeds before the cap is sent once.
    await db.execute(sql`UPDATE kortix.workspace_split_emails SET attempts = 2, next_attempt_at = now() - interval '1 second'`);
    await deliverSplitOwnerEmails('apply', { send: mail.sendEmail });
    await deliverSplitOwnerEmails('apply', { send: mail.sendEmail });
    expect(mail.sent).toHaveLength(1);
  });

  test('finding 31 across the split: a log row from before the move stays visible in the moved workspace, and the keeper labels it Moved to another workspace', async () => {
    const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
    // Spend of the moved project's session, billed to the legacy account, a moment before the split.
    await db.insert(gatewayRequestLogs).values({
      requestId: crypto.randomUUID(), accountId: LEGACY, projectId: MOVED, sessionId: SESSION,
      requestedModel: 'synthetic-model', resolvedModel: 'synthetic-model', provider: 'synthetic',
      status: 200, ok: true, billingMode: 'credits', finalCost: '1.25',
    });
    await splitLegacy(storage, mailStub().sendEmail);
    const target = (await runFor(MOVED))!.toAccountId!;
    // The row stays where it was billed (gateway_request_logs is a ledger the split leaves).
    const [row] = await db.select({ accountId: gatewayRequestLogs.accountId }).from(gatewayRequestLogs).where(eq(gatewayRequestLogs.sessionId, SESSION));
    expect(row?.accountId).toBe(LEGACY);
    // The moved workspace sees the session's full cost, marked as billed elsewhere.
    const detail = await getSessionCostRecord({ accountId: target, sessionId: SESSION });
    expect([detail?.llm_cost, detail?.billed_elsewhere_cost]).toEqual([1.25, 1.25]);
    // The keeper keeps the money and names the project by the label, never by its new name.
    const page = await listCostByProject({ accountId: LEGACY, window, sort: 'total_desc', limit: 10, offset: 0 });
    expect(page.projects.find((p) => p.project_id === MOVED)).toMatchObject({ project_name: 'Moved to another workspace', moved: true, llm_cost: 1.25 });
    expect(page.projects.some((p) => p.project_name === 'Moved')).toBe(false);
  });

  test('split_notice: the moved workspace and the keeper each say where they came from, for 30 days', async () => {
    await planWorkspaceSplits();
    await applyWorkspaceSplitRun((await runFor(MOVED))!.runId, { siteStorage: storage, sendEmail: mailStub().sendEmail });
    const moved = (await runFor(MOVED))!;
    // The keeper says nothing while a move of its account is still open.
    expect(await workspaceSplitNotice(LEGACY)).toBeNull();
    expect(await workspaceSplitNotice(moved.toAccountId!)).toMatchObject({ role: 'moved', source_name: 'Synthetic legacy', billing: 'free', comped_until: null });
    await applyWorkspaceSplitRun((await runFor(OLDEST))!.runId, { siteStorage: storage, sendEmail: mailStub().sendEmail });
    const keeper = await workspaceSplitNotice(LEGACY);
    expect(keeper).toMatchObject({ role: 'keeper', source_name: 'Synthetic legacy', billing: null });
    expect(keeper?.completed_at).toBe(new Date((await runFor(OLDEST))!.completedAt!).toISOString());
    // A 1:1 workspace that never split has none; 31 days later neither has one.
    expect(await workspaceSplitNotice(PAYING)).toBeNull();
    await db.execute(sql`UPDATE kortix.workspace_split_runs SET completed_at = completed_at - interval '31 days' WHERE from_account_id = ${LEGACY}`);
    expect([await workspaceSplitNotice(LEGACY), await workspaceSplitNotice(moved.toAccountId!)]).toEqual([null, null]);
  });

  test('a split_pending flag left on an account\'s only project is reported by I1 and cleared by the plan pass', async () => {
    const LONE = '00000000-0000-4000-a000-0000000e0004';
    const LONE_PROJECT = '00000000-0000-4000-a000-0000000e0107';
    await db.insert(accounts).values({ accountId: LONE, name: 'Lone' });
    await db.insert(projects).values({ projectId: LONE_PROJECT, accountId: LONE, name: 'Lone', repoUrl: 'https://example.invalid/lone.git' });
    try {
      // The flag went stale before the projects_split_pending_sync trigger existed.
      await db.execute(sql`UPDATE kortix.projects SET split_pending = true WHERE project_id = ${LONE_PROJECT}`);
      expect((await checkWorkspaceInvariants()).I1.sample).toEqual([`stale_flag:${LONE}`]);
      expect((await planWorkspaceSplits()).stale_flags_cleared).toBe(1);
      expect(await accountOfProject(LONE_PROJECT)).toEqual({ accountId: LONE, splitPending: false });
      const report = await checkWorkspaceInvariants();
      expect([report.I1.violations, report.I9.violations, report.I12.violations]).toEqual([0, 0, 0]);
    } finally {
      await db.delete(accounts).where(eq(accounts.accountId, LONE));
    }
  });
});
