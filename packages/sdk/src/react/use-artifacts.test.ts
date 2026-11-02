import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import * as hooks from './use-artifacts';
import { qk } from './query-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let comments: ReturnType<typeof hooks.useArtifactComments>;
let activity: ReturnType<typeof hooks.useArtifactActivity>;
let reads: { comments: number; activity: number };
let revision: number;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });

beforeEach(() => {
  reads = { comments: 0, activity: 0 };
  revision = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  configureKortix({ backendUrl: 'https://artifact-hooks.example/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/activity')) {
      reads.activity++;
      return Response.json({ items: [{ id: String(revision), type: 'replied' }], next_cursor: null, older_versions: false });
    }
    if (method === 'GET') {
      reads.comments++;
      return Response.json({ threads: [{ thread_id: 'thread-a', body: String(revision) }] });
    }
    revision++;
    return Response.json({ thread: { thread_id: 'thread-a' }, comment: { comment_id: 'comment-a' }, session_id: 'next-session', created: true });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client.clear();
  globalThis.fetch = originalFetch;
});

async function mount(projectId: string | null, artifactId: string | null, enabled = true) {
  function Probe() {
    comments = hooks.useArtifactComments(projectId, artifactId, { status: 'all', enabled });
    activity = hooks.useArtifactActivity(projectId, artifactId, { limit: 20, enabled });
    return null;
  }
  await act(async () => {
    renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
}

test('each comment write refreshes mounted Comments and Activity before the polling fallback', async () => {
  await mount('project-a', 'artifact-a');
  expect(reads).toEqual({ comments: 1, activity: 1 });
  const writes = [
    () => comments.create({ anchor: { type: 'none', version: 'commit-a' }, body: 'Review.' }),
    () => comments.reply('thread-a', { body: 'Reviewed.' }),
    () => comments.setStatus('thread-a', 'resolved'),
    () => comments.edit('thread-a', 'comment-a', { body: 'Final.' }),
    () => comments.remove('thread-a', 'comment-a'),
    () => comments.send({ thread_ids: ['thread-a'], batch_id: 'batch-a' }),
  ];
  for (let index = 0; index < writes.length; index++) {
    await act(async () => { await writes[index]!(); });
    await settle();
    expect(reads).toEqual({ comments: index + 2, activity: index + 2 });
    expect(activity.data?.items[0]?.id).toBe(String(index + 1));
  }
});

test('mounted reads use a ten-second fallback, scoped keys, and no background polling', async () => {
  await mount('project-a', 'artifact-a');
  const commentQuery = client.getQueryCache().find({ queryKey: qk.project.artifactComments('project-a', 'artifact-a', 'all') })!;
  const activityQuery = client.getQueryCache().find({ queryKey: qk.project.artifactActivity('project-a', 'artifact-a', { limit: 20 }) })!;
  for (const query of [commentQuery, activityQuery]) {
    const options = query.options as { refetchInterval?: number; refetchIntervalInBackground?: boolean };
    expect(options.refetchInterval).toBe(10_000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(query.getObserversCount()).toBe(1);
  }
  expect(commentQuery.queryKey).not.toEqual(qk.project.artifactComments('project-b', 'artifact-a', 'all'));
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(commentQuery.getObserversCount()).toBe(0);
  expect(activityQuery.getObserversCount()).toBe(0);
});

test('missing scope or a disabled feature sends no comments or activity requests', async () => {
  await mount(null, null);
  expect(reads).toEqual({ comments: 0, activity: 0 });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await mount('project-a', 'artifact-a', false);
  expect(reads).toEqual({ comments: 0, activity: 0 });
});

test('comment context shares write invalidation and historical hooks reject mutations before HTTP', async () => {
  const urls: string[] = [];
  let context: ReturnType<typeof hooks.useArtifactCommentContext>;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return url.includes('/context') ? Response.json({ can_comment: false, send_thread_ids: [], version: { commit_id: 'vc old', entry_version: 'old-etag' } })
      : Response.json({ threads: [] });
  }) as unknown as typeof fetch;
  function Probe() {
    context = hooks.useArtifactCommentContext('project-a', 'artifact-a', { version: 'vc old' });
    comments = hooks.useArtifactComments('project-a', 'artifact-a', { status: 'all', version: 'vc old' });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  expect(context!.data?.version.commit_id).toBe('vc old');
  expect(urls.some((url) => url.endsWith('/comments?status=all&version=vc+old'))).toBe(true);
  await act(async () => { await expect(comments.reply('thread-a', { body: 'Must not write.' })).rejects.toThrow('read-only'); });
  await settle();
  expect(urls).toHaveLength(2);
});

test('infinite activity follows opaque cursors, keeps page order without duplicates, and refreshes after a comment write', async () => {
  let infinite: ReturnType<typeof hooks.useInfiniteArtifactActivity>;
  let context: ReturnType<typeof hooks.useArtifactCommentContext>;
  const activityReads: Array<string | null> = [];
  let contextReads = 0;
  let writes = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') { writes++; return Response.json({ comment: { comment_id: 'reply' } }); }
    if (url.pathname.endsWith('/context')) { contextReads++; return Response.json({ can_comment: true, comment_count: writes, version: { commit_id: 'vc_now' } }); }
    if (url.pathname.endsWith('/comments')) return Response.json({ threads: [] });
    const cursor = url.searchParams.get('cursor');
    activityReads.push(cursor);
    return Response.json(cursor ? { items: [{ id: 'shared' }, { id: 'older' }], next_cursor: null, older_versions: true }
      : { items: [{ id: `new-${writes}` }, { id: 'shared' }], next_cursor: 'opaque + cursor', older_versions: false });
  }) as unknown as typeof fetch;
  function Probe() {
    comments = hooks.useArtifactComments('project-a', 'artifact-a');
    context = hooks.useArtifactCommentContext('project-a', 'artifact-a');
    infinite = hooks.useInfiniteArtifactActivity('project-a', 'artifact-a', { limit: 2 });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  expect(infinite!.items.map((item) => item.id)).toEqual(['new-0', 'shared']);
  await act(async () => { await infinite!.fetchNextPage(); });
  await settle();
  expect(activityReads).toEqual([null, 'opaque + cursor']);
  expect(infinite!.items.map((item) => item.id)).toEqual(['new-0', 'shared', 'older']);
  expect(infinite!.hasNextPage).toBe(false);
  expect(infinite!.olderVersions).toBe(true);
  await act(async () => { await comments.reply('thread-a', { body: 'New reply.' }); });
  await settle();
  expect(contextReads).toBe(2);
  expect(context!.data?.comment_count).toBe(1);
  expect(infinite!.items.map((item) => item.id)).toEqual(['new-1', 'shared', 'older']);
});

test('missing scope disables context and infinite activity without network requests', async () => {
  function Probe() {
    hooks.useArtifactCommentContext(null, null);
    hooks.useInfiniteArtifactActivity(null, null);
    return null;
  }
  await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("screenshot hook reads a scoped authenticated Blob and never substitutes another comment image", async () => {
  let screenshot: ReturnType<typeof hooks.useArtifactCommentScreenshot>;
  const fetched: string[] = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer token",
      );
      fetched.push(String(input));
      return new Response("png-bytes", {
        status: String(input).includes("comment-b") ? 404 : 200,
        headers: { "content-type": "image/png" },
      });
    },
  ) as unknown as typeof fetch;
  function Probe({ commentId }: { commentId: string | null }) {
    screenshot = hooks.useArtifactCommentScreenshot(
      "project-a",
      "artifact-a",
      commentId,
    );
    return React.createElement("span", null, screenshot.status);
  }
  const render = async (commentId: string | null) => {
    await act(async () => {
      const child = React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Probe, { commentId }),
      );
      if (renderer) renderer.update(child);
      else renderer = create(child);
    });
    await settle();
  };
  await render(null);
  expect(fetched).toEqual([]);
  await render("comment-a");
  expect(screenshot!.data).toBeInstanceOf(Blob);
  expect(screenshot!.data?.type).toBe("image/png");
  await render("comment-b");
  for (let attempt = 0; attempt < 20 && !screenshot!.error; attempt++)
    await settle();
  expect(screenshot!.data).toBeUndefined();
  expect(screenshot!.error).toMatchObject({ status: 404 });
  expect(fetched).toHaveLength(2);
});

// ── Retry policy and optimistic writes (KRTX-3659) ──────────────────────────

const comment = (over: Record<string, unknown> = {}) => ({
  comment_id: 'comment-a', thread_id: 'thread-a', author_user_id: 'user-a', author_session_id: null,
  author: { kind: 'user', user_id: 'user-a', name: 'Ada' }, body: 'Original.', mentions: [], marks: [], screenshot_key: null,
  created_at: '2026-11-01T10:00:00.000Z', edited_at: null, deleted_at: null, can_edit: true, can_delete: true, ...over,
});
const thread = (over: Record<string, unknown> = {}) => ({
  thread_id: 'thread-a', artifact_id: 'artifact-a', project_id: 'project-a', anchor: { type: 'none', version: 'commit-a' },
  anchor_version: 'commit-a', created_by_user_id: 'user-a', created_by_session_id: null, status: 'open', resolved_by_user_id: null,
  resolved_by_session_id: null, resolved_at: null, agent_state: 'none', agent_error: null, sent_session_id: null, sent_at: null,
  created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', comments: [comment()], outdated: false,
  position: null, can_reply: true, can_resolve: true, ...over,
});

/**
 * The first thread read answers; every later read hangs. Only the hook can
 * change the cache after that, so a test sees the optimistic state, the
 * server's answer, or the rollback, never a refetch hiding a missing one.
 */
function holdingServer(threads: unknown[] = [thread()]) {
  const writes: Array<{ method: string; path: string; answer: (status: number, body: unknown) => void }> = [];
  let threadReads = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (url.pathname.endsWith('/activity')) return Response.json({ items: [], next_cursor: null, older_versions: false });
      if (++threadReads > 1) return new Promise<Response>(() => {});
      return Response.json({ threads });
    }
    return new Promise<Response>((resolve) => {
      writes.push({ method, path: url.pathname, answer: (status, body) => resolve(Response.json(body, { status })) });
    });
  }) as unknown as typeof fetch;
  return { writes };
}

async function mountThreads() {
  function Probe() {
    comments = hooks.useArtifactComments('project-a', 'artifact-a', { status: 'all' });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  expect(comments.data?.map((item) => item.thread_id)).toEqual(['thread-a']);
}

/**
 * Start a write without awaiting it. `done` settles to the result or the error.
 * It is wrapped: an async function that returned the bare promise would wait for it.
 */
async function start(write: () => Promise<unknown>) {
  let done!: Promise<unknown>;
  await act(async () => { done = write().catch((error: unknown) => error); });
  await settle();
  return { done };
}
async function answer(server: ReturnType<typeof holdingServer>, index: number, status: number, body: unknown, write: { done: Promise<unknown> }) {
  await act(async () => { server.writes[index]!.answer(status, body); await write.done; });
  await settle();
}

// The transport already retries a GET twice on 502/503/504 (`makeRequest`), so
// a 503 costs 3 requests and the hook adds none. A 500 gets one hook retry.
test('comment reads never retry a 4xx, retry a 5xx at most once, and add nothing to the transport 503 retries', async () => {
  for (const [status, expected] of [[500, 2], [503, 3], [403, 1]] as const) {
    client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    const hits = { context: 0, comments: 0, activity: 0 };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      hits[path.endsWith('/context') ? 'context' : path.endsWith('/activity') ? 'activity' : 'comments']++;
      return Response.json({ error: 'unavailable' }, { status });
    }) as unknown as typeof fetch;
    let context: ReturnType<typeof hooks.useArtifactCommentContext>;
    let infinite: ReturnType<typeof hooks.useInfiniteArtifactActivity>;
    function Probe() {
      comments = hooks.useArtifactComments('project-a', 'artifact-a', { status: 'all' });
      context = hooks.useArtifactCommentContext('project-a', 'artifact-a');
      activity = hooks.useArtifactActivity('project-a', 'artifact-a');
      infinite = hooks.useInfiniteArtifactActivity('project-a', 'artifact-a');
      return null;
    }
    await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
    const queries = () => [comments!, context!, activity!, infinite!];
    for (let attempt = 0; attempt < 100 && queries().some((query) => !query.isError); attempt++) await settle();
    for (const query of queries()) expect(query.error).toMatchObject({ status });
    expect(hits).toEqual({ context: expected, comments: expected, activity: expected * 2 });
    await act(async () => renderer!.unmount());
    renderer = undefined;
    client.clear();
  }
});

test('create shows a pending thread at once, swaps in the server thread, and removes it when the write fails', async () => {
  const server = holdingServer();
  await mountThreads();
  let done = await start(() => comments.create({ anchor: { type: 'none', version: 'commit-a' }, body: 'Fresh idea.' }));
  expect(server.writes.map((write) => write.method)).toEqual(['POST']);
  const pending = comments.data![1]!;
  expect(pending.optimistic).toBe(true);
  expect(pending.thread_id.startsWith('optimistic-')).toBe(true);
  expect(pending).toMatchObject({ status: 'open', anchor_version: 'commit-a', can_reply: false, can_resolve: false });
  expect(pending.comments).toHaveLength(1);
  expect(pending.comments[0]).toMatchObject({ optimistic: true, body: 'Fresh idea.', thread_id: pending.thread_id, can_edit: false, can_delete: false });
  await answer(server, 0, 201, { thread: thread({ thread_id: 'thread-b', comments: [comment({ comment_id: 'comment-b', thread_id: 'thread-b', body: 'Fresh idea.' })] }) }, done);
  expect(comments.data!.map((item) => item.thread_id)).toEqual(['thread-a', 'thread-b']);
  expect(comments.data![1]!.optimistic).toBeUndefined();
  done = await start(() => comments.create({ anchor: { type: 'none', version: 'commit-a' }, body: 'Lost idea.' }));
  expect(comments.data!.map((item) => item.comments[0]!.body)).toEqual(['Original.', 'Fresh idea.', 'Lost idea.']);
  await answer(server, 1, 500, { error: 'boom' }, done);
  expect(await done.done).toMatchObject({ status: 500 });
  expect(comments.data!.map((item) => item.thread_id)).toEqual(['thread-a', 'thread-b']);
});

test('reply shows a pending comment at once, swaps in the server comment, and removes it when the write fails', async () => {
  const server = holdingServer();
  await mountThreads();
  let done = await start(() => comments.reply('thread-a', { body: 'Agreed.' }));
  const pending = comments.data![0]!.comments[1]!;
  expect(pending).toMatchObject({ optimistic: true, body: 'Agreed.', thread_id: 'thread-a', can_edit: false, can_delete: false });
  expect(pending.comment_id.startsWith('optimistic-')).toBe(true);
  await answer(server, 0, 201, { comment: comment({ comment_id: 'comment-b', body: 'Agreed.' }) }, done);
  expect(comments.data![0]!.comments.map((item) => [item.comment_id, item.optimistic])).toEqual([['comment-a', undefined], ['comment-b', undefined]]);
  done = await start(() => comments.reply('thread-a', { body: 'Lost reply.' }));
  expect(comments.data![0]!.comments).toHaveLength(3);
  await answer(server, 1, 500, { error: 'boom' }, done);
  expect(comments.data![0]!.comments.map((item) => item.comment_id)).toEqual(['comment-a', 'comment-b']);
});

test('resolve and reopen flip the status at once, keep the server answer, and flip back when the write fails', async () => {
  const server = holdingServer();
  await mountThreads();
  let done = await start(() => comments.setStatus('thread-a', 'resolved'));
  expect(comments.data![0]).toMatchObject({ status: 'resolved', optimistic: true });
  expect(comments.data![0]!.resolved_at).not.toBeNull();
  await answer(server, 0, 200, { thread: thread({ status: 'resolved', resolved_at: '2026-11-01T11:00:00.000Z', resolved_by_user_id: 'user-a' }) }, done);
  expect(comments.data![0]).toMatchObject({ status: 'resolved', resolved_at: '2026-11-01T11:00:00.000Z' });
  expect(comments.data![0]!.optimistic).toBeUndefined();
  done = await start(() => comments.setStatus('thread-a', 'open'));
  expect(comments.data![0]).toMatchObject({ status: 'open', resolved_at: null, optimistic: true });
  await answer(server, 1, 500, { error: 'boom' }, done);
  expect(comments.data![0]).toMatchObject({ status: 'resolved', resolved_at: '2026-11-01T11:00:00.000Z' });
  expect(comments.data![0]!.optimistic).toBeUndefined();
});

test('edit shows the new body at once, keeps the server answer, and restores the old body when the write fails', async () => {
  const server = holdingServer();
  await mountThreads();
  let done = await start(() => comments.edit('thread-a', 'comment-a', { body: 'Changed.' }));
  expect(comments.data![0]!.comments[0]).toMatchObject({ body: 'Changed.', optimistic: true });
  expect(comments.data![0]!.comments[0]!.edited_at).not.toBeNull();
  await answer(server, 0, 200, { comment: comment({ body: 'Changed.', edited_at: '2026-11-01T11:00:00.000Z' }) }, done);
  expect(comments.data![0]!.comments[0]).toMatchObject({ body: 'Changed.', edited_at: '2026-11-01T11:00:00.000Z' });
  expect(comments.data![0]!.comments[0]!.optimistic).toBeUndefined();
  done = await start(() => comments.edit('thread-a', 'comment-a', { body: 'Lost edit.' }));
  expect(comments.data![0]!.comments[0]!.body).toBe('Lost edit.');
  await answer(server, 1, 500, { error: 'boom' }, done);
  expect(comments.data![0]!.comments[0]).toMatchObject({ body: 'Changed.', edited_at: '2026-11-01T11:00:00.000Z' });
  expect(comments.data![0]!.comments[0]!.optimistic).toBeUndefined();
});

test('delete shows a tombstone at once, keeps the server answer, and restores the comment when the write fails', async () => {
  const server = holdingServer();
  await mountThreads();
  let done = await start(() => comments.remove('thread-a', 'comment-a'));
  expect(comments.data![0]!.comments[0]).toMatchObject({ body: '', optimistic: true, can_edit: false, can_delete: false });
  expect(comments.data![0]!.comments[0]!.deleted_at).not.toBeNull();
  await answer(server, 0, 500, { error: 'boom' }, done);
  expect(comments.data![0]!.comments[0]).toEqual(comment() as never);
  done = await start(() => comments.remove('thread-a', 'comment-a'));
  await answer(server, 1, 200, { comment: comment({ body: '', deleted_at: '2026-11-01T11:00:00.000Z', can_edit: false, can_delete: false }) }, done);
  expect(comments.data![0]!.comments[0]).toMatchObject({ body: '', deleted_at: '2026-11-01T11:00:00.000Z' });
  expect(comments.data![0]!.comments[0]!.optimistic).toBeUndefined();
});

test('a write answer carries no text position, so the cached position and outdated flag stay until the next read', async () => {
  // The server reads the document only for a list. A create or status answer has position null and outdated false.
  const text = { anchor: { type: 'text', version: 'commit-a', quote: 'Selected', prefix: '', suffix: '' }, anchor_version: 'commit-a' };
  const placed = thread({ ...text, position: { start: 4, end: 12 } });
  const lost = (over: Record<string, unknown> = {}) => thread({
    ...text, thread_id: 'thread-b', outdated: true, comments: [comment({ comment_id: 'comment-b', thread_id: 'thread-b' })], ...over,
  });
  const server = holdingServer([placed, lost()]);
  function Probe() {
    comments = hooks.useArtifactComments('project-a', 'artifact-a', { status: 'all' });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  const resolvedAt = '2026-11-01T11:00:00.000Z';
  let done = await start(() => comments.setStatus('thread-a', 'resolved'));
  await answer(server, 0, 200, { thread: thread({ ...text, status: 'resolved', resolved_at: resolvedAt }) }, done);
  expect(comments.data![0]).toMatchObject({ status: 'resolved', resolved_at: resolvedAt, position: { start: 4, end: 12 }, outdated: false });
  done = await start(() => comments.setStatus('thread-b', 'resolved'));
  await answer(server, 1, 200, { thread: lost({ status: 'resolved', resolved_at: resolvedAt, outdated: false }) }, done);
  expect(comments.data![1]).toMatchObject({ status: 'resolved', position: null, outdated: true });
  done = await start(() => comments.setStatus('thread-b', 'open'));
  await answer(server, 2, 200, { thread: lost({ outdated: false }) }, done);
  expect(comments.data![1]).toMatchObject({ status: 'open', position: null, outdated: true });
  // A brand-new thread has no cached copy: the server's value stands.
  done = await start(() => comments.create({ anchor: text.anchor as never, body: 'New.' }));
  await answer(server, 3, 201, {
    thread: thread({ ...text, thread_id: 'thread-c', comments: [comment({ comment_id: 'comment-c', thread_id: 'thread-c', body: 'New.' })] }),
  }, done);
  expect(comments.data!.map((item) => [item.thread_id, item.position, item.outdated]))
    .toEqual([['thread-a', { start: 4, end: 12 }, false], ['thread-b', null, true], ['thread-c', null, false]]);
});
