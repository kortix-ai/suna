import { afterEach, describe, expect, test } from 'bun:test';

import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  resolveSessionRuntime,
  SessionRuntimeError,
  waitForSessionReady,
} from '../session-runtime.ts';
import { auth, session } from './support/attach-fixtures.ts';

type StartReply = { stage: string; reason?: string };

/** Minimal ApiClient whose POST replies come from a scripted queue. */
function fakeClient(replies: Array<StartReply | Error>): {
  client: ApiClient;
  posts: string[];
} {
  const posts: string[] = [];
  const queue = [...replies];
  const client = {
    apiBase: 'https://api.example.test',
    get: async () => {
      throw new Error('unexpected GET');
    },
    post: async (path: string) => {
      posts.push(path);
      const next = queue.shift() ?? { stage: 'ready' };
      if (next instanceof Error) throw next;
      return next as never;
    },
    put: async () => {
      throw new Error('unexpected PUT');
    },
    patch: async () => {
      throw new Error('unexpected PATCH');
    },
    delete: async () => {
      throw new Error('unexpected DELETE');
    },
  } as unknown as ApiClient;
  return { client, posts };
}

const noSleep = async (): Promise<void> => {};

describe('waitForSessionReady', () => {
  test('polls /start and returns once the runtime reports ready', async () => {
    const { client, posts } = fakeClient([{ stage: 'provisioning' }, { stage: 'ready' }]);
    await waitForSessionReady(client, 'proj', 'sess', { sleep: noSleep });
    expect(posts).toEqual(['/projects/proj/sessions/sess/start', '/projects/proj/sessions/sess/start']);
  });

  test('tolerates `stopped` for the first five polls after a restart', async () => {
    const { client, posts } = fakeClient([
      { stage: 'stopped' },
      { stage: 'stopped' },
      { stage: 'stopped' },
      { stage: 'stopped' },
      { stage: 'stopped' },
      { stage: 'ready' },
    ]);
    await waitForSessionReady(client, 'proj', 'sess', { sleep: noSleep });
    expect(posts).toHaveLength(6);
  });

  test('a sixth `stopped` poll is terminal', async () => {
    const { client } = fakeClient(Array.from({ length: 7 }, () => ({ stage: 'stopped' })));
    const err = (await waitForSessionReady(client, 'proj', 'sess', { sleep: noSleep }).catch(
      (e) => e,
    )) as SessionRuntimeError;
    expect(err).toBeInstanceOf(SessionRuntimeError);
    expect(err.kind).toBe('start-failed');
    expect(err.message).toBe('Session did not start (stopped).');
  });

  test('a failed stage carries the reason', async () => {
    const { client } = fakeClient([{ stage: 'failed', reason: 'no capacity' }]);
    const err = (await waitForSessionReady(client, 'proj', 'sess', { sleep: noSleep }).catch(
      (e) => e,
    )) as SessionRuntimeError;
    expect(err.kind).toBe('start-failed');
    expect(err.message).toBe('Session did not start (failed: no capacity).');
  });

  test('an API failure keeps the original error as the cause', async () => {
    const boom = new Error('HTTP 500');
    const { client } = fakeClient([boom]);
    const err = (await waitForSessionReady(client, 'proj', 'sess', { sleep: noSleep }).catch(
      (e) => e,
    )) as SessionRuntimeError;
    expect(err.kind).toBe('api');
    expect(err.cause).toBe(boom);
  });

  test('never-ready polls time out after the attempt budget', async () => {
    const { client, posts } = fakeClient(
      Array.from({ length: 3 }, () => ({ stage: 'provisioning' })),
    );
    const err = (await waitForSessionReady(client, 'proj', 'sess', {
      attempts: 3,
      sleep: noSleep,
    }).catch((e) => e)) as SessionRuntimeError;
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe('Timed out waiting for the sandbox to start.');
    expect(posts).toHaveLength(3);
  });
});

describe('resolveSessionRuntime', () => {
  test("onNotRunning 'fail' rejects a dormant row before any SDK call", async () => {
    const { client, posts } = fakeClient([]);
    const stopped: ProjectSession = { ...session, status: 'stopped' };
    const err = (await resolveSessionRuntime({
      auth,
      client,
      projectId: 'proj',
      session: stopped,
      onNotRunning: 'fail',
    }).catch((e) => e)) as SessionRuntimeError;
    expect(err).toBeInstanceOf(SessionRuntimeError);
    expect(err.kind).toBe('not-running');
    expect(err.message).toBe(`Session ${stopped.session_id} is stopped, not running.`);
    expect(posts).toEqual([]);
  });

  test("onNotRunning 'fail' is the default", async () => {
    const { client } = fakeClient([]);
    const err = (await resolveSessionRuntime({
      auth,
      client,
      projectId: 'proj',
      session: { ...session, status: 'provisioning' },
    }).catch((e) => e)) as SessionRuntimeError;
    expect(err.kind).toBe('not-running');
    expect(err.message).toContain('is provisioning, not running');
  });
});

describe('resolveSessionRuntime on a running row', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('adopts the row\'s runtime and never calls /start', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return Response.json({
        stage: 'ready',
        sandbox: { external_id: 'sb-start' },
        runtime_session_id: 'ses_start',
      });
    }) as unknown as typeof fetch;
    const { client } = fakeClient([]);
    const runtime = await resolveSessionRuntime({
      auth,
      client,
      projectId: 'proj',
      session: {
        ...session,
        session_id: 'abcd1234-0000-0000-0000-00000000run1',
        sandbox_url: 'https://api.example.test/v1/p/sb-1/8000',
        runtime_session_id: 'ses_row',
      },
    });
    expect(urls.filter((url) => url.includes('/start'))).toEqual([]);
    expect(runtime.runtimeSessionId).toBe('ses_row');
  });
});
