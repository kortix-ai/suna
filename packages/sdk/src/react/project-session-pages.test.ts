import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';

import type { ProjectSession, ProjectSessionPage } from '../core/rest/projects-client';
import {
  findCachedProjectSession,
  flattenProjectSessionPages,
  mapProjectSessionListCache,
  mergeProjectSessionHeadPage,
  upsertProjectSessionInPages,
} from './project-session-pages';
import { patchKortixSessionTitleMirrors } from './use-opencode-events/helpers';
import { qk } from './query-keys';

const row = (sessionId: string, extra: Partial<ProjectSession> = {}) =>
  ({ session_id: sessionId, name: sessionId, custom_name: null, ...extra }) as ProjectSession;

const pages = (...groups: ProjectSession[][]): InfiniteData<ProjectSessionPage, string | null> => ({
  pages: groups.map((sessions, index) => ({
    sessions,
    next_cursor: index < groups.length - 1 ? `c${index}` : null,
  })),
  pageParams: groups.map((_, index) => (index === 0 ? null : `c${index - 1}`)),
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('flattenProjectSessionPages', () => {
  test('is empty before the first page lands', () => {
    expect(flattenProjectSessionPages(undefined)).toEqual([]);
  });

  test('concatenates pages in order', () => {
    const data = pages([row('a'), row('b')], [row('c')]);
    expect(flattenProjectSessionPages(data).map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
  });

  test('keeps the first copy of a session that moved between pages', () => {
    // A session active since page 1 was fetched moves to the top: a refetched
    // page 1 and a stale page 3 both carry it. The newest-page copy wins.
    const fresh = row('b', { name: 'fresh' });
    const stale = row('b', { name: 'stale' });
    const data = pages([fresh, row('a')], [row('c'), stale]);
    const flat = flattenProjectSessionPages(data);
    expect(flat.map((s) => s.session_id)).toEqual(['b', 'a', 'c']);
    expect(flat[0]).toBe(fresh);
  });
});

describe('mapProjectSessionListCache', () => {
  const rename = (rows: ProjectSession[]) =>
    rows.some((s) => s.session_id === 'b')
      ? rows.map((s) => (s.session_id === 'b' ? { ...s, name: 'renamed' } : s))
      : rows;

  test('maps a bare array', () => {
    const next = mapProjectSessionListCache([row('a'), row('b')], rename) as ProjectSession[];
    expect(next.map((s) => s.name)).toEqual(['a', 'renamed']);
  });

  test('maps every page of infinite data and keeps pageParams', () => {
    const data = pages([row('a')], [row('b')]);
    const next = mapProjectSessionListCache(data, rename) as typeof data;
    expect(next.pages[1]!.sessions[0]!.name).toBe('renamed');
    expect(next.pages[1]!.next_cursor).toBeNull();
    expect(next.pageParams).toBe(data.pageParams);
    // Untouched pages keep their identity, so React Query structural sharing holds.
    expect(next.pages[0]).toBe(data.pages[0]);
  });

  test('returns the same reference when nothing changed', () => {
    const data = pages([row('a')]);
    expect(mapProjectSessionListCache(data, rename)).toBe(data);
    const array = [row('a')];
    expect(mapProjectSessionListCache(array, rename)).toBe(array);
  });

  test('passes through anything that is not a session list', () => {
    const single = row('b');
    expect(mapProjectSessionListCache(single, rename)).toBe(single);
    expect(mapProjectSessionListCache(undefined, rename)).toBeUndefined();
  });
});

describe('upsertProjectSessionInPages', () => {
  test('replaces a loaded session in place', () => {
    const data = pages([row('a')], [row('b')]);
    const next = upsertProjectSessionInPages(data, row('b', { name: 'seeded' }))!;
    expect(next.pages[1]!.sessions.map((s) => s.name)).toEqual(['seeded']);
    expect(next.pages[0]).toBe(data.pages[0]);
  });

  test('prepends an unseen session to the first page', () => {
    const data = pages([row('a')], [row('b')]);
    const next = upsertProjectSessionInPages(data, row('new'))!;
    expect(next.pages[0]!.sessions.map((s) => s.session_id)).toEqual(['new', 'a']);
  });

  test('does not invent a cache entry: with no pages loaded there is nothing to seed', () => {
    // A fabricated single page would carry `next_cursor: null` and tell the
    // list it has reached the end.
    expect(upsertProjectSessionInPages(undefined, row('new'))).toBeUndefined();
  });
});

describe('findCachedProjectSession', () => {
  test('finds a session in a loaded page', () => {
    const qc = client();
    qc.setQueryData(qk.project.sessionPages('P1'), pages([row('a')], [row('b')]));
    expect(findCachedProjectSession(qc, 'P1', 'b')?.session_id).toBe('b');
  });

  test('finds a session in the unpaged array cache', () => {
    const qc = client();
    qc.setQueryData(qk.project.sessions('P1'), [row('a')]);
    expect(findCachedProjectSession(qc, 'P1', 'a')?.session_id).toBe('a');
  });

  test('is undefined when the session is on no loaded page, or in another project', () => {
    const qc = client();
    qc.setQueryData(qk.project.sessionPages('P1'), pages([row('a')]));
    qc.setQueryData(qk.project.sessionPages('P2'), pages([row('b')]));
    expect(findCachedProjectSession(qc, 'P1', 'b')).toBeUndefined();
  });

  test('never reads the single-session detail entry as a list', () => {
    const qc = client();
    qc.setQueryData(qk.project.session('P1', 'a'), row('a'));
    expect(findCachedProjectSession(qc, 'P1', 'a')).toBeUndefined();
  });
});

describe('patchKortixSessionTitleMirrors on paged data', () => {
  test('writes a runtime title into the loaded page that holds the session', () => {
    const qc = client();
    const key = qk.project.sessionPages('P1');
    qc.setQueryData(
      key,
      pages([row('a', { opencode_session_id: 'oc-a' })], [row('b', { opencode_session_id: 'oc-b' })]),
    );

    patchKortixSessionTitleMirrors(qc, 'P1', 'oc-b', 'Generated title');

    const data = qc.getQueryData<InfiniteData<ProjectSessionPage>>(key)!;
    expect(data.pages[1]!.sessions[0]!.name).toBe('Generated title');
    expect(data.pages[0]!.sessions[0]!.name).toBe('a');
  });

  test('never overwrites a user rename on a page', () => {
    const qc = client();
    const key = qk.project.sessionPages('P1');
    qc.setQueryData(key, pages([row('a', { opencode_session_id: 'oc-a', custom_name: 'Mine' })]));

    patchKortixSessionTitleMirrors(qc, 'P1', 'oc-a', 'Generated title');

    expect(qc.getQueryData<InfiniteData<ProjectSessionPage>>(key)!.pages[0]!.sessions[0]!.name).toBe(
      'a',
    );
  });
});

describe('mergeProjectSessionHeadPage', () => {
  const head = (sessions: ProjectSession[], next_cursor: string | null) => ({ sessions, next_cursor });

  test('replaces a single loaded page with the fresh head', () => {
    const data = pages([row('a'), row('b')]);
    const merged = mergeProjectSessionHeadPage(data, head([row('new'), row('a')], 'c9'));
    expect(merged).not.toBe('refetch');
    const result = merged as ReturnType<typeof pages>;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.sessions.map((s) => s.session_id)).toEqual(['new', 'a']);
    expect(result.pages[0]!.next_cursor).toBe('c9');
  });

  test('a head with no next cursor is the whole list: later pages are dropped', () => {
    const data = pages([row('a')], [row('b')]);
    const result = mergeProjectSessionHeadPage(data, head([row('a')], null)) as ReturnType<typeof pages>;
    expect(result.pages.map((p) => p.sessions.map((s) => s.session_id))).toEqual([['a']]);
    expect(result.pageParams).toEqual([null]);
  });

  test('keeps deeper pages and carries rows a new session pushed off page 1', () => {
    // Page 1 held a,b,c; a new session arrived, so the fresh head is new,a,b and
    // `c` now sits between the fresh boundary and page 2's old cursor.
    const data = pages([row('a'), row('b'), row('c')], [row('d')]);
    const result = mergeProjectSessionHeadPage(data, head([row('new'), row('a'), row('b')], 'cb')) as ReturnType<typeof pages>;
    expect(result.pages[0]!.sessions.map((s) => s.session_id)).toEqual(['new', 'a', 'b', 'c']);
    expect(result.pages[0]!.next_cursor).toBe('c0');
    expect(result.pages[1]).toBe(data.pages[1]);
  });

  test('drops a page-1 row that vanished from the head range (deleted or hidden)', () => {
    const data = pages([row('a'), row('gone'), row('b')], [row('d')]);
    const result = mergeProjectSessionHeadPage(data, head([row('a'), row('b')], 'cb')) as ReturnType<typeof pages>;
    expect(result.pages[0]!.sessions.map((s) => s.session_id)).toEqual(['a', 'b']);
  });

  test('asks for a full refetch when the head shares no row with page 1', () => {
    const data = pages([row('a')], [row('b')]);
    expect(mergeProjectSessionHeadPage(data, head([row('x'), row('y')], 'cy'))).toBe('refetch');
  });

  test('returns the same data when the head rows are the cached rows', () => {
    const a = row('a');
    const b = row('b');
    const data = pages([a, b], [row('c')]);
    expect(mergeProjectSessionHeadPage(data, head([a, b], 'cb'))).toBe(data);
  });

  test('nothing to merge before the first page loads', () => {
    expect(mergeProjectSessionHeadPage(undefined, head([row('a')], null))).toBeUndefined();
  });
});

describe('findCachedProjectSession at scale', () => {
  test('indexes each cache entry once: repeat lookups do not rescan 12,000 rows', () => {
    const qc = client();
    const all = Array.from({ length: 12_000 }, (_, i) => row(`s${i}`));
    const groups = Array.from({ length: 240 }, (_, p) => all.slice(p * 50, p * 50 + 50));
    qc.setQueryData(qk.project.sessionPages('P1'), pages(...groups));
    expect(findCachedProjectSession(qc, 'P1', 's11999')?.session_id).toBe('s11999');
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) findCachedProjectSession(qc, 'P1', `s${i * 5}`);
    // 2,000 lookups over 12,000 rows: an unindexed scan is ~12M comparisons.
    expect(performance.now() - started).toBeLessThan(50);
  });
});
