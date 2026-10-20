import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

import { invalidateReviewItems, reviewKeys, withReviewItemStatus } from './use-review';

// KRTX-1739: the drawer and the Sessions page fold GET needs-input into the
// review counts, and it lists a pending connector call. A decision that
// refetched the review list alone left the session on Needs you until the
// needs-input poll (30 s).
describe('invalidateReviewItems', () => {
  test('refetches every review read, the needs-you counts and the needs-input summary', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = mock((_filters: { queryKey: readonly unknown[] }) => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as typeof queryClient.invalidateQueries;

    invalidateReviewItems(queryClient, 'proj-1');

    expect(invalidateSpy.mock.calls).toEqual([
      [{ queryKey: ['review-items', 'proj-1'] }],
      [{ queryKey: qk.project.reviewSummary('proj-1') }],
      [{ queryKey: qk.project.needsInput('proj-1') }],
    ]);
  });
});

// KRTX-2316: the project root stays mounted while a project is open, and the
// Sessions page reads its caches. They poll the needs-you counts, never the
// review list, which grows with the project's history.
describe('always-mounted review reads', () => {
  for (const path of ['../../components/session/ProjectScreen.tsx', '../../components/session/ProjectSessionsPage.tsx']) {
    test(`${path} reads the counts, not the list`, () => {
      const source = readFileSync(join(import.meta.dir, path), 'utf8');
      expect(source).toContain('useReviewNeedsYou(');
      expect(source).not.toMatch(/useReviewItems|listReviewItems|review\/items/);
    });
  }
});

// KRTX-2316: every review read is a page set under one prefix, so a verdict
// and an invalidation reach them all.
describe('review reads', () => {
  test('each filter is its own page set under the project prefix', () => {
    const prefix = reviewKeys.list('p1');
    const done = reviewKeys.pages('p1', { segment: 'done' });
    expect(done.slice(0, prefix.length)).toEqual([...prefix]);
    expect(done).not.toEqual(reviewKeys.pages('p1', { segment: 'needs_you' }));
    expect(reviewKeys.needsYou('p1', '{}').slice(0, prefix.length)).toEqual([...prefix]);
  });

  test('a verdict sets the status in a page set and in a single page', () => {
    const row = (id: string) => ({ review_item_id: id, status: 'needs_you' }) as never;
    const pages = { pages: [{ review_items: [row('a'), row('b')] }], pageParams: [undefined] };
    expect(withReviewItemStatus(pages, 'b', 'approved')).toEqual({
      pages: [{ review_items: [row('a'), { review_item_id: 'b', status: 'approved' }] }],
      pageParams: [undefined],
    });
    expect(withReviewItemStatus({ review_items: [row('a')] }, 'a', 'rejected')).toEqual({
      review_items: [{ review_item_id: 'a', status: 'rejected' }],
    });
    expect(withReviewItemStatus(undefined, 'a', 'approved')).toBeUndefined();
  });
});
