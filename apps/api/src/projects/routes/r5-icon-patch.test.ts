/**
 * `PATCH /v1/projects/:projectId` — the emoji icon's tri-state semantics, AND
 * the mutual exclusion with `icon_glyph` (see `./r5-glyph-patch.test.ts` for
 * the glyph side of the same invariant).
 *
 * The handler's other writers are truthiness-gated (`if (name) updates.name =
 * name`), which is safe because an empty name is not a meaningful value. `icon`
 * cannot use that shape: `null` IS a meaningful value ("remove the icon"), and
 * `normalizeProjectIcon` collapses BOTH invalid input and an explicit null to
 * `null`. Piping its result straight through would make `icon: "garbage"`
 * indistinguishable from `icon: null` and silently wipe a user's emoji on a
 * malformed request.
 *
 * So there are four cases, and only the request body — not the normalizer's
 * return value — can tell them apart:
 *
 *   | request              | metadata write                              |
 *   |----------------------|----------------------------------------------|
 *   | no `icon` key        | none — the stored icon is untouched           |
 *   | `icon: null`         | `metadataMerge({}, ['icon'])`                 |
 *   | `icon: "🚀"`         | `metadataMerge({ icon: '🚀' }, ['icon_glyph'])`|
 *   | `icon: "garbage"`    | none — the stored icon is untouched           |
 *
 * A project shows ONE icon, so setting `icon` deletes `icon_glyph` in the SAME
 * statement — `metadataMerge`'s second argument, above — and setting
 * `icon_glyph` deletes `icon` the same way. That is why every "icon set"
 * assertion below carries `icon_glyph` as the delete key (`$1`) ahead of the
 * `icon` patch (`$2`): a project could otherwise end up holding both, and a
 * reader would have to invent a tiebreak. See `r5.ts`'s PATCH handler comment
 * for the full seven-case table across both fields.
 *
 * This file drives the REAL `r5.ts` Hono handler (`projectsApp.request(...)`)
 * and asserts on the SQL the update actually SETs, serialized through Drizzle's
 * own `PgDialect`. Asserting on the fragment object would prove only that some
 * object was built; serializing it proves the statement Postgres would run.
 *
 * `mock.module` is process-global in bun:test — same caveat as
 * `./r2-icon-wiring.test.ts` — so this MUST run in its own file (`--isolate`
 * gives each test file its own process; see `scripts/test.sh`). Runs ungated
 * (no TEST_DATABASE_URL): the db module is mocked, so there is no database.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '00000000-0000-4000-a000-0000000099a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000099a1';
const USER_ID = '00000000-0000-4000-a000-0000000099a2';

function projectRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'icon-patch-test',
    repoUrl: 'https://github.com/acme/icon-patch-test.git',
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

describe('PATCH /:projectId — icon absent', () => {
  test('a name-only patch writes NO metadata at all, so the stored icon survives', async () => {
    const res = await patch({ name: 'renamed-only' });

    expect(res.status).toBe(200);
    expect(lastSet().name).toBe('renamed-only');
    // Not `toBeUndefined()`: Drizzle's `.set()` treats a present-but-undefined
    // key differently from an absent one in some versions, and "we never
    // mentioned metadata" is the property that matters.
    expect('metadata' in lastSet()).toBe(false);
  });

  test('an empty patch writes no metadata either', async () => {
    const res = await patch({});

    expect(res.status).toBe(200);
    expect('metadata' in lastSet()).toBe(false);
  });
});

describe('PATCH /:projectId — icon set', () => {
  test('a valid emoji merges `{ icon }` into metadata SQL-side', async () => {
    returningRow = projectRow({ metadata: { icon: '🎯' } });

    const res = await patch({ icon: '🎯' });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    // The `- $n` is the icon/icon_glyph mutual exclusion: setting `icon` must
    // delete `icon_glyph` in the same statement, or a project could hold both.
    expect(sql).toBe(`(coalesce("kortix"."projects"."metadata", '{}'::jsonb) - $1) || $2::jsonb`);
    expect(params).toEqual(['icon_glyph', '{"icon":"🎯"}']);
    // The response is what the browser re-renders from.
    expect(await res.json()).toMatchObject({ icon: '🎯' });
  });

  test('a multi-codepoint emoji survives verbatim into the merged patch', async () => {
    // A ZWJ family is one grapheme but five codepoints; a normalizer that
    // sliced by code unit would land half a sequence in the column.
    await patch({ icon: '👨‍👩‍👧‍👦' });

    expect(metadataQuery().params).toEqual(['icon_glyph', '{"icon":"👨‍👩‍👧‍👦"}']);
  });

  test('the icon is trimmed before it is stored', async () => {
    await patch({ icon: '  🚀  ' });

    expect(metadataQuery().params).toEqual(['icon_glyph', '{"icon":"🚀"}']);
  });

  test('name and icon in one patch both land', async () => {
    const res = await patch({ name: 'renamed-and-iconed', icon: '🎯' });

    expect(res.status).toBe(200);
    expect(lastSet().name).toBe('renamed-and-iconed');
    expect(metadataQuery().params).toEqual(['icon_glyph', '{"icon":"🎯"}']);
  });
});

describe('PATCH /:projectId — icon cleared', () => {
  test('an explicit null DELETES the icon key SQL-side', async () => {
    returningRow = projectRow({ metadata: {} });

    const res = await patch({ icon: null });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    expect(sql).toBe(`(coalesce("kortix"."projects"."metadata", '{}'::jsonb) - $1) || $2::jsonb`);
    expect(params).toEqual(['icon', '{}']);
    expect(await res.json()).toMatchObject({ icon: null });
  });

  test('clearing the icon does not touch any sibling metadata key', async () => {
    // `- 'icon'` names exactly one key; a `metadata: {}` whole-object write
    // would have wiped the routing pin, onboarding stamp and every other
    // top-level key with it.
    await patch({ icon: null });

    const { sql, params } = metadataQuery();
    expect(params[0]).toBe('icon');
    expect(sql.match(/ - \$/g)).toHaveLength(1);
  });

  test('a name-and-clear patch renames AND clears', async () => {
    const res = await patch({ name: 'renamed-and-cleared', icon: null });

    expect(res.status).toBe(200);
    expect(lastSet().name).toBe('renamed-and-cleared');
    expect(metadataQuery().params).toEqual(['icon', '{}']);
  });
});

describe('PATCH /:projectId — invalid icon is NOT a clear', () => {
  // The whole reason this handler cannot use `normalizeProjectIcon(body.icon)`
  // on its own: it returns null for BOTH of these, and for a deliberate clear.
  const rejected: [string, unknown][] = [
    ['plain text', 'garbage'],
    ['a single latin letter', 'A'],
    ['two emoji', '🚀🚀'],
    ['an emoji with a trailing word', '🚀 launch'],
    ['a 5000-char string', 'x'.repeat(5000)],
    ['a number', 42],
    ['an object', { icon: '🚀' }],
    ['an array', ['🚀']],
    ['a boolean', true],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ];

  for (const [label, value] of rejected) {
    test(`${label} leaves the stored icon untouched — no metadata write`, async () => {
      const res = await patch({ icon: value });

      expect(res.status).toBe(200);
      expect('metadata' in lastSet()).toBe(false);
    });
  }

  test('an invalid icon still lets the rest of the patch through', async () => {
    // Same "degrade, never fail" posture as the create paths: the icon is
    // decoration, the rename is not.
    const res = await patch({ name: 'renamed-despite-bad-icon', icon: 'garbage' });

    expect(res.status).toBe(200);
    expect(lastSet().name).toBe('renamed-despite-bad-icon');
    expect('metadata' in lastSet()).toBe(false);
  });
});
