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
const context: artifacts.ArtifactCommentContext = {
  can_comment: true, can_moderate: false, comment_count: 2, send_thread_count: 1, send_thread_ids: ['thread-a'],
  people: [{ user_id: 'user-a', name: 'Ada', avatar_url: null, token: '@ada@example.test' }],
  agents: [{ agent_name: 'writer', name: 'Writer', session_id: null, token: '@agent.writer' }],
  send_target: { kind: 'new', session_id: null, agent_name: 'writer' },
  version: { commit_id: 'vc_pinned', entry_version: 'entry-etag' },
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
    | { kind: 'session'; session_id: string; agent_name: string; token?: string }
    | { kind: 'agent'; agent_name: string; token?: string };
  const exported: Equal<artifacts.ArtifactCommentMention, Mention> = true;
  const returned: Equal<artifacts.ArtifactComment['mentions'], Mention[]> = true;
  expect([exported, returned]).toEqual([true, true]);
});

test('stored agent mention tokens survive comment reads without a runnable agent roster', async () => {
  const mentions: artifacts.ArtifactCommentMention[] = [
    { kind: 'agent', agent_name: 'writer', token: '@agent.writer' },
    { kind: 'session', session_id: 'session-a', agent_name: 'writer', token: '@agent.writer' },
  ];
  response = { threads: [{ ...thread, comments: [{ ...comment, mentions }] }] };
  const result = await artifacts.listArtifactComments('project-a', 'artifact-a');
  expect(result[0]?.comments[0]?.mentions).toEqual(mentions);
  expect(calls).toHaveLength(1);
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

test('historical comment reads preserve the explicit Files commit and authoritative action rights', async () => {
  const historical: artifacts.ArtifactCommentThread = { ...thread, can_reply: false, can_resolve: false,
    comments: [{ ...comment, can_edit: false, can_delete: false }] };
  response = { threads: [historical] };
  expect(await artifacts.listArtifactComments('project-a', 'artifact-a', { status: 'all', version: 'vc old' })).toEqual([historical]);
  expect(calls[0]?.url).toBe(`${base}/comments?status=all&version=vc+old`);
});

test('comment context returns insertion tokens, permissions, eligible threads, and the actual Send target', async () => {
  response = context;
  expect(await artifacts.getArtifactCommentContext('project-a', 'artifact-a', { version: 'vc old', agent: 'writer one' })).toEqual(context);
  expect(calls[0]).toMatchObject({ url: `${base}/comments/context?version=vc+old&agent=writer+one`, method: 'GET' });
  const handle = createKortix({ backendUrl: 'https://artifact-sdk.example/v1', getToken: async () => 'session-token' }).project('project-a');
  expect(await handle.artifacts.comments.context('artifact-a')).toEqual(context);
});

test('comment snapshots read immutable content at the context commit, never its entry ETag', async () => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return urls.length === 1 ? Response.json(context) : new Response('# Exact saved Markdown\n');
  }) as unknown as typeof fetch;
  const handle = createKortix({ backendUrl: 'https://artifact-sdk.example/v1', getToken: async () => 'session-token' }).project('project-a');
  expect(await handle.artifacts.comments.snapshot('artifact-a')).toEqual({ version: 'vc_pinned', text: '# Exact saved Markdown\n' });
  expect(urls).toEqual([`${base}/comments/context`, `${base}/content?version=vc_pinned`]);
});

test('a comment snapshot without a saved commit rejects before reading content', async () => {
  response = { ...context, version: { commit_id: null, entry_version: null } };
  await expect(artifacts.readArtifactCommentSnapshot('project-a', 'artifact-a')).rejects.toMatchObject({ code: 'artifact_comment_snapshot_unavailable' });
  expect(calls).toHaveLength(1);
});

test('comment context exposes the total separately from its bounded Send batch', async () => {
  const typed: Equal<artifacts.ArtifactCommentContext['send_thread_count'], number> = true;
  const ids = Array.from({ length: 100 }, (_, index) => `thread-${index}`);
  response = { ...context, send_thread_ids: ids, send_thread_count: 101 };
  const result = await artifacts.getArtifactCommentContext('project-a', 'artifact-a');
  expect(typed).toBe(true);
  expect(result.send_thread_ids).toEqual(ids);
  expect(result.send_thread_count).toBe(101);
  expect(calls).toHaveLength(1);
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

test("drawing create and reply preserve optional marks and screenshot without widening edit input", async () => {
  const mark = {
    tool: "pen" as const,
    color: "black" as const,
    width: 0.01,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  };
  response = { thread, comment };
  await artifacts.createArtifactComment("project-a", "artifact-a", {
    anchor,
    body: "Drawn",
    marks: [mark],
    screenshot_base64: "aW1hZ2U=",
  });
  await artifacts.replyArtifactComment("project-a", "artifact-a", "thread-a", {
    body: "Reply",
    marks: [mark],
    screenshot_base64: "aW1hZ2U=",
  });
  expect(calls[0].body).toEqual({
    anchor,
    body: "Drawn",
    marks: [mark],
    screenshot_base64: "aW1hZ2U=",
  });
  expect(calls[1].body).toEqual({
    body: "Reply",
    marks: [mark],
    screenshot_base64: "aW1hZ2U=",
  });
});

test("screenshot reads authenticate each binary request and keep API refusal status", async () => {
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status,
        headers: { "content-type": "image/png" },
      });
    },
  ) as unknown as typeof fetch;
  const blob = await artifacts.readArtifactCommentScreenshot(
    "project-a",
    "artifact-a",
    "comment-a",
  );
  expect(blob.type).toBe("image/png");
  expect(blob.size).toBe(4);
  expect(calls[0].url).toBe(`${base}/comments/comment-a/screenshot`);
  expect(calls[0].authorization).toBe("Bearer session-token");
  await createKortix({
    backendUrl: "https://artifact-sdk.example/v1",
    getToken: async () => "session-token",
  })
    .project("project-a")
    .artifacts.comments.readScreenshot("artifact-a", "comment-a");
  status = 404;
  await expect(
    artifacts.readArtifactCommentScreenshot(
      "project-a",
      "artifact-a",
      "comment-a",
    ),
  ).rejects.toMatchObject({ status: 404 });
});

test('screenshot reads retain authenticated JSON refusal details', async () => {
  response = { error: 'Screenshot not found', code: 'not_found' };
  status = 404;
  await expect(artifacts.readArtifactCommentScreenshot('project-a', 'artifact-a', 'comment-a')).rejects.toMatchObject({
    status: 404, code: 'not_found', details: response, data: response,
  });
});

test('Send drawing quota refusals retain all API limits', async () => {
  status = 413;
  for (const includeParts of [false, true]) {
    response = { error: 'Screenshot limit reached', code: 'artifact_comment_screenshot_limit', limits: {
      max_files: 20, max_total_bytes: 104857600, max_screenshot_bytes: 2097152,
      ...(includeParts ? { max_parts_bytes: 12582912 } : {}),
    } };
    await expect(artifacts.sendArtifactComments('project-a', 'artifact-a', { thread_ids: ['thread-a'], batch_id: 'owned-batch' }))
      .rejects.toMatchObject({ status: 413, code: 'artifact_comment_screenshot_limit', details: response, data: response });
  }
});

test("mark parser accepts empty/valid data and rejects malformed or unbounded old response values", () => {
  const mark: artifacts.ArtifactCommentMark = {
    tool: "arrow",
    color: "red",
    width: 0.01,
    points: [
      { x: 0, y: 0.2 },
      { x: 1, y: 1 },
    ],
  };
  expect(artifacts.parseArtifactCommentMarks([])).toEqual([]);
  expect(artifacts.parseArtifactCommentMarks([mark])).toEqual([mark]);
  for (const value of [
    null,
    {},
    [null],
    [{ ...mark, width: 0 }],
    [{ ...mark, token: "extra" }],
    [
      {
        ...mark,
        points: [
          { x: Infinity, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
    Array(65).fill(mark),
  ])
    expect(artifacts.parseArtifactCommentMarks(value)).toBeNull();
});

test("published mark parser stays equal to the server schema without a runtime shared dependency", async () => {
  const { artifactCommentMarksSchema } =
    await import("../../../../../shared/src/artifact-comments");
  const mark = {
    tool: "rectangle",
    color: "blue",
    width: 0.01,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  };
  const values = [
    [],
    [mark],
    [
      {
        ...mark,
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      },
    ],
    [{ ...mark, points: [{ x: 0, y: 0 }] }],
    [{ ...mark, width: NaN }],
    [{ ...mark, color: "green" }],
    [
      {
        ...mark,
        points: [
          { x: 0, y: 0, z: 1 },
          { x: 1, y: 1 },
        ],
      },
    ],
    Array(65).fill(mark),
  ];
  for (const value of values) {
    const server = artifactCommentMarksSchema.safeParse(value);
    const client = artifacts.parseArtifactCommentMarks(value);
    expect(client !== null).toBe(server.success);
    if (server.success) expect(client).toEqual(server.data);
  }
});
