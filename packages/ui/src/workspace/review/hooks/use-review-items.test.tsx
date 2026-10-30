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

const { useReviewItemById, withFreshApprovalDetail } = await import('./use-review-items');
const { configureKortix } = await import('@kortix/sdk');
configureKortix({ backendUrl: 'http://api.example.test/v1', getToken: async () => 'token-synthetic' });

const listRow = (id: string, detail: Record<string, unknown>, status = 'needs_you') =>
  ({ review_item_id: id, kind: 'approval', status, detail }) as unknown as Parameters<
    typeof withFreshApprovalDetail
  >[0][number];

describe('withFreshApprovalDetail', () => {
  test('swaps in the detail read by id and keeps the list status', () => {
    const rows = [
      listRow('call:a', { args_preview: { pull_number: 1 } }, 'approved'),
      listRow('call:b', { args_preview: {} }),
    ];
    const fresh = listRow('call:a', { args_preview: { pull_number: 1 }, resolved_preview: { title: 'T' } });
    const out = withFreshApprovalDetail(rows, fresh);
    expect(out[0]).toMatchObject({ status: 'approved', detail: { resolved_preview: { title: 'T' } } });
    expect(out[1]).toBe(rows[1]);
  });

  test('no fresh copy, or a native item: the rows as they are', () => {
    const rows = [listRow('item-1', {})];
    expect(withFreshApprovalDetail(rows, undefined)).toBe(rows);
    expect(withFreshApprovalDetail(rows, listRow('item-1', { x: 1 }))).toBe(rows);
  });
});

describe('useReviewItemById', () => {
  async function read(id: string | null, enabled: boolean) {
    const { act, create } = await import('react-test-renderer');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        review_item: { review_item_id: id, detail: { resolved_preview: { title: 'Loaded' } } },
      });
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: { data?: unknown } = {};
    function Probe() {
      const q = useReviewItemById('proj-1', id, enabled);
      seen.data = q.data;
      (seen as { error?: unknown }).error = q.error;
      return null;
    }
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      await act(async () => root?.unmount());
      client.clear();
      globalThis.fetch = realFetch;
    }
    return { fetched, seen };
  }

  test('an opened connector call is read by id, and the loaded detail comes back', async () => {
    const { fetched, seen } = await read('call:exec-1', true);
    expect((seen as { error?: unknown }).error ?? null).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/projects/proj-1/review/items/call:exec-1');
    expect(seen.data).toMatchObject({ detail: { resolved_preview: { title: 'Loaded' } } });
  });

  test('nothing opened, or not enabled: no request', async () => {
    expect((await read(null, true)).fetched).toEqual([]);
    expect((await read('call:exec-1', false)).fetched).toEqual([]);
  });
});
