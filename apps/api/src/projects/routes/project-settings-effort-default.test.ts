/**
 * `PUT /v1/projects/:projectId/default-reasoning-effort` — the project's
 * default reasoning effort (Settings → General).
 *
 * The stored value rides EVERY prompt in the project (`metadata.default_reasoning_effort`,
 * injected at delivery when the prompt carries no variant), so the route:
 *   - writes ONLY its own key through the SQL-side atomic merge
 *     (`metadataMerge`) — the same concurrent-writer guarantee every other
 *     `projects.metadata` writer relies on (see `../lib/metadata-merge.ts`);
 *   - accepts only effort labels the catalog actually publishes;
 *   - never lets a session-bound principal flip it (the sandbox-provider-pin
 *     guard: the agent that wants a different effort has the per-session
 *     picker, not the project-wide switch);
 *   - returns the serialized project with the field re-validated on read.
 *
 * This file drives the REAL `project-settings.ts` Hono handler
 * (`projectsApp.request(...)`) and asserts on the SQL the update actually
 * SETs, serialized through Drizzle's own `PgDialect`.
 *
 * `mock.module` is process-global in bun:test — same caveat as
 * `./project-settings-onboarding-profile.test.ts` — so this MUST run in its own
 * file (`--isolate` gives each test file its own process). Runs ungated (no
 * TEST_DATABASE_URL): the db module is mocked, so there is no database.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '00000000-0000-4000-a000-0000000099c0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000099c1';
const USER_ID = '00000000-0000-4000-a000-0000000099c2';

let returnedRow: Record<string, unknown> | null = null;
let isSessionPrincipal = false;

function projectRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'effort-default-test',
    repoUrl: 'https://github.com/acme/effort-default-test.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const realAuth = await import('../../middleware/auth');
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', USER_ID);
    return next();
  },
}));

let setCalls: Record<string, unknown>[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: async () => [returnedRow ?? projectRow()],
          }),
        };
      },
    }),
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: projectRow(),
    projectRole: 'manager',
    effectiveRole: 'manager',
  }),
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async () => true,
}));

const realAgentScope = await import('../../iam/agent-scope');
mock.module('../../iam/agent-scope', () => ({
  ...realAgentScope,
  isProjectSessionPrincipal: () => isSessionPrincipal,
}));

const { projectsApp } = await import('../lib/app');
(await import('./project-settings')).registerProjectSettingsRoutes();

const dialect = new PgDialect();

function put(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/default-reasoning-effort`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The `metadata` column value, as the statement Postgres would receive. */
function metadataQuery(): { sql: string; params: unknown[] } {
  expect(setCalls).toHaveLength(1);
  const value = setCalls[0]?.metadata;
  // A plain object here would mean the handler went back to read-modify-write
  // on the jsonb, which is exactly what metadata-merge.ts exists to prevent.
  expect(typeof (value as SQL)?.getSQL).toBe('function');
  return dialect.sqlToQuery(value as SQL);
}

beforeEach(() => {
  setCalls = [];
  returnedRow = null;
  isSessionPrincipal = false;
});

describe('PUT /default-reasoning-effort', () => {
  test('stores a published effort label atomically', async () => {
    const res = await put({ effort: 'xhigh' });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    // `(coalesce(metadata,'{}') - key) || patch` is the atomic top-level
    // merge signature; a bare object assignment would be the lossy
    // read-modify-write this route must not do.
    expect(sql).toContain("coalesce(\"kortix\".\"projects\".\"metadata\", '{}'::jsonb)");
    expect(sql).toContain('||');
    // The whole patch is one bound jsonb parameter carrying the key and value.
    expect(params).toContain(JSON.stringify({ default_reasoning_effort: 'xhigh' }));
  });

  test('trims the label before storing it', async () => {
    const res = await put({ effort: '  high ' });

    expect(res.status).toBe(200);
    expect(metadataQuery().params).toContain(JSON.stringify({ default_reasoning_effort: 'high' }));
  });

  test('null clears the stored default', async () => {
    const res = await put({ effort: null });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    // The clear is the delete form: `(... - key) || '{}'`, no patch of the key.
    expect(sql).toContain('-');
    expect(JSON.stringify(params)).not.toContain(JSON.stringify({ default_reasoning_effort: null }));
  });

  test("an empty string clears (the UI's Automatic option may send '')", async () => {
    const res = await put({ effort: '' });

    expect(res.status).toBe(200);
    expect(setCalls).toHaveLength(1);
    expect(dialect.sqlToQuery(setCalls[0]?.metadata as SQL).sql).toContain('-');
  });

  test('rejects a label no catalog model publishes, and writes nothing', async () => {
    const res = await put({ effort: 'ultra' });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_effort');
    expect(setCalls).toHaveLength(0);
  });

  test('rejects a body without the effort key', async () => {
    const res = await put({});

    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });

  test('rejects a non-string effort', async () => {
    const res = await put({ effort: 5 });

    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });

  test('a session-bound principal may not flip the project-wide default', async () => {
    isSessionPrincipal = true;

    const res = await put({ effort: 'high' });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('agent_session_forbidden');
    expect(setCalls).toHaveLength(0);
  });

  test('the response carries the re-validated field', async () => {
    // Valid metadata echoes through; a value written directly to the DB (or
    // before the validator existed) reads as null, never as garbage.
    returnedRow = projectRow({ metadata: { default_reasoning_effort: 'ultra' } });
    const cleared = await put({ effort: null });
    expect((await cleared.json()).default_reasoning_effort).toBe(null);

    setCalls = [];
    returnedRow = projectRow({ metadata: { default_reasoning_effort: 'high' } });
    const kept = await put({ effort: 'low' });
    expect((await kept.json()).default_reasoning_effort).toBe('high');
  });
});
