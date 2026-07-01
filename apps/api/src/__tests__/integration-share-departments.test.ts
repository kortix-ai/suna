/**
 * Integration test (real local DB): the connectors/secrets "Who can use it"
 * sharing model works end-to-end for DEPARTMENTS (account groups), not just
 * individual members — the runtime teeth behind the aligned SharingPicker UI.
 *
 * Proves the full chain the dashboard now exercises:
 *   setSecretSharing / setConnectorSharingDb  (write: intent → group grants)
 *     → resolveShareSubject                   (resolve a user's departments)
 *       → isSecretUsableBy via listProjectSecretsForUser  (runtime filter)
 *         → scopeToIntent                     (read back for the picker)
 *
 * Runs against the local Postgres (DATABASE_URL).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  executorConnectorGrants,
  executorConnectors,
  projectSecrets,
} from '@kortix/db';
import { db } from '../shared/db';
import { listProjectSecretsForUser, writeSharedProjectSecret } from '../projects/secrets';
import { loadGrants, resolveShareSubject, scopeToIntent, setSecretSharing } from '../executor/share';
import { setConnectorSharingDb } from '../executor/credentials';

let ctx: { projectId: string; accountId: string } | null = null;
const DEPT = crypto.randomUUID();
const IN_DEPT = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const NAMED = crypto.randomUUID();
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const S_DEPT = `E2E_SHARE_DEPT_${SUFFIX}`;
const S_MIXED = `E2E_SHARE_MIXED_${SUFFIX}`;
const S_EMPTY = `E2E_SHARE_EMPTY_${SUFFIX}`;
let connectorId = '';

async function secretIdFor(name: string): Promise<string> {
  const [row] = await db
    .select({ id: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx!.projectId), eq(projectSecrets.name, name)))
    .limit(1);
  return row!.id;
}

/** Names of shared secrets visible to a user (via the real runtime resolver). */
async function visibleTo(userId: string): Promise<Set<string>> {
  const subject = await resolveShareSubject(userId);
  return new Set(Object.keys(await listProjectSecretsForUser(ctx!.projectId, subject)));
}

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // A department + one member in it. resolveShareSubject reads groups purely
  // from account_group_members, so that's all the seeding the filter needs.
  await db
    .insert(accountGroups)
    .values({ groupId: DEPT, accountId: ctx.accountId, name: `E2E Dept ${SUFFIX}` })
    .onConflictDoNothing();
  await db
    .insert(accountGroupMembers)
    .values({ groupId: DEPT, userId: IN_DEPT })
    .onConflictDoNothing();

  // Three project-wide secrets, then narrow each via setSecretSharing.
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_DEPT, value: 'v1' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_MIXED, value: 'v2' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_EMPTY, value: 'v3' });

  await setSecretSharing(await secretIdFor(S_DEPT), { mode: 'members', memberIds: [], groupIds: [DEPT] });
  await setSecretSharing(await secretIdFor(S_MIXED), {
    mode: 'members',
    memberIds: [NAMED],
    groupIds: [DEPT],
  });

  // A minimal connector to prove the parallel connector write/read path.
  const [conn] = await db
    .insert(executorConnectors)
    .values({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      slug: `e2e-share-${SUFFIX.toLowerCase()}`,
      name: `E2E Share ${SUFFIX}`,
      providerType: 'http',
    })
    .returning({ id: executorConnectors.connectorId });
  connectorId = conn!.id;
});

afterAll(async () => {
  if (!ctx) return;
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx.projectId), inArray(projectSecrets.name, [S_DEPT, S_MIXED, S_EMPTY])));
  if (connectorId) {
    await db.delete(executorConnectorGrants).where(eq(executorConnectorGrants.connectorId, connectorId));
    await db.delete(executorConnectors).where(eq(executorConnectors.connectorId, connectorId));
  }
  await db.delete(accountGroupMembers).where(eq(accountGroupMembers.groupId, DEPT));
  await db.delete(accountGroups).where(eq(accountGroups.groupId, DEPT));
});

describe('"Who can use it" — department (group) sharing, real DB', () => {
  test('secret scoped to a DEPARTMENT: dept members see it, outsiders do not', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    expect(await resolveShareSubject(IN_DEPT)).toEqual({ userId: IN_DEPT, groupIds: [DEPT] });
    expect((await resolveShareSubject(OUTSIDER)).groupIds).toEqual([]);
    expect(await visibleTo(IN_DEPT)).toContain(S_DEPT);
    expect(await visibleTo(OUTSIDER)).not.toContain(S_DEPT);
  });

  test('mixed member + department: the named member AND dept members see it', async () => {
    if (!ctx) return;
    expect(await visibleTo(NAMED)).toContain(S_MIXED); // named directly
    expect(await visibleTo(IN_DEPT)).toContain(S_MIXED); // via department
    expect(await visibleTo(OUTSIDER)).not.toContain(S_MIXED);
  });

  test('empty allow-list collapses to project-wide (everyone sees it again)', async () => {
    if (!ctx) return;
    // The picker/backend guard: emptying the list must NOT leave the secret
    // stranded on a restricted-with-no-grants scope — it reverts to project.
    await setSecretSharing(await secretIdFor(S_EMPTY), { mode: 'members', memberIds: [], groupIds: [] });
    const [row] = await db
      .select({ scope: projectSecrets.shareScope })
      .from(projectSecrets)
      .where(and(eq(projectSecrets.projectId, ctx.projectId), eq(projectSecrets.name, S_EMPTY)))
      .limit(1);
    expect(row!.scope).toBe('project');
    expect(await visibleTo(OUTSIDER)).toContain(S_EMPTY);
  });

  test('read-back round-trips the department into the picker selection', async () => {
    if (!ctx) return;
    const id = await secretIdFor(S_MIXED);
    const [{ scope }] = await db
      .select({ scope: projectSecrets.shareScope })
      .from(projectSecrets)
      .where(eq(projectSecrets.secretId, id))
      .limit(1);
    const grants = (await loadGrants([id])).get(id) ?? [];
    const intent = scopeToIntent(scope, grants);
    expect(intent.mode).toBe('members');
    if (intent.mode === 'members') {
      expect(new Set(intent.groupIds)).toEqual(new Set([DEPT]));
      expect(new Set(intent.memberIds)).toEqual(new Set([NAMED]));
    }
  });

  test('connector sharing persists + reads back a department grant', async () => {
    if (!ctx || !connectorId) return;
    await setConnectorSharingDb(connectorId, { mode: 'members', memberIds: [], groupIds: [DEPT] });
    const grants = await db
      .select({ pt: executorConnectorGrants.principalType, pid: executorConnectorGrants.principalId })
      .from(executorConnectorGrants)
      .where(eq(executorConnectorGrants.connectorId, connectorId));
    expect(grants).toEqual([{ pt: 'group', pid: DEPT }]);
    const [{ scope }] = await db
      .select({ scope: executorConnectors.shareScope })
      .from(executorConnectors)
      .where(eq(executorConnectors.connectorId, connectorId))
      .limit(1);
    const intent = scopeToIntent(scope, grants.map((g) => ({ principalType: g.pt, principalId: g.pid })));
    expect(intent).toEqual({ mode: 'members', memberIds: [], groupIds: [DEPT] });
  });
});
