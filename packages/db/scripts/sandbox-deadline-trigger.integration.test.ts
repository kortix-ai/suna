// The sandbox-deadline anchor guard, executed by a REAL PostgreSQL.
//
// The trigger owns `active_since` as immutable provider-run observability and
// preserves the resume floor. It no longer caps active-turn deadlines at 24
// hours. The test runs the SHIPPED migrations against a disposable server.
// Every case below is a defect review found in the first cut:
//
//   I1  the anchor was immutable only WHILE status='active', so plain application
//       Drizzle moved the cap's left operand on any UPDATE that landed the row
//       anywhere else;
//   I2  ANY non-active -> active transition re-anchored, so the cap was resettable
//       an unbounded number of times by flipping status out and back — including
//       through `provisioning`, which application code writes routinely with no
//       provider stop involved;
//   I3  a status flip that did not itself write deadline_at DISCARDED a live
//       grant and replaced it with the 20-minute boot floor — including
//       markSandboxUsed's heal, whose WHERE clause fires precisely when there IS
//       a live grant to lose.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-sandbox-deadline-${crypto.randomUUID().slice(0, 8)}`;

function psql(sql: string, allowFailure = false, extraArgs: string[] = []) {
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
      ...extraArgs,
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

/** Run a single-value query and return the scalar as text. `-t -A` (tuples only,
 *  unaligned) rather than `\pset`, which echoes a confirmation line into stdout. */
function scalar(sql: string): string {
  return psql(sql, false, ['-t', '-A']).output.trim();
}

const BOX = '00000000-0000-4000-a000-000000000001';

/** Reset the row to a known live-and-anchored state without going through the
 *  trigger's park/resume path (the anchor is forced with a direct catalog-free
 *  rewrite: DELETE + INSERT, which the INSERT branch anchors at now()). */
function reseed(status: string, deadlineOffset = "interval '4 hours'") {
  psql(`
    DELETE FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}';
    INSERT INTO kortix.session_sandboxes(sandbox_id, session_id, external_id, provider, status, deadline_at)
    VALUES ('${BOX}', 'sess-1', 'ext-1', 'daytona', '${status}', now() + ${deadlineOffset});
  `);
}

describe.skipIf(!dockerAvailable)('session_sandboxes anchor guard — real PostgreSQL', () => {
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
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
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

    // The original shipped migration supplies the table objects. The newest
    // lifecycle migration then removes the old CHECK and installs the current
    // trigger. Tests must exercise the final migration state, not the 2026-07-30
    // intermediate state.
    const migration = await Bun.file(
      resolve(import.meta.dir, '..', 'migrations', '20260730000452547_sandbox_deadline.sql'),
    ).text();
    const triggerAndCheck = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));
    if (!triggerAndCheck.includes('session_sandboxes_deadline_within_cap')) {
      throw new Error('migration text no longer contains the trigger + CHECK section');
    }
    const repairMigration = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        'migrations',
        '20260730064010447_repair_sandbox_deadline_guard.sql',
      ),
    ).text();
    if (!repairMigration.includes('CREATE OR REPLACE FUNCTION')) {
      throw new Error('repair migration no longer replaces the deadline guard');
    }
    const activeTurnMigration = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        'migrations',
        '20260817150000000_active_turn_lifecycle_no_wall_clock_cap.sql',
      ),
    ).text();
    if (!activeTurnMigration.includes('DROP CONSTRAINT IF EXISTS')) {
      throw new Error('active-turn migration no longer removes the deadline cap');
    }

    psql(`
      CREATE SCHEMA kortix;
      CREATE TYPE kortix.session_sandbox_status AS ENUM
        ('provisioning', 'active', 'stopped', 'error', 'archived');
      CREATE TABLE kortix.session_sandboxes (
        sandbox_id uuid PRIMARY KEY,
        session_id text NOT NULL,
        external_id text,
        provider text NOT NULL,
        status kortix.session_sandbox_status NOT NULL DEFAULT 'provisioning',
        -- NULLABLE, exactly as in production (schema/kortix.ts:
        -- jsonb('metadata').default({}) with no .notNull()). Declaring it NOT NULL
        -- here hid the whole class of non-object metadata defects below.
        metadata jsonb DEFAULT '{}'::jsonb,
        active_since timestamptz NOT NULL DEFAULT now(),
        deadline_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ${triggerAndCheck}

      CREATE OR REPLACE FUNCTION kortix.session_sandboxes_anchor_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;

      ${repairMigration}
      ${activeTurnMigration}
    `);
  }, 60_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  describe('INSERT', () => {
    test('anchors at now() and floors a bare row at 15 minutes', () => {
      psql(`
        DELETE FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}';
        INSERT INTO kortix.session_sandboxes(sandbox_id, session_id, provider, status)
        VALUES ('${BOX}', 'sess-1', 'daytona', 'provisioning');
      `);

      expect(
        scalar(`SELECT deadline_at - active_since = interval '15 minutes'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('a stated deadline survives, and the trigger still owns the anchor', () => {
      reseed('provisioning');

      expect(
        scalar(`SELECT deadline_at > now() + interval '3 hours'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // An INSERT must not be able to carry in a forged park witness and buy a free
    // re-anchor on its very first status flip.
    test('a witness supplied at INSERT is stripped', () => {
      psql(`
        DELETE FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}';
        INSERT INTO kortix.session_sandboxes(sandbox_id, session_id, provider, status, metadata)
        VALUES ('${BOX}', 'sess-1', 'daytona', 'provisioning', '{"stretchParkedAt":"forged"}');
      `);

      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('f');
    });
  });

  describe('I1 — the anchor is not movable by application code, in ANY state', () => {
    test('an active row cannot move it (this always held)', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes
               SET active_since = now() - interval '10 days'
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > now() - interval '1 minute'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // ═══ THE HOLE ═══ the first cut pinned the anchor only while
    // OLD.status = 'active', so ANY update that landed the row elsewhere moved
    // the cap's left operand freely.
    test('REGRESSION: a write that lands the row on stopped cannot move it either', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes
               SET status = 'stopped', active_since = now() - interval '10 days'
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > now() - interval '1 minute'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('REGRESSION: nor on provisioning, error or archived', () => {
      for (const status of ['provisioning', 'error', 'archived']) {
        reseed('active');
        psql(`UPDATE kortix.session_sandboxes
                 SET status = '${status}', active_since = now() - interval '10 days'
               WHERE sandbox_id = '${BOX}'`);

        expect(
          scalar(`SELECT active_since > now() - interval '1 minute'
                    FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
        ).toBe('t');
      }
    });

    test('REGRESSION: nor while staying off active the whole time', () => {
      reseed('stopped');
      psql(`UPDATE kortix.session_sandboxes
               SET active_since = now() - interval '10 days', updated_at = now()
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > now() - interval '1 minute'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });
  });

  describe('I2 — a new stretch requires a park the trigger itself witnessed', () => {
    test('a genuine park then resume anchors a fresh stretch', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');

      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
      // The witness is consumed, so it cannot buy a second reset.
      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('f');
    });

    // ═══ THE UNBOUNDED RESET ═══ `provisioning` is written routinely by
    // application code (in-place restart, identity recovery, the boot completion
    // itself) with no provider stop anywhere in sight. Under the first cut each
    // such flip handed the box a fresh 24 hours.
    test('REGRESSION: active -> provisioning -> active does NOT reset the provider-run anchor', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      psql(
        `UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since = '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // A witness must survive a park -> park write (stopped -> archived, an error
    // being reclassified), or restoring an archived box would inherit an anchor
    // that may already be past its cap and expire the box on the spot.
    test('the witness survives a park -> park transition', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'archived' WHERE sandbox_id = '${BOX}'`);
      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');

      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // The witness is trigger-owned in BOTH directions: a caller can neither add
    // one nor delete one to manipulate the anchor.
    test('a caller cannot DESTROY a witness either', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);

      psql(
        `UPDATE kortix.session_sandboxes SET metadata = '{}'::jsonb WHERE sandbox_id = '${BOX}'`,
      );

      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('the witness buys exactly ONE re-anchor, then is gone', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);
      const anchored = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      // No park in between this time — a provisioning round trip must not reset.
      psql(
        `UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since = '${anchored}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    }, 15_000);

    test('REGRESSION: flipping out and back a hundred times buys nothing', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      psql(`
        DO $do$
        BEGIN
          FOR i IN 1..100 LOOP
            UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}';
            UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}';
          END LOOP;
        END
        $do$;
      `);

      expect(
        scalar(`SELECT active_since = '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // The one provisioning flip that DOES mean the box is gone: external_id
    // released, so no provider instance exists to keep running.
    test('active -> provisioning WITH the box released is a park, and re-anchors', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      psql(`UPDATE kortix.session_sandboxes
               SET status = 'provisioning', external_id = NULL
             WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes
               SET status = 'active', external_id = 'ext-2'
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('REGRESSION: a witness cannot be forged by an ordinary UPDATE', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );

      // Try to plant it while active, then while provisioning, then resume.
      psql(`UPDATE kortix.session_sandboxes
               SET metadata = metadata || '{"stretchParkedAt":"forged"}'::jsonb
             WHERE sandbox_id = '${BOX}'`);
      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('f');

      psql(`UPDATE kortix.session_sandboxes
               SET status = 'provisioning', metadata = metadata || '{"stretchParkedAt":"forged"}'::jsonb
             WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since = '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });
  });

  // `metadata` is NULLABLE free-form jsonb in production. The trigger must not
  // raise on ANY value a caller can send — the migration header promises exactly
  // that, and `- 'key'` on a jsonb SCALAR raises 22023 while `|| object` on a
  // jsonb ARRAY appends instead of setting a key, silently swallowing the witness.
  describe('metadata is not guaranteed to be an object', () => {
    for (const [label, value] of [
      ['a jsonb null scalar', `'null'::jsonb`],
      ['a jsonb string scalar', `'"x"'::jsonb`],
      ['a jsonb number scalar', `'7'::jsonb`],
      ['a jsonb array', `'[1,2]'::jsonb`],
      ['SQL NULL', 'NULL'],
    ] as const) {
      test(`REGRESSION: ${label} never raises`, () => {
        reseed('active');
        const written = psql(
          `\\set VERBOSITY verbose
           UPDATE kortix.session_sandboxes SET metadata = ${value}
            WHERE sandbox_id = '${BOX}';`,
          true,
        );

        expect(written.exitCode).toBe(0);
        expect(written.output).not.toContain('22023');
      });
    }

    // A park -> resume must still re-anchor when the caller sent a non-object on
    // the way through: the witness lives in the row, not in the caller's payload.
    test('a non-object metadata cannot destroy the witness', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes SET metadata = '[1,2]'::jsonb
             WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since > '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // Nor forge one: a jsonb ARRAY whose elements include the key name makes the
    // bare `?` containment operator answer true.
    test('an array naming the witness key cannot forge one', () => {
      reseed('active');
      const before = scalar(
        `SELECT active_since FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes
               SET status = 'provisioning', metadata = '["stretchParkedAt"]'::jsonb
             WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT active_since = '${before}'::timestamptz
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });
  });

  describe('I3 — a status flip floors the deadline, never discards a live grant', () => {
    // ═══ THE GRANT-EATER ═══ markSandboxUsed's heal writes status='active' with
    // `WHERE deadline_at > now()` and states no deadline of its own. The first
    // cut replaced that live grant with the 20-minute boot floor, so a box mid-turn
    // with 3h50m left came back from a transient blip with 20 minutes.
    test('REGRESSION: the heal path keeps a live 4-hour grant', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);

      psql(`UPDATE kortix.session_sandboxes
               SET status = 'active', updated_at = now()
             WHERE sandbox_id = '${BOX}' AND deadline_at > now()`);

      expect(
        scalar(`SELECT deadline_at > now() + interval '3 hours'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('an EXPIRED deadline is still refloored to 15 minutes on resume', () => {
      reseed('active', "interval '-1 hour'");
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT deadline_at > now() + interval '14 minutes'
                  AND deadline_at < now() + interval '16 minutes'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('a caller that STATES a live deadline on the flip is left alone', () => {
      reseed('active');
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      psql(`UPDATE kortix.session_sandboxes
               SET status = 'active', deadline_at = now() + interval '90 minutes'
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT deadline_at BETWEEN now() + interval '89 minutes'
                                      AND now() + interval '91 minutes'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // Carrying a live grant across a flip late in a provider run must not raise
    // 23514. The resume floor can cross the old 24-hour boundary because a
    // verified active turn now has no wall-clock cap.
    test('a flip across the former cap succeeds and preserves a live deadline', () => {
      reseed('active', "interval '4 hours'");
      // Age the stretch to 23h55m by rebuilding the row with an old anchor: the
      // only writer that can set an old anchor is the INSERT branch, so park and
      // resume through a manufactured history instead — set the deadline to the
      // cap edge and flip.
      psql(`
        ALTER TABLE kortix.session_sandboxes DISABLE TRIGGER trg_session_sandboxes_anchor_guard;
        UPDATE kortix.session_sandboxes
           SET active_since = now() - interval '23 hours 55 minutes',
               deadline_at  = now() + interval '4 minutes'
         WHERE sandbox_id = '${BOX}';
        ALTER TABLE kortix.session_sandboxes ENABLE TRIGGER trg_session_sandboxes_anchor_guard;
      `);
      // A provisioning flip carries the anchor forward and applies the floor.
      psql(
        `UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}'`,
      );
      const flip = psql(
        `UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = '${BOX}';`,
        true,
      );

      expect(flip.exitCode).toBe(0);
      expect(flip.output).not.toContain('23514');
      expect(
        scalar(`SELECT deadline_at > active_since + interval '24 hours'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // The old cap made an unwitnessed park with a stale anchor resume already
    // expired. The current trigger keeps the anchor for observability and floors
    // the deadline independently.
    test('REGRESSION: an UNWITNESSED park with a stale anchor still resumes LIVE', () => {
      reseed('active');
      // Park from `provisioning` with the external box intact — a real transition
      // (session-sandbox.ts, preserveEstablishedRuntime) that mints no witness.
      psql(
        `UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}'`,
      );
      psql(`UPDATE kortix.session_sandboxes SET status = 'stopped' WHERE sandbox_id = '${BOX}'`);
      // 25 hours pass while the row sits parked. Constructing "time passed" is the
      // only thing done with the trigger off; the resume below runs with it live.
      psql(`
        ALTER TABLE kortix.session_sandboxes DISABLE TRIGGER trg_session_sandboxes_anchor_guard;
        UPDATE kortix.session_sandboxes
           SET active_since = now() - interval '25 hours',
               deadline_at  = now() - interval '25 hours'
         WHERE sandbox_id = '${BOX}';
        ALTER TABLE kortix.session_sandboxes ENABLE TRIGGER trg_session_sandboxes_anchor_guard;
      `);
      expect(
        scalar(`SELECT metadata ? 'stretchParkedAt'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('f');

      // Exactly what resumeStoppedSandbox writes: status, updated_at, metadata.
      // Never deadline_at.
      psql(`UPDATE kortix.session_sandboxes
               SET status = 'active', updated_at = now(), metadata = metadata
             WHERE sandbox_id = '${BOX}'`);

      expect(
        scalar(`SELECT deadline_at > now()
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
      expect(
        scalar(`SELECT deadline_at BETWEEN now() + interval '14 minutes'
                                      AND now() + interval '16 minutes'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    // Active-turn renewal is monotone and intentionally independent of the old
    // anchor ceiling.
    test('REGRESSION: an active-turn grant crosses the former cap', () => {
      const live = psql(
        `UPDATE kortix.session_sandboxes s
            SET deadline_at = GREATEST(
                  s.deadline_at,
                  now() + make_interval(secs => 14400))
          WHERE s.sandbox_id = '${BOX}' AND s.status IN ('active', 'provisioning')
         RETURNING (s.deadline_at > s.active_since + interval '24 hours') AS live`,
        false,
        ['-t', '-A'],
      ).output;

      expect(live).toContain('t');
      expect(live).not.toContain('f');
    });

    // Removing the cap must not make the provider-run anchor caller-mutable.
    test('status churn still buys no provider-run re-anchor', () => {
      reseed('active');
      psql(`
        ALTER TABLE kortix.session_sandboxes DISABLE TRIGGER trg_session_sandboxes_anchor_guard;
        UPDATE kortix.session_sandboxes SET active_since = now() - interval '12 hours'
         WHERE sandbox_id = '${BOX}';
        ALTER TABLE kortix.session_sandboxes ENABLE TRIGGER trg_session_sandboxes_anchor_guard;
        UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = '${BOX}';
        UPDATE kortix.session_sandboxes SET status = 'active'       WHERE sandbox_id = '${BOX}';
      `);

      expect(
        scalar(`SELECT now() - active_since > interval '11 hours'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });

    test('a caller can state a deadline past the former cap', () => {
      reseed('active');
      const rejected = psql(
        `\\set VERBOSITY verbose
         UPDATE kortix.session_sandboxes
            SET deadline_at = now() + interval '11 days'
          WHERE sandbox_id = '${BOX}';`,
        true,
      );

      expect(rejected.exitCode).toBe(0);
      expect(rejected.output).not.toContain('23514');
      expect(
        scalar(`SELECT deadline_at > active_since + interval '10 days'
                  FROM kortix.session_sandboxes WHERE sandbox_id = '${BOX}'`),
      ).toBe('t');
    });
  });
});
