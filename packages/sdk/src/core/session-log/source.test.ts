import { afterEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../http/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFirstSessionLogPage, fetchSessionLogPage, loadSessionLogPage, negotiateSessionLog, SESSION_LOG_FIRST_PAGE_LIMIT } from './source';
import type { SessionLog } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const loader = async () => ({});
const page = () => {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: true };
};

describe('negotiateSessionLog', () => {
  // The stored log is the API's: it needs no runtime, so a stopped box reads it too. The
  // session stream serves `schema=v2` for every daemon (it converts a daemon that does not
  // list `session.log.v2`), so the runtime's capability list no longer gates it.
  test('v2 when the flag is on and a page loader exists, whatever the runtime lists', () => {
    expect(negotiateSessionLog({ flag: true, loader })).toBe('v2');
  });
  test('v1 for each missing condition', () => {
    expect(negotiateSessionLog({ flag: false, loader })).toBe('v1');
    expect(negotiateSessionLog({ flag: true, loader: null })).toBe('v1');
  });
  test('an API that predates the flag never says true, so this SDK keeps v1 there', () => {
    expect(negotiateSessionLog({ flag: undefined, loader })).toBe('v1');
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

describe('fetchSessionLogPage', () => {
  test('passes the query (thread, before_seq, limit) and returns a valid page; null on failure', async () => {
    const calls: unknown[] = [];
    const query = { thread: 'ses_child', before_seq: 7, limit: 40 };
    const result = await fetchSessionLogPage(async (...args) => {
      calls.push(args.slice(0, 3));
      return page();
    }, 'proj_1', 'kses_1', query);
    expect(calls).toEqual([['proj_1', 'kses_1', query]]);
    expect(result).toEqual(page());
    expect(await fetchSessionLogPage(async () => { throw new Error('404'); }, 'p', 's', query)).toBeNull();
  });
});
