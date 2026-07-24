/**
 * Connector `headers:` — arbitrary static request headers on a connector.
 *
 * Two layers, both exercised here:
 *   1. the shared ruleset (`@kortix/manifest-schema`) that the CR-merge gate,
 *      apps/api's manifest parser and the executor all validate against —
 *      RFC 7230 token names, no CR/LF (header injection), caps, and the
 *      round-trip of a header table through parse → normalized map;
 *   2. the executor merge (`executor/execute.ts`), where the SECURITY rule
 *      lives: the credential always wins, so a static header can never spoof
 *      or clobber the connector's auth header.
 *
 * Deliberately imports only config-free modules (manifest-schema + execute) so
 * the file runs without the API's env validation. The manifest-level
 * round-trip (kortix.yaml → ConnectorSpec → kortix.yaml) lives in
 * unit-connectors-parse.test.ts, which already imports the manifest parser.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONNECTOR_HEADERS_MAX_COUNT,
  CONNECTOR_HEADER_NAME_MAX_LENGTH,
  CONNECTOR_HEADER_VALUE_MAX_LENGTH,
  parseConnectorHeaders,
  sanitizeConnectorHeaders,
} from '@kortix/manifest-schema';
import {
  applyConnectorHeaders,
  executeCall,
  type ExecutorAuth,
  type FetchImpl,
} from '../executor/execute';

const BEARER: ExecutorAuth = { type: 'bearer', in: 'header', name: null, prefix: null };
const API_KEY: ExecutorAuth = { type: 'custom', in: 'header', name: 'X-API-Key', prefix: null };
const NO_AUTH: ExecutorAuth = { type: 'none', in: 'header', name: null, prefix: null };

function recordingFetch(status = 200, responseBody = '{"ok":true}') {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return { status, ok: status >= 200 && status < 300, text: async () => responseBody };
  };
  return { fetchImpl, calls };
}

function expectError(raw: unknown): string {
  const parsed = parseConnectorHeaders(raw);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? '' : parsed.error;
}

describe('parseConnectorHeaders — happy paths', () => {
  test('missing / null / empty tables normalize to {}', () => {
    for (const raw of [undefined, null, {}]) {
      const parsed = parseConnectorHeaders(raw);
      expect(parsed).toEqual({ ok: true, value: {} });
    }
  });

  test('keeps names verbatim, trims values, preserves authoring order', () => {
    const parsed = parseConnectorHeaders({
      Accept: 'application/json',
      'X-Tenant-Id': '  acme  ',
      'user-agent': 'kortix/1.0',
    });
    expect(parsed).toEqual({
      ok: true,
      value: { Accept: 'application/json', 'X-Tenant-Id': 'acme', 'user-agent': 'kortix/1.0' },
    });
    expect(parsed.ok && Object.keys(parsed.value)).toEqual(['Accept', 'X-Tenant-Id', 'user-agent']);
  });

  test('round-trips: a parsed table re-parses to itself', () => {
    const first = parseConnectorHeaders({ Accept: 'application/json', 'X-Api-Version': 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(parseConnectorHeaders(first.value)).toEqual(first);
  });

  test('YAML scalars (number/bool) become strings; an empty value is legal', () => {
    expect(parseConnectorHeaders({ 'X-Api-Version': 2, 'X-Beta': true, 'X-Empty': '' })).toEqual({
      ok: true,
      value: { 'X-Api-Version': '2', 'X-Beta': 'true', 'X-Empty': '' },
    });
  });

  test('every RFC 7230 token character is accepted', () => {
    const name = "abcXYZ019!#$%&'*+-.^_`|~";
    expect(parseConnectorHeaders({ [name]: 'v' })).toEqual({ ok: true, value: { [name]: 'v' } });
  });
});

describe('parseConnectorHeaders — rejections (security)', () => {
  test('invalid header names are rejected', () => {
    expect(expectError({ 'X Tenant': 'acme' })).toContain('invalid header name');
    expect(expectError({ 'X-Tenant:': 'acme' })).toContain('invalid header name');
    expect(expectError({ 'X-Ténant': 'acme' })).toContain('invalid header name');
    expect(expectError({ 'X-Bad\r\nInjected': 'v' })).toContain('invalid header name');
    expect(expectError({ '': 'acme' })).toContain('header name is required');
  });

  test('CR / LF in a value is rejected (response splitting / header injection)', () => {
    expect(expectError({ 'X-Tenant-Id': 'acme\r\nX-Admin: true' })).toContain('must not contain CR or LF');
    expect(expectError({ 'X-Tenant-Id': 'acme\nX-Admin: true' })).toContain('must not contain CR or LF');
    expect(expectError({ 'X-Tenant-Id': 'acme\r' })).toContain('must not contain CR or LF');
  });

  test('other control characters in a value are rejected', () => {
    expect(expectError({ 'X-Tenant-Id': 'ac\x00me' })).toContain('control characters');
    expect(expectError({ 'X-Tenant-Id': 'ac\x7fme' })).toContain('control characters');
  });

  test('transport-owned headers cannot be set', () => {
    for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'Connection']) {
      expect(expectError({ [name]: '1' })).toContain('controlled by the transport');
    }
  });

  test('non-string values and non-table tables are rejected', () => {
    expect(expectError({ 'X-A': { nested: true } })).toContain('must be a string');
    expect(expectError({ 'X-A': null })).toContain('must be a string');
    expect(expectError([{ name: 'X-A', value: 'b' }])).toContain('must be a table');
    expect(expectError('Accept: application/json')).toContain('must be a table');
  });

  test('two spellings of one header are a conflict, not two headers', () => {
    expect(expectError({ 'X-Tenant-Id': 'a', 'x-tenant-id': 'b' })).toContain('duplicate header');
  });
});

describe('parseConnectorHeaders — caps', () => {
  test(`at most ${CONNECTOR_HEADERS_MAX_COUNT} headers`, () => {
    const atCap = Object.fromEntries(
      Array.from({ length: CONNECTOR_HEADERS_MAX_COUNT }, (_, i) => [`X-H${i}`, 'v']),
    );
    expect(parseConnectorHeaders(atCap).ok).toBe(true);
    expect(expectError({ ...atCap, 'X-One-Too-Many': 'v' })).toContain('too many headers');
  });

  test(`header name is capped at ${CONNECTOR_HEADER_NAME_MAX_LENGTH} characters`, () => {
    const atCap = 'X'.repeat(CONNECTOR_HEADER_NAME_MAX_LENGTH);
    expect(parseConnectorHeaders({ [atCap]: 'v' }).ok).toBe(true);
    expect(expectError({ [`${atCap}X`]: 'v' })).toContain('too long');
  });

  test(`header value is capped at ${CONNECTOR_HEADER_VALUE_MAX_LENGTH} characters`, () => {
    const atCap = 'v'.repeat(CONNECTOR_HEADER_VALUE_MAX_LENGTH);
    expect(parseConnectorHeaders({ 'X-Big': atCap }).ok).toBe(true);
    expect(expectError({ 'X-Big': `${atCap}v` })).toContain('too long');
  });
});

describe('sanitizeConnectorHeaders — the executor fail-safe', () => {
  test('drops only the illegal entries', () => {
    expect(
      sanitizeConnectorHeaders({
        Accept: 'application/json',
        'X Bad Name': 'dropped',
        'X-Injected': 'a\r\nX-Admin: true',
        Host: 'evil.example.com',
        'X-Fine': 'kept',
      }),
    ).toEqual({ Accept: 'application/json', 'X-Fine': 'kept' });
  });

  test('non-tables and over-cap tables never blow up', () => {
    expect(sanitizeConnectorHeaders(undefined)).toEqual({});
    expect(sanitizeConnectorHeaders('nope')).toEqual({});
    const tooMany = Object.fromEntries(
      Array.from({ length: CONNECTOR_HEADERS_MAX_COUNT + 10 }, (_, i) => [`X-H${i}`, 'v']),
    );
    expect(Object.keys(sanitizeConnectorHeaders(tooMany))).toHaveLength(CONNECTOR_HEADERS_MAX_COUNT);
  });
});

describe('applyConnectorHeaders — the credential always wins', () => {
  test('a static header cannot clobber the auth header (any casing)', () => {
    const headers: Record<string, string> = {};
    applyConnectorHeaders(headers, { authorization: 'Bearer attacker', Accept: 'text/plain' }, BEARER);
    expect(headers).toEqual({ Accept: 'text/plain' });
  });

  test('a static header cannot clobber a custom auth header (any casing)', () => {
    const headers: Record<string, string> = {};
    applyConnectorHeaders(headers, { 'x-api-key': 'attacker', 'X-Tenant-Id': 'acme' }, API_KEY);
    expect(headers).toEqual({ 'X-Tenant-Id': 'acme' });
  });

  test('the auth header name is only reserved when the credential is in a header', () => {
    const queryAuth: ExecutorAuth = { type: 'custom', in: 'query', name: 'api_key', prefix: null };
    const headers: Record<string, string> = {};
    applyConnectorHeaders(headers, { Authorization: 'Basic static' }, queryAuth);
    expect(headers).toEqual({ Authorization: 'Basic static' });
  });

  test('replaces a same-named default rather than sending two spellings', () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    applyConnectorHeaders(headers, { Accept: 'text/csv' }, NO_AUTH);
    expect(headers).toEqual({ Accept: 'text/csv' });
  });
});

describe('executeCall — static headers on the wire', () => {
  test('http: merged in, and the bearer credential still wins', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: BEARER,
      headers: { Accept: 'application/json', 'X-Tenant-Id': 'acme', Authorization: 'Bearer spoofed' },
      secret: 'sk_123',
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({
      Accept: 'application/json',
      'X-Tenant-Id': 'acme',
      Authorization: 'Bearer sk_123',
    });
  });

  test('http: a static Content-Type survives the JSON body default', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'POST', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: NO_AUTH,
      headers: { 'Content-Type': 'application/vnd.api+json' },
      args: { body: { name: 'ada' } },
      fetchImpl,
    });
    expect(calls[0]!.headers['Content-Type']).toBe('application/vnd.api+json');
    expect(calls[0]!.body).toBe('{"name":"ada"}');
  });

  test('http + oauth1: the signed Authorization header is not spoofable', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/statuses' },
      baseUrl: 'https://api.example.com',
      auth: { type: 'oauth1', in: 'header', name: null, prefix: null },
      headers: { Authorization: 'Bearer spoofed', 'X-Tenant-Id': 'acme' },
      secret: JSON.stringify({
        consumer_key: 'ck', consumer_secret: 'cs', token: 't', token_secret: 'ts',
      }),
      fetchImpl,
    });
    expect(calls[0]!.headers.Authorization).toStartWith('OAuth ');
    expect(calls[0]!.headers['X-Tenant-Id']).toBe('acme');
  });

  test('mcp: overrides the transport defaults but never the credential', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'mcp', tool: 'search' },
      baseUrl: 'https://mcp.example.com/mcp',
      auth: API_KEY,
      headers: { Accept: 'application/json', 'X-API-Key': 'spoofed', 'X-Trace': 'on' },
      secret: 'k_live',
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Trace': 'on',
      'X-API-Key': 'k_live',
    });
  });

  test('graphql: merged in alongside the credential', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'graphql', operation: 'query', field: 'user' },
      baseUrl: 'https://gql.example.com/graphql',
      auth: BEARER,
      headers: { 'X-Tenant-Id': 'acme', Authorization: 'Bearer spoofed' },
      secret: 'sk_123',
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'acme',
      Authorization: 'Bearer sk_123',
    });
  });

  test('postman: overrides a collection header, never the credential', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: {
        kind: 'postman',
        method: 'GET',
        url: 'https://api.example.com/things',
        headers: { Accept: 'text/plain', 'X-Collection': 'keep' },
        bodyMode: null,
      },
      auth: API_KEY,
      headers: { Accept: 'application/json', 'X-API-Key': 'spoofed' },
      secret: 'k_live',
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({
      Accept: 'application/json',
      'X-Collection': 'keep',
      'X-API-Key': 'k_live',
    });
  });

  test('an illegal stored header is dropped, never sent', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: NO_AUTH,
      // Shape a pre-validation row could hold; the executor must not emit it.
      headers: { 'X-Injected': 'a\r\nX-Admin: true', Host: 'evil.example.com', 'X-Ok': 'v' },
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({ 'X-Ok': 'v' });
  });

  test('no headers declared → the request is byte-identical to before', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: BEARER,
      secret: 'sk_123',
      fetchImpl,
    });
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer sk_123' });
  });
});
