/**
 * `transferProjectOwnership` — the project-transfer data movement.
 *
 * A transfer re-parents a project from one account to another. Every table
 * that copies the owning account's id next to the project id (session rows,
 * drives, git connections, project-bound tokens, connector tenant rows, …)
 * must follow, or the moved project goes dark inside its new account: reads
 * like `session-costs` join `project_sessions.account_id` directly, so a
 * stale copy hides the project's own history from its new home. The ledger
 * tables (`usage_events`, `gateway_request_logs`, …) intentionally STAY with
 * the source account: they are the financial record of what that account
 * consumed while the project lived there.
 *
 * The permission GATES live in the route (the codebase convention — see the
 * DELETE handler in `routes/project-settings.ts`); this suite proves the two
 * real IAM decisions the route relies on, against the real engine and a real
 * database:
 *
 *   - an account owner can act on their own project (`project.delete` tier),
 *   - a caller who is not a member of the TARGET account is denied
 *     `project.create` there (`not_a_member`) — acceptance criterion 2 of
 *     KRTX-1747.
 *
 * Runs against real PostgreSQL (`TEST_DATABASE_URL`); every row is seeded and
 * cleaned here. See `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountMemberships,
  accountSecretResources,
  accountSecretGrants,
  accountTokens,
  accounts,
  drives,
  iamRoles,
  projectGitConnections,
  projectSessions,
  projects,
  roleAssignments,
  usageEvents,
} from '@kortix/db';
import { and, eq, getTableName, getTableColumns, is, isNull, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../shared/db';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { authorize } from '../../iam/authorize';
import {
  PROJECT_TRANSFER_LEAVE_TABLES,
  PROJECT_TRANSFER_TABLES,
  ProjectTransferError,
  transferProjectOwnership,
} from './project-transfer';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// Fixed uuids so a crashed previous run is still cleaned up.
const SOURCE_ACCOUNT = '00000000-0000-4000-a000-00000000a101';
const TARGET_ACCOUNT = '00000000-0000-4000-a000-00000000a102';
const OWNER_A = '00000000-0000-4000-a000-00000000a111';
const OWNER_B = '00000000-0000-4000-a000-00000000a112';
const PROJECT_MEMBER = '00000000-0000-4000-a000-00000000a113';
const PROJECT_ID = '00000000-0000-4000-a000-00000000a120';
const SESSION_ID = 'transfer-test-session-1';
const DRIVE_ID = '00000000-0000-4000-a000-00000000a130';
const TOKEN_ID = '00000000-0000-4000-a000-00000000a131';
const GIT_CONNECTION_ID = '00000000-0000-4000-a000-00000000a132';

/** Global system roles are seeded by the rbac migration (account_id NULL). */
async function systemRoleId(key: string, scopeType: string): Promise<string> {
  const [role] = await db
    .select({ roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, key), eq(iamRoles.scopeType, scopeType)));
  if (!role) throw new Error(`system role ${key}/${scopeType} not seeded`);
  return role.roleId;
}

async function seed(): Promise<void> {
  await db.insert(accounts).values([
    { accountId: SOURCE_ACCOUNT, name: 'Transfer source' },
    { accountId: TARGET_ACCOUNT, name: 'Transfer target' },
  ]);
  await db.insert(accountMemberships).values([
    { userId: OWNER_A, accountId: SOURCE_ACCOUNT },
    { userId: OWNER_B, accountId: TARGET_ACCOUNT },
    { userId: PROJECT_MEMBER, accountId: SOURCE_ACCOUNT },
  ]);

  // The project must exist BEFORE its project-scoped assignment: the
  // `role_assignments_project_account_guard` trigger refuses an assignment
  // whose project is not yet in the row's account.
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: SOURCE_ACCOUNT,
    name: 'Transferable workspace',
    repoUrl: 'https://github.com/acme/transferable.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: { icon: '🚚', onboarding_completed_at: '2026-01-01T00:00:00Z' },
  });
  // Account roles through the canonical store.
  const ownerAccount = await systemRoleId('owner', 'account');
  const memberProject = await systemRoleId('member', 'project');
  await db.insert(roleAssignments).values([
    // OWNER_A owns the source account. On the allowed path they also own the
    // target; the denied path seeds no target assignment for them.
    { accountId: SOURCE_ACCOUNT, principalType: 'user', principalId: OWNER_A, roleId: ownerAccount, scopeType: 'account' },
    { accountId: TARGET_ACCOUNT, principalType: 'user', principalId: OWNER_B, roleId: ownerAccount, scopeType: 'account' },
    // A plain project member, granted INSIDE the source account.
    { accountId: SOURCE_ACCOUNT, principalType: 'user', principalId: PROJECT_MEMBER, roleId: memberProject, scopeType: 'project', scopeId: PROJECT_ID },
  ]);
  await db.insert(projectSessions).values({
    sessionId: SESSION_ID,
    accountId: SOURCE_ACCOUNT,
    projectId: PROJECT_ID,
    branchName: 'main',
  });
  await db.insert(drives).values({
    driveId: DRIVE_ID,
    accountId: SOURCE_ACCOUNT,
    projectId: PROJECT_ID,
    kind: 'project',
    name: 'Project drive',
    platinumVolumeName: `transfer-test-volume-${DRIVE_ID.slice(0, 8)}`,
  });
  await db.insert(projectGitConnections).values({
    connectionId: GIT_CONNECTION_ID,
    accountId: SOURCE_ACCOUNT,
    projectId: PROJECT_ID,
    provider: 'github',
    repoUrl: 'https://github.com/acme/transferable.git',
    authMethod: 'managed',
    status: 'connected',
  });
  // A project-bound token — what a running session's sandbox calls back with.
  await db.insert(accountTokens).values({
    tokenId: TOKEN_ID,
    accountId: SOURCE_ACCOUNT,
    userId: OWNER_A,
    projectId: PROJECT_ID,
    name: 'session token',
    publicKey: 'k'.repeat(64),
    secretKeyHash: 'h'.repeat(128),
  });
  // The ledger row that must NOT follow the project.
  await db.insert(usageEvents).values({
    accountId: SOURCE_ACCOUNT,
    projectId: PROJECT_ID,
    provider: 'anthropic',
    model: 'claude-sonnet',
    route: 'messages',
    inputTokens: 100,
  });
}

async function cleanup(): Promise<void> {
  await db.delete(accounts).where(eq(accounts.accountId, SOURCE_ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, TARGET_ACCOUNT));
}

/** The `account_id` of one row, by its primary key — a raw read so the test
 *  does not re-derive what the service wrote. */
async function accountOf(kind: 'session' | 'drive' | 'token' | 'connection' | 'event', id: string): Promise<string | null> {
  const table = { session: 'project_sessions', drive: 'drives', token: 'account_tokens', connection: 'project_git_connections', event: 'usage_events' }[kind];
  const pk = { session: 'session_id', drive: 'drive_id', token: 'token_id', connection: 'connection_id', event: 'event_id' }[kind];
  const result = await db.execute<{ account_id: string }>(
    sql`SELECT account_id FROM kortix.${sql.raw(table)} WHERE ${sql.raw(pk)} = ${id}`,
  );
  return result[0]?.account_id ?? null;
}

withDb('project transfer', () => {
  beforeEach(seed);
  afterEach(cleanup);

  async function seedSecret(withGrant = false, corrupt = false) {
    const [secret] = await db.insert(accountSecretResources).values({
      accountId: SOURCE_ACCOUNT, projectId: PROJECT_ID, label: 'Transfer secret',
      name: 'TRANSFER_TEST', valueEnc: corrupt ? 'invalid-envelope' : encryptAccountSecret(SOURCE_ACCOUNT, 'synthetic-secret'),
      consumer: 'llm_gateway', strategy: 'runtime', createdBy: OWNER_A,
    }).returning();
    if (!secret) throw new Error('secret fixture missing');
    if (withGrant) await db.insert(accountSecretGrants).values({
      accountId: SOURCE_ACCOUNT, secretId: secret.secretId, userId: PROJECT_MEMBER, grantedBy: OWNER_A,
    });
    return secret;
  }

  test('transfers a project secret with source-member grants without retaining source access', async () => {
    const secret = await seedSecret(true);
    await transferProjectOwnership({ projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT });
    const [moved] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secret.secretId));
    expect(moved?.accountId).toBe(TARGET_ACCOUNT);
    expect(await db.select().from(accountSecretGrants).where(eq(accountSecretGrants.secretId, secret.secretId))).toEqual([]);
  });

  test('re-encrypts project secret for destination and leaves account-scoped ciphertext untouched', async () => {
    const secret = await seedSecret();
    const [accountSecret] = await db.insert(accountSecretResources).values({
      accountId: SOURCE_ACCOUNT, label: 'Account secret', name: 'ACCOUNT_TEST',
      valueEnc: encryptAccountSecret(SOURCE_ACCOUNT, 'account-only'), consumer: 'llm_gateway', strategy: 'runtime', createdBy: OWNER_A,
    }).returning();
    if (!accountSecret) throw new Error('account secret fixture missing');
    await transferProjectOwnership({ projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT });
    const [moved] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secret.secretId));
    expect(moved).toBeDefined();
    expect(decryptAccountSecret(TARGET_ACCOUNT, moved?.valueEnc ?? '')).toBe('synthetic-secret');
    expect(() => decryptAccountSecret(SOURCE_ACCOUNT, moved?.valueEnc ?? '')).toThrow();
    const [unchanged] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, accountSecret.secretId));
    expect(unchanged?.accountId).toBe(SOURCE_ACCOUNT);
    expect(unchanged?.valueEnc).toBe(accountSecret.valueEnc);
  });

  test('an undecryptable project secret rolls back ownership, grants and all ciphertext', async () => {
    const secret = await seedSecret();
    await seedSecret(false, true);
    await expect(transferProjectOwnership({ projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT })).rejects.toThrow();
    const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(project?.accountId).toBe(SOURCE_ACCOUNT);
    const [unchanged] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secret.secretId));
    expect(unchanged?.valueEnc).toBe(secret.valueEnc);
    expect(unchanged?.accountId).toBe(SOURCE_ACCOUNT);
    expect(await db.select().from(accountSecretGrants).where(eq(accountSecretGrants.secretId, secret.secretId))).toHaveLength(0);
    expect(await accountOf('session', SESSION_ID)).toBe(SOURCE_ACCOUNT);
  });

  test('a later write failure rolls back the re-encrypted secret and revoked grants', async () => {
    const secret = await seedSecret(true);
    await db.execute(sql`CREATE FUNCTION kortix.reject_transfer_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic late transfer failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_transfer_test BEFORE UPDATE ON kortix.project_sessions
      FOR EACH ROW EXECUTE FUNCTION kortix.reject_transfer_test()`);
    try {
      await expect(transferProjectOwnership({ projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT })).rejects.toThrow();
      const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
      expect(project?.accountId).toBe(SOURCE_ACCOUNT);
      const [unchanged] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secret.secretId));
      expect(unchanged?.valueEnc).toBe(secret.valueEnc);
      expect(unchanged?.accountId).toBe(SOURCE_ACCOUNT);
      expect(await db.select().from(accountSecretGrants).where(eq(accountSecretGrants.secretId, secret.secretId))).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_transfer_test ON kortix.project_sessions`);
      await db.execute(sql`DROP FUNCTION kortix.reject_transfer_test()`);
    }
  });

  test('moves the project and every project-scoped row to the target account', async () => {
    // The caller (OWNER_A) also holds the target account, so the route's
    // target gate would pass; this suite exercises the movement itself.
    await db.insert(accountMemberships).values({ userId: OWNER_A, accountId: TARGET_ACCOUNT });
    const ownerAccount = await systemRoleId('owner', 'account');
    await db.insert(roleAssignments).values({
      accountId: TARGET_ACCOUNT, principalType: 'user', principalId: OWNER_A, roleId: ownerAccount, scopeType: 'account',
    });

    const result = await transferProjectOwnership({
      projectId: PROJECT_ID,
      fromAccountId: SOURCE_ACCOUNT,
      toAccountId: TARGET_ACCOUNT,
    });
    expect(result).toEqual({ projectId: PROJECT_ID, accountId: TARGET_ACCOUNT });

    const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(project?.accountId).toBe(TARGET_ACCOUNT);
    // Settings survive the move: name, icon, manifest, repo.
    expect(project?.name).toBe('Transferable workspace');
    expect(project?.repoUrl).toBe('https://github.com/acme/transferable.git');
    expect(project?.metadata?.icon).toBe('🚚');

    expect(await accountOf('session', SESSION_ID)).toBe(TARGET_ACCOUNT);
    expect(await accountOf('drive', DRIVE_ID)).toBe(TARGET_ACCOUNT);
    expect(await accountOf('connection', GIT_CONNECTION_ID)).toBe(TARGET_ACCOUNT);
    expect(await accountOf('token', TOKEN_ID)).toBe(TARGET_ACCOUNT);

    // The usage ledger stays with the account that consumed it.
    const [event] = await db.select().from(usageEvents).where(eq(usageEvents.projectId, PROJECT_ID));
    expect(event?.accountId).toBe(SOURCE_ACCOUNT);
  });

  test('re-points system user grants and drops source-directory and pending grants', async () => {
    await db.insert(accountMemberships).values({ userId: OWNER_A, accountId: TARGET_ACCOUNT });
    const ownerAccount = await systemRoleId('owner', 'account');
    await db.insert(roleAssignments).values({
      accountId: TARGET_ACCOUNT, principalType: 'user', principalId: OWNER_A, roleId: ownerAccount, scopeType: 'account',
    });

    const memberProject = await systemRoleId('member', 'project');
    // A group grant and a pending invite grant scoped to the project.
    const groupId = '00000000-0000-4000-a000-00000000a140';
    const pendingPrincipal = '00000000-0000-4000-a000-00000000a141';
    await db.insert(roleAssignments).values([
      { accountId: SOURCE_ACCOUNT, principalType: 'group', principalId: groupId, roleId: memberProject, scopeType: 'project', scopeId: PROJECT_ID },
      { accountId: SOURCE_ACCOUNT, principalType: 'pending', principalId: pendingPrincipal, roleId: memberProject, scopeType: 'project', scopeId: PROJECT_ID },
    ]);

    await transferProjectOwnership({
      projectId: PROJECT_ID,
      fromAccountId: SOURCE_ACCOUNT,
      toAccountId: TARGET_ACCOUNT,
    });

    const assignments = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.scopeType, 'project'), eq(roleAssignments.scopeId, PROJECT_ID)));
    const byPrincipal = new Map(assignments.map((a) => [`${a.principalType}:${a.principalId}`, a]));
    // The user grant followed the project into the target account…
    expect(byPrincipal.get(`user:${PROJECT_MEMBER}`)?.accountId).toBe(TARGET_ACCOUNT);
    // Source account invitations cannot activate grants in the target.
    expect(byPrincipal.has(`pending:${pendingPrincipal}`)).toBe(false);
    // …and the group grant is gone: the group is a directory object of the
    // SOURCE account and its grant cannot be re-resolved in the target.
    expect(byPrincipal.has(`group:${groupId}`)).toBe(false);
  });

  test('does not retain a custom role owned by the source account', async () => {
    const [role] = await db.insert(iamRoles).values({
      accountId: SOURCE_ACCOUNT, key: 'transfer_custom', name: 'Transfer custom', scopeType: 'project',
    }).returning();
    if (!role) throw new Error('custom role fixture missing');
    await db.insert(roleAssignments).values({
      accountId: SOURCE_ACCOUNT, principalType: 'user', principalId: OWNER_A,
      roleId: role.roleId, scopeType: 'project', scopeId: PROJECT_ID,
    });
    await transferProjectOwnership({
      projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT,
    });
    const retained = await db.select().from(roleAssignments).where(and(
      eq(roleAssignments.scopeId, PROJECT_ID), eq(roleAssignments.roleId, role.roleId),
    ));
    expect(retained).toEqual([]);
  });

  test('a caller who is not a member of the target account cannot trigger the transfer', async () => {
    // The real engine, the real accounts: OWNER_A owns the source and is NOT
    // a member of the target. The route gates the transfer on `project.create`
    // in the TARGET account — exactly what a non-member lacks.
    const actor = { userId: OWNER_A, accountId: TARGET_ACCOUNT, credential: { kind: 'jwt' as const }, ctx: {} };
    const verdict = await authorize(actor, 'project.create');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('not_a_member');

    const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(project?.accountId).toBe(SOURCE_ACCOUNT);
  });

  test('a member of the target account who may create projects passes the target gate', async () => {
    await db.insert(accountMemberships).values({ userId: OWNER_A, accountId: TARGET_ACCOUNT });
    const ownerAccount = await systemRoleId('owner', 'account');
    await db.insert(roleAssignments).values({
      accountId: TARGET_ACCOUNT, principalType: 'user', principalId: OWNER_A, roleId: ownerAccount, scopeType: 'account',
    });
    const actor = { userId: OWNER_A, accountId: TARGET_ACCOUNT, credential: { kind: 'jwt' as const }, ctx: {} };
    const verdict = await authorize(actor, 'project.create');
    expect(verdict.allowed).toBe(true);
  });

  test('refuses a same-account transfer and a missing target', async () => {
    await expect(transferProjectOwnership({
      projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: SOURCE_ACCOUNT,
    })).rejects.toBeInstanceOf(ProjectTransferError);

    await expect(transferProjectOwnership({
      projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: '00000000-0000-4000-a000-00000000a999',
    })).rejects.toBeInstanceOf(ProjectTransferError);
    // Nothing moved.
    const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(project?.accountId).toBe(SOURCE_ACCOUNT);
  });

  test('a stale from-account is refused (concurrent move guard)', async () => {
    await db.insert(accountMemberships).values({ userId: OWNER_A, accountId: TARGET_ACCOUNT });
    const ownerAccount = await systemRoleId('owner', 'account');
    await db.insert(roleAssignments).values({
      accountId: TARGET_ACCOUNT, principalType: 'user', principalId: OWNER_A, roleId: ownerAccount, scopeType: 'account',
    });
    await transferProjectOwnership({
      projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT,
    });
    // A second caller whose loaded row still says the source account.
    await expect(transferProjectOwnership({
      projectId: PROJECT_ID, fromAccountId: SOURCE_ACCOUNT, toAccountId: TARGET_ACCOUNT,
    })).rejects.toBeInstanceOf(ProjectTransferError);
    const [project] = await db.select().from(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(project?.accountId).toBe(TARGET_ACCOUNT);
  });

  test('every schema table carrying both account_id and project_id is classified', async () => {
    // The anti-drift guard: a new table that copies the owning account's id
    // next to the project id must be either moved by the transfer or kept
    // with a stated reason — never silently forgotten.
    //
    // Introspected through drizzle's `is` guard: @kortix/db and apps/api
    // resolve the same drizzle copy here, so the class check holds.
    const schema = await import('@kortix/db');
    const moved = new Set(PROJECT_TRANSFER_TABLES.map((t) => getTableName(t)));
    const leave = new Set(Object.keys(PROJECT_TRANSFER_LEAVE_TABLES));
    const both: string[] = [];
    for (const exported of Object.values(schema)) {
      if (!exported || typeof exported !== 'object') continue;
      if (!is(exported, PgTable)) continue; // views are derived — nothing to re-point
      const columns = getTableColumns(exported);
      const name = getTableName(exported);
      if ('accountId' in columns && 'projectId' in columns) both.push(name);
    }
    expect(both.length).toBeGreaterThan(30);
    for (const name of both) {
      expect(moved.has(name) || leave.has(name)).toBe(true);
    }
    // No stale classifications.
    const known = new Set(both);
    for (const name of moved) expect(known.has(name)).toBe(true);
    for (const name of leave) expect(known.has(name)).toBe(true);
    // The projects table itself moves.
    expect(moved.has('projects')).toBe(true);
    // The ledgers stay.
    expect(leave.has('usage_events')).toBe(true);
    expect(leave.has('gateway_request_logs')).toBe(true);
  });
});
