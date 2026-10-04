/**
 * Integration test (real local PostgreSQL): the parked-runtime sweep rotates
 * through the whole fleet. Every row of a batch is stamped `parkedVerifiedAt`
 * whatever its outcome; a row that only some outcomes stamped stayed at the
 * head of every batch and starved the rest. Rows on a provider this API does
 * not serve are skipped before any provider call, so nothing here touches a
 * network.
 */
import { beforeAll, expect, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { config } from '../config';
import { verifyParkedRuntimes } from '../projects/reaping/parked-runtime-verification';
import { db } from '../shared/db';
import { seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

let project: SeededProject;
const sandboxIds: string[] = [];

beforeAll(async () => {
  project = await seedProject('parked-verify');
});

// No teardown: each DB suite runs on its own fresh database, and a guard
// trigger refuses deleting session_sandboxes rows.

test('a skipped row is stamped too, so the next batch moves on', async () => {
  const unserved = (['daytona', 'platinum', 'e2b'] as const).find(
    (p) => !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(p),
  );
  if (!unserved) throw new Error('every provider is allowed here; the test needs one that is not');

  for (let i = 0; i < 2; i += 1) {
    const sessionId = await seedSession(project, crypto.randomUUID());
    const [row] = await db
      .insert(sessionSandboxes)
      .values({
        sandboxId: crypto.randomUUID(),
        sessionId,
        accountId: project.account_id,
        projectId: project.project_id,
        provider: unserved,
        status: 'stopped',
        externalId: `ext-${crypto.randomUUID()}`,
      })
      .returning({ sandboxId: sessionSandboxes.sandboxId });
    sandboxIds.push(row!.sandboxId);
  }

  const now = new Date();
  await verifyParkedRuntimes(now);

  const rows = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.sandboxId, sandboxIds));
  expect(rows.map((r) => (r.metadata as Record<string, unknown>).parkedVerifiedAt)).toEqual([
    now.toISOString(),
    now.toISOString(),
  ]);
});
