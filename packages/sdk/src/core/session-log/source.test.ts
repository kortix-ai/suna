import { afterEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../http/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFirstSessionLogPage, loadSessionLogPage, negotiateSessionLog, SESSION_LOG_FIRST_PAGE_LIMIT } from './source';
import type { SessionLog } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const loader = async () => ({});
const page = () => {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: true };
};

describe('negotiateSessionLog', () => {
  const V2 = ['session.rewind', 'session.log.v2'];
  test('v2 only when health lists session.log.v2, the flag is on and a page loader exists', () => {
    expect(negotiateSessionLog({ capabilities: V2, flag: true, loader })).toBe('v2');
  });
  test('v1 for each missing condition', () => {
    expect(negotiateSessionLog({ capabilities: V2, flag: false, loader })).toBe('v1');
    expect(negotiateSessionLog({ capabilities: V2, flag: true, loader: null })).toBe('v1');
    expect(negotiateSessionLog({ capabilities: ['session.rewind'], flag: true, loader })).toBe('v1');
  });
  test('v1 when the capability list is unknown or empty: runtimeSupports reads that as "everything", negotiation does not', () => {
    expect(negotiateSessionLog({ capabilities: null, flag: true, loader })).toBe('v1');
    expect(negotiateSessionLog({ capabilities: undefined, flag: true, loader })).toBe('v1');
    expect(negotiateSessionLog({ capabilities: [], flag: true, loader })).toBe('v1');
  });
  test('an API that predates the flag never says true, so this SDK keeps v1 there', () => {
    expect(negotiateSessionLog({ capabilities: V2, flag: undefined, loader })).toBe('v1');
  });
});

describe('loadSessionLogPage: GET /v1/projects/:p/sessions/:s/log', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function serve(status: number, body: unknown) {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url instanceof Request ? url.url : url));
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
    return urls;
  }

  test('asks the route with thread, before_seq and limit, and returns the body', async () => {
    const urls = serve(200, page());
    expect(await loadSessionLogPage!('proj 1', 'kses_1', { thread: 'ses_a', before_seq: 12, limit: 40 })).toEqual(page());
    expect(urls).toEqual(['http://test.local/v1/projects/proj%201/sessions/kses_1/log?thread=ses_a&before_seq=12&limit=40']);
  });

  test('a 404 (no stored log, or an unknown thread) reads as no page: the session stays on v1', async () => {
    serve(404, { error: 'No session log for this session' });
    expect(await fetchFirstSessionLogPage(loadSessionLogPage!, 'p', 's')).toBeNull();
  });
});

describe('fetchFirstSessionLogPage', () => {
  test('asks for the newest page of the root thread and returns a valid page', async () => {
    const calls: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await fetchFirstSessionLogPage(async (...args) => {
      calls.push(args);
      return page();
    }, 'proj_1', 'kses_1', signal);
    expect(calls).toEqual([['proj_1', 'kses_1', { limit: SESSION_LOG_FIRST_PAGE_LIMIT }, signal]]);
    expect(result).toEqual(page());
  });

  test('null for an invalid page or a failed request; never throws', async () => {
    const bad = page();
    (bad.messages[0] as Record<string, unknown>).blocks = 'x';
    expect(await fetchFirstSessionLogPage(async () => bad, 'p', 's')).toBeNull();
    expect(await fetchFirstSessionLogPage(async () => ({ error: 'not found' }), 'p', 's')).toBeNull();
    expect(await fetchFirstSessionLogPage(async () => { throw new Error('404'); }, 'p', 's')).toBeNull();
  });
});
