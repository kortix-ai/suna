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
/** Extra ids the race cases create; cleaned with the rest. */
const ownedRaceIds: string[] = [];
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
  for (const repositoryId of [...Object.values(ids), ...ownedRaceIds]) {
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

  test('a rename during an observation cannot resurrect the old row', async () => {
    if (!guard()) return;
    const postgres = (await import('postgres')).default;
    const raced = String(914000000 + Math.floor(Math.random() * 9000000));
    ownedRaceIds.push(raced);
    const identityFull = { provider: 'github' as const, repositoryId: raced, owner: 'kortix-ai', repo: 'alias-fixture' };
    await insertRaw({ repositoryId: raced, ref: 'refs/heads/main', desiredSha: shaOld, revision: 9 });

    // A: takes its token from the row as it stands — the legacy spelling.
    const token = await beginRefObservation({ provider: 'github', repositoryId: raced }, 'main');
    expect(token.ref).toBe('refs/heads/main');
    expect(token.generation).toBe(9);

    // A consolidation starts and holds this branch's lock, exactly as the
    // migration does. Everything below is ordered by that lock, not by timing.
    const holder = postgres('postgresql://postgres:postgres@127.0.0.1:13922/postgres', { max: 1 });
    await holder.unsafe('begin');
    await holder.unsafe(
      `select pg_advisory_xact_lock(hashtextextended('github:' || $1 || ':main', 0))`,
      [raced] as never,
    );

    // A resumes and blocks on the lock before it can resolve a key or write.
    const delayed = observeRepoRef({
      identity: identityFull,
      ref: 'main',
      desiredSha: shaOld,
      via: 'reconcile',
      token,
    });

    // Under the lock: the row is renamed and a newer observation is recorded.
    await holder.unsafe(
      `update kortix.repo_snapshot_refs set ref = 'main' where repository_id = $1 and ref = 'refs/heads/main'`,
      [raced] as never,
    );
    await holder.unsafe(
      `update kortix.repo_snapshot_refs set desired_sha = $2, revision = 10 where repository_id = $1 and ref = 'main'`,
      [raced, shaNew] as never,
    );
    await holder.unsafe('commit');
    await holder.end();

    const result = await delayed;
    // A's token described a row that no longer exists. It must not write, and
    // it must not recreate the legacy row beside the survivor.
    expect(result.ref).toBe('main');
    expect(result.desiredSha).toBe(shaNew);
    const rows = await rowsFor(raced);
    expect(rows.map((r) => r.ref)).toEqual(['main']);
    expect(rows[0]?.desired_sha).toBe(shaNew);
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
    // `claimRefsDueForReconcile` is deployment-wide: it leases whatever is due.
    // Refuse to run it when anything else is due rather than take someone
    // else's row.
    const foreignDue = (await db.execute(sql`
      select count(*)::int as n from kortix.repo_snapshot_refs
      where reconcile_after <= now() and repository_id <> ${ids.migrationAlias}`)) as unknown as Array<{
      n: number;
    }>;
    expect(foreignDue[0]?.n ?? 0).toBe(0);

    const claimed = await claimRefsDueForReconcile(50);
    const mine = claimed.find((row) => row.repositoryId === ids.migrationAlias);
    expect(mine?.ref).toBe('refs/heads/release');
  });
});

describe('the consolidation migration folds old rows into the canonical one', () => {
  /**
   * The migration runs in a database of its own.
   *
   * Its SQL is deployment-wide by definition — it consolidates EVERY alias row
   * in `kortix.repo_snapshot_refs` — so running it against a shared database
   * would rewrite rows belonging to whoever else is using it. A throwaway
   * database with the same table gives the real SQL real rows to move and
   * touches nothing else.
   */
  const scratchDb = `kortix_alias_migration_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let scratch: ReturnType<typeof import('postgres')> | null = null;
  let scratchReady = false;
  let scratchReason = '';

  beforeAll(async () => {
    if (!ready) return;
    try {
      const postgres = (await import('postgres')).default;
      const admin = postgres('postgresql://postgres:postgres@127.0.0.1:13922/postgres', { max: 1 });
      await admin.unsafe(`create database "${scratchDb}"`);
      await admin.end();
      scratch = postgres(`postgresql://postgres:postgres@127.0.0.1:13922/${scratchDb}`, { max: 1 });
      await scratch.unsafe(`create schema kortix`);
      await scratch.unsafe(`
        create table kortix.repo_snapshot_refs (
          provider text not null,
          repository_id text not null,
          owner text not null,
          repo text not null,
          ref text not null,
          desired_sha text,
          revision bigint not null default 0,
          observed_at timestamptz not null default now(),
          observed_via text not null,
          reconcile_after timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (provider, repository_id, ref)
        )`);
      scratchReady = true;
    } catch (error) {
      scratchReason = error instanceof Error ? error.message : String(error);
    }
  });

  afterAll(async () => {
    await scratch?.end().catch(() => {});
    if (!scratchReady) return;
    const postgres = (await import('postgres')).default;
    const admin = postgres('postgresql://postgres:postgres@127.0.0.1:13922/postgres', { max: 1 });
    await admin.unsafe(`drop database if exists "${scratchDb}" with (force)`).catch(() => {});
    await admin.end();
  });

  function scratchGuard(): boolean {
    if (!guard()) return false;
    if (scratchReady) return true;
    throw new Error(`migration scratch database unavailable — ${scratchReason}`);
  }

  /** The real migration, driven through exactly the three calls it makes. */
  async function runMigration(): Promise<void> {
    const { up } = await import(
      '../../../../packages/db/migrations/20260912164500000_repo_snapshot_ref_alias_consolidation.concurrent'
    );
    await up({
      noTransaction: () => {},
      sql: async (text: string) => {
        await (scratch as NonNullable<typeof scratch>).unsafe(text);
      },
      db: {
        query: async (text: string) => {
          const result = await (scratch as NonNullable<typeof scratch>).unsafe(text);
          // postgres-js reports an UPDATE/DELETE's affected rows in `count`;
          // `length` is 0 without RETURNING, which would end the batching loop
          // after one pass and silently leave everything past it behind.
          return { rowCount: result.count ?? 0, rows: [...result] };
        },
      },
    } as never);
  }

  async function scratchRows(repositoryId: string) {
    return (await (scratch as NonNullable<typeof scratch>).unsafe(
      `select ref, desired_sha, revision from kortix.repo_snapshot_refs
       where repository_id = '${repositoryId}' order by ref`,
    )) as unknown as Array<{ ref: string; desired_sha: string | null; revision: string }>;
  }

  async function seedScratch(input: {
    repositoryId: string;
    ref: string;
    desiredSha: string | null;
    revision: number;
    reconcileAfter?: string | null;
  }): Promise<void> {
    await (scratch as NonNullable<typeof scratch>).unsafe(
      `insert into kortix.repo_snapshot_refs
        (provider, repository_id, owner, repo, ref, desired_sha, revision, observed_via, reconcile_after)
       values ('github', $1, 'kortix-ai', 'alias-fixture', $2, $3, $4, 'webhook', $5)`,
      [
        input.repositoryId,
        input.ref,
        input.desiredSha,
        String(input.revision),
        input.reconcileAfter ?? null,
      ] as never,
    );
  }

  test('an alias-only row is renamed in place, keeping its revision', async () => {
    if (!scratchGuard()) return;
    await seedScratch({
      repositoryId: ids.migrationBoth,
      ref: 'refs/heads/feature',
      desiredSha: shaOld,
      revision: 4,
    });
    await runMigration();

    const rows = await scratchRows(ids.migrationBoth);
    expect(rows.map((r) => r.ref)).toEqual(['feature']);
    expect(rows[0]?.desired_sha).toBe(shaOld);
    expect(Number(rows[0]?.revision)).toBe(4);
  });

  test('the canonical row wins a duplicate, whatever the counters say', async () => {
    if (!scratchGuard()) return;
    await (scratch as NonNullable<typeof scratch>).unsafe(
      `delete from kortix.repo_snapshot_refs where repository_id = '${ids.migrationBoth}'`,
    );
    // The alias has the HIGHER counter and the OLDER SHA. `revision` counts
    // writes to one row; it does not order two rows, so trusting it here would
    // restore a stale revision over a current one.
    await seedScratch({ repositoryId: ids.migrationBoth, ref: 'main', desiredSha: shaNew, revision: 3 });
    await seedScratch({
      repositoryId: ids.migrationBoth,
      ref: 'refs/heads/main',
      desiredSha: shaOld,
      revision: 9,
    });
    await runMigration();

    const rows = await scratchRows(ids.migrationBoth);
    expect(rows.map((r) => r.ref)).toEqual(['main']);
    expect(rows[0]?.desired_sha).toBe(shaNew);
    // Untouched, so no in-flight observation's CAS token is invalidated.
    expect(Number(rows[0]?.revision)).toBe(3);
  });

  test('a deadline the alias was still owed is not lost', async () => {
    if (!scratchGuard()) return;
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await (scratch as NonNullable<typeof scratch>).unsafe(
      `delete from kortix.repo_snapshot_refs where repository_id = '${ids.aliasOnly}'`,
    );
    await seedScratch({
      repositoryId: ids.aliasOnly,
      ref: 'main',
      desiredSha: shaNew,
      revision: 2,
      reconcileAfter: later,
    });
    await seedScratch({
      repositoryId: ids.aliasOnly,
      ref: 'refs/heads/main',
      desiredSha: shaOld,
      revision: 1,
      reconcileAfter: soon,
    });
    await runMigration();

    const due = (await (scratch as NonNullable<typeof scratch>).unsafe(
      `select reconcile_after from kortix.repo_snapshot_refs where repository_id = '${ids.aliasOnly}'`,
    )) as unknown as Array<{ reconcile_after: Date }>;
    expect(due).toHaveLength(1);
    expect(new Date(due[0]?.reconcile_after as Date).getTime()).toBeLessThan(Date.parse(later));
  });

  test('more rows than one batch are all consolidated', async () => {
    if (!scratchGuard()) return;
    const bulk = String(919000000 + Math.floor(Math.random() * 900000));
    await (scratch as NonNullable<typeof scratch>).unsafe(`
      insert into kortix.repo_snapshot_refs
        (provider, repository_id, owner, repo, ref, desired_sha, revision, observed_via)
      select 'github', '${bulk}', 'kortix-ai', 'alias-fixture',
             'refs/heads/branch-' || g, '${shaOld}', 1, 'webhook'
      from generate_series(1, 700) g`);
    // 700 alias-only rows against a batch of 500: a loop that stops after the
    // first pass leaves 200 behind.
    await runMigration();

    const left = (await (scratch as NonNullable<typeof scratch>).unsafe(
      `select count(*)::int as n from kortix.repo_snapshot_refs
       where repository_id = '${bulk}' and ref like 'refs/heads/%'`,
    )) as unknown as Array<{ n: number }>;
    expect(left[0]?.n).toBe(0);
    const renamed = (await (scratch as NonNullable<typeof scratch>).unsafe(
      `select count(*)::int as n from kortix.repo_snapshot_refs where repository_id = '${bulk}'`,
    )) as unknown as Array<{ n: number }>;
    expect(renamed[0]?.n).toBe(700);
  });

  test('running it again changes nothing', async () => {
    if (!scratchGuard()) return;
    const before = await scratchRows(ids.migrationBoth);
    await runMigration();
    expect(await scratchRows(ids.migrationBoth)).toEqual(before);
  });
});
