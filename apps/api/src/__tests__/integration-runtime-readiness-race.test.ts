import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import {
  claimSessionRuntimeBootstrap,
  clearRuntimeReadinessClocks,
  markOpencodeReadyWaitStarted,
  markRuntimeWakeStarted,
} from '../projects/routes/shared';
import { RUNTIME_READINESS_CLOCK_KEYS } from '../projects/session-lifecycle/readiness-clocks';
import { db } from '../shared/db';

const sandboxId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = `readiness-${sandboxId}`;
const originalMetadata = {
  initStatus: 'ready',
  opencodeBootPhase: 'starting',
  opencodeBootWaitFirstSeenAt: '2026-09-07T15:30:00.000Z',
  activeTurns: { original: { state: 'active' } },
};

async function readSandbox() {
  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
  if (!row) throw new Error('fixture sandbox missing');
  return row;
}

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${accountId}::uuid, 'readiness-race')`,
  );
  await db.execute(sql`INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${projectId}::uuid, ${accountId}::uuid, 'readiness-race', 'https://example.invalid/readiness.git')`);
  await db.execute(sql`INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${sessionId}, ${accountId}::uuid, ${projectId}::uuid, ${`readiness-${sandboxId}`}, 'running')`);
});

beforeEach(async () => {
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, status, metadata, updated_at)
    VALUES (${sandboxId}::uuid, ${sessionId}, ${accountId}::uuid,
            ${projectId}::uuid, 'readiness-original', 'active',
            ${JSON.stringify(originalMetadata)}::jsonb, '2026-09-07T15:31:40.219123Z')
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = 'active', metadata = EXCLUDED.metadata,
           external_id = EXCLUDED.external_id, updated_at = EXCLUDED.updated_at`);
});

afterAll(async () => {
  await db.execute(sql`UPDATE kortix.project_sessions
    SET metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
    WHERE session_id = ${sessionId}`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${sessionId}`);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${projectId}::uuid`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${accountId}::uuid`);
});

const observations = [
  [
    'wake',
    (row: Awaited<ReturnType<typeof readSandbox>>) => markRuntimeWakeStarted(row, 'stopped'),
  ],
  [
    'boot progress',
    (row: Awaited<ReturnType<typeof readSandbox>>) =>
      markOpencodeReadyWaitStarted(row, 'not_ready', 'config-ready'),
  ],
  ['ready', clearRuntimeReadinessClocks],
] as const;

for (const [name, observe] of observations) {
  test(`SESS-9: stale ${name} cannot erase an accepted restart or its new clocks`, async () => {
    const observed = await readSandbox();
    const restarted = {
      initStatus: 'ready',
      runtimeRestartId: crypto.randomUUID(),
      runtimeRestartPhase: 'stopping',
      runtimeRestartLeaseUntil: '2026-09-07T15:33:00.000Z',
      runtimeWakeStartedAt: '2026-09-07T15:31:44.000Z',
      runtimeWakeProviderStatus: 'starting',
      activeTurns: { newer: { state: 'accepted' } },
    };
    await db
      .update(sessionSandboxes)
      .set({ status: 'provisioning', metadata: restarted })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    const before = await readSandbox();
    await observe(observed);
    expect(await readSandbox()).toEqual(before);
  });

  test(`a stale ${name} cannot change metadata after a status-only stop`, async () => {
    const observed = await readSandbox();
    await db
      .update(sessionSandboxes)
      .set({ status: 'stopped' })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    const before = await readSandbox();
    await observe(observed);
    expect(await readSandbox()).toEqual(before);
  });

  test(`a stale ${name} cannot overwrite metadata written by a concurrent turn`, async () => {
    const observed = await readSandbox();
    await db
      .update(sessionSandboxes)
      .set({ metadata: { ...originalMetadata, activeTurns: { newer: { state: 'active' } } } })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    const before = await readSandbox();
    await observe(observed);
    expect(await readSandbox()).toEqual(before);
  });
}

test('current wake and boot observations apply despite PostgreSQL timestamp microseconds', async () => {
  await markRuntimeWakeStarted(await readSandbox(), 'stopped');
  const waking = await readSandbox();
  expect(waking.metadata?.runtimeWakeStartedAt).toBeString();
  expect(waking.metadata?.runtimeWakeProviderStatus).toBe('stopped');
  expect(waking.metadata?.activeTurns).toEqual(originalMetadata.activeTurns);
  await markRuntimeWakeStarted(waking, 'unknown');
  expect(await readSandbox()).toEqual(waking);
  await markOpencodeReadyWaitStarted(waking, 'not_ready', 'config-ready');
  const booting = await readSandbox();
  expect(booting.metadata?.opencodeReadyWaitReason).toBe('not_ready');
  expect(booting.metadata?.opencodeBootPhase).toBe('config-ready');
  expect(booting.metadata?.activeTurns).toEqual(originalMetadata.activeTurns);
  await clearRuntimeReadinessClocks(booting);
  const ready = await readSandbox();
  for (const key of RUNTIME_READINESS_CLOCK_KEYS) expect(ready.metadata).not.toHaveProperty(key);
  expect(ready.metadata?.initStatus).toBe('ready');
  expect(ready.metadata?.activeTurns).toEqual(originalMetadata.activeTurns);
});

test('one bootstrap claim starts a fresh clock before stale readiness observations can overwrite it', async () => {
  const observed = await readSandbox();
  const now = new Date('2026-09-08T09:04:20.000Z');
  const claims = await Promise.all([
    claimSessionRuntimeBootstrap(observed, now),
    claimSessionRuntimeBootstrap(observed, now),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = await readSandbox();
  expect(claimed.updatedAt.toISOString()).toBe(now.toISOString());
  expect(claimed.metadata?.sessionRuntimeBootstrapFor).toBe(observed.externalId);
  expect(claimed.metadata?.sessionRuntimeBootstrapAt).toBe(now.toISOString());
  expect(claimed.metadata?.opencodeBootWaitFirstSeenAt).toBe(now.toISOString());
  expect(claimed.metadata?.opencodeUnreachableWaitStartedAt).toBe(now.toISOString());
  expect(claimed.metadata?.activeTurns).toEqual(originalMetadata.activeTurns);
  for (const [, observe] of observations) {
    await observe(observed);
    expect(await readSandbox()).toEqual(claimed);
  }
  expect(await claimSessionRuntimeBootstrap(claimed, new Date(now.getTime() + 1000))).toBeNull();
  expect(await readSandbox()).toEqual(claimed);
});

test('a bootstrap claim cannot outlive a stop or a concurrent turn update', async () => {
  const observed = await readSandbox();
  await db.update(sessionSandboxes).set({ status: 'stopped' }).where(eq(sessionSandboxes.sandboxId, sandboxId));
  const stopped = await readSandbox();
  expect(await claimSessionRuntimeBootstrap(observed)).toBeNull();
  expect(await readSandbox()).toEqual(stopped);
  await db.update(sessionSandboxes).set({ status: 'active', metadata: { ...originalMetadata, activeTurns: { newer: { state: 'active' } } } }).where(eq(sessionSandboxes.sandboxId, sandboxId));
  const concurrent = await readSandbox();
  expect(await claimSessionRuntimeBootstrap(observed)).toBeNull();
  expect(await readSandbox()).toEqual(concurrent);
});
