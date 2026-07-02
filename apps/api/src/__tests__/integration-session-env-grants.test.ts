/**
 * Integration test (real local DB): secret access is enforced at the SANDBOX ENV
 * boundary, not just the GET /secrets list. A member a secret isn't shared with
 * must be unable to read it from $ENV inside their session.
 *
 * Secrets are governed by ONE model — the share model (project_secret_grants +
 * share_scope) — written by both the Secret "Who can access this" dialog AND the
 * Members "Resource access" card (via addSecretResourceGrant). This drives the
 * real `buildSessionSandboxEnvVars` against it:
 *   - an OUTSIDER (not in the allow-list) never gets the restricted secret, but
 *     unscoped secrets still reach them (default = project-wide / open).
 *   - the granted member gets the restricted secret back.
 *
 * Runs against the local Postgres (DATABASE_URL).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import { addSecretResourceGrant, writeSharedProjectSecret } from '../projects/secrets';
import { buildSessionSandboxEnvVars } from '../projects/lib/sessions';

let ctx: { projectId: string; accountId: string } | null = null;
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
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // Two project-wide secrets; then restrict SCOPED to GRANTED_USER via the share
  // model — the same write the Resource-access card and Secrets dialog make.
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: SCOPED, value: 'scoped-val' });
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: UNSCOPED, value: 'open-val' });
  await addSecretResourceGrant({
    projectId: ctx.projectId,
    name: SCOPED,
    principalType: 'member',
    principalId: GRANTED_USER,
  });
});

afterAll(async () => {
  if (!ctx) return;
  // project_secret_grants cascade-delete with their secret rows.
  for (const name of [SCOPED, UNSCOPED]) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, ctx.projectId), eq(projectSecrets.name, name)));
  }
});

describe('secret sharing gates the sandbox env (buildSessionSandboxEnvVars)', () => {
  test('outsider: the restricted secret is dropped from the env, unscoped stays', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    const env = await envFor(OUTSIDER);
    // A member the secret isn't shared with cannot read it from $ENV.
    expect(env[SCOPED]).toBeUndefined();
    // Unscoped secrets remain open — restricting one only affects that secret.
    expect(env[UNSCOPED]).toBe('open-val');
    // The advertised name list must agree with what's actually injected.
    const names = (env.KORTIX_PROJECT_SECRET_NAMES ?? '').split(',');
    expect(names).not.toContain(SCOPED);
    expect(names).toContain(UNSCOPED);
  });

  test('granted member: gets the restricted secret back', async () => {
    if (!ctx) return;
    const env = await envFor(GRANTED_USER);
    expect(env[SCOPED]).toBe('scoped-val');
    expect(env[UNSCOPED]).toBe('open-val');
    expect((env.KORTIX_PROJECT_SECRET_NAMES ?? '').split(',')).toContain(SCOPED);
  });
});
