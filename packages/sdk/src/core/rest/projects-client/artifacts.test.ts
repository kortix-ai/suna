import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import * as artifacts from './artifacts';

const originalFetch = globalThis.fetch;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const base = 'https://artifact-sdk.example/v1/projects/project-a/artifacts/artifact-a';
const anchor = { type: 'text' as const, version: 'commit-a', quote: 'Revenue', prefix: '', suffix: ' is final.' };
const comment: artifacts.ArtifactComment = {
  comment_id: 'comment-a', thread_id: 'thread-a', author_user_id: 'user-a', author_session_id: null,
  author: { kind: 'user', user_id: 'user-a', name: 'Reviewer' }, body: 'Review.', mentions: [], marks: [], screenshot_key: null,
  created_at: '2026-10-29T12:00:00.000Z', edited_at: null, deleted_at: null,
};
const thread: artifacts.ArtifactCommentThread = {
  thread_id: 'thread-a', artifact_id: 'artifact-a', project_id: 'project-a', anchor, anchor_version: anchor.version,
  created_by_user_id: 'user-a', created_by_session_id: null, status: 'open', resolved_by_user_id: null,
  resolved_by_session_id: null, resolved_at: null, agent_state: 'none', sent_session_id: null, sent_at: null,
  created_at: comment.created_at, updated_at: comment.created_at, comments: [comment], outdated: false, position: { start: 0, end: 7 },
};
let calls: { url: string; method: string; body: unknown; authorization: string | null }[] = [];
let response: unknown;
let status: number;

beforeEach(() => {
  calls = [];
  response = {};
  status = 200;
  configureKortix({ backendUrl: 'https://artifact-sdk.example/v1', getToken: async () => 'session-token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('resolved comment mentions expose the exact person, session, and agent union', () => {
  type Mention = { kind: 'user'; user_id: string }
    | { kind: 'session'; session_id: string; agent_name: string }
    | { kind: 'agent'; agent_name: string };
  const exported: Equal<artifacts.ArtifactCommentMention, Mention> = true;
  const returned: Equal<artifacts.ArtifactComment['mentions'], Mention[]> = true;
  expect([exported, returned]).toEqual([true, true]);
});

test('listArtifactComments reads open threads by default and supports resolved or all', async () => {
  response = { threads: [thread] };
  expect(await artifacts.listArtifactComments('project-a', 'artifact-a')).toEqual([thread]);
  expect(calls[0]).toEqual({ url: `${base}/comments`, method: 'GET', body: undefined, authorization: 'Bearer session-token' });
  await artifacts.listArtifactComments('project-a', 'artifact-a', { status: 'resolved' });
  expect(calls.at(-1)?.url).toBe(`${base}/comments?status=resolved`);
  await artifacts.listArtifactComments('project-a', 'artifact-a', { status: 'all' });
  expect(calls.at(-1)?.url).toBe(`${base}/comments?status=all`);
});

test('createArtifactComment sends the selected version, anchor and body and unwraps the thread', async () => {
  response = { thread };
  status = 201;
  expect(await artifacts.createArtifactComment('project-a', 'artifact-a', { anchor, body: 'Confirm revenue.' })).toEqual(thread);
  expect(calls[0]).toMatchObject({ url: `${base}/comments`, method: 'POST', body: { anchor, body: 'Confirm revenue.' } });
});

test('replyArtifactComment sends a reply to the scoped thread and unwraps the comment', async () => {
  response = { comment };
  status = 201;
  expect(await artifacts.replyArtifactComment('project-a', 'artifact-a', 'thread-a', { body: 'Confirmed.' })).toEqual(comment);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/thread-a/replies`, method: 'POST', body: { body: 'Confirmed.' } });
});

test('setArtifactCommentStatus resolves and reopens through the existing thread contract', async () => {
  response = { thread };
  expect(await artifacts.setArtifactCommentStatus('project-a', 'artifact-a', 'thread-a', 'resolved')).toEqual(thread);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/thread-a`, method: 'PATCH', body: { status: 'resolved' } });
  await artifacts.setArtifactCommentStatus('project-a', 'artifact-a', 'thread-a', 'open');
  expect(calls[1]?.body).toEqual({ status: 'open' });
});

test('editArtifactComment updates only the selected comment and unwraps the result', async () => {
  response = { comment };
  expect(await artifacts.editArtifactComment('project-a', 'artifact-a', 'thread-a', 'comment-a', { body: 'Final figures.' })).toEqual(comment);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/thread-a/comment-a`, method: 'PATCH', body: { body: 'Final figures.' } });
});

test('deleteArtifactComment returns the tombstone from the scoped delete', async () => {
  response = { comment: { ...comment, body: '', deleted_at: '2026-10-29T12:00:00.000Z' } };
  expect(await artifacts.deleteArtifactComment('project-a', 'artifact-a', 'thread-a', 'comment-a')).toEqual((response as any).comment);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/thread-a/comment-a`, method: 'DELETE', body: undefined });
});

test('listArtifactActivity preserves the page, opaque cursor and older-history marker', async () => {
  const page: artifacts.ArtifactActivityPage = { items: [{ id: 'save:commit-a', type: 'saved', at: comment.created_at,
    actor: { kind: 'user', id: 'user-a', name: 'Reviewer' }, data: { commit_id: 'commit-a' } }], next_cursor: 'next', older_versions: true };
  response = page;
  expect(await artifacts.listArtifactActivity('project-a', 'artifact-a', { limit: 12, cursor: 'c+/=' })).toEqual(page);
  expect(calls[0]?.url).toBe(`${base}/activity?limit=12&cursor=c%2B%2F%3D`);
});

test('getArtifactCommentThread resolves a bare thread id within its project', async () => {
  response = { thread };
  expect(await artifacts.getArtifactCommentThread('project-a', 'thread-a')).toEqual(thread);
  expect(calls[0]?.url).toBe('https://artifact-sdk.example/v1/projects/project-a/artifact-comment-threads/thread-a');
});

test('sendArtifactComments preserves the batch id and agent and returns the target session', async () => {
  const result = { session_id: 'next-session', created: true };
  response = result;
  expect(await artifacts.sendArtifactComments('project-a', 'artifact-a', {
    thread_ids: ['thread-a'], batch_id: 'batch-a', agent: 'reviewer',
  })).toEqual(result);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/send`, method: 'POST',
    body: { thread_ids: ['thread-a'], batch_id: 'batch-a', agent: 'reviewer' } });
  const handle = createKortix({ backendUrl: 'https://artifact-sdk.example/v1', getToken: async () => 'session-token' }).project('project-a');
  await handle.artifacts.comments.send('artifact-a', { thread_ids: ['thread-a'] });
  expect((calls[1]!.body as { batch_id: string }).batch_id).toMatch(/^[0-9a-f-]{36}$/);
});

test('comment errors preserve the HTTP status and code for callers', async () => {
  response = { error: 'Comment permission required', code: 'artifact_comment_forbidden' };
  status = 403;
  try {
    await artifacts.createArtifactComment('project-a', 'artifact-a', { anchor, body: 'Review.' });
    throw new Error('The denied write resolved');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe('artifact_comment_forbidden');
  }
});

test('the project facade exposes the Artifact comment and activity functions', async () => {
  const handle = createKortix({ backendUrl: 'https://artifact-sdk.example/v1', getToken: async () => 'session-token' }).project('project-a');
  response = { threads: [thread] };
  expect(await handle.artifacts.comments.list('artifact-a', { status: 'all' })).toEqual([thread]);
  response = { thread };
  expect(await handle.artifacts.comments.get('thread-a')).toEqual(thread);
  const page: artifacts.ArtifactActivityPage = { items: [], next_cursor: null, older_versions: false };
  response = page;
  expect(await handle.artifacts.activity('artifact-a')).toEqual(page);
});
