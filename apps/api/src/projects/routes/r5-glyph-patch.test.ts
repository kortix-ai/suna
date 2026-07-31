/**
 * `PATCH /v1/projects/:projectId` — the `icon` / `icon_glyph` mutual
 * exclusion and its own tri-state semantics.
 *
 * A project shows ONE icon: an emoji (`metadata.icon`) or a named glyph
 * (`metadata.icon_glyph`). Writing either key must delete the other in the
 * SAME statement, or a project could end up holding both and a reader would
 * have to invent a tiebreak. `metadataMerge(patch, deleteKeys)` builds
 * `(coalesce(metadata,'{}') - key) || patch::jsonb` — one SQL expression
 * evaluated under the row's own lock, so the delete and the merge cannot
 * interleave with another writer.
 *
 * Both normalizers (`normalizeProjectIcon`, `normalizeProjectGlyph`) collapse
 * BOTH invalid input and an explicit `null` to `null`, so only the request
 * BODY — not the normalizer's return value — can tell "clear it" apart from
 * "malformed, leave it alone":
 *
 *   | request              | metadata write                              |
 *   |-----------------------|---------------------------------------------|
 *   | key absent             | none — the stored value is untouched        |
 *   | `icon: "🚀"`           | merge `{ icon }`,       delete `icon_glyph`  |
 *   | `icon: null`           | delete the `icon` key                        |
 *   | `icon: garbage`        | none                                         |
 *   | `icon_glyph: {...}`    | merge `{ icon_glyph }`, delete `icon`        |
 *   | `icon_glyph: null`     | delete the `icon_glyph` key                  |
 *   | `icon_glyph: garbage`  | none                                         |
 *
 * `icon_glyph` is checked FIRST, so a request carrying both valid values
 * resolves the same way the three create paths resolve it: the glyph wins.
 *
 * This file drives the REAL `r5.ts` Hono handler (`projectsApp.request(...)`)
 * and asserts on the SQL the update actually SETs, serialized through
 * Drizzle's own `PgDialect`. Asserting on the fragment object would prove
 * only that some object was built; serializing it proves the statement
 * Postgres would run.
 *
 * `mock.module` is process-global in bun:test — same caveat as
 * `./r5-icon-patch.test.ts` — so this MUST run in its own file (`--isolate`
 * gives each test file its own process; see `scripts/test.sh`). Runs ungated
 * (no TEST_DATABASE_URL): the db module is mocked, so there is no database.
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
    name: 'glyph-patch-test',
    repoUrl: 'https://github.com/acme/glyph-patch-test.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: { icon: '🚀' },
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Every `.set({...})` the handler issued, in call order. */
let setCalls: Record<string, unknown>[] = [];
/** What `.returning()` resolves to for the next update. */
let returningRow: Record<string, unknown> = projectRow();

// ── The database. Only `update(...).set(...).where(...).returning()` is
// reachable from this handler, so only that chain is implemented; anything else
// throws rather than silently resolving.
mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: async () => [returningRow],
          }),
        };
      },
    }),
  },
}));

// ── Access + capability. No DB, no IAM.
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

// Registers r5.ts's routes onto the shared `projectsApp` singleton. r1.ts
// (which attaches the `supabaseAuth` middleware) is deliberately NOT imported,
// so these requests need no Authorization header.
const { projectsApp } = await import('../lib/app');
await import('./r5');

const dialect = new PgDialect();

function patch(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The single `.set()` the handler issued for the last request. */
function lastSet(): Record<string, unknown> {
  expect(setCalls).toHaveLength(1);
  const [set] = setCalls;
  // The assertion above already failed the test if the handler issued no
  // update; the throw is only here to narrow the type for the caller.
  if (!set) throw new Error('the handler issued no .set()');
  return set;
}

/** The `metadata` column value, as the statement Postgres would receive. */
function metadataQuery(): { sql: string; params: unknown[] } {
  const value = lastSet().metadata;
  // A plain object here would mean the handler went back to read-modify-write
  // on the jsonb, which is exactly what metadata-merge.ts exists to prevent.
  expect(typeof (value as SQL)?.getSQL).toBe('function');
  const { sql, params } = dialect.sqlToQuery(value as SQL);
  return { sql, params };
}

beforeEach(() => {
  setCalls = [];
  returningRow = projectRow();
});

describe('PATCH /:projectId — glyph set', () => {
  test('a valid glyph merges it AND deletes the icon key', async () => {
    const res = await patch({ icon_glyph: { name: 'Rocket', color: 'blue' } });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    // The `- $n` is the invariant. Without it a project could hold both.
    expect(sql).toBe(`(coalesce("kortix"."projects"."metadata", '{}'::jsonb) - $1) || $2::jsonb`);
    expect(params).toEqual(['icon', '{"icon_glyph":{"name":"Rocket","color":"blue"}}']);
  });

  test('an invalid-name glyph is rejected the same as any other garbage', async () => {
    await patch({ icon_glyph: { name: 'NotAGlyph', color: 'blue' } });

    expect('metadata' in lastSet()).toBe(false);
  });

  test('an invalid-color glyph is rejected the same as any other garbage', async () => {
    await patch({ icon_glyph: { name: 'Rocket', color: 'chartreuse' } });

    expect('metadata' in lastSet()).toBe(false);
  });
});

describe('PATCH /:projectId — icon set', () => {
  test('a valid emoji merges it AND deletes the glyph key', async () => {
    const res = await patch({ icon: '🚀' });

    expect(res.status).toBe(200);
    const { params } = metadataQuery();
    expect(params).toEqual(['icon_glyph', '{"icon":"🚀"}']);
  });
});

describe('PATCH /:projectId — explicit null clears exactly one key', () => {
  test('an explicit null deletes only the glyph key', async () => {
    returningRow = projectRow({ metadata: {} });

    await patch({ icon_glyph: null });

    const { params } = metadataQuery();
    expect(params).toEqual(['icon_glyph', '{}']);
  });

  test('an explicit null deletes only the icon key', async () => {
    returningRow = projectRow({ metadata: {} });

    await patch({ icon: null });

    const { params } = metadataQuery();
    expect(params).toEqual(['icon', '{}']);
  });
});

describe('PATCH /:projectId — malformed value is NOT a clear', () => {
  test('a malformed glyph writes NO metadata, so the stored value survives', async () => {
    const res = await patch({ icon_glyph: { name: 'Skull', color: 'red' } });

    expect(res.status).toBe(200);
    expect('metadata' in lastSet()).toBe(false);
  });

  test('a malformed emoji writes NO metadata, so the stored value survives', async () => {
    const res = await patch({ icon: 'garbage' });

    expect(res.status).toBe(200);
    expect('metadata' in lastSet()).toBe(false);
  });
});

describe('PATCH /:projectId — neither key present', () => {
  test('a name-only patch writes no metadata at all', async () => {
    const res = await patch({ name: 'renamed-only' });

    expect(res.status).toBe(200);
    expect(lastSet().name).toBe('renamed-only');
    expect('metadata' in lastSet()).toBe(false);
  });

  test('an empty patch writes no metadata either', async () => {
    const res = await patch({});

    expect(res.status).toBe(200);
    expect('metadata' in lastSet()).toBe(false);
  });
});

describe('PATCH /:projectId — both keys present, the glyph wins', () => {
  test('when both are valid the glyph wins and the emoji is not written', async () => {
    const res = await patch({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });

    expect(res.status).toBe(200);
    const { params } = metadataQuery();
    expect(params).toEqual(['icon', '{"icon_glyph":{"name":"Star","color":"red"}}']);
  });

  test('a valid emoji with a malformed glyph writes NO metadata — icon_glyph wins the check, not the write', async () => {
    // `icon_glyph` is checked FIRST regardless of validity: a malformed glyph
    // short-circuits the whole block, so a syntactically valid `icon` sitting
    // alongside it is never reached. This is the same "glyph wins" precedence,
    // just visible on the failure path instead of the success path.
    const res = await patch({ icon: '🚀', icon_glyph: { name: 'Skull', color: 'red' } });

    expect(res.status).toBe(200);
    expect('metadata' in lastSet()).toBe(false);
  });
});
