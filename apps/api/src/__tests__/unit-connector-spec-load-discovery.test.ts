import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Regression for Better Stack API prod pattern `3e5bd849…` —
 * `Error: failed to fetch spec at <spec url>: HTTP 401 Unauthorized`
 * (mechanism `generic`, `handled: true`), call site `loadSourceText` in
 * `apps/api/src/services/connectors/sync.ts`, on
 * `POST /v1/connectors/projects/:id/connectors` (24 occurrences / 2 users,
 * first seen 2026-08-21; statuses seen in the wild: 401, 403, 404).
 *
 * Root cause: `discoverConnectorAuthFromSource` treats every spec-load
 * failure except "path not in the repository" as a server fault. A spec URL
 * the user typed that answers non-OK HTTP (an auth-walled or wrong URL) —
 * or returns a body that is not a JSON/YAML spec — threw a bare `Error`
 * through the create/auth-discovery routes → `app.onError` → generic
 * `captureException` → Sentry, and the user got an opaque 500 instead of
 * the actionable message.
 *
 * This is the same antipattern as the `RepoFileNotFoundError` degradation in
 * the same wrapper (Better Stack `a8d20288…`) and the typed
 * `AllowedSourceValidationError` route mapping (Better Stack `f5c0ce61…`):
 * an EXPECTED user-input state must not page like a server defect.
 *
 * The fix: `loadSourceText` and `parseSpecDocument` throw a typed
 * `SpecLoadError` for an unreadable spec, and the discovery wrapper degrades
 * it to the empty discovery with the reason as a warning — the create then
 * proceeds and the sync path records the real error on the connector
 * (status `error` + the create flow's sync-error toast), like every other
 * broken spec. The egress guard's refusals (private host, bad scheme, DNS
 * of a non-public host) keep their typed envelopes; genuine git/DB faults
 * still propagate.
 *
 * Hermetic: no real DNS (`mock.module` of `node:dns/promises`, the
 * `egress.test.ts` pattern) and a stubbed `globalThis.fetch`.
 */

// No real DNS: every host resolves from this table.
let dnsResults: Record<string, Array<{ address: string; family: number }>> = {};
mock.module('node:dns/promises', () => ({
  lookup: async (host: string) => dnsResults[host] ?? [],
}));

const { discoverConnectorAuthFromSource } = await import('../services/connectors/sync');
const { AllowedSourceValidationError } = await import('../services/marketplace/catalog');
const { UnsafeEgressError } = await import('../lib/ssrf-guard');
import type { GitBackedProject } from '../services/git';

const PROJECT = { projectId: 'proj-1', defaultBranch: 'main' } as GitBackedProject;

let fetchCalls: string[] = [];
let responses: Array<{
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: Error;
}> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  dnsResults = { 'specs.example.com': [{ address: '93.184.216.34', family: 4 }] };
  fetchCalls = [];
  responses = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: '{}' };
    if (r.throw) throw r.throw;
    // statusText mirrors a real HTTP reason phrase ("Unauthorized"), which the
    // spec-load error message embeds.
    return new Response(r.body ?? null, {
      status: r.status,
      statusText: r.statusText ?? '',
      headers: r.headers,
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('auth discovery degrades on a spec source that cannot be loaded', () => {
  test('an auth-walled spec URL (HTTP 401) returns the empty discovery with the reason, not a throw', async () => {
    responses.push({ status: 401, statusText: 'Unauthorized', body: '' });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'openapi',
      spec: 'https://specs.example.com/portal-api.openapi.yaml',
    });
    expect(discovery.status).toBe('none');
    expect(discovery.recommended).toBeNull();
    expect(discovery.candidates).toEqual([]);
    expect(discovery.warnings).toEqual([
      'failed to fetch spec at https://specs.example.com/portal-api.openapi.yaml: HTTP 401 Unauthorized',
    ]);
  });

  test('a spec URL answering 404 degrades the same way', async () => {
    responses.push({ status: 404, statusText: 'Not Found', body: '' });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'openapi',
      spec: 'https://specs.example.com/wrong-path.yaml',
    });
    expect(discovery.status).toBe('none');
    expect(discovery.recommended).toBeNull();
    expect(discovery.warnings).toEqual([
      'failed to fetch spec at https://specs.example.com/wrong-path.yaml: HTTP 404 Not Found',
    ]);
  });

  test('a landing page fetched as the spec (HTTP 200 HTML) degrades on the parse error', async () => {
    responses.push({
      status: 200,
      body: '<!DOCTYPE html><html><body>Not a spec</body></html>',
    });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'openapi',
      spec: 'https://specs.example.com/landing',
    });
    expect(discovery.status).toBe('none');
    expect(discovery.recommended).toBeNull();
    expect(discovery.warnings[0]).toMatch(/looks like an HTML\/XML page/);
  });

  test('a spec host that refuses the connection degrades with the network error', async () => {
    responses.push({ status: 200, throw: new TypeError('Unable to connect') });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'openapi',
      spec: 'https://specs.example.com/closed-port.yaml',
    });
    expect(discovery.status).toBe('none');
    expect(discovery.recommended).toBeNull();
    expect(discovery.warnings[0]).toContain(
      'failed to fetch spec at https://specs.example.com/closed-port.yaml',
    );
  });

  test('a remote Postman source answering 401 degrades the same way', async () => {
    responses.push({ status: 401, statusText: 'Unauthorized', body: '' });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'postman',
      spec: 'https://specs.example.com/team.postman_collection.json',
    });
    expect(discovery.status).toBe('none');
    expect(discovery.recommended).toBeNull();
    expect(discovery.warnings).toEqual([
      'failed to fetch spec at https://specs.example.com/team.postman_collection.json: HTTP 401 Unauthorized',
    ]);
  });

  test('a readable spec still discovers auth — the degradation is not a blanket swallow', async () => {
    responses.push({
      status: 200,
      body: [
        'openapi: 3.0.0',
        'components:',
        '  securitySchemes:',
        '    key: { type: apiKey, in: header, name: X-API-Key }',
        'paths:',
        '  /things:',
        '    get: { security: [{ key: [] }], responses: {} }',
      ].join('\n'),
    });
    const discovery = await discoverConnectorAuthFromSource(PROJECT, {
      provider: 'openapi',
      spec: 'https://specs.example.com/real-api.openapi.yaml',
    });
    expect(discovery.status).toBe('detected');
    expect(discovery.recommended).toEqual({
      type: 'custom',
      in: 'header',
      name: 'X-API-Key',
      prefix: null,
    });
  });

  test('a URL the egress guard refuses still throws its typed validation error', async () => {
    // The SSRF guard runs before the fetch. It must NOT be degraded into the
    // empty discovery: the routes map it to the structured
    // `invalid_source_address` 400 (Better Stack `f5c0ce61…`).
    await expect(
      discoverConnectorAuthFromSource(PROJECT, {
        provider: 'openapi',
        spec: 'http://169.254.169.254/latest/meta-data',
      }),
    ).rejects.toBeInstanceOf(AllowedSourceValidationError);
    expect(fetchCalls).toEqual([]);
  });

  test('a spec host that the DNS-resolving egress guard rejects (private IP) still throws UnsafeEgressError', async () => {
    // The registry guard admits an https URL on a public-looking host; the
    // DNS-resolving egress guard then resolves it to a private address. That
    // refusal must survive the spec-load catch UNWRAPPED — wrapping it would
    // turn a security refusal into a degraded discovery and skip the
    // structured 400.
    dnsResults['blocked.example.com'] = [{ address: '10.0.0.5', family: 4 }];
    await expect(
      discoverConnectorAuthFromSource(PROJECT, {
        provider: 'openapi',
        spec: 'https://blocked.example.com/internal-api.openapi.yaml',
      }),
    ).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(fetchCalls).toEqual([]);
  });
});
