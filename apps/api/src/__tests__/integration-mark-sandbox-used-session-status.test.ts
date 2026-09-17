/**
 * Integration test (real local DB): proxied traffic may write the session row
 * `running` only for a runtime that IS running.
 *
 * `markSandboxUsed` runs on every proxied response (throttled per pod). A
 * restart and an in-place recovery keep the same `external_id` and set the
 * sandbox row and the session row to `provisioning` while the box comes back.
 * The open tab keeps polling that box through the proxy, and each response
 * used to write the session row `running` again, so the sidebar dot moved
 * yellow → green → yellow while the runtime was still down.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const { db } = await import('../shared/db');
const { markSandboxUsed } = await import('../sandbox-proxy/backend');

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const created: Array<{ sandboxId: string; sessionId: string }> = [];

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const first = (r: unknown) => ((r as Rows).rows ?? (r as Rows))[0];

async function fixture(input: {
  sessionStatus: string;
  sandboxStatus: string;
  metadata?: Record<string, unknown>;
  deadline?: 'expired' | 'live';
}): Promise<{ externalId: string; statusOf: () => Promise<{ sandbox: string; session: string }> }> {
  const sandboxId = crypto.randomUUID();
  const sessionId = `mark-used-${sandboxId}`;
  const externalId = `ext-${sandboxId}`;
  created.push({ sandboxId, sessionId });
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${sandboxId}`}, ${input.sessionStatus})`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, external_id, metadata)
    VALUES (${sandboxId}::uuid, ${sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${input.sandboxStatus}, ${externalId}, ${JSON.stringify(input.metadata ?? {})}::jsonb)`);
  if (input.deadline === 'expired') {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes SET deadline_at = now() - interval '1 second'
       WHERE sandbox_id = ${sandboxId}::uuid`);
  } else if (input.deadline === 'live') {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '10 minutes'
       WHERE sandbox_id = ${sandboxId}::uuid`);
  }
  return {
    externalId,
    statusOf: async () =>
      first(
        await db.execute(sql`
          SELECT s.status AS sandbox, p.status AS session
            FROM kortix.session_sandboxes s
            JOIN kortix.project_sessions p ON p.session_id = s.session_id
           WHERE s.sandbox_id = ${sandboxId}::uuid`),
      ) as { sandbox: string; session: string },
  };
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'mark-used-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'mark-used-it', 'https://example.invalid/r.git')`);
});

afterAll(async () => {
  for (const { sandboxId, sessionId } of created) {
    // The identity guard refuses to delete an established sandbox unless its
    // session is tombstoned, so tombstone it first.
    await db
      .execute(sql`
        UPDATE kortix.project_sessions
           SET metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
         WHERE session_id = ${sessionId}`)
      .catch(() => undefined);
    await db
      .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${sandboxId}::uuid`)
      .catch(() => undefined);
    await db
      .execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${sessionId}`)
      .catch(() => undefined);
  }
  await db
    .execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`)
    .catch(() => undefined);
});

describe('markSandboxUsed — the session row follows the runtime, not the traffic', () => {
  test('a restart in flight keeps the session provisioning while the tab polls the box', async () => {
    const box = await fixture({
      sessionStatus: 'provisioning',
      sandboxStatus: 'provisioning',
      metadata: {
        runtimeRestartId: crypto.randomUUID(),
        runtimeRestartStartedAt: new Date().toISOString(),
        runtimeRestartLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        runtimeRestartPhase: 'starting',
      },
    });

    await markSandboxUsed(box.externalId);

    expect(await box.statusOf()).toEqual({ sandbox: 'provisioning', session: 'provisioning' });
  });

  test('an in-place recovery in flight keeps the session provisioning', async () => {
    const box = await fixture({
      sessionStatus: 'provisioning',
      sandboxStatus: 'provisioning',
      metadata: { runtimeIdentityState: 'recovering' },
    });

    await markSandboxUsed(box.externalId);

    expect(await box.statusOf()).toEqual({ sandbox: 'provisioning', session: 'provisioning' });
  });

  test('a stopped box whose heal is refused does not mark its session running', async () => {
    const box = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      deadline: 'expired',
    });

    await markSandboxUsed(box.externalId);

    expect(await box.statusOf()).toEqual({ sandbox: 'stopped', session: 'stopped' });
  });

  // Guards: these pass before and after the fix. They pin that a live runtime
  // still marks its session running.
  test('guard: an active box marks its session running', async () => {
    const box = await fixture({ sessionStatus: 'provisioning', sandboxStatus: 'active' });

    await markSandboxUsed(box.externalId);

    expect(await box.statusOf()).toEqual({ sandbox: 'active', session: 'running' });
  });

  test('guard: a stopped box with a live deadline heals and marks its session running', async () => {
    const box = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      deadline: 'live',
    });

    await markSandboxUsed(box.externalId);

    expect(await box.statusOf()).toEqual({ sandbox: 'active', session: 'running' });
  });
});
