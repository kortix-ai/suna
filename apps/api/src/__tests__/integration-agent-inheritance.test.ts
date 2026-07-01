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
});
