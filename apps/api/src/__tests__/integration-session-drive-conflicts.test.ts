/**
 * Integration test (real local DB): the session's folders name their open
 * conflict copies and when the newest one was detected.
 *
 * The session's conflict notice (packages/ui conflict-marks.ts) compares
 * `latestConflictAt` across reads, so a folder that mounts with old conflicts
 * announces nothing and a conflict detected later is announced once. Each
 * folder counts only the conflicts inside it; resolved and dismissed copies
 * count for none. The runner gives this file its own fresh database.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { accounts, driveConflicts, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';

const { ensureProjectDrive, readSessionDriveMounts } = await import('../drives/service');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const OLD = new Date('2026-11-01T10:00:00.000Z');
const NEW = new Date('2026-11-04T09:00:00.000Z');
let driveId = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-drive-conflicts' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'session-drive-conflicts',
    repoUrl: 'https://example.test/session-drive-conflicts.git',
  });
  driveId = (await ensureProjectDrive(ACCOUNT, PROJECT)).driveId;
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: SESSION,
    createdBy: OWNER,
    visibility: 'project',
    origin: 'trigger',
    agentName: 'editor',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: SESSION,
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    provider: 'platinum',
    externalId: `box-${SESSION.slice(0, 8)}`,
    status: 'active',
    config: {},
    metadata: {
      driveMounts: [
        { driveId, kind: 'project', mountPath: '/drives/me', readOnly: false, subdir: '/Users/ana', role: 'me' },
        { driveId, kind: 'project', mountPath: '/drives/team', readOnly: false, subdir: '/Team' },
      ],
    },
  });
  await db.insert(driveConflicts).values([
    { driveId, path: '/Users/ana/a (conflict 1).md', originalPath: '/Users/ana/a.md', detectedAt: OLD },
    { driveId, path: '/Users/ana/b (conflict 1).md', originalPath: '/Users/ana/b.md', detectedAt: NEW },
    // Closed copies, and a newer one outside both folders: none of them count.
    { driveId, path: '/Users/ana/c (conflict 1).md', originalPath: '/Users/ana/c.md', detectedAt: new Date('2026-11-05T00:00:00.000Z'), resolvedAt: new Date() },
    { driveId, path: '/Team/d (conflict 1).md', originalPath: '/Team/d.md', detectedAt: new Date('2026-11-05T00:00:00.000Z'), dismissedAt: new Date() },
    { driveId, path: '/Other/e (conflict 1).md', originalPath: '/Other/e.md', detectedAt: new Date('2026-11-06T00:00:00.000Z') },
  ]);
});

describe('session drive conflicts', () => {
  test('each folder names its open conflicts and when the newest was detected', async () => {
    const mounts = await readSessionDriveMounts(SESSION);
    const byPath = Object.fromEntries(mounts.map((m) => [m.mountPath, m]));
    expect(byPath['/drives/me']).toMatchObject({ openConflicts: 2, latestConflictAt: NEW.toISOString() });
    expect(byPath['/drives/team']).toMatchObject({ openConflicts: 0, latestConflictAt: null });
  });
});
