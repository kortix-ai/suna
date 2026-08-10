import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

// PATCH /v1/projects/:workspaceId/features (canonical) and .../experimental
// (deprecated alias) drive the real HTTP route against the real DB. The two
// paths share one handler, so the alias must be byte-for-byte equivalent, and
// the ordering fixes this route was rewritten for must hold:
//   • an archived project is read-only — 404 BEFORE the metadata write, not
//     after it (the old handler committed the mutation and then 404'd);
//   • a malformed body is a 400, not a silently-empty object that reports the
//     misleading "Unknown feature flag 'undefined'".
const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const ARCHIVED = crypto.randomUUID();
const EDITOR = crypto.randomUUID();

const minted: string[] = [];
let secret = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'feature-flag-toggle-test' });
  await db.insert(projects).values([
    {
      workspaceId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'feature-flag-toggle-test-project',
      repoUrl: 'https://example.com/feature-flag-toggle.git',
    },
    {
      workspaceId: ARCHIVED,
      accountId: ACCOUNT,
      name: 'feature-flag-toggle-archived-project',
      repoUrl: 'https://example.com/feature-flag-toggle-archived.git',
      status: 'archived',
      metadata: { experimental: { apps: true } },
    },
  ]);
  await db
    .insert(accountMembers)
    .values({ userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false });
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: EDITOR, projectRole: 'editor' },
    { accountId: ACCOUNT, workspaceId: ARCHIVED, userId: EDITOR, projectRole: 'editor' },
  ]);

  // Account-scoped (no workspaceId): a project-scoped token is rejected by the
  // auth middleware before the handler when it addresses a different project,
  // and this suite must reach the handler for BOTH projects.
  const token = await createAccountToken({
    accountId: ACCOUNT,
    userId: EDITOR,
    name: 'feature-flag-toggle-test',
  });
  minted.push(token.tokenId);
  secret = token.secretKey;
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

function patch(path: string, body: string | undefined) {
  return app.request(path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  });
}

async function storedOverrides(workspaceId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  return (row?.metadata as { experimental?: Record<string, unknown> } | null)?.experimental;
}

describe('PATCH /v1/projects/:workspaceId/features', () => {
  test('sets, then clears, a per-project override', async () => {
    const on = await patch(`/v1/projects/${WORKSPACE}/features`, JSON.stringify({ feature: 'apps', enabled: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).experimental.apps).toBe(true);
    expect(await storedOverrides(WORKSPACE)).toEqual({ apps: true });

    const off = await patch(`/v1/projects/${WORKSPACE}/features`, JSON.stringify({ feature: 'apps', enabled: false }));
    expect(off.status).toBe(200);
    expect((await off.json()).experimental.apps).toBe(false);
    expect(await storedOverrides(WORKSPACE)).toEqual({ apps: false });

    const cleared = await patch(`/v1/projects/${WORKSPACE}/features`, JSON.stringify({ feature: 'apps', enabled: null }));
    expect(cleared.status).toBe(200);
    // apps' platform default is off, so clearing the override lands back on false.
    expect((await cleared.json()).experimental.apps).toBe(false);
    expect(await storedOverrides(WORKSPACE)).toBeUndefined();
  });

  test('the /experimental alias behaves identically', async () => {
    const viaAlias = await patch(
      `/v1/projects/${WORKSPACE}/experimental`,
      JSON.stringify({ feature: 'review_center', enabled: true }),
    );
    expect(viaAlias.status).toBe(200);
    const aliasBody = await viaAlias.json();
    expect(aliasBody.experimental.review_center).toBe(true);
    expect(await storedOverrides(WORKSPACE)).toEqual({ review_center: true });

    const viaCanonical = await patch(
      `/v1/projects/${WORKSPACE}/features`,
      JSON.stringify({ feature: 'review_center', enabled: true }),
    );
    expect(viaCanonical.status).toBe(200);
    const canonicalBody = await viaCanonical.json();
    expect(canonicalBody.experimental).toEqual(aliasBody.experimental);
    expect(canonicalBody.experimental_features).toEqual(aliasBody.experimental_features);

    await patch(
      `/v1/projects/${WORKSPACE}/features`,
      JSON.stringify({ feature: 'review_center', enabled: null }),
    );
  });

  test('an unknown flag is a 400', async () => {
    const res = await patch(`/v1/projects/${WORKSPACE}/features`, JSON.stringify({ feature: 'nope', enabled: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown feature flag 'nope'");
    expect(await storedOverrides(WORKSPACE)).toBeUndefined();
  });

  test('a non-boolean, non-null `enabled` is a 400', async () => {
    const res = await patch(`/v1/projects/${WORKSPACE}/features`, JSON.stringify({ feature: 'apps', enabled: 'yes' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('enabled must be a boolean or null');
    expect(await storedOverrides(WORKSPACE)).toBeUndefined();
  });

  test('a malformed body is a 400, never a misreported unknown flag', async () => {
    // Unparseable / non-object bodies are rejected by the route's zod body
    // validator (the shared `{ error: true, message: 'Validation failed' }`
    // envelope) before the handler runs.
    for (const body of ['{ not json', '"apps"', 'null']) {
      const res = await patch(`/v1/projects/${WORKSPACE}/features`, body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).not.toContain('Unknown feature flag');
    }
    const array = await patch(`/v1/projects/${WORKSPACE}/features`, '[]');
    expect(array.status).toBe(400);
    expect(JSON.stringify(await array.json())).not.toContain('Unknown feature flag');
    expect(await storedOverrides(WORKSPACE)).toBeUndefined();
  });

  test('a body that bypasses the JSON validator still 400s in the handler', async () => {
    // Without `content-type: application/json` the zod body validator does not
    // run, so the handler's own strict-body guard is the one that answers.
    const res = await app.request(`/v1/projects/${WORKSPACE}/features`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${secret}` },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Request body must be a JSON object');
    expect(await storedOverrides(WORKSPACE)).toBeUndefined();
  });

  test('an archived project is 404 and its metadata is NOT mutated', async () => {
    for (const path of [`/v1/projects/${ARCHIVED}/features`, `/v1/projects/${ARCHIVED}/experimental`]) {
      const res = await patch(path, JSON.stringify({ feature: 'apps', enabled: false }));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Not found');
      expect(await storedOverrides(ARCHIVED)).toEqual({ apps: true });
    }
  });
});
