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
