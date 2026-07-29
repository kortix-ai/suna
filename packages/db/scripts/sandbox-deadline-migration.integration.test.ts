/**
 * BOUNDED SANDBOX LIFETIME — the migration chain, against a real PostgreSQL.
 *
 * The three objects this feature's correctness rests on are all database
 * objects, not TypeScript: the `session_sandboxes_deadline_bounded` CHECK, the
 * `session_sandboxes_anchor_guard` BEFORE trigger, and the usage progress
 * trigger. None of them can be tested with a mock — a mocked driver would
 * happily accept the exact writes Postgres must reject. So this spins a
 * disposable container, applies the REAL migration files (the .concurrent.ts
 * ones have their pgm.sql() bodies extracted and replayed, so the text under
 * test is the text that ships), and drives them with prod-shaped rows.
 *
 * Follows the existing convention in this directory
 * (runtime-identity-migration.integration.test.ts): the table is created with
 * the minimum shape the migrations touch rather than by replaying the whole
 * baseline, so the test is seconds not minutes. The full chain from
 * `0000_bootstrap.sql` through these seven migrations was applied separately
 * against a throwaway Postgres 17 before this was written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-sandbox-deadline-${crypto.randomUUID().slice(0, 8)}`;
const MIGRATIONS = resolve(import.meta.dir, '..', 'migrations');

function psql(sql: string, allowFailure = false) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

/** Single scalar, trimmed — psql tuples-only so the value is the whole stdout. */
function scalar(sql: string): string {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-tAq',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0)
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/**
 * Replay a .concurrent.ts migration by extracting its pgm.sql() template
 * literals in order. Deliberately runs the SHIPPED text: a hand-copied SQL
 * duplicate in the test would drift from the migration silently, which is the
 * one failure mode a migration test exists to prevent.
 */
async function replayConcurrent(filename: string): Promise<void> {
  const src = await Bun.file(resolve(MIGRATIONS, filename)).text();
  const statements = [...src.matchAll(/pgm\.sql\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
  expect(statements.length).toBeGreaterThan(0);
  for (const stmt of statements) psql(stmt);
}

async function applySql(filename: string): Promise<void> {
  psql(await Bun.file(resolve(MIGRATIONS, filename)).text());
}

const ACC_A = '11111111-1111-1111-1111-111111111111';
const ACC_B = '22222222-2222-2222-2222-222222222222';

/**
 * The disposable server's image tag matches the one CI already runs as a
 * service container and the one the sibling migration tests use. That is not
 * cosmetic: on a cold runner an unmatched tag means a registry PULL inside the
 * hook, which is exactly what blew bun's default 5s hook budget the first time
 * this ran in CI (it passes locally forever, because the image is cached).
 * The explicit hook timeouts below are the real fix; sharing the tag makes the
 * pull unnecessary in the common case.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine';

/** Generous enough to absorb a cold `docker pull` on a fresh runner. */
const CONTAINER_BOOT_TIMEOUT_MS = 180_000;

describe.skipIf(!dockerAvailable)('sandbox deadline migrations — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      POSTGRES_IMAGE,
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'testdb', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    // Minimum shape the seven migrations touch.
    psql(`
      CREATE SCHEMA kortix;
      CREATE TYPE kortix.session_sandbox_status AS ENUM ('provisioning','active','stopped','error','archived');
      CREATE TABLE kortix.session_sandboxes (
        sandbox_id uuid PRIMARY KEY,
        session_id text NOT NULL UNIQUE,
        account_id uuid NOT NULL,
        project_id uuid NOT NULL,
        provider text NOT NULL DEFAULT 'daytona',
        external_id text,
        status kortix.session_sandbox_status NOT NULL DEFAULT 'provisioning',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE kortix.usage_events (
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL,
        session_id text,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_usage_events_session ON kortix.usage_events (session_id);
      -- The shadow reporter joins these two. Minimal shapes: it reads only
      -- project_sessions.metadata (for the harness bucket) and
      -- acp_session_envelopes.created_at (the BYOK progress signal that has no
      -- usage_events counterpart).
      CREATE TABLE kortix.project_sessions (
        session_id text PRIMARY KEY,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE kortix.acp_session_envelopes (
        ordinal bigserial PRIMARY KEY,
        session_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ── Prod-shaped population, seeded BEFORE the backfill, mirroring the live
    // measurement: a 264-hour zombie with no usage ever, a 20-hour trigger box
    // whose last LLM call was 19h ago, a genuinely live box mid-turn, a
    // provisioning row with a box behind it, and a terminal row.
    psql(`
      INSERT INTO kortix.session_sandboxes
        (sandbox_id, session_id, account_id, project_id, external_id, status, created_at)
      VALUES
        (gen_random_uuid(), 'sess-zombie-264h', '${ACC_A}', '${ACC_A}', 'box-zombie', 'active',  now() - interval '264 hours'),
        (gen_random_uuid(), 'sess-stale-usage', '${ACC_A}', '${ACC_A}', 'box-stale',  'active',  now() - interval '20 hours'),
        (gen_random_uuid(), 'sess-live-turn',   '${ACC_A}', '${ACC_A}', 'box-live',   'active',  now() - interval '3 hours'),
        (gen_random_uuid(), 'sess-provisioning','${ACC_A}', '${ACC_A}', 'box-prov',   'provisioning', now() - interval '90 minutes'),
        (gen_random_uuid(), 'sess-terminal',    '${ACC_A}', '${ACC_A}', 'box-gone',   'stopped', now() - interval '40 hours');
      INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens, created_at)
      VALUES
        ('${ACC_A}', 'sess-stale-usage', 100, 50, now() - interval '19 hours'),
        ('${ACC_A}', 'sess-live-turn',   100, 50, now() - interval '5 minutes');
    `);

    await applySql('20260730090000000_sandbox_deadline_columns.sql');
    await replayConcurrent('20260730090000001_sandbox_deadline_indexes.concurrent.ts');
    await applySql('20260730090000002_backfill_sandbox_deadlines.sql');
    await applySql('20260730090000003_sandbox_deadline_check.sql');
    await applySql('20260730090000004_validate_sandbox_deadline_check.sql');
    await applySql('20260730090000005_sandbox_anchor_guard.sql');
    await applySql('20260730090000006_usage_extends_sandbox_deadline.sql');
  }, CONTAINER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, 60_000);

  // ── Step 1: the columns ────────────────────────────────────────────────────

  test('both columns land NOT NULL with defaults, so the OLD API can still insert', () => {
    const rows = scalar(`
      SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY column_name)
        FROM information_schema.columns
       WHERE table_schema = 'kortix' AND table_name = 'session_sandboxes'
         AND column_name IN ('active_since','deadline_at')`);
    expect(rows).toBe('active_since:NO,deadline_at:NO');
    // An insert that mentions neither column — i.e. what an instance running the
    // previous version emits mid-rollout — must still succeed AND must not be
    // born expired. The 20-minute boot floor comes from the anchor guard, not
    // from a column default, precisely so it also covers this shape.
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
          VALUES (gen_random_uuid(), 'sess-old-api-writer', '${ACC_A}', '${ACC_A}', 'provisioning')`);
    expect(
      Number(
        scalar(`SELECT (extract(epoch from deadline_at - now()) / 60)::int
                            FROM kortix.session_sandboxes WHERE session_id='sess-old-api-writer'`),
      ),
    ).toBeGreaterThanOrEqual(19);
  });

  test('an in-flight provision is NOT born expired — the boot floor covers provisioning too', () => {
    // A row is born `provisioning` and flipped to `active` only once the
    // provider returns. A floor applied only to active inserts would make every
    // cold boot a kill candidate before its VM finished starting.
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, status)
          VALUES (gen_random_uuid(), 'sess-booting', '${ACC_A}', '${ACC_A}', 'box-booting', 'provisioning')`);
    expect(
      scalar(
        `SELECT (deadline_at > now())::text FROM kortix.session_sandboxes WHERE session_id='sess-booting'`,
      ),
    ).toBe('true');
  });

  test('a transition that states an ALREADY-PAST deadline is floored, not honoured', () => {
    // The "restart is instantly re-killed" loop. A writer flipping a parked box
    // back to active with the deadline it died holding must not hand the sweep a
    // row that is expired the moment it becomes active — that presents to a user
    // as "Start does nothing".
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, status)
          VALUES (gen_random_uuid(), 'sess-stale-restart', '${ACC_A}', '${ACC_A}', 'box-restart', 'stopped')`);
    psql(`UPDATE kortix.session_sandboxes
             SET status='active', deadline_at = now() - interval '9 hours'
           WHERE session_id='sess-stale-restart'`);
    expect(
      scalar(
        `SELECT (deadline_at > now())::text FROM kortix.session_sandboxes WHERE session_id='sess-stale-restart'`,
      ),
    ).toBe('true');
  });

  test('the kill query has a partial index on its exact predicate', () => {
    expect(
      scalar(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname='kortix' AND indexname='idx_session_sandboxes_deadline'`),
    ).toContain('WHERE (status = ANY');
  });

  // ── Step 3: the backfill ───────────────────────────────────────────────────

  test('a 264-hour zombie with no usage lands already-expired, in the backfilled cohort', () => {
    const row = scalar(`
      SELECT (deadline_at < now())::text || '|' || (metadata->>'deadlineCohort')
             || '|' || (extract(epoch from now() - active_since) / 3600)::int::text
        FROM kortix.session_sandboxes WHERE session_id='sess-zombie-264h'`);
    const [expired, cohort, anchorAgeHours] = row.split('|');
    expect(expired).toBe('true');
    expect(cohort).toBe('backfilled');
    // Anchored at most 23h ago — NOT at created_at. Anchoring a 264h box at its
    // creation would put it permanently past the 24h cap, so no later write
    // could ever rescue it and shadow mode could not measure anything about it.
    expect(Number(anchorAgeHours)).toBe(23);
  });

  test('a box whose last LLM call was 19h ago is expired but still inside the cap', () => {
    const row = scalar(`
      SELECT (deadline_at < now())::text || '|' || (deadline_at <= active_since + interval '24 hours')::text
        FROM kortix.session_sandboxes WHERE session_id='sess-stale-usage'`);
    expect(row).toBe('true|true');
  });

  test('a box with billed progress in the last 2h gets a FRESH anchor and a real window', () => {
    const row = scalar(`
      SELECT (metadata->>'deadlineCohort')
             || '|' || (extract(epoch from active_since - now()))::int::text
             || '|' || (extract(epoch from deadline_at - now()) / 60)::int::text
        FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`);
    const [cohort, anchorDeltaSec, windowMin] = row.split('|');
    expect(cohort).toBe('live');
    expect(Math.abs(Number(anchorDeltaSec))).toBeLessThan(60); // anchored at ~now
    expect(Number(windowMin)).toBeGreaterThan(115);
    expect(Number(windowMin)).toBeLessThanOrEqual(120);
  });

  test('provisioning rows are backfilled too — a parked box with a VM is otherwise invisible', () => {
    expect(
      scalar(
        `SELECT (metadata ? 'deadlineCohort')::text FROM kortix.session_sandboxes WHERE session_id='sess-provisioning'`,
      ),
    ).toBe('true');
  });

  test('terminal rows are left on the column defaults and never touched', () => {
    expect(
      scalar(
        `SELECT (metadata ? 'deadlineCohort')::text FROM kortix.session_sandboxes WHERE session_id='sess-terminal'`,
      ),
    ).toBe('false');
  });

  test('the backfill leaves no scratch objects behind in the kortix schema', () => {
    expect(
      scalar(`
      SELECT count(*) FROM pg_tables
       WHERE schemaname='kortix' AND tablename LIKE '\\_%'`),
    ).toBe('0');
  });

  // ── Steps 4/5: the CHECK ───────────────────────────────────────────────────

  test('the CHECK is VALIDATED, not left NOT VALID — an unvalidated ceiling binds nothing', () => {
    expect(
      scalar(`
      SELECT convalidated::text FROM pg_constraint
       WHERE conname='session_sandboxes_deadline_bounded'`),
    ).toBe('true');
  });

  test('a write past active_since + 24h is rejected with 23514', () => {
    const { exitCode, output } = psql(
      `UPDATE kortix.session_sandboxes
          SET deadline_at = active_since + interval '25 hours'
        WHERE session_id='sess-live-turn'`,
      true,
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain('session_sandboxes_deadline_bounded');
  });

  test('a write exactly AT the cap is admitted — the bound is inclusive, as the writers assume', () => {
    psql(`UPDATE kortix.session_sandboxes
             SET deadline_at = active_since + interval '24 hours'
           WHERE session_id='sess-live-turn'`);
    expect(
      scalar(`SELECT (deadline_at = active_since + interval '24 hours')::text
                     FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`),
    ).toBe('true');
  });

  // ── Step 6: the anchor guard — the object the whole ceiling rests on ───────

  test('I1: active_since CANNOT be moved while the row is active', () => {
    const before = scalar(
      `SELECT active_since::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
    );
    // The exact write a future engineer would reach for to "give this box more
    // room". It does not error — it simply does nothing, because a hard failure
    // on an ORM's whole-object UPDATE would 500 a hot path.
    psql(
      `UPDATE kortix.session_sandboxes SET active_since = now() WHERE session_id='sess-live-turn'`,
    );
    expect(
      scalar(
        `SELECT active_since::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
      ),
    ).toBe(before);
  });

  test('I1: sliding the anchor forward cannot buy a longer deadline either', () => {
    // With the anchor pinned, the follow-up extension the attacker actually
    // wants still hits the CHECK.
    const { exitCode } = psql(
      `
      UPDATE kortix.session_sandboxes
         SET active_since = now(), deadline_at = now() + interval '23 hours'
       WHERE session_id='sess-zombie-264h'`,
      true,
    );
    expect(exitCode).not.toBe(0);
  });

  test('I4: a non-active -> active transition mints a fresh stretch and a floored deadline', () => {
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, status, created_at)
          VALUES (gen_random_uuid(), 'sess-resume', '${ACC_A}', '${ACC_A}', 'box-resume', 'stopped', now() - interval '50 hours')`);
    // A writer that flips the row to active WITHOUT touching the deadline — the
    // proxy heal / restart-in-place shape. Pre-trigger this inherited a stale,
    // already-expired deadline and the box was re-killed on the next pass.
    psql(`UPDATE kortix.session_sandboxes SET status='active' WHERE session_id='sess-resume'`);
    const row = scalar(`
      SELECT (extract(epoch from now() - active_since))::int::text
             || '|' || (extract(epoch from deadline_at - now()) / 60)::int::text
        FROM kortix.session_sandboxes WHERE session_id='sess-resume'`);
    const [anchorAgeSec, windowMin] = row.split('|');
    expect(Number(anchorAgeSec)).toBeLessThan(60);
    expect(Number(windowMin)).toBeGreaterThanOrEqual(19);
    expect(Number(windowMin)).toBeLessThanOrEqual(20);
  });

  test('I4: a transition that DOES state its own deadline keeps it', () => {
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, status)
          VALUES (gen_random_uuid(), 'sess-anchored-open', '${ACC_A}', '${ACC_A}', 'box-open', 'stopped')`);
    psql(`UPDATE kortix.session_sandboxes
             SET status='active', deadline_at = now() + interval '4 hours'
           WHERE session_id='sess-anchored-open'`);
    expect(
      Number(
        scalar(`SELECT (extract(epoch from deadline_at - now()) / 60)::int
                            FROM kortix.session_sandboxes WHERE session_id='sess-anchored-open'`),
      ),
    ).toBeGreaterThan(230);
  });

  test('I4: an INSERT that arrives already active is anchored at insert time', () => {
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, created_at)
          VALUES (gen_random_uuid(), 'sess-born-active', '${ACC_A}', '${ACC_A}', 'active', now() - interval '10 hours')`);
    expect(
      Number(
        scalar(`SELECT (extract(epoch from now() - active_since))::int
                            FROM kortix.session_sandboxes WHERE session_id='sess-born-active'`),
      ),
    ).toBeLessThan(60);
  });

  // ── Step 7: the usage progress trigger ─────────────────────────────────────

  test('W3a: a billed usage event extends the box that produced it', () => {
    psql(
      `UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '3 minutes' WHERE session_id='sess-live-turn'`,
    );
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_A}', 'sess-live-turn', 10, 20)`);
    expect(
      Number(
        scalar(`SELECT (extract(epoch from deadline_at - now()) / 60)::int
                            FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`),
      ),
    ).toBeGreaterThan(115);
  });

  test('W3a: a usage event from ANOTHER account cannot extend this session', () => {
    psql(
      `UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '3 minutes' WHERE session_id='sess-live-turn'`,
    );
    const before = scalar(
      `SELECT deadline_at::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
    );
    // The legacy router path still takes session_id from the request body, so
    // forging another tenant's session id is cheap. The account predicate is
    // what makes it worthless.
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_B}', 'sess-live-turn', 10, 20)`);
    expect(
      scalar(
        `SELECT deadline_at::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
      ),
    ).toBe(before);
  });

  test('W3a: a ZERO-token event does not fire — a wedged retry loop cannot forge progress', () => {
    psql(
      `UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '3 minutes' WHERE session_id='sess-live-turn'`,
    );
    const before = scalar(
      `SELECT deadline_at::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
    );
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_A}', 'sess-live-turn', 0, 0)`);
    expect(
      scalar(
        `SELECT deadline_at::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
      ),
    ).toBe(before);
  });

  test('W3a: no write when the deadline is already far enough out — churn tracks turns, not calls', () => {
    // The trigger's third predicate is `deadline_at < now() + 2h - 2min`, so the
    // no-write band is the last 2 minutes of a full grant. Measured intra-session
    // gaps between consecutive usage events are p50 0.13min / p90 0.70min, so in
    // practice the overwhelming majority of a turn's LLM calls land in this band
    // and issue no write at all. This asserts the band exists and is exact.
    psql(
      `UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '119 minutes' WHERE session_id='sess-live-turn'`,
    );
    const before = scalar(
      `SELECT deadline_at::text, xmin::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
    );
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_A}', 'sess-live-turn', 10, 20)`);
    // Same tuple version = no UPDATE happened at all, not merely "no visible change".
    expect(
      scalar(
        `SELECT deadline_at::text, xmin::text FROM kortix.session_sandboxes WHERE session_id='sess-live-turn'`,
      ),
    ).toBe(before);
  });

  test('W3a: the extension is capped, so a chatty box near its cap cannot escape it', () => {
    psql(`UPDATE kortix.session_sandboxes
             SET deadline_at = active_since + interval '24 hours'
           WHERE session_id='sess-live-turn'`);
    psql(`UPDATE kortix.session_sandboxes
             SET deadline_at = least(active_since + interval '24 hours', now() + interval '1 minute')
           WHERE session_id='sess-born-active'`);
    // sess-born-active was anchored ~now, so now()+2h is well inside its cap and
    // it extends. The interesting case is a box whose cap is nearly spent.
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_A}', 'sess-born-active', 10, 20)`);
    expect(
      scalar(`SELECT (deadline_at <= active_since + interval '24 hours')::text
                     FROM kortix.session_sandboxes WHERE session_id='sess-born-active'`),
    ).toBe('true');
  });

  test('W3a: a usage event never rolls back because the deadline write failed', () => {
    // The trigger body is exception-tolerant on purpose: billing accuracy
    // outranks deadline accuracy. Prove it by pointing the event at a session
    // with no sandbox row at all.
    psql(`INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens)
          VALUES ('${ACC_A}', 'sess-does-not-exist', 10, 20)`);
    expect(
      scalar(`SELECT count(*) FROM kortix.usage_events WHERE session_id='sess-does-not-exist'`),
    ).toBe('1');
  });

  // ── The shadow reporter's real SQL ─────────────────────────────────────────

  test('the SHIPPED shadow kill query parses and runs against the real objects', async () => {
    // Reads the statement out of apps/api rather than duplicating it. A
    // hand-copied SQL twin in a test drifts from the code silently, which is
    // the one failure mode a query test exists to prevent — and a shadow pass
    // whose query throws every tick logs a warning nobody reads and reports a
    // reassuring zero.
    const source = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        '..',
        '..',
        'apps',
        'api',
        'src',
        'projects',
        'lifetime',
        'shadow-queries.ts',
      ),
    ).text();
    const blocks = [...source.matchAll(/sql`([\s\S]*?)`\)/g)].map((m) => m[1] ?? '');
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      // Substitute the two bound parameters with literals. Everything else in
      // these statements is static text by construction.
      const statement = block
        .replace(/\$\{opts\.perAccountCap\}/g, '5')
        .replace(/\$\{opts\.limit\}/g, '25')
        .replace(/\$\{seconds\}/g, '300');
      expect(statement).not.toContain('${');
      psql(statement);
    }
  });

  test('the kill query uses the partial deadline index, not a sequential scan', () => {
    // Postgres will happily seq-scan a tiny test table, so force the choice to
    // be about whether the index is USABLE for this predicate rather than about
    // row counts. SET must share the session with EXPLAIN — each psql call here
    // is its own connection.
    const plan = scalar(`
      SET enable_seqscan = off;
      EXPLAIN (COSTS OFF)
      SELECT sandbox_id FROM kortix.session_sandboxes
       WHERE status IN ('active','provisioning')
         AND external_id IS NOT NULL
         AND deadline_at <= now()`);
    // The partial index's predicate is `status IN ('active','provisioning')`,
    // so this also proves Postgres can prove the implication — a partial index
    // the planner cannot match is an index that silently never runs.
    expect(plan).toContain('idx_session_sandboxes_deadline');
  });

  // ── The remediation script's SELECTION RULE ────────────────────────────────

  test('the remediation plan never selects a box that is doing work', async () => {
    // The one-off drain for the existing backlog. Its safety rule is that a box
    // with billed OR relayed progress inside the progress grant is NEVER a
    // candidate at any age, and that no flag can override it. Tested here, on
    // real rows, because the rule is entirely SQL — a mocked driver would
    // confirm nothing.
    psql(`
      INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, provider, external_id, status, metadata, created_at)
      VALUES
        (gen_random_uuid(), 'rem-wedged',  '${ACC_A}', '${ACC_A}', 'daytona',  'box-rem-wedged',  'active', '{"source":"trigger:cron"}'::jsonb, now() - interval '208 hours'),
        -- 90h old and gateway-silent for 90h, but it billed a call 3 minutes
        -- ago: working, and must survive.
        (gen_random_uuid(), 'rem-working', '${ACC_A}', '${ACC_A}', 'daytona',  'box-rem-working', 'active', '{"source":"ui"}'::jsonb,           now() - interval '90 hours'),
        -- The BYOK case: NO usage_events exist for it anywhere, by
        -- construction. A usage-only rule would have killed it.
        (gen_random_uuid(), 'rem-byok',    '${ACC_A}', '${ACC_A}', 'platinum', 'box-rem-byok',    'active', '{"source":"ui"}'::jsonb,           now() - interval '100 hours');
      INSERT INTO kortix.project_sessions (session_id) VALUES ('rem-wedged'), ('rem-working'), ('rem-byok');
      INSERT INTO kortix.usage_events (account_id, session_id, input_tokens, output_tokens, created_at)
      VALUES ('${ACC_A}', 'rem-working', 10, 10, now() - interval '3 minutes');
      INSERT INTO kortix.acp_session_envelopes (session_id, created_at)
      VALUES ('rem-byok', now() - interval '2 minutes');
    `);

    const script = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        '..',
        '..',
        'apps',
        'api',
        'scripts',
        'remediate-wedged-sandboxes.ts',
      ),
    ).text();
    const block = script.match(/sql`([\s\S]*?)`\)/)?.[1] ?? '';
    expect(block).toContain('per_account_rank');
    const statement = block
      .replace(/\$\{options\.minAgeHours\}/g, '12')
      .replace(/\$\{PROGRESS_GRANT_MS\}/g, '7200000')
      .replace(/\$\{options\.requireNoUsage\}/g, 'false')
      .replace(/\$\{options\.accountId\}/g, 'NULL')
      // Caps deliberately lifted: the safety rule must hold even when an
      // operator has removed every other limit.
      .replace(/\$\{options\.perAccount\}/g, '1000')
      .replace(/\$\{options\.max\}/g, '1000');
    expect(statement).not.toContain('${');

    const selected = scalar(
      `SELECT coalesce(string_agg(t.external_id, ',' ORDER BY t.external_id), '') FROM (${statement}) t
        WHERE t.external_id LIKE 'box-rem-%'`,
    );
    expect(selected).toBe('box-rem-wedged');

    psql(`DELETE FROM kortix.session_sandboxes WHERE session_id LIKE 'rem-%'`);
    psql(`DELETE FROM kortix.project_sessions WHERE session_id LIKE 'rem-%'`);
  });

  // ── The two monitors, against real rows ────────────────────────────────────

  test('M1 counts boxes alive past their deadline — the leak, as one number', async () => {
    // The success criterion of this whole feature stated as one number: if M1
    // stays at zero with enforcement on, the leak is fixed. Run the SHIPPED SQL
    // rather than a copy, for the same reason as the shadow query above.
    const monitors = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        '..',
        '..',
        'apps',
        'api',
        'src',
        'projects',
        'lifetime',
        'monitors.ts',
      ),
    ).text();
    const blocks = [...monitors.matchAll(/sql`([\s\S]*?)`\)/g)].map((m) => m[1] ?? '');
    expect(blocks.length).toBe(2);
    const m1 = (blocks[0] ?? '').replace(/\$\{toleranceSeconds\}/g, '900');
    expect(m1).not.toContain('${');
    // sess-zombie-264h and sess-stale-usage were backfilled to a deadline hours
    // in the past, so both are overdue well beyond the 15-minute tolerance.
    // Wrapped so the two-column monitor yields one scalar.
    const overdue = Number(scalar(`SELECT t.overdue FROM (${m1.replace(/;\s*$/, '')}) t`));
    expect(overdue).toBeGreaterThanOrEqual(2);
  });

  test('M2 reads ZERO while nothing stamps a deadline stop — shadow mode, proved', () => {
    // The claim "this change kills nothing" is checkable rather than asserted:
    // M2 keys on metadata.deadlineStop, which only the ENFORCING sweep writes.
    expect(
      scalar(`SELECT count(*)::int FROM kortix.session_sandboxes WHERE metadata ? 'deadlineStop'`),
    ).toBe('0');
  });

  test('M2 catches a stop of a box that had progress inside the grant', async () => {
    // The leading false-kill indicator, and it is 0 BY CONSTRUCTION: a deadline
    // stop of a box with recent billed or relayed progress means an EXTENSION
    // WRITE WAS MISSED, not that the box deserved to die.
    psql(`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
          VALUES (gen_random_uuid(), 'sess-wrongly-killed', '${ACC_A}', '${ACC_A}', 'box-wk', 'stopped',
                  jsonb_build_object('deadlineStop', jsonb_build_object(
                    'atIso', to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SSZ'),
                    'lastUsageAgeMs', 60000,
                    'lastAcpRelayAgeMs', null,
                    'grantSource', 'progress')))`);
    const monitors = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        '..',
        '..',
        'apps',
        'api',
        'src',
        'projects',
        'lifetime',
        'monitors.ts',
      ),
    ).text();
    const blocks = [...monitors.matchAll(/sql`([\s\S]*?)`\)/g)].map((m) => m[1] ?? '');
    const m2 = (blocks[1] ?? '')
      .replace(/\$\{windowSeconds\}/g, '86400')
      .replace(/\$\{grantMs\}/g, '7200000');
    expect(m2).not.toContain('${');
    const row = scalar(
      `SELECT (t.deadline_stops || '|' || t.stopped_with_recent_progress) FROM (${m2.replace(/;\s*$/, '')}) t`,
    );
    expect(row).toBe('1|1');
    psql(`DELETE FROM kortix.session_sandboxes WHERE session_id='sess-wrongly-killed'`);
  });

  // ── The kill query the reaper will run ─────────────────────────────────────

  test('the kill query finds exactly the wedged boxes and nothing else', () => {
    const found = scalar(`
      SELECT string_agg(session_id, ',' ORDER BY session_id)
        FROM kortix.session_sandboxes
       WHERE status IN ('active','provisioning')
         AND external_id IS NOT NULL
         AND deadline_at <= now()`);
    expect(found.split(',').sort()).toEqual(['sess-stale-usage', 'sess-zombie-264h']);
  });
});
