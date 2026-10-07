import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import {
  EMPTY_SESSION_PAGE_SCAN_LIMIT,
  flattenProjectSessionPages,
  projectSessionsPageParam,
  shouldScanPastEmptySessionPages,
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
