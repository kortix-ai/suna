import { describe, expect, mock, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

import { invalidateReviewItems } from './use-review';

// KRTX-1739: the drawer and the Sessions page fold GET needs-input into the
// review counts, and it lists a pending connector call. A decision that
// refetched the review list alone left the session on Needs you until the
// needs-input poll (30 s).
describe('invalidateReviewItems', () => {
  test('refetches the review list and the project needs-input summary', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = mock((_filters: { queryKey: readonly unknown[] }) => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as typeof queryClient.invalidateQueries;

    invalidateReviewItems(queryClient, 'proj-1');

    expect(invalidateSpy.mock.calls).toEqual([
      [{ queryKey: ['review-items', 'proj-1'] }],
      [{ queryKey: qk.project.needsInput('proj-1') }],
    ]);
  });
});
