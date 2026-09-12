/**
 * Pre-existing `refs/heads/*` ref rows, at runtime and through the migration
 * that consolidates them.
 *
 * A row written before ref keys were normalized is a different row under the
 * table's unique key, so a lookup for `main` cannot see it: its revision is
 * never read, its generation comes back null, and the next observation creates
 * a SECOND row for the same branch — two revisions of one ref, one of them
 * permanently due for reconciliation and invisible to everything else.
 *
 * Every fixture here is inserted RAW, exactly as an older build left it.
 *
 * Run (from apps/api):
 *   dotenvx run -f .env.local -f .env --quiet -- bash -c 'export \
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:13922/postgres \
 *     KORTIX_URL=http://127.0.0.1:13608; bun test --isolate \
 *     src/__tests__/integration-repo-snapshot-ref-alias.test.ts'
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  beginRefObservation,
  claimRefsDueForReconcile,
  ensureRefReconcileScheduled,
  observeRepoRef,
  readRepoRef,
} from '../repo-snapshots/store';

const ALLOW_SKIP = process.env.KORTIX_REPO_SNAPSHOT_E2E === 'skip';
let ready = false;
let reason = '';
/** One id per case, so nothing here can collide with or delete another writer's rows. */
const ids = {
  aliasOnly: String(910000000 + Math.floor(Math.random() * 9000000)),
  bothSpellings: String(911000000 + Math.floor(Math.random() * 9000000)),
  migrationAlias: String(912000000 + Math.floor(Math.random() * 9000000)),
  migrationBoth: String(913000000 + Math.floor(Math.random() * 9000000)),
};
const shaOld = 'a'.repeat(40);
const shaNew = 'b'.repeat(40);

async function insertRaw(input: {
  repositoryId: string;
  ref: string;
  desiredSha: string | null;
  revision: number;
  reconcileAfter?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into kortix.repo_snapshot_refs
      (provider, repository_id, owner, repo, ref, desired_sha, revision, observed_at, observed_via, reconcile_after)
    values ('github', ${input.repositoryId}, 'kortix-ai', 'alias-fixture', ${input.ref}, ${input.desiredSha},
            ${input.revision}, now(), 'webhook', ${input.reconcileAfter ?? null}::timestamptz)`);
}

async function rowsFor(repositoryId: string) {
  return (await db.execute(sql`
    select ref, desired_sha, revision from kortix.repo_snapshot_refs
    where provider = 'github' and repository_id = ${repositoryId} order by ref`)) as unknown as Array<{
    ref: string;
    desired_sha: string | null;
    revision: string;
  }>;
}

beforeAll(async () => {
  try {
    await db.execute(sql`select 1 from kortix.repo_snapshot_refs limit 1`);
    ready = true;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
});

afterAll(async () => {
  for (const repositoryId of Object.values(ids)) {
    await db
      .execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${repositoryId}`)
      .catch(() => {});
  }
});

function guard(): boolean {
  if (ready) return true;
  if (!ALLOW_SKIP) throw new Error(`ref alias prerequisites missing — ${reason}`);
  console.warn(`[ref-alias] SKIPPED by KORTIX_REPO_SNAPSHOT_E2E=skip — ${reason}`);
  return false;
}

describe('a ref row stored under the old full-ref spelling stays usable', () => {
  const identity = (repositoryId: string) => ({ provider: 'github' as const, repositoryId });

  test('both spellings read the one existing row', async () => {
    if (!guard()) return;
    await insertRaw({ repositoryId: ids.aliasOnly, ref: 'refs/heads/main', desiredSha: shaOld, revision: 7 });

    expect((await readRepoRef(identity(ids.aliasOnly), 'main'))?.desiredSha).toBe(shaOld);
    expect((await readRepoRef(identity(ids.aliasOnly), 'refs/heads/main'))?.desiredSha).toBe(shaOld);
  });

  test('its generation is the one the database holds, not null', async () => {
    if (!guard()) return;
    const token = await beginRefObservation(identity(ids.aliasOnly), 'main');
    // A null generation here would make the next write insert-only, and the
    // observation would be silently dropped for as long as the alias exists.
    expect(token.generation).toBe(7);

    await observeRepoRef({
      identity: { ...identity(ids.aliasOnly), owner: 'kortix-ai', repo: 'alias-fixture' },
      ref: 'main',
      desiredSha: shaNew,
      via: 'reconcile',
      token,
    });
    const rows = await rowsFor(ids.aliasOnly);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.desired_sha).toBe(shaNew);
    expect(Number(rows[0]?.revision)).toBe(8);
  });

  test('scheduling through either spelling leaves no second, permanently due row', async () => {
    if (!guard()) return;
    await ensureRefReconcileScheduled({
      identity: { ...identity(ids.aliasOnly), owner: 'kortix-ai', repo: 'alias-fixture' },
      ref: 'refs/heads/main',
      at: new Date(Date.now() + 600_000),
    });
    const rows = await rowsFor(ids.aliasOnly);
    expect(rows).toHaveLength(1);
    const due = (await db.execute(sql`
      select ref from kortix.repo_snapshot_refs
      where repository_id = ${ids.aliasOnly} and reconcile_after <= now()`)) as unknown as Array<{ ref: string }>;
    expect(due).toHaveLength(0);
  });

  test('the canonical row wins when both spellings exist', async () => {
    if (!guard()) return;
    await insertRaw({ repositoryId: ids.bothSpellings, ref: 'main', desiredSha: shaNew, revision: 3 });
    await insertRaw({
      repositoryId: ids.bothSpellings,
      ref: 'refs/heads/main',
      desiredSha: shaOld,
      revision: 9,
    });
    // A higher revision on the alias must not make it authoritative: the
    // canonical row is the one every other reader already uses.
    expect((await readRepoRef(identity(ids.bothSpellings), 'main'))?.desiredSha).toBe(shaNew);
    expect((await beginRefObservation(identity(ids.bothSpellings), 'main')).generation).toBe(3);
  });

  test('a claimed alias row still reconciles under its own spelling', async () => {
    if (!guard()) return;
    await insertRaw({
      repositoryId: ids.migrationAlias,
      ref: 'refs/heads/release',
      desiredSha: shaOld,
      revision: 2,
      reconcileAfter: new Date(Date.now() - 60_000).toISOString(),
    });
    const claimed = await claimRefsDueForReconcile(50);
    const mine = claimed.find((row) => row.repositoryId === ids.migrationAlias);
    expect(mine?.ref).toBe('refs/heads/release');
  });
});

describe('the consolidation migration folds old rows into the canonical one', () => {
  /** The real migration, driven against this database through the three calls it makes. */
  async function runMigration(): Promise<void> {
    const { up } = await import(
      '../../../../packages/db/migrations/20260912164500000_repo_snapshot_ref_alias_consolidation.concurrent'
    );
    await up({
      noTransaction: () => {},
      sql: async (text: string) => {
        await db.execute(sql.raw(text));
      },
      db: {
        query: async (text: string) => {
          const rows = (await db.execute(sql.raw(text))) as unknown as unknown[];
          return { rowCount: Array.isArray(rows) ? rows.length : 0, rows };
        },
      },
    } as never);
  }

  test('an alias-only row is renamed in place, keeping its revision', async () => {
    if (!guard()) return;
    await insertRaw({
      repositoryId: ids.migrationBoth,
      ref: 'refs/heads/feature',
      desiredSha: shaOld,
      revision: 4,
    });
    await runMigration();

    const rows = await rowsFor(ids.migrationBoth);
    expect(rows.map((r) => r.ref)).toEqual(['feature']);
    expect(rows[0]?.desired_sha).toBe(shaOld);
    expect(Number(rows[0]?.revision)).toBe(4);
  });

  test('a duplicated branch keeps the later observation and one row', async () => {
    if (!guard()) return;
    await db.execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${ids.migrationBoth}`);
    await insertRaw({ repositoryId: ids.migrationBoth, ref: 'main', desiredSha: shaOld, revision: 3 });
    await insertRaw({
      repositoryId: ids.migrationBoth,
      ref: 'refs/heads/main',
      desiredSha: shaNew,
      revision: 9,
    });
    await runMigration();

    const rows = await rowsFor(ids.migrationBoth);
    expect(rows.map((r) => r.ref)).toEqual(['main']);
    // The alias held the later observation, so its SHA survives …
    expect(rows[0]?.desired_sha).toBe(shaNew);
    // … and the revision moves past both, so no in-flight CAS token matches.
    expect(Number(rows[0]?.revision)).toBe(10);
  });

  test('running it again changes nothing', async () => {
    if (!guard()) return;
    const before = await rowsFor(ids.migrationBoth);
    await runMigration();
    expect(await rowsFor(ids.migrationBoth)).toEqual(before);
  });
});
