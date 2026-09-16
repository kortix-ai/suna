import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';

import type { ProjectSession, ProjectSessionPage } from '../core/rest/projects-client';
import {
  findCachedProjectSession,
  flattenProjectSessionPages,
  mapProjectSessionListCache,
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
