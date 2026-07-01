/**
 * Integration test (real local DB): per-secret resource grants are enforced at
 * the SANDBOX ENV boundary, not just the GET /secrets list. This is the runtime
 * teeth of the feature — a member who can't see TEST_KEY in the UI must also be
 * unable to read it from $ENV inside their session.
 *
 * Drives the real `buildSessionSandboxEnvVars` (the session-start env resolver)
 * against a real project + real iam_resource_grants rows:
 *   - an OUTSIDER (not granted, not owner/admin) never gets the scoped secret,
 *     but unscoped secrets still reach them (default = open).
 *   - the GRANTED member gets the scoped secret back.
 *
 * Runs against the local Postgres (DATABASE_URL). Ensures the grants table
 * exists in beforeAll (the local DB may be behind on migrations).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMembers, projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import { upsertResourceGrant } from '../iam/resource-grants';
import { writeSharedProjectSecret } from '../projects/secrets';
import { buildSessionSandboxEnvVars } from '../projects/lib/sessions';

let ctx: { projectId: string; accountId: string } | null = null;
const grantCleanup: string[] = [];
// Both are seeded as PLAIN members (account_role='member') so neither gets the
// owner/admin implicit-Manager bypass — the per-secret grant is the only thing
// that can let a secret through. (account_members has no FK to auth.users, so
// arbitrary uuids are safe to seed; the only FK is account_id → accounts.)
const GRANTED_USER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
// Unique names so we never collide with real project secrets / parallel runs.
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const SCOPED = `E2E_SCOPED_${SUFFIX}`;
const UNSCOPED = `E2E_UNSCOPED_${SUFFIX}`;

async function envFor(userId: string): Promise<Record<string, string>> {
  if (!ctx) throw new Error('no ctx');
  return buildSessionSandboxEnvVars({
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    sessionId: crypto.randomUUID(),
    userId,
    repoUrl: '',
    baseRef: 'main',
    agentName: 'default',
    llmGatewayEnabled: false,
  });
}

beforeAll(async () => {
  await db.execute(sql`create table if not exists kortix.iam_resource_grants (
    grant_id uuid primary key default gen_random_uuid(),
    account_id uuid not null,
    project_id uuid not null,
    resource_type varchar(32) not null,
    resource_id text not null,
    principal_type varchar(16) not null,
    principal_id uuid not null,
    effect varchar(8) not null default 'allow',
    expires_at timestamptz,
    granted_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await db.execute(
    sql`create unique index if not exists uq_iam_resource_grants on kortix.iam_resource_grants (project_id, resource_type, resource_id, principal_type, principal_id)`,
  );
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // Seed the two actors as plain members of the project's account.
  await db
    .insert(accountMembers)
    .values([
      { userId: GRANTED_USER, accountId: ctx.accountId, accountRole: 'member', isSuperAdmin: false },
      { userId: OUTSIDER, accountId: ctx.accountId, accountRole: 'member', isSuperAdmin: false },
    ])
    .onConflictDoNothing();

  // Two project-wide (shareScope='project') secrets: both readable by anyone by
  // default — so what restricts SCOPED is purely the resource grant, nothing else.
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: SCOPED, value: 'scoped-val' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: UNSCOPED, value: 'open-val' });

  // Scope SCOPED to GRANTED_USER only.
  const { grantId } = await upsertResourceGrant({
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    resourceType: 'secret',
    resourceId: SCOPED,
    principalType: 'member',
    principalId: GRANTED_USER,
    grantedBy: GRANTED_USER,
  });
  grantCleanup.push(grantId);
});

afterAll(async () => {
  if (!ctx) return;
  for (const id of grantCleanup) {
    await db.execute(sql`delete from kortix.iam_resource_grants where grant_id = ${id}`);
  }
  for (const name of [SCOPED, UNSCOPED]) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, ctx.projectId), eq(projectSecrets.name, name)));
  }
  await db
    .delete(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, ctx.accountId),
        inArray(accountMembers.userId, [GRANTED_USER, OUTSIDER]),
      ),
    );
});

describe('per-secret grants gate the sandbox env (buildSessionSandboxEnvVars)', () => {
  test('outsider: scoped-out secret is dropped from the env, unscoped stays', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    const env = await envFor(OUTSIDER);
    // The whole point: a member who was never granted SCOPED cannot read it from $ENV.
    expect(env[SCOPED]).toBeUndefined();
    // Unscoped secrets remain open — grants only restrict what they name.
    expect(env[UNSCOPED]).toBe('open-val');
    // The advertised name list must agree with what's actually injected.
    const names = (env.KORTIX_PROJECT_SECRET_NAMES ?? '').split(',');
    expect(names).not.toContain(SCOPED);
    expect(names).toContain(UNSCOPED);
  });

  test('granted member: gets the scoped secret back', async () => {
    if (!ctx) return;
    const env = await envFor(GRANTED_USER);
    expect(env[SCOPED]).toBe('scoped-val');
    expect(env[UNSCOPED]).toBe('open-val');
    expect((env.KORTIX_PROJECT_SECRET_NAMES ?? '').split(',')).toContain(SCOPED);
  });
});
