import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { projectSessionsPageParam, flattenProjectSessionPages } from './use-project-sessions';
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
