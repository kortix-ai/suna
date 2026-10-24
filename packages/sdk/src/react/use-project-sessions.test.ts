import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { qk } from './query-keys';
import {
  EMPTY_SESSION_PAGE_SCAN_LIMIT,
  flattenProjectSessionPages,
  projectSessionsPageParam,
  shouldScanPastEmptySessionPages,
  useProjectSessions,
} from './use-project-sessions';
import type { ProjectSessionPage } from '../core/rest/projects-client/sessions';

describe('paged session-list query key', () => {
  test('nests under the scope-less prefix every mutation already invalidates', () => {
    const prefix = qk.project.sessionsScope('P1');
    const paged = qk.project.sessionsPaged('P1');
    expect(paged.slice(0, prefix.length)).toEqual([...prefix]);
  });

  test('is a different slot from the flat list — the two cache different shapes', () => {
    expect(qk.project.sessionsPaged('P1')).not.toEqual([...qk.project.sessions('P1')] as never);
  });

  test('keeps the scopes apart, exactly as the flat list does', () => {
    expect(qk.project.sessionsPaged('P1', 'project')).not.toEqual([
      ...qk.project.sessionsPaged('P1', 'visible'),
    ] as never);
  });
});

describe('projectSessionsPageParam', () => {
  test('hands back the cursor the server issued', () => {
    const page: ProjectSessionPage = { items: [], next_cursor: 'NEXT1' };
    expect(projectSessionsPageParam(page)).toBe('NEXT1');
  });

  test('returns undefined on the last page so react-query stops asking', () => {
    // null is "the list ended". Returning it as a pageParam would make
    // hasNextPage stay true and the sidebar offer a Load-more that fetches
    // page one again, forever.
    const page: ProjectSessionPage = { items: [], next_cursor: null };
    expect(projectSessionsPageParam(page)).toBeUndefined();
  });
});

describe('flattenProjectSessionPages', () => {
  test('concatenates pages in order', () => {
    const pages: ProjectSessionPage[] = [
      { items: [{ session_id: 'S1' }, { session_id: 'S2' }] as never, next_cursor: 'C1' },
      { items: [{ session_id: 'S3' }] as never, next_cursor: null },
    ];
    expect(flattenProjectSessionPages({ pages, pageParams: [] }).map((s) => s.session_id)).toEqual([
      'S1',
      'S2',
      'S3',
    ]);
  });

  test('is an empty list before the first page arrives', () => {
    expect(flattenProjectSessionPages(undefined)).toEqual([]);
  });

  test('drops a row a later page repeats', () => {
    // A session prompted between two page fetches moves to the top of the
    // `updated_at DESC` order, so a row already served on page 1 can appear
    // again on page 2. Rendering it twice gives React two children with the
    // same key, which is a real crash in list code that keys by session_id.
    const pages: ProjectSessionPage[] = [
      { items: [{ session_id: 'S1' }, { session_id: 'S2' }] as never, next_cursor: 'C1' },
      { items: [{ session_id: 'S2' }, { session_id: 'S3' }] as never, next_cursor: null },
    ];
    expect(flattenProjectSessionPages({ pages, pageParams: [] }).map((s) => s.session_id)).toEqual([
      'S1',
      'S2',
      'S3',
    ]);
  });
});

describe('filtered session-list query keys (KRTX-639)', () => {
  test('an unfiltered key is unchanged, so legacy readers still hit it', () => {
    expect(qk.project.sessionsPaged('P1', 'visible', {})).toEqual([
      ...qk.project.sessionsPaged('P1'),
    ] as never);
  });

  test('each filter gets its own cache slot', () => {
    const root = qk.project.sessionsPaged('P1', 'visible', { parent: 'root', startedBy: 'me' });
    const shared = qk.project.sessionsPaged('P1', 'visible', { parent: 'root', startedBy: 'others' });
    const searched = qk.project.sessionsPaged('P1', 'visible', { parent: 'root', startedBy: 'me', q: 'x' });
    expect(root).not.toEqual([...shared] as never);
    expect(root).not.toEqual([...searched] as never);
    expect(root).not.toEqual([...qk.project.sessionsPaged('P1')] as never);
  });

  test('a filtered key nests under the sessions prefix', () => {
    const prefix = qk.project.sessionsScope('P1');
    const key = qk.project.sessionsPaged('P1', 'visible', { parent: 'root' });
    expect(key.slice(0, prefix.length)).toEqual([...prefix]);
  });

  test('children get a key per parent and per query', () => {
    const a = qk.project.sessionChildren('P1', 'S1');
    expect(a).not.toEqual([...qk.project.sessionChildren('P1', 'S2')] as never);
    expect(a).not.toEqual([...qk.project.sessionChildren('P1', 'S1', 'q')] as never);
    expect(a.slice(0, qk.project.sessionsScope('P1').length)).toEqual([...qk.project.sessionsScope('P1')]);
  });
});

// KRTX-1727: the server drops sessions the viewer may not see (and deleted
// ones) after a bounded scan, so a page can be empty and still carry a cursor.
// Page one empty was rendered as "No sessions yet" and hid the Shared section.
describe('shouldScanPastEmptySessionPages', () => {
  const empty = (cursor: string | null): ProjectSessionPage => ({ items: [], next_cursor: cursor });
  const pages = (...p: ProjectSessionPage[]) => ({ pages: p, pageParams: p.map(() => null) });

  test('an empty page with a cursor is not the end: scan the next page', () => {
    expect(shouldScanPastEmptySessionPages(pages(empty('C1')), true)).toBe(true);
  });

  test('no cursor, no data, or any loaded session: stop', () => {
    expect(shouldScanPastEmptySessionPages(pages(empty(null)), false)).toBe(false);
    expect(shouldScanPastEmptySessionPages(undefined, true)).toBe(false);
    const one = { items: [{ session_id: 's1' }], next_cursor: 'C2' } as unknown as ProjectSessionPage;
    expect(shouldScanPastEmptySessionPages(pages(empty('C1'), one), true)).toBe(false);
  });

  test('stops after the scan limit, so a viewer who sees nothing is not scanned forever', () => {
    const limit = Array.from({ length: EMPTY_SESSION_PAGE_SCAN_LIMIT }, () => empty('C'));
    expect(shouldScanPastEmptySessionPages(pages(...limit.slice(1)), true)).toBe(true);
    expect(shouldScanPastEmptySessionPages(pages(...limit), true)).toBe(false);
  });
});

// The hook's own scan, mounted against a stubbed `fetch`. The stub answers at
// once: a page can land before React renders the fetch that asked for it.
describe('useProjectSessions reads past empty pages (KRTX-1727)', () => {
  // Page N answers cursor `C<N>` (page 0 the first read); 'fail' answers 500.
  let pages: Array<{ ids: string[]; next: string | null } | 'fail'> = [];
  const cursors: Array<string | null> = [];
  // A network that answers after React rendered the fetch (ms); 0 answers at once.
  let latency = 0;
  let root: ReturnType<typeof create> | undefined;
  let list: ReturnType<typeof useProjectSessions>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
    cursors.length = 0;
    latency = 0;
    globalThis.fetch = mock(async (url: unknown) => {
      const cursor = new URL(String(url)).searchParams.get('cursor');
      cursors.push(cursor);
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
      const page = pages[cursor ? Number(cursor.slice(1)) : 0];
      if (!page || page === 'fail') return Response.json({ error: 'unavailable' }, { status: 500 });
      return Response.json(
        page.ids.map((id) => ({ session_id: id })),
        { headers: page.next ? { 'x-next-cursor': page.next } : {} },
      );
    }) as unknown as typeof fetch;
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
  });

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      list = useProjectSessions('P1', { scope: 'project', q: 'deploy', limit: 20 });
      return null;
    }
    await act(async () => {
      root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    for (let i = 0; i < 15; i++) await settle();
  }

  test('reads empty pages with a cursor until a row shows', async () => {
    pages = [
      { ids: [], next: 'C1' },
      { ids: [], next: 'C2' },
      { ids: ['S-old'], next: null },
    ];
    await mount();
    expect(cursors).toEqual([null, 'C1', 'C2']);
    expect(list.sessions.map((s) => s.session_id)).toEqual(['S-old']);
    expect(list.isScanning).toBe(false);
  });

  test('a failed page ends the scan: no retry loop, the next page stays offered', async () => {
    pages = [{ ids: [], next: 'C1' }, 'fail'];
    latency = 5;
    await mount();
    expect(cursors).toEqual([null, 'C1']);
    expect(list.isScanning).toBe(false);
    expect(list.hasNextPage).toBe(true);
    expect(list.isFetching).toBe(false);
  });

  test('a refetch after a failed page resumes the scan', async () => {
    pages = [{ ids: [], next: 'C1' }, 'fail'];
    latency = 5;
    await mount();
    pages[1] = { ids: ['S-old'], next: null };
    await act(async () => {
      await list.refetch();
    });
    for (let i = 0; i < 15; i++) await settle();
    expect(cursors).toEqual([null, 'C1', null, 'C1']);
    expect(list.sessions.map((s) => s.session_id)).toEqual(['S-old']);
  });
});

describe('useProjectSessions spaceId', () => {
  test('lists one space: sends space_id and caches under the space key', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url));
      return Response.json([{ session_id: 'S1', space_id: 'SPACE-1' }]);
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let list: ReturnType<typeof useProjectSessions> | undefined;
    function Probe() {
      list = useProjectSessions('P1', { parent: 'root', spaceId: 'SPACE-1' });
      return null;
    }
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(new URL(urls[0]!).searchParams.get('space_id')).toBe('SPACE-1');
    expect(list?.sessions.map((s) => s.session_id)).toEqual(['S1']);
    const key = qk.project.sessionsPaged('P1', 'visible', { parent: 'root', spaceId: 'SPACE-1' });
    expect(client.getQueryData(key)).toBeDefined();
    await act(async () => root!.unmount());
  });
});

describe('useProjectSessions pollFirstPageOnly', () => {
  // Page N answers cursor `C<N>` (page 0 the first read).
  let pages: Array<{ ids: string[]; next: string | null }> = [];
  const cursors: Array<string | null> = [];
  let root: ReturnType<typeof create> | undefined;
  let list: ReturnType<typeof useProjectSessions>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
    cursors.length = 0;
    globalThis.fetch = mock(async (url: unknown) => {
      const cursor = new URL(String(url)).searchParams.get('cursor');
      cursors.push(cursor);
      const page = pages[cursor ? Number(cursor.slice(1)) : 0]!;
      return Response.json(
        page.ids.map((id) => ({ session_id: id })),
        { headers: page.next ? { 'x-next-cursor': page.next } : {} },
      );
    }) as unknown as typeof fetch;
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    jest.useRealTimers();
  });

  // The fake clock moves `ms` in 5 ms steps, letting the answered fetches and React settle between steps.
  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += 5) {
      await act(async () => {
        jest.advanceTimersByTime(5);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    }
  };

  test('a poll re-reads page one only, and a loaded older page keeps its rows', async () => {
    jest.useFakeTimers();
    pages = [
      { ids: ['B', 'A'], next: 'C1' },
      { ids: ['Z'], next: null },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      list = useProjectSessions('P1', { spaceId: 'SPACE-1', parent: 'root', refetchInterval: 40, pollFirstPageOnly: true });
      return null;
    }
    await act(async () => {
      root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    await advance(20);
    await act(async () => {
      void list.fetchNextPage();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    await advance(20);
    expect(cursors).toEqual([null, 'C1']);

    // A new thread arrives and pushes A off page one.
    pages[0] = { ids: ['N', 'B'], next: 'C1' };
    await advance(150);

    expect(cursors.slice(2).length).toBeGreaterThan(0);
    expect(cursors.slice(2).every((cursor) => cursor === null)).toBe(true);
    // N is new; A stays (its page-two cursor starts after it); Z stays loaded.
    expect(list.sessions.map((s) => s.session_id)).toEqual(['N', 'B', 'A', 'Z']);
    expect(list.hasNextPage).toBe(false);
  });
});
