/**
 * Which threads a notes refresh reaches (`runningThreadIds`): the Channels
 * switch refreshes every running thread of the project, a channel rename only
 * the channel's. A thread without a running box, or of another project, is
 * never reached.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projectSessions, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { runningThreadIds } from './space-folders';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const GENERAL = crypto.randomUUID();
const DESIGN = crypto.randomUUID();

async function thread(projectId: string, spaceId: string | null, box: 'active' | 'stopped' | null): Promise<string> {
  const sessionId = `notes-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId, branchName: sessionId, spaceId });
  if (box) {
    await db.insert(sessionSandboxes).values({ sandboxId: crypto.randomUUID(), sessionId, accountId: ACCOUNT, projectId, provider: 'platinum', status: box });
  }
  return sessionId;
}

let general = '';
let design = '';
let unfiled = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-folders-notes-test' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.test/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'q', repoUrl: 'https://example.test/q.git' },
  ]);
  await db.insert(projectSpaces).values([
    { spaceId: GENERAL, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'general', name: 'general', isDefault: true },
    { spaceId: DESIGN, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'design', name: 'design' },
  ]);
  general = await thread(PROJECT, GENERAL, 'active');
  design = await thread(PROJECT, DESIGN, 'active');
  // In no space: the switch reaches it too (a refresh of a thread with no channel section is harmless).
  unfiled = await thread(PROJECT, null, 'active');
  await thread(PROJECT, GENERAL, 'stopped');
  await thread(PROJECT, DESIGN, null);
  await thread(OTHER_PROJECT, null, 'active');
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('the Channels switch reaches every running thread of the project, filed or not, and nothing else', async () => {
  expect((await runningThreadIds(PROJECT)).sort()).toEqual([general, design, unfiled].sort());
});

test('a channel rename reaches only that channel’s running threads', async () => {
  expect(await runningThreadIds(PROJECT, DESIGN)).toEqual([design]);
  expect(await runningThreadIds(PROJECT, GENERAL)).toEqual([general]);
});
