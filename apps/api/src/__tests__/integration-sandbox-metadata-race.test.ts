// Real-PostgreSQL race tests for `session_sandboxes.metadata`.
//
// Incident (SESS-9, every PR preview, 2026-09): a restart stayed in
// `provisioning` for ~350 s. The daemon's boot-timeline POST pins the egress IP
// at first-ready. The pin READ the metadata, a restart CLAIMED the row ~0.2 s
// later (`runtimeRestartId` + wake clocks), and the pin then WROTE its stale
// copy back. The claim was gone, `ownsRestart()` returned false, and the
// detached restart returned without a trace.
//
// A mocked `db` cannot reproduce this: the defect is the gap between two
// statements and what Postgres does to a blocked UPDATE when the lock holder
// commits. Each test holds the row lock with a second connection, lets the
// writer under test block on it, then commits — the exact interleaving.
//
// Runs in the `db-suites` lane of `pnpm test` (one throwaway database per
// file). It writes and deletes rows with fixed ids.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import pg from 'pg';

const SANDBOX_ID = '00000000-0000-4000-a000-00000000e9a1';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000e9a2';
const PROJECT_ID = '00000000-0000-4000-a000-00000000e9a3';
const EXTERNAL_ID = 'ext-metadata-race';

const RESTART_CLAIM = {
  runtimeRestartId: 'restart-under-test',
  runtimeRestartStartedAt: '2026-09-22T10:00:00.000Z',
  runtimeRestartLeaseExpiresAt: '2026-09-22T10:04:00.000Z',
  runtimeRestartPhase: 'stopping',
  runtimeWakeStartedAt: '2026-09-22T10:00:00.000Z',
};

let admin: pg.Client;

/**
 * The identity-immutability trigger refuses to delete a row that carries an
 * `external_id` unless its session is tombstoned (`metadata.deletedAt`). The
 * fixture session is created tombstoned for exactly that reason.
 */
async function ensureParents(): Promise<void> {
  await admin.query(
    `INSERT INTO kortix.accounts (account_id, name) VALUES ($1, 'metadata race e2e')
     ON CONFLICT (account_id) DO NOTHING`,
    [ACCOUNT_ID],
  );
  await admin.query(
    `INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
     VALUES ($1, $2, 'metadata race e2e', 'https://example.test/race.git')
     ON CONFLICT (project_id) DO NOTHING`,
    [PROJECT_ID, ACCOUNT_ID],
  );
  await admin.query(
    `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, metadata)
     VALUES ($1, $2, $3, 'e2e/metadata-race', '{"deletedAt":"2026-09-22T00:00:00.000Z"}'::jsonb)
     ON CONFLICT (session_id) DO NOTHING`,
    [SANDBOX_ID, ACCOUNT_ID, PROJECT_ID],
  );
}

async function purge(): Promise<void> {
  await admin.query(`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1`, [SANDBOX_ID]);
}

async function seed(metadata: Record<string, unknown>, status = 'active'): Promise<void> {
  await purge();
  await admin.query(
    `INSERT INTO kortix.session_sandboxes
       (sandbox_id, session_id, account_id, project_id, status, external_id, metadata)
     VALUES ($1::uuid, $1::text, $2, $3, $4, $5, $6::jsonb)`,
    [SANDBOX_ID, ACCOUNT_ID, PROJECT_ID, status, EXTERNAL_ID, JSON.stringify(metadata)],
  );
}

async function readMetadata(): Promise<Record<string, unknown>> {
  const result = await admin.query(
    `SELECT metadata FROM kortix.session_sandboxes WHERE sandbox_id = $1`,
    [SANDBOX_ID],
  );
  return (result.rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Run `write` on a second connection inside an open transaction, start
 * `contender`, wait until the contender blocks on the row lock (or finishes
 * without touching the row), then commit `write` and await the contender.
 */
async function interleave(
  write: (tx: pg.Client) => Promise<unknown>,
  contender: () => Promise<unknown>,
): Promise<void> {
  const tx = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await tx.connect();
  try {
    await tx.query('BEGIN');
    await write(tx);
    let settled = false;
    const running = contender().finally(() => {
      settled = true;
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (settled) break;
      const waiting = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%session_sandboxes%'`,
      );
      if (waiting.rows[0].n > 0) break;
      if (Date.now() > deadline) throw new Error('contender never blocked on the row lock');
      await Bun.sleep(20);
    }
    await tx.query('COMMIT');
    await running;
  } finally {
    await tx.end();
  }
}

describe('session_sandboxes.metadata writers merge atomically (real PostgreSQL)', () => {
  beforeAll(async () => {
    // The modules under test read `config.DATABASE_URL` at import time.
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await ensureParents();
  });

  afterAll(async () => {
    await purge();
    await admin.query(`DELETE FROM kortix.project_sessions WHERE session_id = $1`, [SANDBOX_ID]);
    await admin.query(`DELETE FROM kortix.projects WHERE project_id = $1`, [PROJECT_ID]);
    await admin.query(`DELETE FROM kortix.accounts WHERE account_id = $1`, [ACCOUNT_ID]);
    await admin.end();
  });

  beforeEach(async () => {
    await seed({ initStatus: 'ready' });
  });

  afterEach(async () => {
    await purge();
  });

  describe('egress pin vs restart claim', () => {
    test('a restart claim committed while the pin is in flight survives the pin', async () => {
      const { pinSandboxEgressIp } = await import('../platform/services/sandbox-egress-pin');
      await interleave(
        (tx) =>
          tx.query(
            `UPDATE kortix.session_sandboxes
             SET status = 'provisioning', metadata = metadata || $2::jsonb
             WHERE sandbox_id = $1`,
            [SANDBOX_ID, JSON.stringify(RESTART_CLAIM)],
          ),
        () => pinSandboxEgressIp(SANDBOX_ID, '203.0.113.7'),
      );
      const metadata = await readMetadata();
      expect(metadata.runtimeRestartId).toBe(RESTART_CLAIM.runtimeRestartId);
      expect(metadata.runtimeWakeStartedAt).toBe(RESTART_CLAIM.runtimeWakeStartedAt);
      expect(metadata.egress_ip).toBe('203.0.113.7');
      expect(metadata.initStatus).toBe('ready');
    });

    test('first pin wins: a second pin never moves the address', async () => {
      const { pinSandboxEgressIp } = await import('../platform/services/sandbox-egress-pin');
      await pinSandboxEgressIp(SANDBOX_ID, '203.0.113.7');
      await pinSandboxEgressIp(SANDBOX_ID, '198.51.100.9');
      expect((await readMetadata()).egress_ip).toBe('203.0.113.7');
    });

    test('an empty-string pin counts as unpinned and is replaced', async () => {
      await seed({ egress_ip: '' });
      const { pinSandboxEgressIp } = await import('../platform/services/sandbox-egress-pin');
      await pinSandboxEgressIp(SANDBOX_ID, '203.0.113.7');
      expect((await readMetadata()).egress_ip).toBe('203.0.113.7');
    });

    test('a NULL metadata column is pinned, not skipped', async () => {
      await admin.query(
        `UPDATE kortix.session_sandboxes SET metadata = NULL WHERE sandbox_id = $1`,
        [SANDBOX_ID],
      );
      const { pinSandboxEgressIp } = await import('../platform/services/sandbox-egress-pin');
      await pinSandboxEgressIp(SANDBOX_ID, '203.0.113.7');
      expect(await readMetadata()).toEqual({ egress_ip: '203.0.113.7' });
    });
  });

  describe('restart claim vs concurrent writers', () => {
    const claim = () => {
      const startedAt = new Date();
      return {
        id: crypto.randomUUID(),
        startedAt,
        leaseExpiresAt: new Date(startedAt.getTime() + 4 * 60_000),
      };
    };

    test('a pin committed while the restart claim is in flight survives the claim', async () => {
      // The reverse order of SESS-9: the restart read the row, the pin landed,
      // then the claim wrote its stale copy back and the session lost its
      // egress pin (the secret broker then fails OPEN for that session).
      await seed({
        initStatus: 'ready',
        opencodeBootPhase: 'ready',
        runtimeStartFailureCount: 2,
        stopReason: 'idle',
      });
      const { claimInPlaceRestart } = await import('../projects/session-lifecycle/runtime-restart-claim');
      const restart = claim();
      let owned = false;
      await interleave(
        (tx) =>
          tx.query(
            `UPDATE kortix.session_sandboxes
             SET metadata = metadata || '{"egress_ip":"203.0.113.7"}'::jsonb
             WHERE sandbox_id = $1`,
            [SANDBOX_ID],
          ),
        async () => {
          owned = await claimInPlaceRestart({
            sandboxId: SANDBOX_ID,
            externalId: EXTERNAL_ID,
            claim: restart,
          });
        },
      );
      expect(owned).toBe(true);
      const metadata = await readMetadata();
      expect(metadata.egress_ip).toBe('203.0.113.7');
      expect(metadata.runtimeRestartId).toBe(restart.id);
      expect(metadata.runtimeRestartPhase).toBe('stopping');
      expect(metadata.runtimeWakeStartedAt).toBe(restart.startedAt.toISOString());
      expect(metadata.runtimeWakeProviderStatus).toBe('starting');
      // What an explicit restart clears is still cleared.
      expect(metadata.opencodeBootPhase).toBeUndefined();
      expect(metadata.runtimeStartFailureCount).toBeUndefined();
      expect(metadata.stopReason).toBeUndefined();
      expect(metadata.initStatus).toBe('ready');
    });

    test('a /start readiness write from a row read before the claim does not erase it', async () => {
      const { markOpencodeReadyWaitStarted } = await import('../projects/routes/shared');
      const { claimInPlaceRestart } = await import('../projects/session-lifecycle/runtime-restart-claim');
      const staleRow = { sandboxId: SANDBOX_ID, metadata: await readMetadata() } as never;
      const restart = claim();
      await claimInPlaceRestart({ sandboxId: SANDBOX_ID, externalId: EXTERNAL_ID, claim: restart });

      await markOpencodeReadyWaitStarted(staleRow, 'not_ready', 'config-deps|opencode=starting');

      const metadata = await readMetadata();
      expect(metadata.runtimeRestartId).toBe(restart.id);
      expect(metadata.runtimeWakeStartedAt).toBe(restart.startedAt.toISOString());
    });

    test('a /start readiness write merges its clocks and keeps keys written after its read', async () => {
      const { markOpencodeReadyWaitStarted } = await import('../projects/routes/shared');
      const staleRow = { sandboxId: SANDBOX_ID, metadata: await readMetadata() } as never;
      await admin.query(
        `UPDATE kortix.session_sandboxes SET metadata = metadata || '{"egress_ip":"203.0.113.7"}'::jsonb
         WHERE sandbox_id = $1`,
        [SANDBOX_ID],
      );

      await markOpencodeReadyWaitStarted(staleRow, 'not_ready', 'config-deps|opencode=starting');

      const metadata = await readMetadata();
      expect(metadata.egress_ip).toBe('203.0.113.7');
      expect(metadata.opencodeReadyWaitReason).toBe('not_ready');
      expect(typeof metadata.opencodeNotReadyWaitStartedAt).toBe('string');
      expect(typeof metadata.opencodeBootWaitFirstSeenAt).toBe('string');
      expect(metadata.opencodeBootPhase).toBe('config-deps|opencode=starting');
      expect(metadata.initStatus).toBe('ready');
    });

    test('a /start wake mark from a row read before the claim does not erase it', async () => {
      const { markRuntimeWakeStarted } = await import('../projects/routes/shared');
      const { claimInPlaceRestart } = await import('../projects/session-lifecycle/runtime-restart-claim');
      const staleRow = { sandboxId: SANDBOX_ID, metadata: await readMetadata() } as never;
      const restart = claim();
      await claimInPlaceRestart({ sandboxId: SANDBOX_ID, externalId: EXTERNAL_ID, claim: restart });

      await markRuntimeWakeStarted(staleRow, 'unknown');

      const metadata = await readMetadata();
      expect(metadata.runtimeRestartId).toBe(restart.id);
      // The claim's wake clock is the current attempt's; a stale poll must not move it.
      expect(metadata.runtimeWakeStartedAt).toBe(restart.startedAt.toISOString());
      expect(metadata.runtimeWakeProviderStatus).toBe('starting');
    });

    test('a /start wake mark merges and keeps keys written after its read', async () => {
      const { markRuntimeWakeStarted } = await import('../projects/routes/shared');
      const staleRow = { sandboxId: SANDBOX_ID, metadata: await readMetadata() } as never;
      await admin.query(
        `UPDATE kortix.session_sandboxes SET metadata = metadata || '{"egress_ip":"203.0.113.7"}'::jsonb
         WHERE sandbox_id = $1`,
        [SANDBOX_ID],
      );

      await markRuntimeWakeStarted(staleRow, 'unknown');

      const metadata = await readMetadata();
      expect(metadata.egress_ip).toBe('203.0.113.7');
      expect(typeof metadata.runtimeWakeStartedAt).toBe('string');
      expect(metadata.runtimeWakeProviderStatus).toBe('unknown');
    });
  });
});
