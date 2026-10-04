import { afterEach, describe, expect, test } from 'bun:test';
import { publishTeamsAppToCatalog, TEAMS_CATALOG_PUBLISH_TIMEOUT_MS } from '../services/channels/teams/catalog';
import { TEAMS_MANIFEST_VERSION } from '../services/channels/teams-manifest';

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

  test('an already-published app (409) resolves its id and submits the package as a new app definition', async () => {
    const posts: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (init?.method === 'POST' && u.endsWith('/appDefinitions')) {
        posts.push(u);
        expect(init.headers['content-type']).toBe('application/zip');
        return jsonRes(201, { id: 'def-2' });
      }
      if (init?.method === 'POST') return new Response('', { status: 409 });
      return jsonRes(200, { value: [{ id: 'existing-77' }] });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ ok: true, published: true, teamsAppId: 'existing-77', updated: true });
    expect(posts).toEqual(['https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/existing-77/appDefinitions']);
  });

  test('a rejected app-definition update still reports the existing app as published', async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (init?.method === 'POST' && u.endsWith('/appDefinitions')) return jsonRes(403, { error: { code: 'Forbidden' } });
      if (init?.method === 'POST') return new Response('', { status: 409 });
      return jsonRes(200, { value: [{ id: 'existing-77' }] });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ ok: true, published: true, teamsAppId: 'existing-77' });
    expect(r.updated).toBeUndefined();
  });

  test('reports failure when the publish is rejected outright', async () => {
    globalThis.fetch = (async () => jsonRes(500, { error: 'boom' })) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.ok).toBe(false);
    expect(r.published).toBe(false);
  });
});

/**
 * The version the org catalog serves decides whether a team can grant the
 * app's read permissions. Manifest 1.0.0 requests neither; 1.1.0 and 1.2.0
 * lack the group-chat one. A team on such a version refuses every thread read
 * with "Resource specific consent grants". The publish reports the version so
 * the Channels page can say the app needs an update.
 */
describe('publishTeamsAppToCatalog — the app version the org catalog serves', () => {
  function catalogWith(definitions: Array<{ version: string; publishingState: string }>, update: Response) {
    const gets: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (init?.method === 'POST' && u.endsWith('/appDefinitions')) return update.clone();
      if (init?.method === 'POST') return new Response('', { status: 409 });
      gets.push(decodeURIComponent(u));
      return jsonRes(200, { value: [{ id: 'existing-77', appDefinitions: definitions }] });
    }) as any;
    return gets;
  }

  test('a first publish serves this manifest version', async () => {
    globalThis.fetch = (async () => jsonRes(201, { id: 'catalog-123' })) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.version).toBe(TEAMS_MANIFEST_VERSION);
  });

  test('an accepted app-definition update serves this manifest version', async () => {
    const gets = catalogWith([{ version: '1.2.0', publishingState: 'published' }], jsonRes(201, { id: 'def-2' }));

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ updated: true, version: TEAMS_MANIFEST_VERSION });
    expect(gets[0]).toContain('$expand=appDefinitions');
  });

  test('a rejected update reports the version the catalog still serves, not this one', async () => {
    catalogWith(
      [
        { version: '1.7.0', publishingState: 'submitted' },
        { version: '1.2.0', publishingState: 'published' },
      ],
      jsonRes(403, { error: { code: 'Forbidden' } }),
    );

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.updated).toBeUndefined();
    expect(r.version).toBe('1.2.0');
  });

  test('an update Graph refuses because the catalog already serves this version reports this version', async () => {
    catalogWith(
      [{ version: TEAMS_MANIFEST_VERSION, publishingState: 'published' }],
      jsonRes(409, { error: { code: 'Conflict', message: 'App with same version already exists' } }),
    );

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.version).toBe(TEAMS_MANIFEST_VERSION);
  });

  test('a non-admin connect to a tenant that already has the app reports the version it serves', async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (init?.method !== 'POST') {
        return jsonRes(200, { value: [{ id: 'existing-77', appDefinitions: [{ version: '1.0.0', publishingState: 'published' }] }] });
      }
      return u.includes('requiresReview') ? new Response('', { status: 409 }) : jsonRes(403, { error: { code: 'Forbidden' } });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r).toMatchObject({ ok: true, published: true, teamsAppId: 'existing-77', version: '1.0.0' });
  });

  test('a package sent for admin review serves no version yet', async () => {
    globalThis.fetch = (async (url: any) =>
      String(url).includes('requiresReview') ? jsonRes(201, { id: 'submitted-9' }) : jsonRes(403, {})) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.pendingReview).toBe(true);
    expect(r.version).toBeUndefined();
  });
});

describe('publishTeamsAppToCatalog — failure detail and timeout (one-click install on dev returned ?teams=consented with no reason)', () => {
  test('a rejected publish carries the Graph status AND the response body in error', async () => {
    globalThis.fetch = (async () =>
      jsonRes(400, { error: { code: 'BadRequest', message: 'Invalid manifest: validDomains' } })) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('400');
    expect(r.error).toContain('Invalid manifest: validDomains');
  });

  test('a failed review submit carries the review status and body in error', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (!u.includes('requiresReview')) return jsonRes(403, { error: { code: 'Forbidden' } });
      return jsonRes(400, { error: { message: 'review disabled by policy' } });
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('400');
    expect(r.error).toContain('review disabled by policy');
  });

  test('an aborted fetch is reported as a timeout, naming the budget', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as any;

    const r = await publishTeamsAppToCatalog({ accessToken: 'tok', baseUrl: 'https://dev-api', appId: 'app-1' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
    expect(r.error).toContain(String(TEAMS_CATALOG_PUBLISH_TIMEOUT_MS / 1000));
  });

  test('the publish budget is at least 90 s — a first-time org-catalog publish measured 21 s from a laptop, and the old 30 s abort is the prime suspect for the dev failure', () => {
    expect(TEAMS_CATALOG_PUBLISH_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });
});
