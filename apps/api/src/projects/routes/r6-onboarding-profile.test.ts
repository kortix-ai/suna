/**
 * `PATCH /v1/projects/:projectId/onboarding` — the `profile` envelope.
 *
 * Two independent writes share this route. `completed` is a TOP-LEVEL lifecycle
 * flag (`metadata.onboarding_completed_at`); `profile` is a NESTED object
 * (`metadata.onboarding`) written answer-by-answer as the user moves through the
 * wizard. Neither may disturb the other, and neither may disturb the
 * provider-routing pin that also lives in `metadata`.
 *
 * The nested write must use `metadataMergeSubtree`, which re-reads
 * `metadata->'onboarding'` inside the statement. A top-level `||` merge of the
 * whole sub-object would let two concurrent writers into DIFFERENT sub-keys lose
 * each other's update one level down — see `../lib/metadata-merge.ts`.
 *
 * This file drives the REAL `r6.ts` Hono handler (`projectsApp.request(...)`)
 * and asserts on the SQL the update actually SETs, serialized through Drizzle's
 * own `PgDialect`. Asserting on the fragment object would prove only that some
 * object was built; serializing it proves the statement Postgres would run.
 *
 * `mock.module` is process-global in bun:test — same caveat as
 * `./r5-icon-patch.test.ts` — so this MUST run in its own file (`--isolate`
 * gives each test file its own process). Runs ungated (no TEST_DATABASE_URL):
 * the db module is mocked, so there is no database.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '00000000-0000-4000-a000-0000000099b0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000099b1';
const USER_ID = '00000000-0000-4000-a000-0000000099b2';

function projectRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'onboarding-profile-test',
    repoUrl: 'https://github.com/acme/onboarding-profile-test.git',
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

// ── Auth. Unlike `./r5-icon-patch.test.ts`, this suite CANNOT simply decline to
// import `./r1` (the file that runs `projectsApp.use('/*', supabaseAuth)`):
// `r6.ts` imports `../../executor/sync`, which reaches `../index` and pulls r1
// in transitively. So the middleware is always attached here, and every request
// would 401. Replace it with a pass-through instead. This must be registered
// BEFORE `./r6` is imported, or r1 will already hold the real reference.
const realAuth = await import('../../middleware/auth');
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', USER_ID);
    return next();
  },
}));

/** Every `.set({...})` the handler issued, in call order. */
let setCalls: Record<string, unknown>[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: async () => [projectRow()],
          }),
        };
      },
    }),
  }, auditDb: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: async () => [projectRow()],
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

const { projectsApp } = await import('../lib/app');
await import('./r6');

const dialect = new PgDialect();

function patch(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/onboarding`, {
    method: 'PATCH',
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
});

describe('profile writes', () => {
  test('merges the profile atomically into the nested `onboarding` key', async () => {
    const res = await patch({ profile: { use_case: 'sales', company_size: '51-200' } });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    // jsonb_build_object + a `->` read of the CURRENT sub-object is the
    // signature of metadataMergeSubtree. A bare `||` would be the lossy
    // top-level merge this route must not use.
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain('->');
    expect(params).toContain('onboarding');
    expect(params).toContain(JSON.stringify({ use_case: 'sales', company_size: '51-200' }));
  });

  test('never touches the top-level completion flag', async () => {
    await patch({ profile: { company_domain: 'acme.com' } });

    const { sql, params } = metadataQuery();
    expect(sql).not.toContain('onboarding_completed_at');
    expect(JSON.stringify(params)).not.toContain('onboarding_completed_at');
  });

  test('trims and lowercases the company domain', async () => {
    await patch({ profile: { company_domain: '  ACME.CO.UK  ' } });

    const { params } = metadataQuery();
    expect(params).toContain(JSON.stringify({ company_domain: 'acme.co.uk' }));
  });

  test('drops unknown keys rather than rejecting the request', async () => {
    // Best-effort survey capture: a client sending a field we retired must not
    // break a user's onboarding.
    const res = await patch({ profile: { use_case: 'sales', evil: 'x' } });

    expect(res.status).toBe(200);
    const { params } = metadataQuery();
    expect(JSON.stringify(params)).not.toContain('evil');
    expect(params).toContain(JSON.stringify({ use_case: 'sales' }));
  });

  test('drops values outside the allowed option sets', async () => {
    const res = await patch({ profile: { use_case: 'not-a-use-case', company_size: '7' } });

    expect(res.status).toBe(200);
    // Nothing survived the allowlist, so there is nothing to write.
    expect(setCalls).toHaveLength(0);
  });
});

describe('completion writes', () => {
  test('completed:true writes the top-level flag and no nested merge', async () => {
    const res = await patch({ completed: true });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    expect(sql).not.toContain('jsonb_build_object');
    expect(JSON.stringify(params)).toContain('onboarding_completed_at');
  });

  test('completed:false deletes the top-level flag and no nested merge', async () => {
    const res = await patch({ completed: false });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    expect(sql).not.toContain('jsonb_build_object');
    expect(params).toContain('onboarding_completed_at');
  });
});

describe('no-op requests', () => {
  test('an empty profile object issues no UPDATE', async () => {
    // A no-op UPDATE would still bump `updated_at`, which reorders project
    // lists for no reason.
    const res = await patch({ profile: {} });

    expect(res.status).toBe(200);
    expect(setCalls).toHaveLength(0);
  });

  test('an empty body issues no UPDATE', async () => {
    const res = await patch({});

    expect(res.status).toBe(200);
    expect(setCalls).toHaveLength(0);
  });
});
