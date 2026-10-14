import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getReviewSummary, listReviewItems } from './review';

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
