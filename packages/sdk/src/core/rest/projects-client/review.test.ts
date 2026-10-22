import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { bulkActReviewItems, getReviewSummary, listReviewItems } from './review';

let urls: string[] = [];
let nextBody: unknown = {};

beforeEach(() => {
  urls = [];
  globalThis.fetch = mock(async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('getReviewSummary reads the needs-you counts, not the list', async () => {
  nextBody = { needs_you_total: 3, needs_you_by_session: { s1: 2 } };
  const summary = await getReviewSummary('P1');
  expect(urls).toEqual(['http://test.local/projects/P1/review/summary']);
  expect(summary).toEqual({ needs_you_total: 3, needs_you_by_session: { s1: 2 } });
});

test('listReviewItems sends the page query and returns next_cursor', async () => {
  nextBody = { review_items: [], next_cursor: 'c2' };
  const page = await listReviewItems('P1', {
    segment: 'done',
    kind: 'change',
    sessionId: 's1',
    limit: 200,
    cursor: 'c1',
  });
  expect(urls).toEqual([
    'http://test.local/projects/P1/review/items?segment=done&kind=change&session_id=s1&limit=200&cursor=c1',
  ]);
  expect(page.next_cursor).toBe('c2');
});

test('listReviewItems with no params stays a bare GET', async () => {
  nextBody = { review_items: [] };
  await listReviewItems('P1');
  expect(urls).toEqual(['http://test.local/projects/P1/review/items']);
});

test('bulkActReviewItems returns one typed result per id', async () => {
  nextBody = {
    updated: 1,
    review_items: [],
    results: [
      { id: 'r1', ok: true },
      { id: 'call:e1', ok: false, code: 'expired' },
    ],
  };
  const res = await bulkActReviewItems('P1', { ids: ['r1', 'call:e1'], verdict: 'approve' });
  expect(urls).toEqual(['http://test.local/projects/P1/review/bulk']);
  // Typed: a renamed or dropped code fails tsc here.
  const code: 'expired' | 'already_resolved' | 'preview_unavailable' | 'forbidden' | 'not_found' | 'not_bulk_actionable' | undefined =
    res.results?.[1]?.code;
  expect(code).toBe('expired');
  expect(res.updated).toBe(1);
});
