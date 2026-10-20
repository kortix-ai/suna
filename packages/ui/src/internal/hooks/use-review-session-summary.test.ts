import { describe, expect, test } from 'bun:test';

import { withNeedsInput } from './use-review-session-summary';

// KRTX-1739: a session whose agent waits on a question reads `needs-you` too.
describe('withNeedsInput', () => {
  test('adds a session that only GET needs-input lists (an open agent question)', () => {
    expect(withNeedsInput({ s1: 2 }, { total: 1, sessions: { s2: 1 } })).toEqual({ s1: 2, s2: 1 });
  });

  test('takes the larger count: a connector approval is in both lists, a sum would count it twice', () => {
    expect(withNeedsInput({ s1: 1, s2: 3 }, { total: 3, sessions: { s1: 2, s2: 1 } })).toEqual({ s1: 2, s2: 3 });
  });

  test('no needs-input summary yet, or an empty one, keeps the review counts as they are', () => {
    const reviews = { s1: 1 };
    expect(withNeedsInput(reviews, undefined)).toBe(reviews);
    expect(withNeedsInput(reviews, { total: 0, sessions: {} })).toBe(reviews);
  });
});

describe('useIsNeedsInputPoller: one 30 s poll per project, however many lists mount', () => {
  test('the oldest mounted reader polls; the next one takes over when it unmounts', async () => {
    const { createElement } = await import('react');
    const { act, create } = await import('react-test-renderer');
    const { useIsNeedsInputPoller } = await import('./use-review-session-summary');
    const seen: Record<string, boolean> = {};
    const Reader = ({ name, projectId }: { name: string; projectId: string }) => {
      seen[name] = useIsNeedsInputPoller(projectId);
      return null;
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let sidebar!: ReturnType<typeof create>;
    let page!: ReturnType<typeof create>;
    let other!: ReturnType<typeof create>;
    await act(async () => {
      sidebar = create(createElement(Reader, { name: 'sidebar', projectId: 'p1' }));
    });
    await act(async () => {
      page = create(createElement(Reader, { name: 'page', projectId: 'p1' }));
      other = create(createElement(Reader, { name: 'other', projectId: 'p2' }));
    });
    expect(seen).toEqual({ sidebar: true, page: false, other: true });
    await act(async () => sidebar.unmount());
    expect(seen.page).toBe(true);
    await act(async () => {
      page.unmount();
      other.unmount();
    });
  });
});
