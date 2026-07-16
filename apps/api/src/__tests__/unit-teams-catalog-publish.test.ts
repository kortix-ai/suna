import { afterEach, describe, expect, test } from 'bun:test';
import { publishTeamsAppToCatalog } from '../channels/teams/catalog';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('publishTeamsAppToCatalog — delegated org-catalog publish', () => {
  test('an admin publishes immediately (201) and gets the catalog id', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), method: init?.method });
      return jsonRes(201, { id: 'catalog-123' });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1', appName: 'Kortix Dev' });

    expect(r).toMatchObject({ ok: true, published: true, teamsAppId: 'catalog-123' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).not.toContain('requiresReview');
  });

  test('a non-admin (403) is submitted for admin review', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (!u.includes('requiresReview')) return jsonRes(403, { error: { code: 'Forbidden' } });
      return jsonRes(201, { id: 'submitted-9' });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ ok: true, published: false, pendingReview: true, teamsAppId: 'submitted-9' });
    expect(urls.some((u) => u.includes('requiresReview=true'))).toBe(true);
  });

  test('an already-published app (409) resolves its id via externalId lookup', async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      if (init?.method === 'POST') return new Response('', { status: 409 });
      return jsonRes(200, { value: [{ id: 'existing-77' }] });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ ok: true, published: true, teamsAppId: 'existing-77' });
  });

  test('reports failure when the publish is rejected outright', async () => {
    globalThis.fetch = (async () => jsonRes(500, { error: 'boom' })) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.ok).toBe(false);
    expect(r.published).toBe(false);
  });
});
