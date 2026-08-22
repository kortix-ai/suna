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
 * "malformed, leave it alone". Resolution is by VALIDITY, not by key
 * presence, so a PATCH agrees with the three create paths on every shared
 * input, including a body that carries both keys:
 *
 *   | request                                          | metadata write                     |
 *   |---------------------------------------------------|-------------------------------------|
 *   | neither key present                                | none — the stored value is untouched |
 *   | `icon_glyph` valid                                 | merge `{ icon_glyph }`, delete `icon` |
 *   | `icon_glyph` invalid, `icon` valid                 | merge `{ icon }`,       delete `icon_glyph` |
 *   | `icon_glyph: null`, `icon` valid                   | merge `{ icon }`,       delete `icon_glyph` |
 *   | `icon` valid alone                                 | merge `{ icon }`,       delete `icon_glyph` |
 *   | `icon: null` alone                                 | delete the `icon` key |
 *   | `icon_glyph: null` alone (no valid icon)           | delete the `icon_glyph` key |
 *   | `icon: null` AND `icon_glyph: null` (both explicit) | delete BOTH keys |
 *   | `icon` invalid alone                               | none |
 *   | both invalid, neither explicitly `null`            | none |
 *
 * `icon_glyph` is checked FIRST, so a request carrying both valid values
 * resolves the same way the three create paths resolve it: the glyph wins —
 * and it wins on VALIDITY, not on which key the body happens to name, so an
 * invalid/absent glyph never blocks a valid `icon` from being written. Only
 * an explicit `null` on a key clears THAT key; a malformed value must never
 * wipe a choice the user made. Both keys `null` in the SAME request reads as
 * "clear the icon entirely" and clears both, rather than privileging one key.
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

  test('a valid emoji with a malformed glyph falls through to the emoji, same as the create paths', async () => {
    // `icon_glyph` is checked first, but by VALIDITY, not by key presence: a
    // malformed glyph does not win the check, it just fails to be a valid
    // glyph, so the handler falls through to the (valid) `icon`. Before this
    // fix, `icon_glyph` winning on key presence alone made this request write
    // NO metadata at all — a silent lost write, and a disagreement with
    // /provision, /create-repo, and /link-repository, which all resolve this
    // exact body to `{ icon }` via `iconGlyph ? … : icon ? { icon } : {}`.
    const res = await patch({ icon: '🚀', icon_glyph: { name: 'Skull', color: 'red' } });

    expect(res.status).toBe(200);
    const { params } = metadataQuery();
    expect(params).toEqual(['icon_glyph', '{"icon":"🚀"}']);
  });

  test('an explicit icon_glyph: null with a valid icon falls through to the emoji', async () => {
    // Same fall-through, from the OTHER shape of "no valid glyph": an explicit
    // null rather than garbage. Before this fix this also wrote nothing.
    const res = await patch({ icon: '🚀', icon_glyph: null });

    expect(res.status).toBe(200);
    const { params } = metadataQuery();
    expect(params).toEqual(['icon_glyph', '{"icon":"🚀"}']);
  });
});

describe('PATCH /:projectId — both keys explicitly null clears both', () => {
  test('icon: null AND icon_glyph: null deletes both keys in one statement', async () => {
    // Neither side resolves to a value worth storing, and BOTH keys carry an
    // explicit null — the deliberate decision for this ambiguous case: it
    // reads as "clear the icon entirely" rather than privileging one key's
    // deletion over the other's.
    returningRow = projectRow({ metadata: {} });

    const res = await patch({ icon: null, icon_glyph: null });

    expect(res.status).toBe(200);
    const { sql, params } = metadataQuery();
    expect(sql).toBe(
      `((coalesce("kortix"."projects"."metadata", '{}'::jsonb) - $1) - $2) || $3::jsonb`,
    );
    expect(params).toEqual(['icon_glyph', 'icon', '{}']);
  });
});
