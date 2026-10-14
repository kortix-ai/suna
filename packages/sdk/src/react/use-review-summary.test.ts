import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { nextReviewItemsCursor, reviewItemsOf } from './use-review-summary';

describe('review query keys (KRTX-2316)', () => {
  test('the summary and every page set nest under the project scope', () => {
    const scope = qk.project.scope('P1');
    expect(qk.project.reviewSummary('P1').slice(0, scope.length)).toEqual([...scope]);
    const pages = qk.project.reviewItemPages('P1', { segment: 'done' });
    const prefix = qk.project.reviewItemsScope('P1');
    expect(pages.slice(0, prefix.length)).toEqual([...prefix]);
    expect(prefix.slice(0, scope.length)).toEqual([...scope]);
  });

  test('each filter is its own page set', () => {
    expect(qk.project.reviewItemPages('P1', { segment: 'done' })).not.toEqual(
      qk.project.reviewItemPages('P1', { segment: 'needs_you' }),
    );
    expect(qk.project.reviewItemPages('P1')).toEqual(qk.project.reviewItemPages('P1', {}));
  });
});

describe('review pages', () => {
  test('a page with a cursor has a next page; the last page and an older server have none', () => {
    expect(nextReviewItemsCursor({ review_items: [], next_cursor: 'c2' })).toBe('c2');
    expect(nextReviewItemsCursor({ review_items: [], next_cursor: null })).toBeUndefined();
    expect(nextReviewItemsCursor({ review_items: [] })).toBeUndefined();
  });

  test('reviewItemsOf flattens the loaded pages in order', () => {
    const row = (id: string) => ({ review_item_id: id }) as never;
    expect(
      reviewItemsOf({
        pages: [{ review_items: [row('a'), row('b')] }, { review_items: [row('c')] }],
      }).map((item) => item.review_item_id),
    ).toEqual(['a', 'b', 'c']);
    expect(reviewItemsOf(undefined)).toEqual([]);
  });
});
