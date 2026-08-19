/**
 * Integration test (real local DB): JAY-599 / T21 — adopting a warm session
 * must clear `metadata.warm` so the `visible` session list stops hiding it.
 *
 * `dropWarmSessionMarkerOnAdopt` (projects/routes/warm-sessions.ts) is called
 * from POST /start (projects/routes/r8.ts) — the earliest server signal a
 * user actually entered a session. Adoption also stamps `last_activity_at` in
 * the SAME statement (a deliberate reversal of the earlier "adoption is not a
 * turn" pin — see the helper's doc comment): the warm take only ever fires
 * /start because the user pressed Enter with a prompt, and an unstamped row
 * sorted the just-started session at its CREATE time, burying it in the
 * sidebar. `recordSessionActivity` (projects/session-activity.ts) still owns
 * the per-turn stamp and re-stamps seconds later.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { dropWarmSessionMarkerOnAdopt } from '../projects/routes/warm-sessions';
import { recordSessionActivity } from '../projects/session-activity';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

let n = 0;
async function seed(metadata: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const sessionId = `adopt-${n}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: USER,
    metadata,
  });
  return sessionId;
}

async function rowOf(sessionId: string) {
  const [row] = await db
    .select({
      metadata: projectSessions.metadata,
      updatedAt: projectSessions.updatedAt,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return {
    metadata: (row?.metadata ?? {}) as Record<string, unknown>,
    updatedAt: row?.updatedAt,
  };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'warm-session-adopt-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('dropWarmSessionMarkerOnAdopt', () => {
  test('drops metadata.warm — the row becomes `visible`-scope eligible', async () => {
    const sessionId = await seed({ warm: true, source: 'ui' });

    await dropWarmSessionMarkerOnAdopt(sessionId);

    const { metadata } = await rowOf(sessionId);
    expect(metadata.warm).toBeUndefined();
    // Untouched sibling keys survive the JSONB `-` delete operator.
    expect(metadata.source).toBe('ui');
  });

  test('stamps last_activity_at at adoption — the user just pressed Enter with a prompt', async () => {
    const sessionId = await seed({ warm: true });

    await dropWarmSessionMarkerOnAdopt(sessionId, Date.parse('2026-08-17T09:30:00.000Z'));

    const { metadata } = await rowOf(sessionId);
    expect(metadata.warm).toBeUndefined();
    expect(metadata.last_activity_at).toBe('2026-08-17T09:30:00.000Z');
  });

  // REVERSED (with the activity stamp): `GET /sessions` orders by
  // `updated_at DESC`, so an adoption that left it untouched made API-order
  // consumers (CLI, mobile, external SDK) report a stale "latest session"
  // until the first prompt's `recordSessionActivity` caught up. Adoption now
  // stamps both, exactly like `recordSessionActivity`.
  test('bumps updated_at to the adoption time — API-order consumers see the adopted session as newest', async () => {
    const sessionId = await seed({ warm: true });

    await dropWarmSessionMarkerOnAdopt(sessionId, Date.parse('2026-08-17T09:30:00.000Z'));

    const after = (await rowOf(sessionId)).updatedAt;
    expect(after?.toISOString()).toBe('2026-08-17T09:30:00.000Z');
  });

  test('a session that was never warm keeps its updated_at — the WHERE guard bounds the touch', async () => {
    const sessionId = await seed({ source: 'ui' });
    const before = (await rowOf(sessionId)).updatedAt;

    await dropWarmSessionMarkerOnAdopt(sessionId, Date.parse('2026-08-17T09:30:00.000Z'));

    const after = (await rowOf(sessionId)).updatedAt;
    expect(after?.getTime()).toBe(before?.getTime());
  });

  test('a session that was never warm: no-op, no throw', async () => {
    const sessionId = await seed({ source: 'ui' });

    await dropWarmSessionMarkerOnAdopt(sessionId);

    const { metadata } = await rowOf(sessionId);
    expect(metadata).toEqual({ source: 'ui' });
  });

  test('idempotent — a second call finds no marker left and never re-stamps', async () => {
    const sessionId = await seed({ warm: true });

    await dropWarmSessionMarkerOnAdopt(sessionId, Date.parse('2026-08-17T09:30:00.000Z'));
    await dropWarmSessionMarkerOnAdopt(sessionId, Date.parse('2026-08-17T09:45:00.000Z'));

    const { metadata } = await rowOf(sessionId);
    expect(metadata.warm).toBeUndefined();
    expect(metadata.last_activity_at).toBe('2026-08-17T09:30:00.000Z');
  });

  test('never throws on an unknown session id', async () => {
    await dropWarmSessionMarkerOnAdopt(crypto.randomUUID());
  });

  // The turn path stays exactly as it was: `recordSessionActivity` still
  // drops the marker AND stamps activity together, for a session that never
  // went through /start (e.g. a server-side follow-up delivered straight to
  // an OLD, already-visible session — /start is skipped for those).
  test('recordSessionActivity is unaffected — still drops the marker AND stamps activity together', async () => {
    const sessionId = await seed({ warm: true });

    await recordSessionActivity({
      sessionId,
      projectId: PROJECT,
      at: Date.parse('2026-08-11T09:00:00.000Z'),
    });

    const { metadata } = await rowOf(sessionId);
    expect(metadata.warm).toBeUndefined();
    expect(metadata.last_activity_at).toBe('2026-08-11T09:00:00.000Z');
  });
});
