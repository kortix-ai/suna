import { beforeEach, expect, mock, test } from 'bun:test';
import { accountMembers, projects } from '@kortix/db';
import type { Actor } from '../iam/actor';

// Synthetic ids only.
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';
const ARTIFACT = '20000000-0000-4000-8000-000000000003';
const OWNER = '20000000-0000-4000-8000-000000000004';
const PEER = '20000000-0000-4000-8000-000000000005';
const THREAD = '20000000-0000-4000-8000-000000000006';
const COMMENT = '20000000-0000-4000-8000-000000000007';

let manifest: () => Promise<{ specs: Array<{ name: string; enabled: boolean }> }>;
const manifestCalls: unknown[][] = [];
const targetCalls: unknown[][] = [];
const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];

class AuthorityError extends Error {}
mock.module('../lib/logger', () => ({
  logger: { warn: (message: string, context?: Record<string, unknown>) => warnings.push({ message, context }), info() {}, error() {}, debug() {} },
}));
mock.module('../config', () => ({ config: { KORTIX_URL: 'https://api.kortix.test' } }));
mock.module('../notifications/access', () => ({ filterArtifactRecipients: async (_artifact: unknown, ids: string[]) => ids }));
mock.module('../projects/surface', () => ({
  loadProjectAgents: (...args: unknown[]) => { manifestCalls.push(args); return manifest(); },
  resolveUserIdentities: async (ids: string[]) => new Map(ids.map((id) => [id, { exists: true, displayName: id === OWNER ? 'Owner' : 'Peer', email: null, avatarUrl: null }])),
}));
mock.module('./comment-authority', () => ({
  ArtifactCommentAuthorityError: AuthorityError,
  authorizeArtifactCommentAgent: async (_actor: Actor, _project: unknown, agentName: string) => ({ actor: _actor, agentName, canPromptExisting: false, callerSessionId: null }),
}));
mock.module('./comment-delivery', () => ({
  resolveArtifactCommentSendTarget: async (...args: unknown[]) => {
    targetCalls.push(args);
    await manifest();
    return { agentName: 'writer', session: undefined, descriptor: { kind: 'new', session_id: null, agent_name: 'writer' } };
  },
}));
mock.module('./comments-service', () => ({
  ArtifactCommentError: class extends Error {},
  listArtifactCommentThreads: async () => [{
    thread_id: THREAD, status: 'open', created_by_session_id: null, anchor: { type: 'none', version: 'v1' },
    comments: [{ comment_id: COMMENT, thread_id: THREAD, deleted_at: null, mentions: [], body: 'Check the totals.', author_user_id: OWNER,
      author_session_id: null, screenshot_key: null }],
  }],
}));
mock.module('./service', () => ({ entryVersion: async () => 'etag-1', listVersions: async () => [{ id: 'commit-1' }] }));
mock.module('./comment-screenshot-parts', () => ({
  selectScreenshotSendBatch: (ids: string[]) => ({ send_thread_ids: ids, send_thread_count: ids.length }),
  screenshotTargetCapability: async () => ({ mayNeedImages: false }),
  screenshotReferences: () => [],
  screenshotSizes: async () => new Map(),
  screenshotReferenceBudget: () => ({ bytes: 0, partsBytes: 0 }),
}));
const rows = (table: unknown) => table === projects ? [{ projectId: PROJECT, accountId: ACCOUNT, status: 'active' }]
  : table === accountMembers ? [{ userId: OWNER }, { userId: PEER }] : [];
class Query {
  constructor(readonly table: unknown) {}
  where() { return this; }
  innerJoin() { return this; }
  orderBy() { return this; }
  then(resolve: (value: unknown[]) => void, reject: (error: unknown) => void) { return Promise.resolve(rows(this.table)).then(resolve, reject); }
}
mock.module('../shared/db', () => ({ db: { select: () => ({ from: (table: unknown) => new Query(table) }) } }));

const { readArtifactCommentContext } = await import('./comment-context');

const actor = { accountId: ACCOUNT, userId: OWNER, credential: { kind: 'jwt' }, ctx: {} } as unknown as Actor;
const access = (canComment = true) => ({
  artifact: { artifactId: ARTIFACT, projectId: PROJECT, accountId: ACCOUNT, title: 'Forecast', root: 'docs', entry: 'index.md', createdBySessionId: null },
  viewer: { userId: OWNER, manageAny: false }, sessionId: null, canEdit: true, canComment,
}) as never;

beforeEach(() => {
  manifest = async () => ({ specs: [{ name: 'writer', enabled: true }, { name: 'off', enabled: false }] });
  manifestCalls.length = 0;
  targetCalls.length = 0;
  warnings.length = 0;
});

test('a readable manifest lists the permitted agents and the Send target, and reports agents as available', async () => {
  const context = await readArtifactCommentContext(access(), actor, {});
  expect(manifestCalls).toHaveLength(1);
  expect(manifestCalls[0]![1]).toEqual({ rethrowReadErrors: true });
  expect(context.agents_unavailable).toBe(false);
  expect(context.agents.map((agent) => agent.agent_name)).toEqual(['writer']);
  expect(context.send_target).toEqual({ kind: 'new', session_id: null, agent_name: 'writer' });
  expect(context.send_thread_ids).toEqual([THREAD]);
  expect(context.people.map((person) => person.name)).toEqual(['Owner', 'Peer']);
  expect(warnings).toHaveLength(0);
});

test('an unreadable manifest still answers people, counts and version, with no agents and no Send target', async () => {
  manifest = async () => { throw Object.assign(new Error('fatal: repository not found'), { name: 'GitOperationError' }); };
  const context = await readArtifactCommentContext(access(), actor, {});
  expect(context.agents_unavailable).toBe(true);
  expect(context.agents).toEqual([]);
  expect(context.send_target).toBeNull();
  expect(context.send_thread_ids).toEqual([]);
  expect(context.send_thread_count).toBe(0);
  expect(context.can_comment).toBe(true);
  expect(context.comment_count).toBe(1);
  expect(context.people.map((person) => person.user_id)).toEqual([OWNER, PEER]);
  expect(context.version).toEqual({ commit_id: 'commit-1', entry_version: 'etag-1' });
  // The Send target resolver reads the same manifest: it is never asked, so it cannot 5xx for the same cause.
  expect(targetCalls).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.context).toMatchObject({ projectId: PROJECT, artifactId: ARTIFACT, errorName: 'GitOperationError' });
});

test('a caller who cannot comment reads no manifest and is never told agents are unavailable', async () => {
  manifest = async () => { throw new Error('must not be read'); };
  const context = await readArtifactCommentContext(access(false), actor, {});
  expect(manifestCalls).toHaveLength(0);
  expect(context.agents_unavailable).toBe(false);
  expect(context.agents).toEqual([]);
  expect(context.send_target).toBeNull();
});
