/**
 * Integration test (real PostgreSQL): `stoppedSandboxWakePending`, the read
 * that decides whether the sandbox proxy tells a client to keep retrying a
 * stopped box (KRTX-3140).
 *
 * A wake claim leaves the row `stopped` and stamps a lease in its metadata
 * until the provider confirms the box. While that lease is open a read is
 * still worth retrying; once it lapses, or when no wake was ever claimed, it
 * is not.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { stoppedSandboxWakePending } from '../projects/session-open';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

let project: SeededProject | null = null;
let sessionId = '';
const externalId = `wake-pending-box-${crypto.randomUUID()}`;

beforeAll(async () => {
  localTestDatabaseUrl();
  project = await seedProject('wake-pending');
  sessionId = await seedSession(project, crypto.randomUUID());
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'platinum',
    status: 'stopped',
    externalId,
    metadata: { stopReason: 'idle_grace' },
  });
});

afterAll(async () => {
  // The identity trigger lets a box row with an external id go only once its
  // session is deleted.
  await db
    .update(projectSessions)
    .set({ metadata: { deletedAt: new Date().toISOString() } })
    .where(eq(projectSessions.sessionId, sessionId));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
  if (project) await removeSeeded([project]);
});

async function setWake(startedAgoMs: number, leaseFromNowMs: number) {
  const now = Date.now();
  await db
    .update(sessionSandboxes)
    .set({
      metadata: {
        stopReason: 'idle_grace',
        runtimeWakeId: crypto.randomUUID(),
        runtimeWakeStartedAt: new Date(now - startedAgoMs).toISOString(),
        runtimeWakeLeaseExpiresAt: new Date(now + leaseFromNowMs).toISOString(),
      },
    })
    .where(eq(sessionSandboxes.externalId, externalId));
}

test('a parked box with no wake claimed has no wake pending', async () => {
  expect(await stoppedSandboxWakePending(externalId)).toBe(false);
});

test('a claimed wake whose lease is open is pending', async () => {
  await setWake(5_000, 235_000);
  expect(await stoppedSandboxWakePending(externalId)).toBe(true);
});

test('a claimed wake whose lease lapsed is not pending', async () => {
  await setWake(300_000, -60_000);
  expect(await stoppedSandboxWakePending(externalId)).toBe(false);
});

test('an unknown box has no wake pending', async () => {
  expect(await stoppedSandboxWakePending(`missing-${crypto.randomUUID()}`)).toBe(false);
});
