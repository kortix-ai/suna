/**
 * Integration test (real local DB): the two security-sensitive primitives behind
 * the "assign human → agent" inheritance pyramid.
 *
 *   resolveDeclaredSharedSecrets   — resolves an agent's DECLARED secrets from the
 *                                    shared store, BYPASSING per-user share scope
 *                                    (the agent declared them + the launcher is
 *                                    assigned), but never reserved/connector rows.
 *   isProjectResourceExplicitlyGranted — inheritance requires a DELIBERATE
 *                                    assignment; an UNSCOPED agent grants nobody.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import { resolveDeclaredSharedSecrets, writeSharedProjectSecret } from '../projects/secrets';
import { setSecretSharing } from '../executor/share';
import { isProjectResourceExplicitlyGranted, upsertResourceGrant } from '../iam';
import { resolveAssignedAgentNames, unionDeclaredResources } from '../projects/lib/agent-inheritance';

let ctx: { projectId: string; accountId: string } | null = null;
const grantCleanup: string[] = [];
const ASSIGNED = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const DEPT = crypto.randomUUID();
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const S_DECL = `E2E_INH_DECL_${SUFFIX}`; // declared + restricted to OTHER
const S_CONN = `E2E_INH_CONN_${SUFFIX}`; // connector-scoped
const S_KORTIX = `KORTIX_E2E_INH_${SUFFIX}`; // reserved
const AGENT = `release-bot-${SUFFIX.toLowerCase()}`;
const FREE_AGENT = `free-agent-${SUFFIX.toLowerCase()}`;

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_DECL, value: 'decl-val' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_CONN, value: 'conn-val', scope: 'connector' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: S_KORTIX, value: 'sys-val' });

  // Restrict S_DECL to OTHER so ASSIGNED can't personally see it — inheritance
  // must still surface it because the agent declares it.
  const [decl] = await db
    .select({ id: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx.projectId), eq(projectSecrets.name, S_DECL)))
    .limit(1);
  await setSecretSharing(decl!.id, { mode: 'members', memberIds: [OTHER], groupIds: [] });

  // Assign the agent to ASSIGNED (member) — the "assign human → agent" grant.
  const g = await upsertResourceGrant({
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    resourceType: 'agent',
    resourceId: AGENT,
    principalType: 'member',
    principalId: ASSIGNED,
    grantedBy: ASSIGNED,
  });
  grantCleanup.push(g.grantId);
});

afterAll(async () => {
  if (!ctx) return;
  for (const id of grantCleanup) {
    await db.execute(sql`delete from kortix.iam_resource_grants where grant_id = ${id}`);
  }
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx.projectId), inArray(projectSecrets.name, [S_DECL, S_CONN, S_KORTIX])));
});

describe('agent-inheritance primitives', () => {
  test('resolveDeclaredSharedSecrets bypasses share scope for declared names, skips reserved + connector', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    const env = await resolveDeclaredSharedSecrets(ctx.projectId, [S_DECL, S_CONN, S_KORTIX, 'E2E_MISSING']);
    // S_DECL is restricted to OTHER, but the agent declared it → resolved anyway.
    expect(env[S_DECL]).toBe('decl-val');
    // Connector-scoped, reserved (KORTIX_*), and non-existent are never returned.
    expect(env[S_CONN]).toBeUndefined();
    expect(env[S_KORTIX]).toBeUndefined();
    expect(env.E2E_MISSING).toBeUndefined();
  });

  test('empty name list resolves nothing', async () => {
    if (!ctx) return;
    expect(await resolveDeclaredSharedSecrets(ctx.projectId, [])).toEqual({});
  });

  test('isProjectResourceExplicitlyGranted: assigned member yes, others no, unscoped agent no', async () => {
    if (!ctx) return;
    // ASSIGNED is named on the agent grant → assigned.
    expect(await isProjectResourceExplicitlyGranted(ctx.projectId, 'agent', AGENT, ASSIGNED, [])).toBe(true);
    // OTHER is not named → not assigned.
    expect(await isProjectResourceExplicitlyGranted(ctx.projectId, 'agent', AGENT, OTHER, [])).toBe(false);
    // A different, UNSCOPED agent → nobody is assigned (even though it's usable).
    expect(await isProjectResourceExplicitlyGranted(ctx.projectId, 'agent', FREE_AGENT, ASSIGNED, [DEPT])).toBe(false);
  });

  test('department assignment counts: a member of an assigned dept is assigned', async () => {
    if (!ctx) return;
    const g = await upsertResourceGrant({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      resourceType: 'agent',
      resourceId: FREE_AGENT,
      principalType: 'group',
      principalId: DEPT,
      grantedBy: ASSIGNED,
    });
    grantCleanup.push(g.grantId);
    // OTHER is in DEPT → assigned to FREE_AGENT via the department.
    expect(await isProjectResourceExplicitlyGranted(ctx.projectId, 'agent', FREE_AGENT, OTHER, [DEPT])).toBe(true);
    // ASSIGNED is not in DEPT and not named → still not assigned to FREE_AGENT.
    expect(await isProjectResourceExplicitlyGranted(ctx.projectId, 'agent', FREE_AGENT, ASSIGNED, [])).toBe(false);
  });

  test('resolveAssignedAgentNames returns every agent the subject is assigned to (global set)', async () => {
    if (!ctx) return;
    // ASSIGNED is named on AGENT only.
    const forAssigned = await resolveAssignedAgentNames(ctx.projectId, ASSIGNED, []);
    expect(forAssigned.has(AGENT)).toBe(true);
    expect(forAssigned.has(FREE_AGENT)).toBe(false);
    // OTHER is in DEPT, which is assigned to FREE_AGENT (from the prior test).
    const forOther = await resolveAssignedAgentNames(ctx.projectId, OTHER, [DEPT]);
    expect(forOther.has(FREE_AGENT)).toBe(true);
    expect(forOther.has(AGENT)).toBe(false);
    // A stranger with no grants and no depts is assigned to nothing.
    expect((await resolveAssignedAgentNames(ctx.projectId, crypto.randomUUID(), [])).size).toBe(0);
  });
});

describe('unionDeclaredResources — pure union over assigned agents', () => {
  const AGENTS = [
    { name: 'a', env: ['S1', 'S2'], connectors: ['github'] as string[] },
    { name: 'b', env: ['S2', 'S3'], connectors: ['stripe'] as string[] },
    { name: 'c', env: 'all' as const, connectors: 'all' as const },
    { name: 'd', env: [] as string[], connectors: [] as string[] },
  ];

  test('unions + de-dupes the CONCRETE lists of only the assigned agents', () => {
    const { secrets, connectors } = unionDeclaredResources(AGENTS, new Set(['a', 'b']));
    expect([...secrets].sort()).toEqual(['S1', 'S2', 'S3']);
    expect([...connectors].sort()).toEqual(['github', 'stripe']);
  });

  test('preserves PROVENANCE: a name shared by two agents lists both, order = first-seen', () => {
    const { secretSources, connectorSources } = unionDeclaredResources(AGENTS, new Set(['a', 'b']));
    // S2 is declared by both a and b → both are credited.
    expect(secretSources.get('S2')).toEqual(['a', 'b']);
    expect(secretSources.get('S1')).toEqual(['a']);
    expect(secretSources.get('S3')).toEqual(['b']);
    expect(connectorSources.get('github')).toEqual(['a']);
    expect(connectorSources.get('stripe')).toEqual(['b']);
  });

  test("'all' contributes no concrete name; unassigned + empty agents add nothing", () => {
    // Only 'c' ('all') and 'd' ([]) assigned → nothing concrete to inherit.
    const onlyAllAndEmpty = unionDeclaredResources(AGENTS, new Set(['c', 'd']));
    expect(onlyAllAndEmpty.secrets).toEqual([]);
    expect(onlyAllAndEmpty.connectors).toEqual([]);
    expect(onlyAllAndEmpty.secretSources.size).toBe(0);
    // No assignments → empty.
    const none = unionDeclaredResources(AGENTS, new Set());
    expect(none.secrets).toEqual([]);
    expect(none.connectors).toEqual([]);
  });
});
