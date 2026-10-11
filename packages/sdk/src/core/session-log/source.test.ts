import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFirstSessionLogPage, loadSessionLogPage, negotiateSessionLog, SESSION_LOG_FIRST_PAGE_LIMIT } from './source';
import type { SessionLog } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const loader = async () => ({});

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

test('no page loader is wired until the API serves GET /v1/projects/:p/sessions/:s/log (P4.2)', () => {
  expect(loadSessionLogPage).toBeNull();
});

describe('fetchFirstSessionLogPage', () => {
  const page = () => {
    const { threads, ...session } = structuredClone(log);
    return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), messages: threads[0]!.messages, has_more: true };
  };

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
