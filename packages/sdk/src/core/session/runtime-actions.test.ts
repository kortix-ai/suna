import { describe, expect, test } from 'bun:test';

import { readRuntimeLogPage } from './runtime-actions';

const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const message = (seq: number) => ({
  schema: 'kortix.session/2', v: 1, message_id: `msg_${seq}`, thread_id: 'ses_root', seq, role: 'user', kind: 'turn', status: 'complete',
  in_context: true, model: null, usage: null, finish: null, error: null, created_at: '2026-10-30T00:00:00.000Z', completed_at: null,
  producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks: [],
});
const head = { schema: 'kortix.session/2', v: 1, thread_id: 'ses_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '' };

function box(answer: { status?: number; body: unknown }) {
  const urls: string[] = [];
  const fetch = (async (request: Request) => {
    urls.push(request.url);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { urls, fetch };
}

describe('readRuntimeLogPage: the box page of a box that serves runtime.log.v1', () => {
  test('a whole page comes back as a SessionLogPage, read from GET /kortix/runtime/log with the query', async () => {
    const body = { session: { session_id: 'S' }, generation: 2, threads: [head], thread_id: 'ses_root', messages: [message(1), message(2)], has_more: false };
    const { urls, fetch } = box({ body });
    expect(await readRuntimeLogPage(RUNTIME, fetch, { limit: 40 })).toEqual(body as never);
    expect(urls).toEqual([`${RUNTIME}/kortix/runtime/log?limit=40`]);
  });

  test('a page without the session record or the thread heads (an older box) is null', async () => {
    const { fetch } = box({ body: { generation: 0, thread_id: 'ses_root', messages: [message(1)], has_more: false } });
    expect(await readRuntimeLogPage(RUNTIME, fetch, { limit: 40 })).toBeNull();
  });

  test('a refused read (503 while the runtime starts) or a network failure is null', async () => {
    expect(await readRuntimeLogPage(RUNTIME, box({ status: 503, body: { error: 'pi runtime is not started' } }).fetch, { limit: 40 })).toBeNull();
    const failing = (async () => { throw new Error('network'); }) as unknown as typeof globalThis.fetch;
    expect(await readRuntimeLogPage(RUNTIME, failing, { limit: 40 })).toBeNull();
  });
});
