import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../core/http/config';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import { readSessionAudit } from './use-session-audit';

const EMPTY_AUDIT = { session_id: '', agent: null, audit_access: false, count: 0, actions: [] };

describe('readSessionAudit — the endpoint-only fallback', () => {
  test('answers the cache, never the network, when either id is missing', async () => {
    expect(await readSessionAudit(undefined, undefined, undefined, 100)).toEqual(EMPTY_AUDIT as never);
    expect(await readSessionAudit(undefined, 'sess-1', undefined, 100)).toEqual(EMPTY_AUDIT as never);
    expect(await readSessionAudit('proj-1', undefined, undefined, 100)).toEqual(EMPTY_AUDIT as never);
  });

  test('a missing id with cached rows echoes the cache, not the empty default', async () => {
    const cached = { session_id: 'S1', agent: 'kortix', audit_access: false, count: 1, actions: [{ execution_id: 'e1' } as never] };
    expect(await readSessionAudit(undefined, undefined, cached, 100)).toEqual(cached as never);
  });
});

describe('readSessionAudit and the open bundle', () => {
  beforeEach(() => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  });

  function mockFetch(body: (url: string) => unknown) {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body(String(url))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return urls;
  }

  function bundle(audit: unknown) {
    return {
      observed_at: '2026-09-27T12:00:00.000Z',
      session: { session_id: 'S1' },
      turn: { known: true, turns: [] },
      queue: { known: true, prompts: [], held: false },
      transcript: { known: true, requested: false },
      config: { known: true },
      models: { known: false, reason: 'llm_gateway_disabled' },
      audit,
    };
  }

  test('a FIRST read (no cache) answers from the open bundle without touching /audit', async () => {
    resetSessionOpenBundles();
    const row = { execution_id: 'e1', status: 'pending_approval' };
    const urls = mockFetch(() =>
      bundle({ known: true, session_id: 'S1', agent: 'kortix', audit_access: false, count: 1, actions: [row] }),
    );
    openSessionBundle('P1', 'S1');
    const result = await readSessionAudit('P1', 'S1', undefined, 100);
    expect(urls.filter((u) => u.endsWith('/audit?limit=100&include_events=false'))).toHaveLength(0);
    expect(result).toEqual({
      session_id: 'S1',
      agent: 'kortix',
      audit_access: false,
      count: 1,
      actions: [row],
    } as never);
  });

  test('a read that already holds rows never answers from the bundle — it asks the endpoint', async () => {
    resetSessionOpenBundles();
    const stale = { execution_id: 'e1', status: 'pending_approval' };
    const fresh = { execution_id: 'e1', status: 'ok' };
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: true, session_id: 'S1', agent: null, audit_access: false, count: 1, actions: [stale] })
        : { session_id: 'S1', agent: null, audit_access: false, count: 1, actions: [fresh] },
    );
    openSessionBundle('P1', 'S1');
    const cached = { session_id: 'S1', agent: null, audit_access: false, count: 1, actions: [stale as never] };
    const result = await readSessionAudit('P1', 'S1', cached, 100);
    expect(urls.filter((u) => u.includes('/audit'))).toHaveLength(1);
    expect(result.actions).toEqual([fresh] as never);
  });

  test('an unknown audit leg falls back to the endpoint, never to an empty actions list', async () => {
    resetSessionOpenBundles();
    const row = { execution_id: 'e2', status: 'ok' };
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: false, reason: 'leg_failed' })
        : { session_id: 'S1', agent: null, audit_access: false, count: 1, actions: [row] },
    );
    openSessionBundle('P1', 'S1');
    const result = await readSessionAudit('P1', 'S1', undefined, 100);
    expect(urls.filter((u) => u.includes('/audit'))).toHaveLength(1);
    expect(result.actions).toEqual([row] as never);
  });

  test('passes the requested limit and includeEvents:false through to the endpoint fallback', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: false, reason: 'leg_failed' })
        : { session_id: 'S1', agent: null, audit_access: false, count: 0, actions: [] },
    );
    await readSessionAudit('P1', 'S1', undefined, 42);
    const auditUrl = urls.find((u) => u.includes('/audit'));
    expect(auditUrl).toContain('limit=42');
    expect(auditUrl).toContain('include_events=false');
  });

  test('a silent poller (showErrors:false) still gets a real answer from the endpoint fallback', async () => {
    // `showErrors` is `backendApi`'s error-toast suppression flag — its wiring
    // is `sessions.test.ts`'s job. This proves only that `readSessionAudit`
    // accepts and forwards the option without breaking the read itself, which
    // is what an always-mounted, error-silent poller (the header nudge)
    // depends on.
    resetSessionOpenBundles();
    mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: false, reason: 'leg_failed' })
        : { session_id: 'S1', agent: null, audit_access: false, count: 2, actions: [] },
    );
    const result = await readSessionAudit('P1', 'S1', undefined, 100, { showErrors: false });
    expect(result.count).toBe(2);
  });
});
