/**
 * Integration test (real local DB): the last-activity stamp.
 *
 * `metadata.last_activity_at` is what the sidebar dates a session by. It is
 * written from the prompt path, which is the same window in which the title CAS
 * and the opencode_sessions snapshot write their OWN keys of the same jsonb
 * column — so the one thing that must never happen is this stamp clobbering
 * either of them. These tests pin the merge and the timestamp together.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { recordSessionActivity } from '../projects/session-activity';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

let n = 0;
async function seed(metadata: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const sessionId = `activity-${n}-${crypto.randomUUID().slice(0, 8)}`;
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
    .select({ metadata: projectSessions.metadata, updatedAt: projectSessions.updatedAt })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return { metadata: (row?.metadata ?? {}) as Record<string, unknown>, updatedAt: row?.updatedAt };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-activity-test' });
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

describe('recordSessionActivity', () => {
  test('stamps last_activity_at as an ISO string and advances updated_at', async () => {
    const sessionId = await seed();
    const at = Date.parse('2026-08-11T09:30:00.000Z');

    await recordSessionActivity({ sessionId, projectId: PROJECT, at });

    const row = await rowOf(sessionId);
    expect(row.metadata.last_activity_at).toBe('2026-08-11T09:30:00.000Z');
    expect(row.updatedAt?.toISOString()).toBe('2026-08-11T09:30:00.000Z');
  });

  test('merges — a concurrent title and the conversation snapshot both survive', async () => {
    const sessionId = await seed({
      name: 'Generated Title',
      custom_name: 'My Own Name',
      opencode_sessions: [{ id: 'oc-1', updated_at: 1 }],
    });

    await recordSessionActivity({ sessionId, projectId: PROJECT });

    const { metadata } = await rowOf(sessionId);
    expect(metadata.name).toBe('Generated Title');
    expect(metadata.custom_name).toBe('My Own Name');
    expect(metadata.opencode_sessions).toEqual([{ id: 'oc-1', updated_at: 1 }]);
    expect(typeof metadata.last_activity_at).toBe('string');
  });

  test('a later turn moves the stamp forward', async () => {
    const sessionId = await seed();

    await recordSessionActivity({
      sessionId,
      projectId: PROJECT,
      at: Date.parse('2026-08-10T09:00:00.000Z'),
    });
    await recordSessionActivity({
      sessionId,
      projectId: PROJECT,
      at: Date.parse('2026-08-11T09:00:00.000Z'),
    });

    expect((await rowOf(sessionId)).metadata.last_activity_at).toBe('2026-08-11T09:00:00.000Z');
  });

  test('scoped to its project — a mismatched projectId writes nothing', async () => {
    const sessionId = await seed();

    await recordSessionActivity({ sessionId, projectId: crypto.randomUUID() });

    expect((await rowOf(sessionId)).metadata.last_activity_at).toBeUndefined();
  });

  test('never throws on a missing identifier', async () => {
    await recordSessionActivity({ sessionId: '', projectId: PROJECT });
    await recordSessionActivity({ sessionId: 'x', projectId: '' });
  });
});
