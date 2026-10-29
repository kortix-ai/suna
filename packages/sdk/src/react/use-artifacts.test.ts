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
    return Response.json({ thread: { thread_id: 'thread-a' }, comment: { comment_id: 'comment-a' } });
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
