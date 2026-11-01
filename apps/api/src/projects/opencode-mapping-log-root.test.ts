// A box that serves its own session log (`runtime.log.v1`) names its root on `/kortix/health`:
// readiness and the pin read it there, never from the OpenCode session list.
import { beforeEach, describe, expect, test } from 'bun:test';

import { readRuntimeRoot } from './opencode-mapping';

const ENDPOINT = { url: 'https://daemon.example.test', headers: {} };
const paths: string[] = [];
let answer: () => Response | Promise<Response> = () => Response.json({});
/** `/kortix/runtime/pending`, the signed read: the box takes the session's signature. */
let signed: () => Response | Promise<Response> = () => Response.json({ statuses: {}, permissions: [], questions: [] });

beforeEach(() => {
  paths.length = 0;
  signed = () => Response.json({ statuses: {}, permissions: [], questions: [] });
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url).replace(ENDPOINT.url, '');
    paths.push(path);
    return path === '/kortix/runtime/pending' ? signed() : answer();
  }) as typeof fetch;
});

const health = (harness: Record<string, unknown>) => () => Response.json({ capabilities: ['runtime.log.v1'], harness });

describe('readRuntimeRoot', () => {
  test('a started runtime names its root thread: ready, from /kortix/health and the signed /pending', async () => {
    answer = health({ state: 'ok', ready: false, session: { id: null, required: false, root_thread_id: 'ses_pi_root' } });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: true, root: 'ses_pi_root' });
    expect(paths.sort()).toEqual(['/kortix/health', '/kortix/runtime/pending']);
  });

  test('a box that refuses the signature is unreachable with the daemon reason, even when its health is ready', async () => {
    answer = health({ state: 'ok', session: { id: null, required: false, root_thread_id: 'ses_pi_root' } });
    signed = () => Response.json({ error: 'unauthorized', reason: 'bad_signature' }, { status: 401 });
    const named = await readRuntimeRoot(ENDPOINT);
    expect(named).toMatchObject({ ok: false, reason: 'unreachable', cause: 'unsigned_context' });
    expect((named as { detail?: string }).detail).toContain('bad_signature');
  });

  test('a runtime that has not started answers 503 on /pending: not ready, with its boot phase', async () => {
    answer = health({ state: 'ok', session: { id: null, required: false, root_thread_id: 'ses_pi_root' } });
    signed = () => new Response('{}', { status: 503, headers: { 'x-kortix-boot-phase': 'harness' } });
    expect(await readRuntimeRoot(ENDPOINT)).toEqual({ ok: false, reason: 'not_ready', bootPhase: 'harness' });
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
