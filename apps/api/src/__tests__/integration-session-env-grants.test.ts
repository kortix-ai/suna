/**
 * Integration test (real local DB): session-env injection under the secrets v2
 * identifier model. Authorization is centralized on the agent's `secrets`
 * grant, applied BY IDENTIFIER via `listProjectSecretsSnapshotForUser` (the
 * resolver `buildSessionSandboxEnvVars` calls at sandbox boot) — there is no
 * resource-side allow-list and no per-secret member/group sharing left to test.
 *
 * Covers the model's headline scenario: two identifiers sharing one env-var
 * KEY (GMAPS-primary / GMAPS-backup, both GOOGLE_MAPS_API_KEY) — an agent
 * granted one specific identifier gets exactly that value injected.
 *
 * Runs against the local Postgres (DATABASE_URL).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { projectSecrets, projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import { resolveSandboxEnvSnapshot } from '../projects/lib/sandbox-env-sync';
import {
  AmbiguousSecretGrantError,
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  writeSharedProjectSecret,
} from '../projects/secrets';

let ctx: { projectId: string; accountId: string } | null = null;
const USER = crypto.randomUUID();
const SESSION_ID = `e2e-clobber-${crypto.randomUUID()}`;
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const KEY = `E2E_GMAPS_${SUFFIX}`;
const PRIMARY = `${KEY}-primary`;
const BACKUP = `${KEY}-backup`;
const UNSCOPED = `E2E_UNSCOPED_${SUFFIX}`;

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // Two identifiers, SAME key — the headline secrets-v2 scenario.
  await writeSharedProjectSecret({ projectId: ctx.projectId, identifier: PRIMARY, name: KEY, value: 'primary-val' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, identifier: BACKUP, name: KEY, value: 'backup-val' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: UNSCOPED, value: 'open-val' });
});

afterAll(async () => {
  if (!ctx) return;
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID));
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx.projectId), inArray(projectSecrets.identifier, [PRIMARY, BACKUP, UNSCOPED])));
});

describe('listProjectSecretsSnapshotForUser — session env injection by identifier', () => {
  test('an agent granted ONE identifier gets exactly that value under the shared key', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    const { env, names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [PRIMARY]);
    expect(env[KEY]).toBe('primary-val');
    expect(names).toContain(KEY);
    // Only the granted identifier's key is present — nothing else leaks in.
    expect(Object.keys(env)).toEqual([KEY]);
  });

  test('a DIFFERENT identifier grant gets the OTHER value under the same key', async () => {
    if (!ctx) return;
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [BACKUP]);
    expect(env[KEY]).toBe('backup-val');
  });

  test("'all' (default/back-compat) sees every identifier, deterministically resolving the shared key", async () => {
    if (!ctx) return;
    const { env, names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, 'all');
    expect(env[UNSCOPED]).toBe('open-val');
    expect(names).toContain(UNSCOPED);
    // One of the two GMAPS values wins deterministically — never both/neither.
    expect([isEitherGmapsValue(env)]).toContain(true);
  });

  test('an agent granted BOTH identifiers for the same key is ambiguous — rejected', async () => {
    if (!ctx) return;
    await expect(
      listProjectSecretsSnapshotForUser(ctx.projectId, USER, [PRIMARY, BACKUP]),
    ).rejects.toThrow(AmbiguousSecretGrantError);
  });

  test('an unscoped (single-identifier) secret is unaffected by the collision above', async () => {
    if (!ctx) return;
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [UNSCOPED]);
    expect(env).toEqual({ [UNSCOPED]: 'open-val' });
  });

  test('a KaaB per-session allowlist narrows an "all" agent grant (the boot/hot-push composition)', async () => {
    if (!ctx) return;
    // Both sandbox boot (buildSessionSandboxEnvVars) and hot-push
    // (resolveOwnerRawEnv) compose intersectSecretGrants(grant, allowlist) and
    // pass the result to this resolver. An "all" agent grant narrowed by a
    // session allowlist of [UNSCOPED] must inject ONLY that secret — proving the
    // narrowing against the real DB, end-to-end with the functions in the path.
    const narrowed = intersectSecretGrants('all', [UNSCOPED]);
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, narrowed);
    expect(env).toEqual({ [UNSCOPED]: 'open-val' });

    // A null allowlist is a passthrough — every secret the grant already allowed
    // (byte-identical to pre-KaaB).
    const passthrough = intersectSecretGrants('all', null);
    const { names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, passthrough);
    expect(names).toContain(UNSCOPED);
    expect(names).toContain(KEY);
  });

  test('resolveSandboxEnvSnapshot (hot-push) reads + applies the session secretsAllowlist — the CLOBBER FIX', async () => {
    if (!ctx) return;
    await db.insert(projectSessions).values({
      sessionId: SESSION_ID,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      branchName: 'kaab-clobber-test',
      createdBy: USER,
      agentName: 'default',
      secretsAllowlist: [UNSCOPED],
    });
    const narrowed = await resolveSandboxEnvSnapshot(ctx.projectId, SESSION_ID);
    expect(narrowed?.env[UNSCOPED]).toBe('open-val');
    expect(narrowed?.env[KEY]).toBeUndefined();

    await db
      .update(projectSessions)
      .set({ secretsAllowlist: null })
      .where(eq(projectSessions.sessionId, SESSION_ID));
    const passthroughSnap = await resolveSandboxEnvSnapshot(ctx.projectId, SESSION_ID);
    expect(passthroughSnap?.env[UNSCOPED]).toBe('open-val');
    expect(passthroughSnap?.env[KEY]).toBeDefined();
  });
});

function isEitherGmapsValue(env: Record<string, string>): boolean {
  return env[KEY] === 'primary-val' || env[KEY] === 'backup-val';
}
