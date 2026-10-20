import { expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
let denyPush = false;

const sessionId = '00000000-0000-4000-a000-000000001893';
let caller: string | null = sessionId;
let commits = 0;
mock.module('../../middleware/caller-session', () => ({ callerKortixSessionId: () => caller }));
const access = await import('../lib/access');
mock.module('../lib/access', () => ({ ...access,
  loadProjectForUser: async () => ({ userId: 'owner', row: { accountId: 'account', defaultBranch: 'main' } }),
  assertAgentSessionWorkspaceAllowsRepository: async () => {}, assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    if (denyPush && action === 'project.gitops.push') throw new HTTPException(403, { message: 'Push denied' });
  },
}));
const view = await import('../lib/project-read-view');
mock.module('../lib/project-read-view', () => ({ ...view, projectReadView: async () => ({ refsVisible: async () => true }) }));
const resources = await import('../lib/project-resources');
mock.module('../lib/project-resources', () => ({ ...resources, resourceDenierForRequest: async () => null }));
const git = await import('../lib/git');
mock.module('../lib/git', () => ({ ...git, withProjectGitAuth: async () => ({}) }));
const branches = await import('../git/branches');
mock.module('../git/branches', () => ({ ...branches, remoteBranchExists: async () => true }));
const writer = await import('../git/commit-writer');
mock.module('../git/commit-writer', () => ({ ...writer, commitFileToBranch: async () => { commits++; return { commitSha: 'a'.repeat(40) }; } }));
const { projectsApp } = await import('../lib/app');
(await import('./project-files')).registerProjectFilesRoutes();
async function write(ref: string) {
  return projectsApp.request('/project/files/content', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'kortix.yaml', ref, content: 'name: synthetic', expected_revision: 'a'.repeat(40) }) });
}
test('session credentials cannot commit to default or sibling branches', async () => {
  caller = sessionId; commits = 0;
  expect((await write('main')).status).toBe(403);
  expect((await write('colleague')).status).toBe(403);
  expect(commits).toBe(0);
});
test('session own branch and human default branch remain writable', async () => {
  caller = sessionId; commits = 0;
  expect((await write(sessionId)).status).toBe(200);
  caller = null;
  expect((await write('main')).status).toBe(200);
  expect(commits).toBe(2);
});

test('file-write alone cannot move a branch without push authority', async () => {
  caller = null; commits = 0; denyPush = true;
  try {
    expect((await write('main')).status).toBe(403);
    expect(commits).toBe(0);
  } finally { denyPush = false; }
});
