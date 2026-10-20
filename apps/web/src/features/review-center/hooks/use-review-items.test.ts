import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';

const { invalidateReviewInbox } = await import('./use-review-items');

// KRTX-1739: the session lists fold GET needs-input into the inbox counts, and
// it lists a pending connector call. A verdict that refetched the inbox alone
// left the session on Needs you until the needs-input poll (30 s).
describe('invalidateReviewInbox', () => {
  test('refetches every inbox page, the needs-you counts and the needs-input summary', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = mock((_filters: unknown) => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as typeof queryClient.invalidateQueries;

    await invalidateReviewInbox(queryClient, 'proj-1');

    expect(invalidateSpy.mock.calls).toEqual([
      [{ queryKey: qk.project.reviewItemsScope('proj-1') }],
      [{ queryKey: qk.project.reviewSummary('proj-1') }],
      [{ queryKey: qk.project.needsInput('proj-1') }],
    ]);
  });
});
