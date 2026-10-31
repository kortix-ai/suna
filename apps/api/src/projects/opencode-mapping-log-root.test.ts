// A box that serves its own session log (`runtime.log.v1`) names its root on `/kortix/health`:
// readiness and the pin read it there, never from the OpenCode session list.
import { beforeEach, describe, expect, test } from 'bun:test';

import { readRuntimeRoot } from './opencode-mapping';

const ENDPOINT = { url: 'https://daemon.example.test', headers: {} };
const paths: string[] = [];
let answer: () => Response | Promise<Response> = () => Response.json({});

beforeEach(() => {
  paths.length = 0;
  globalThis.fetch = (async (url: unknown) => {
    paths.push(String(url).replace(ENDPOINT.url, ''));
    return answer();
  }) as typeof fetch;
});

const health = (harness: Record<string, unknown>) => () => Response.json({ capabilities: ['runtime.log.v1'], harness });

describe('readRuntimeRoot', () => {
  test('a started runtime names its root thread: ready, from /kortix/health only', async () => {
    answer = health({ state: 'ok', ready: false, session: { id: null, required: false, root_thread_id: 'ses_pi_root' } });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: true, root: 'ses_pi_root' });
    expect(paths).toEqual(['/kortix/health']);
  });

  test('a runtime still starting, or one that names no root yet, is not ready', async () => {
    answer = health({ state: 'starting', session: { id: null, required: true, root_thread_id: null } });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: false, reason: 'not_ready' });
    answer = health({ state: 'ok', session: { id: null, required: true, root_thread_id: null } });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: false, reason: 'not_ready' });
    answer = () => new Response('{}', { status: 503 });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: false, reason: 'not_ready' });
  });

  test('a refused or failed read is unreachable, with its cause', async () => {
    answer = () => new Response('nope', { status: 401, headers: { server: 'edge' } });
    expect(await readRuntimeRoot(ENDPOINT)).toMatchObject({ ok: false, reason: 'unreachable', cause: 'unsigned_context', responder: 'edge' });
    answer = () => {
      throw new TypeError('fetch failed');
    };
    expect(await readRuntimeRoot(ENDPOINT)).toMatchObject({ ok: false, reason: 'unreachable', cause: 'endpoint_error' });
  });
});
