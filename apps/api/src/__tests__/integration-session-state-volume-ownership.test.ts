/**
 * Integration test (real local DB): an ephemeral session's state volume is
 * named from its session id (`kss-<session id>`). Session metadata only
 * records that the session has one. A value a caller wrote there naming any
 * other volume (a drive's `kd-…`, another session's `kss-…`) must never be
 * queued for deletion: not by the session delete route, and not by the
 * AFTER DELETE trigger a project or account cascade fires.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, platinumVolumeDeletions, projectSessions, projects } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { scheduleSessionStateVolumeDelete, sessionStateVolumeName } from '../platform/services/ephemeral-sandbox';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const VICTIM = `kd-${crypto.randomUUID()}`;

async function session(metadata: Record<string, unknown>): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `state-volume-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    visibility: 'private',
    metadata,
  });
  return sessionId;
}

async function queued(names: string[]): Promise<string[]> {
  const rows = await db
    .select({ name: platinumVolumeDeletions.volumeName })
    .from(platinumVolumeDeletions)
    .where(inArray(platinumVolumeDeletions.volumeName, names));
  return rows.map((r) => r.name).sort();
}

const created: string[] = [];

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'state-volume-ownership' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'state-volume-ownership',
    repoUrl: 'https://example.test/state-volume.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.delete(platinumVolumeDeletions).where(inArray(platinumVolumeDeletions.volumeName, [VICTIM, ...created]));
});

describe('session state volume deletion follows the session id, never the metadata', () => {
  test('the delete route queues the session’s own volume, and ignores a forged one', async () => {
    const own = await session({});
    created.push(sessionStateVolumeName(own));
    await db
      .update(projectSessions)
      .set({ metadata: { ephemeral_state_volume: sessionStateVolumeName(own) } })
      .where(eq(projectSessions.sessionId, own));
    const forged = await session({ ephemeral_state_volume: VICTIM });
    created.push(sessionStateVolumeName(forged));

    await scheduleSessionStateVolumeDelete(own);
    await scheduleSessionStateVolumeDelete(forged);

    expect(await queued([VICTIM, sessionStateVolumeName(own), sessionStateVolumeName(forged)])).toEqual([
      sessionStateVolumeName(own),
    ]);
  });

  test('a cascade delete queues the session’s own volume, and ignores a forged one', async () => {
    const own = await session({});
    created.push(sessionStateVolumeName(own));
    await db
      .update(projectSessions)
      .set({ metadata: { ephemeral_state_volume: sessionStateVolumeName(own) } })
      .where(eq(projectSessions.sessionId, own));
    const forged = await session({ ephemeral_state_volume: VICTIM });
    created.push(sessionStateVolumeName(forged));

    await db.delete(projectSessions).where(inArray(projectSessions.sessionId, [own, forged]));

    expect(await queued([VICTIM, sessionStateVolumeName(own), sessionStateVolumeName(forged)])).toEqual([
      sessionStateVolumeName(own),
    ]);
  });
});
