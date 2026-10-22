// Real-DB check of the legacy runtime bootstrap's run claim. Concurrent
// `/start` polls land on different API replicas; only the row write can
// serialize them. Four claims racing on one row must produce one owner.
//
// Runs in the `db-suites` lane of `pnpm test` (one throwaway database per file).
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import * as realProviders from '../platform/providers';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({ getStatus: async () => 'running' }),
}));
const { buildLegacyBootstrapDeps } = await import('../projects/lib/legacy-runtime-bootstrap-wiring');

let project: SeededProject;
beforeAll(async () => {
  project = await seedProject('legacy-bootstrap-claim');
});
afterAll(async () => {
  await removeSeeded([project]);
});

async function sandbox(metadata: Record<string, unknown>) {
  const sessionId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    values (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId}, 'running')`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, provider, status, metadata)
    values (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
      ${`sbx_claim_${sessionId.slice(0, 8)}`}, 'platinum', 'active', ${JSON.stringify(metadata)}::jsonb)`);
  const deps = buildLegacyBootstrapDeps({
    sandboxId: sessionId,
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'platinum',
    externalId: `sbx_claim_${sessionId.slice(0, 8)}`,
    metadata,
  });
  const read = async () => {
    const [row] = await db.select({ metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId));
    return (row?.metadata ?? {}) as Record<string, any>;
  };
  return { deps, read };
}

const NOW = '2026-10-13T12:33:00.000Z';
const STALE_BEFORE = '2026-10-13T12:13:00.000Z';
const claimPatch = (n: number) => ({
  legacyRuntimeBootstrap: { state: 'running', attempts: n, lastAttemptAt: NOW, reason: `replica-${n}` },
});

test('four concurrent claims on one row: exactly one wins, and its record stays', async () => {
  const { deps, read } = await sandbox({ egressPin: 'kept' });
  const won = await Promise.all([1, 2, 3, 4].map((n) => deps.claimRun(claimPatch(n), STALE_BEFORE)));
  expect(won.filter(Boolean)).toHaveLength(1);
  const metadata = await read();
  expect(metadata.legacyRuntimeBootstrap.reason).toBe(`replica-${won.indexOf(true) + 1}`);
  expect(metadata.egressPin).toBe('kept');
});

test('a running record older than the stale bound, or a finished one, does not block a claim', async () => {
  const stale = await sandbox({
    legacyRuntimeBootstrap: { state: 'running', attempts: 1, lastAttemptAt: '2026-10-13T12:00:00.000Z' },
  });
  expect(await stale.deps.claimRun(claimPatch(2), STALE_BEFORE)).toBe(true);
  expect((await stale.read()).legacyRuntimeBootstrap.attempts).toBe(2);

  const finished = await sandbox({
    legacyRuntimeBootstrap: { state: 'failed', attempts: 1, lastAttemptAt: NOW },
  });
  expect(await finished.deps.claimRun(claimPatch(2), STALE_BEFORE)).toBe(true);
});

test('a fresh running record blocks a claim', async () => {
  const { deps, read } = await sandbox({
    legacyRuntimeBootstrap: { state: 'running', attempts: 1, lastAttemptAt: '2026-10-13T12:30:00.000Z' },
  });
  expect(await deps.claimRun(claimPatch(2), STALE_BEFORE)).toBe(false);
  expect((await read()).legacyRuntimeBootstrap.attempts).toBe(1);
});
