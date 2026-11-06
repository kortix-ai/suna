// Real-PostgreSQL tests for the preview proxy's lifecycle writes
// (`sandbox-proxy/backend.ts`: `markSandboxUsed`, `markSandboxErrored`).
//
// Both writers read the sandbox row, then write it. They used to write
// `WHERE sandbox_id = ?` / `WHERE session_id = ?` only, so:
//   - a delete that archived the row between the read and the heal got
//     `archived -> active` (a deleted session's box revived);
//   - every proxied request flipped the session to `running`, over a
//     `parkTurnError` park, a `failed` dead-letter, or a restart claim;
//   - `markSandboxErrored` overwrote a restart owner's `provisioning` row.
// Each writer is now a named transition (status-transitions.ts). The races
// are reproduced with a second connection that holds the row lock.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from './helpers/pg-client';
import { interleave } from './helpers/interleave';

const ACCOUNT_ID = '00000000-0000-4000-a000-0000000f5a01';
const PROJECT_ID = '00000000-0000-4000-a000-0000000f5a02';
const SESSION_ID = '00000000-0000-4000-a000-0000000f5a03';
const SANDBOX_ID = '00000000-0000-4000-a000-0000000f5a04';

let admin: PgClient;
let seq = 0;

/** A fresh external id per test: `markSandboxUsed` throttles per external id. */
async function seed(input: {
  sandbox: string;
  session: string;
  deadlineInMs?: number;
}): Promise<string> {
  const externalId = `ext-proxy-guard-${++seq}`;
  await purgeSandbox();
  await admin.query(
    `UPDATE kortix.project_sessions SET status = $2, metadata = '{}'::jsonb WHERE session_id = $1`,
    [SESSION_ID, input.session],
  );
  await admin.query(
    `INSERT INTO kortix.session_sandboxes
       (sandbox_id, session_id, account_id, project_id, status, external_id, deadline_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, now() + ($7::text || ' milliseconds')::interval)`,
    [SANDBOX_ID, SESSION_ID, ACCOUNT_ID, PROJECT_ID, input.sandbox, externalId, String(input.deadlineInMs ?? 3_600_000)],
  );
  return externalId;
}

/** The identity trigger deletes an established row only under a tombstoned session. */
async function purgeSandbox(): Promise<void> {
  await admin.query(
    `UPDATE kortix.project_sessions SET metadata = '{"deletedAt":"2026-11-06T00:00:00.000Z"}'::jsonb WHERE session_id = $1`,
    [SESSION_ID],
  );
  await admin.query(`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1`, [SANDBOX_ID]);
}

async function statuses(): Promise<{ sandbox: string; session: string }> {
  const sandbox = await admin.query(`SELECT status FROM kortix.session_sandboxes WHERE sandbox_id = $1`, [SANDBOX_ID]);
  const session = await admin.query(`SELECT status FROM kortix.project_sessions WHERE session_id = $1`, [SESSION_ID]);
  return { sandbox: sandbox.rows[0]?.status, session: session.rows[0]?.status };
}

describe('preview proxy lifecycle writes are guarded transitions (real PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    admin = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO kortix.accounts (account_id, name) VALUES ($1, 'proxy guard e2e') ON CONFLICT DO NOTHING`,
      [ACCOUNT_ID],
    );
    await admin.query(
      `INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
       VALUES ($1, $2, 'proxy guard e2e', 'https://example.test/proxy-guard.git') ON CONFLICT DO NOTHING`,
      [PROJECT_ID, ACCOUNT_ID],
    );
    await admin.query(
      `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
       VALUES ($1, $2, $3, 'e2e/proxy-guard', 'running') ON CONFLICT DO NOTHING`,
      [SESSION_ID, ACCOUNT_ID, PROJECT_ID],
    );
  });

  afterAll(async () => {
    await purgeSandbox();
    await admin.query(`DELETE FROM kortix.project_sessions WHERE session_id = $1`, [SESSION_ID]);
    await admin.query(`DELETE FROM kortix.projects WHERE project_id = $1`, [PROJECT_ID]);
    await admin.query(`DELETE FROM kortix.accounts WHERE account_id = $1`, [ACCOUNT_ID]);
    await admin.end();
  });

  test('a heal never revives a row a concurrent delete archived after the read', async () => {
    const externalId = await seed({ sandbox: 'stopped', session: 'stopped' });
    const { markSandboxUsed } = await import('../sandbox-proxy/backend');
    await interleave(
      (tx) => tx.query(`UPDATE kortix.session_sandboxes SET status = 'archived' WHERE sandbox_id = $1`, [SANDBOX_ID]),
      () => markSandboxUsed(externalId),
      'session_sandboxes',
    );
    expect((await statuses()).sandbox).toBe('archived');
  });

  test('a heal never revives a row a restart claimed for provisioning after the read', async () => {
    const externalId = await seed({ sandbox: 'error', session: 'running' });
    const { markSandboxUsed } = await import('../sandbox-proxy/backend');
    await interleave(
      (tx) => tx.query(`UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = $1`, [SANDBOX_ID]),
      () => markSandboxUsed(externalId),
      'session_sandboxes',
    );
    expect((await statuses()).sandbox).toBe('provisioning');
  });

  test('a heal of a stopped box with a live deadline still makes it active', async () => {
    const externalId = await seed({ sandbox: 'stopped', session: 'running' });
    const { markSandboxUsed } = await import('../sandbox-proxy/backend');
    await markSandboxUsed(externalId);
    expect(await statuses()).toEqual({ sandbox: 'active', session: 'running' });
  });

  for (const parked of ['stopped', 'failed', 'provisioning'] as const) {
    test(`traffic to an active box leaves a ${parked} session ${parked}`, async () => {
      const externalId = await seed({ sandbox: 'active', session: parked });
      const { markSandboxUsed } = await import('../sandbox-proxy/backend');
      await markSandboxUsed(externalId);
      expect(await statuses()).toEqual({ sandbox: 'active', session: parked });
    });
  }

  test('traffic to an active box refreshes a running session', async () => {
    const externalId = await seed({ sandbox: 'active', session: 'running' });
    await admin.query(`UPDATE kortix.project_sessions SET updated_at = now() - interval '1 hour' WHERE session_id = $1`, [SESSION_ID]);
    const { markSandboxUsed } = await import('../sandbox-proxy/backend');
    await markSandboxUsed(externalId);
    const row = await admin.query(
      `SELECT status, updated_at > now() - interval '1 minute' AS fresh FROM kortix.project_sessions WHERE session_id = $1`,
      [SESSION_ID],
    );
    expect(row.rows[0]).toEqual({ status: 'running', fresh: true });
  });

  test('markSandboxErrored never overwrites a restart claim that landed after its read', async () => {
    const externalId = await seed({ sandbox: 'active', session: 'running' });
    const { markSandboxErrored } = await import('../sandbox-proxy/backend');
    await interleave(
      (tx) => tx.query(`UPDATE kortix.session_sandboxes SET status = 'provisioning' WHERE sandbox_id = $1`, [SANDBOX_ID]),
      () => markSandboxErrored(externalId),
      'session_sandboxes',
    );
    expect((await statuses()).sandbox).toBe('provisioning');
  });

  test('markSandboxErrored still marks an active box error', async () => {
    const externalId = await seed({ sandbox: 'active', session: 'running' });
    const { markSandboxErrored } = await import('../sandbox-proxy/backend');
    await markSandboxErrored(externalId);
    expect((await statuses()).sandbox).toBe('error');
  });
});
